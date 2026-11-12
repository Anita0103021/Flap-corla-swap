import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Wallet } from 'ethers';

async function main() {
  const [filename, flag, extra] = process.argv.slice(2);
  if (!filename || filename === '--help' || (flag && flag !== '--import') || extra) {
    console.log('用法: node src/keygen.mjs keystores/wallet-1.json [--import]');
    return;
  }
  if (!process.stdin.isTTY) throw new Error('interactive terminal required');
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  const prompt = async label => {
    process.stderr.write(label);
    try { return await rl.question(''); } finally { process.stderr.write('\n'); }
  };
  let wallet, password;
  try {
    if (flag === '--import') {
      const input = (await prompt('仅在本地终端粘贴私钥（不回显）: ')).trim();
      if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(input)) throw new Error('invalid key');
      wallet = new Wallet(input.startsWith('0x') ? input : '0x' + input);
    } else {
      wallet = new Wallet(Wallet.createRandom().privateKey);
    }
    password = await prompt('设置 keystore 密码（至少 12 字符，不回显）: ');
    if (password.length < 12 || await prompt('再次输入密码: ') !== password) throw new Error('invalid password');
  } finally { rl.close(); }
  const out = resolve(filename);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await wallet.encrypt(password), { flag: 'wx', mode: 0o600 });
  console.log('已写入加密 keystore：' + out);
  console.log('钱包地址：' + wallet.address);
}

main().catch(e => {
  console.error(e?.code === 'EEXIST' ? '目标文件已存在，未覆盖' : '创建失败：检查终端、私钥格式、两次密码和文件权限。');
  process.exitCode = 1;
});
