import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Enumerate the public test suite explicitly: local reports may contain
// independent checkouts or forensic artifacts and must not become test input.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.length && args[0] !== '--firstbuy') throw new Error('Unknown test selection');
const files = (await readdir(new URL('../test/', import.meta.url)))
  .filter(name => name.endsWith('.test.mjs') && (!args.length || name.startsWith('firstbuy-'))).sort()
  .map(name => 'test/' + name);
if (!files.length) throw new Error('No tests selected');
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
