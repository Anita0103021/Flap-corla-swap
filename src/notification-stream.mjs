import { setTimeout as delay } from 'node:timers/promises';

// Only the local HTTP route can attach, after its origin/session checks. A
// single producer covers all subscribers; no browser timers drive chain reads.
export function createNotificationStream({ openFeed, intervalMs = 1_800, heartbeatMs = 15_000, maxClients = 4 }) {
  const clients = new Set();
  let task, heartbeat, closing = false, status = 'syncing';
  const json = frame => JSON.stringify(frame, (_key, value) => typeof value === 'bigint' ? String(value) : value) + '\n';

  function remove(client) {
    if (!clients.delete(client) || clients.size) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
    status = 'syncing';
    task?.controller.abort();
  }
  function write(client, frame) {
    if (!clients.has(client)) return;
    try {
      // Drop a stalled consumer instead of buffering indefinitely.
      if (!client.response.destroyed && client.response.write(json(frame))) return;
    } catch { /* the client may already have left */ }
    remove(client);
    client.response.destroy();
  }
  function mark(next) {
    if (next === status) return;
    status = next;
    for (const client of clients) write(client, { type: 'status', status });
  }
  function start() {
    if (task || closing || !clients.size) return;
    const controller = new AbortController();
    const { signal } = controller;
    const current = { controller };
    task = current;
    current.done = (async () => {
      let feed, failures = 0;
      try {
        while (!signal.aborted) {
          // Take a subscriber/flag snapshot for this poll. A new stream does
          // not get an in-flight batch that began before it subscribed.
          const receivers = [...clients];
          const enabled = {
            whitelist: receivers.some(client => client.enabled.whitelist),
            burst: receivers.some(client => client.enabled.burst),
          };
          try {
            feed ??= await openFeed(signal);
            signal.throwIfAborted();
            const result = await feed.poll({ enabled, signal });
            if (signal.aborted) break;
            const next = ['syncing', 'monitoring', 'degraded'].includes(result?.status) ? result.status : 'monitoring';
            mark(next);
            for (const event of result?.events ?? []) {
              if (event?.kind !== 'whitelist' && event?.kind !== 'burst') continue;
              for (const client of receivers) {
                if (client.enabled[event.kind]) write(client, { type: 'event', event });
              }
            }
            failures = 0;
          } catch {
            if (signal.aborted) break;
            failures = Math.min(failures + 1, 4);
            mark('degraded');
          }
          const wait = Math.min(15_000, intervalMs * (failures ? 2 ** failures : 1));
          try { await delay(wait, undefined, { signal, ref: false }); } catch { if (signal.aborted) break; }
        }
      } finally {
        try { await feed?.close?.(); } catch { /* isolated read-only provider */ }
      }
    })().finally(() => {
      if (task === current) task = undefined;
      start(); // Handle a new connection arriving while the old loop closes.
    });
  }

  return {
    canAttach: () => !closing && clients.size < maxClients,
    attach(response, enabled) {
      const client = { response, enabled };
      clients.add(client);
      response.once('close', () => remove(client));
      response.once('error', () => remove(client));
      write(client, { type: 'ready' });
      write(client, { type: 'status', status });
      if (!clients.size) return;
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          for (const row of clients) write(row, { type: 'ping' });
        }, heartbeatMs);
        heartbeat.unref();
      }
      start();
    },
    async close() {
      closing = true;
      clearInterval(heartbeat);
      task?.controller.abort();
      for (const client of [...clients]) {
        remove(client);
        client.response.end();
      }
      await task?.done;
    },
  };
}
