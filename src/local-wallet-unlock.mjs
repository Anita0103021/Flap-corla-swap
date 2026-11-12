import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, win32 } from 'node:path';
import { syncParentDirectory } from './local-files.mjs';

const FORMAT = 'corla-local-wallet-unlock';
const VERSION = 1;
const MAX_PASSWORD_BYTES = 512;
const MAX_DPAPI_BYTES = 4096;
const MAX_RECORD_BYTES = MAX_DPAPI_BYTES * 2 + 256;
const TIMEOUT_MS = 6000;

function failure(message) {
  return Object.assign(new Error(message), { code: 'LOCAL_WALLET_UNLOCK' });
}

// The command is static. The sensitive input/output only crosses anonymous
// pipes as bytes; nothing is interpolated into PowerShell or the environment.
function encodeCommand(method) {
  return Buffer.from(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputBytes = $null
$outputBytes = $null
$buffer = [byte[]]::new(4097)
try {
  Add-Type -AssemblyName System.Security
  $source = [Console]::OpenStandardInput()
  $count = 0
  while ($count -lt $buffer.Length) {
    $read = $source.Read($buffer, $count, $buffer.Length - $count)
    if ($read -eq 0) { break }
    $count += $read
  }
  if ($count -lt 1 -or $count -gt 4096) { throw 'Invalid DPAPI input length' }
  $inputBytes = [byte[]]::new($count)
  [Buffer]::BlockCopy($buffer, 0, $inputBytes, 0, $count)
  $entropy = [Text.Encoding]::UTF8.GetBytes('Corla Desk local wallet unlock v1')
  $outputBytes = [Security.Cryptography.ProtectedData]::${method}(
    $inputBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $destination = [Console]::OpenStandardOutput()
  $destination.Write($outputBytes, 0, $outputBytes.Length)
  $destination.Flush()
} catch {
  exit 1
} finally {
  [Array]::Clear($buffer, 0, $buffer.Length)
  if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
  if ($null -ne $outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
}
`, 'utf16le').toString('base64');
}
const PROTECT = encodeCommand('Protect');
const UNPROTECT = encodeCommand('Unprotect');

function runDpapi(command, input, maxOutput) {
  return new Promise((resolveOutput, reject) => {
    // Do not resolve powershell.exe through PATH, and do not load a profile.
    const exe = win32.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let child;
    try {
      child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      reject(failure('Windows 无法操作本机免密凭据'));
      return;
    }
    let done = false, size = 0;
    const chunks = [];
    const fail = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      child.kill();
      reject(failure('Windows 无法操作本机免密凭据'));
    };
    const timer = setTimeout(fail, TIMEOUT_MS);
    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.on('data', chunk => {
      if (done) { chunk.fill(0); return; }
      size += chunk.length;
      if (size > maxOutput) {
        chunk.fill(0);
        fail();
      } else chunks.push(chunk);
    });
    child.once('close', code => {
      if (done) return;
      if (code !== 0 || size === 0) { fail(); return; }
      done = true;
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks, size);
      for (const chunk of chunks) chunk.fill(0);
      resolveOutput(bytes);
    });
    child.stdin.end(input);
  });
}

function passwordBytes(password) {
  if (typeof password !== 'string' || !password.trim() || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    throw failure('请输入有效的钱包库密码');
  }
  return Buffer.from(password, 'utf8');
}

async function readRecord(file) {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('无法读取本机免密凭据');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECORD_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_RECORD_BYTES) throw new Error();
    const record = JSON.parse(bytes.toString('utf8', 0, used));
    if (record?.format !== FORMAT || record.version !== VERSION || typeof record.protected !== 'string' ||
        record.protected.length > MAX_DPAPI_BYTES * 2 || !/^(?:[a-f0-9]{2})+$/.test(record.protected)) {
      throw new Error();
    }
    return Buffer.from(record.protected, 'hex');
  } catch {
    throw failure('本机免密凭据已损坏，请用原密码重新启用');
  } finally { await handle.close(); }
}

/** Store a DPAPI-protected copy of the existing vault password. This does not
 * alter vault encryption or migrate the wallet file. Callers must first
 * authenticate the password against the vault before explicitly saving it. */
export function createLocalWalletUnlock(path, {
  platform = process.platform,
  protect = input => runDpapi(PROTECT, input, MAX_DPAPI_BYTES),
  unprotect = input => runDpapi(UNPROTECT, input, MAX_PASSWORD_BYTES),
} = {}) {
  const file = resolve(path);
  const supported = platform === 'win32';
  const checkSupported = () => {
    if (!supported) throw failure('本机免密仅支持 Windows');
  };
  return {
    supported,
    async exists() {
      if (!supported) return false;
      try {
        const blob = await readRecord(file);
        blob?.fill(0);
        return blob !== null;
      } catch { return false; }
    },
    async save(password) {
      checkSupported();
      const bytes = passwordBytes(password);
      const temp = file + '.' + randomBytes(16).toString('hex') + '.tmp';
      let blob;
      try {
        blob = await protect(bytes);
        if (!Buffer.isBuffer(blob) || blob.length < 1 || blob.length > MAX_DPAPI_BYTES || blob.equals(bytes)) throw new Error();
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ format: FORMAT, version: VERSION, protected: blob.toString('hex') }) + '\n', 'utf8');
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temp, file);
        await syncParentDirectory(file);
      } catch {
        throw failure('无法保存本机免密凭据');
      } finally {
        bytes.fill(0);
        if (Buffer.isBuffer(blob)) blob.fill(0);
        await unlink(temp).catch(() => {});
      }
    },
    async read() {
      checkSupported();
      const blob = await readRecord(file);
      if (!blob) throw failure('尚未启用本机免密');
      let bytes;
      try {
        bytes = await unprotect(blob);
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PASSWORD_BYTES) throw new Error();
        const password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!password.trim()) throw new Error();
        return password;
      } catch {
        throw failure('当前 Windows 用户无法解锁本机免密凭据，请用原密码重新启用');
      } finally {
        blob.fill(0);
        if (Buffer.isBuffer(bytes)) bytes.fill(0);
      }
    },
    async remove() {
      checkSupported();
      try {
        await unlink(file);
        await syncParentDirectory(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw failure('无法清除本机免密凭据');
      }
    },
  };
}
