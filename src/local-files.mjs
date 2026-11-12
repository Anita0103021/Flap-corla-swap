import { open } from 'node:fs/promises';
import { dirname } from 'node:path';

// The data file is flushed before rename. Syncing its parent directory is
// best-effort on filesystems that allow it; Windows has no portable Node API
// for opening a directory with the native backup semantics required here.
export async function syncParentDirectory(file) {
  if (process.platform === 'win32') return;
  let parent;
  try {
    parent = await open(dirname(file), 'r');
    await parent.sync();
  } catch { /* A successful atomic rename cannot be rolled back here. */ }
  finally { await parent?.close().catch(() => {}); }
}
