import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { JsonRpcProvider } from 'ethers';
export { compileFirstBuy } from '../../src/firstbuy-contract.mjs';

const require = createRequire(import.meta.url);
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function anvilBinary() {
  const names = { 'win32:x64': 'win32-amd64', 'linux:x64': 'linux-amd64', 'linux:arm64': 'linux-arm64',
    'darwin:x64': 'darwin-amd64', 'darwin:arm64': 'darwin-arm64' };
  const suffix = names[`${process.platform}:${process.arch}`];
  if (!suffix) throw new Error('Unsupported local EVM platform');
  const metadata = require.resolve(`@foundry-rs/anvil-${suffix}/package.json`);
  return join(dirname(metadata), 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
}

export async function startAnvil({ forkUrl, forkBlock, chainId = 56, timeoutMs = 45000 } = {}) {
  const reserve = createServer();
  await new Promise((ok, fail) => { reserve.once('error', fail); reserve.listen(0, '127.0.0.1', ok); });
  const port = reserve.address().port;
  await new Promise(ok => reserve.close(ok));
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId),
    '--hardfork', 'prague', '--base-fee', '0', '--gas-price', '100000000', '--silent'];
  if (forkUrl) {
    const url = new URL(forkUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !Number.isSafeInteger(forkBlock) || forkBlock < 0) throw new Error('Fork source must be an explicit public HTTPS RPC and pinned block');
    args.push('--fork-url', url.href, '--fork-block-number', String(forkBlock));
  }
  const child = spawn(anvilBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let errors = '', failed;
  child.stdout.on('data', () => {});
  child.stderr.on('data', value => { errors = (errors + value.toString()).slice(-4096); });
  child.once('error', error => { failed = error; });
  const endpoint = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(endpoint, chainId, { staticNetwork: true, cacheTimeout: -1 });
  async function close() {
    provider.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(ok => child.once('exit', ok));
      child.kill();
      await Promise.race([exited, sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  const expires = Date.now() + timeoutMs;
  try {
    while (Date.now() < expires) {
      if (failed || child.exitCode !== null) throw new Error('Local EVM failed to start');
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(800) });
        const result = await response.json();
        if (BigInt(result.result) === BigInt(chainId)) return { provider, endpoint, port, close, pid: child.pid };
      } catch { /* startup/fork reads are bounded */ }
      await sleep(100);
    }
    throw new Error('Local EVM start timed out');
  } catch (error) { await close(); throw error; }
}
