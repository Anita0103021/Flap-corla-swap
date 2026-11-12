export function requireRuntime() {
  if (Number(process.versions.node.split('.')[0]) < 24 ||
      typeof process.getBuiltinModule?.('node:sqlite')?.DatabaseSync !== 'function') {
    throw new Error('需要支持 node:sqlite 的 Node.js 24 或更高版本。');
  }
}
