import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Wallet, getAddress, hexlify } from 'ethers';
import { syncParentDirectory } from './local-files.mjs';

const scrypt = promisify(scryptCallback);
const MAX_WALLETS = 32;
const KEY_BYTES = 32;
const FORMAT = 'corla-wallet-vault';
const VERSION = 1;
const KDF = Object.freeze({ N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
const MAX_FILE_BYTES = 32 * 1024;
const PRIVATE_KEY = /^(?:0x)?[0-9a-f]{64}$/i;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const HEX = /^[a-f0-9]*$/;
const INVALID_LABEL = /[\p{Cc}\p{Cf}]|[a-f0-9]{64}/iu;
const queues = new Map();

function fail(message) {
  const error = new Error(message);
  error.code = 'WALLET_VAULT';
  return error;
}

function vaultPassword(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 512 ||
      value.trim().length === 0) {
    throw fail('请输入有效的钱包库密码（最多 512 字节）');
  }
  return value;
}

function walletLabel(input, password = undefined) {
  if (input === undefined) return '';
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 160 ||
      INVALID_LABEL.test(input) || (password && input.includes(password))) {
    throw fail('钱包备注无效，请勿在备注中填写私钥或密码（最多 160 字节）');
  }
  return input.trim();
}

function submittedKeys(value) {
  if (typeof value === 'string') value = value.trim().split(/[\s,;，；]+/u);
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WALLETS) {
    throw fail('每次导入 1–32 个私钥');
  }
  return value.map((key, i) => {
    if (typeof key !== 'string' || !PRIVATE_KEY.test(key.trim())) {
      throw fail('第 ' + (i + 1) + ' 个私钥无效，须为 64 位十六进制');
    }
    return key.trim().replace(/^0x/i, '');
  });
}

function walletAddress(value) {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) throw fail('无效的钱包地址');
  try { return getAddress(value); } catch { throw fail('无效的钱包地址'); }
}

function walletFor(bytes, provider) {
  // Only this in-memory Wallet ever holds unencrypted signing material.
  return new Wallet(hexlify(bytes), provider ?? null);
}

function recordsOf(rows) {
  return rows.map(({ address, label }) => ({ address, label }));
}

function authData(rows) {
  return Buffer.from(JSON.stringify([FORMAT, VERSION, rows.map(({ address, label }) => [address, label])]), 'utf8');
}

function isHex(value, bytes) {
  return typeof value === 'string' && value.length === bytes * 2 && HEX.test(value);
}

async function readVault(file) {
  let handle;
  try { handle = await open(file, 'r'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw fail('无法读取本地钱包库');
  }
  let parsed;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error();
    parsed = JSON.parse(await handle.readFile('utf8'));
    if (parsed?.format !== FORMAT || parsed.version !== VERSION ||
        !isHex(parsed.salt, 32) || !isHex(parsed.iv, 12) || !isHex(parsed.tag, 16) ||
        !Array.isArray(parsed.wallets) || parsed.wallets.length > MAX_WALLETS ||
        !isHex(parsed.ciphertext, KEY_BYTES * parsed.wallets.length)) throw new Error();
    const rows = parsed.wallets.map(row => {
      const address = walletAddress(row?.address);
      if (address !== row.address || typeof row.label !== 'string' || walletLabel(row.label) !== row.label) throw new Error();
      return { address, label: row.label };
    });
    if (new Set(rows.map(row => row.address)).size !== rows.length) throw new Error();
    return { ...parsed, wallets: rows };
  } catch {
    throw fail('钱包库文件格式不受支持或已损坏');
  } finally { await handle.close(); }
}

async function derive(password, salt) {
  const pw = Buffer.from(password, 'utf8');
  try { return await scrypt(pw, salt, KEY_BYTES, KDF); }
  finally { pw.fill(0); }
}

function decrypt(vault, key) {
  let partial, end;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(vault.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(authData(vault.wallets));
    decipher.setAuthTag(Buffer.from(vault.tag, 'hex'));
    partial = decipher.update(Buffer.from(vault.ciphertext, 'hex'));
    end = decipher.final();
    return Buffer.concat([partial, end]);
  } catch {
    throw fail('钱包库密码错误，或加密文件已损坏');
  } finally { partial?.fill(0); end?.fill(0); }
}

function encrypt(rows, clear, key, salt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(authData(rows));
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
  return {
    format: FORMAT, version: VERSION, salt: salt.toString('hex'), iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'), wallets: rows, ciphertext: ciphertext.toString('hex'),
  };
}

async function saveVault(file, vault) {
  const temporary = file + '.' + randomBytes(16).toString('hex') + '.tmp';
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(vault) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
    await syncParentDirectory(file);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function exclusiveFile(file, work) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const path = file + '.lock';
  const deadline = Date.now() + 8000;
  let handle;
  for (;;) {
    try { handle = await open(path, 'wx', 0o600); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw fail('钱包库写入锁未释放，请关闭其他控制台后重试；若上次异常退出，请按 README 清理残留锁');
      await delay(90);
    }
  }
  try { return await work(); }
  finally {
    await handle.close();
    await unlink(path).catch(() => {});
  }
}

function enqueue(file, fn) {
  const next = (queues.get(file) ?? Promise.resolve()).then(fn);
  const tail = next.catch(() => {});
  queues.set(file, tail);
  return next.finally(() => { if (queues.get(file) === tail) queues.delete(file); });
}

async function safe(operation) {
  try { return await operation(); } catch (e) {
    if (e?.code === 'WALLET_VAULT') throw e;
    throw fail('无法操作本地钱包库，请检查文件权限和剩余空间');
  }
}

/** Encrypted vault storing binary key material. Public rows are AAD-protected;
 * no password, signing key or decrypted bytes leave this module except via a
 * signer created by unlock(). */
export function createWalletVault(path) {
  const file = resolve(path);
  const serialized = fn => safe(() => enqueue(file, fn));
  const update = fn => serialized(() => exclusiveFile(file, fn));
  return {
    async exists() {
      return safe(async () => Boolean(await readVault(file)));
    },
    async list() {
      return safe(async () => recordsOf((await readVault(file))?.wallets ?? []));
    },
    async verifyPassword(password) {
      return serialized(async () => {
        const pw = vaultPassword(password);
        const existing = await readVault(file);
        if (!existing) throw fail('钱包库尚未创建，请先导入钱包');
        const key = await derive(pw, Buffer.from(existing.salt, 'hex'));
        let clear;
        try { clear = decrypt(existing, key); }
        finally { clear?.fill(0); key.fill(0); }
      });
    },
    async importWallets({ password, privateKeys, label } = {}) {
      return update(async () => {
        const pw = vaultPassword(password);
        const submitted = submittedKeys(privateKeys);
        const note = walletLabel(label, pw);
        if (submitted.length > 1 && note) throw fail('批量导入时请留空钱包备注');
        const existing = await readVault(file);
        if (!existing && [...pw.trim()].length < 12) throw fail('首次创建钱包库，密码至少需要 12 个字符');
        const rows = recordsOf(existing?.wallets ?? []);
        const salt = existing ? Buffer.from(existing.salt, 'hex') : randomBytes(32);
        const key = await derive(pw, salt);
        let old, clear;
        const additions = [];
        try {
          old = existing ? decrypt(existing, key) : Buffer.alloc(0);
          if (rows.length + submitted.length > MAX_WALLETS) throw fail('钱包库最多存放 32 个钱包');
          const seen = new Set(rows.map(row => row.address));
          for (const [index, raw] of submitted.entries()) {
            const bytes = Buffer.from(raw, 'hex');
            additions.push(bytes);
            let wallet;
            try { wallet = walletFor(bytes); }
            catch { throw fail('第 ' + (index + 1) + ' 个私钥不是有效的 EVM 签名密钥'); }
            if (seen.has(wallet.address)) throw fail('发现重复钱包，整批未导入');
            seen.add(wallet.address);
            rows.push({ address: wallet.address, label: note });
          }
          clear = Buffer.concat([old, ...additions]);
          await saveVault(file, encrypt(rows, clear, key, salt));
          return recordsOf(rows);
        } finally {
          old?.fill(0);
          clear?.fill(0);
          for (const bytes of additions) bytes.fill(0);
          key.fill(0);
        }
      });
    },
    async removeWallet({ password, address } = {}) {
      return update(async () => {
        const pw = vaultPassword(password);
        const wallet = walletAddress(address);
        const existing = await readVault(file);
        if (!existing) throw fail('钱包库尚未创建');
        const salt = Buffer.from(existing.salt, 'hex');
        const key = await derive(pw, salt);
        let old, clear;
        try {
          old = decrypt(existing, key);
          const rows = recordsOf(existing.wallets);
          const index = rows.findIndex(row => row.address === wallet);
          if (index < 0) throw fail('钱包不存在');
          rows.splice(index, 1);
          clear = Buffer.concat([old.subarray(0, index * KEY_BYTES), old.subarray((index + 1) * KEY_BYTES)]);
          // Removing the last row retains the vault and its existing password.
          await saveVault(file, encrypt(rows, clear, key, salt));
          return recordsOf(rows);
        } finally { old?.fill(0); clear?.fill(0); key.fill(0); }
      });
    },
    async unlock({ password, provider } = {}) {
      return serialized(async () => {
        const pw = vaultPassword(password);
        const existing = await readVault(file);
        if (!existing) throw fail('钱包库尚未创建，请先导入钱包');
        const key = await derive(pw, Buffer.from(existing.salt, 'hex'));
        let clear;
        try {
          clear = decrypt(existing, key);
          return existing.wallets.map((row, i) => {
            const wallet = walletFor(clear.subarray(i * KEY_BYTES, (i + 1) * KEY_BYTES), provider);
            if (wallet.address !== row.address) throw fail('钱包库地址与签名密钥不匹配');
            return wallet;
          });
        } finally { clear?.fill(0); key.fill(0); }
      });
    },
  };
}
