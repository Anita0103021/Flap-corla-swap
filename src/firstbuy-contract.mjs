import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getAddress, keccak256, zeroPadValue } from 'ethers';

const SOURCE = 'contracts/CorlaFirstBuyExecutor.sol';
let artifactTask;
export async function compileFirstBuy(extraSources = {}) {
  const { default: solc } = await import('solc');
  const sources = { [SOURCE]: { content: await readFile(new URL('../' + SOURCE, import.meta.url), 'utf8') }, ...extraSources };
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'paris',
      metadata: { bytecodeHash: 'none' }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object',
        'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } } })));
  const errors = result.errors?.filter(row => row.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(row => row.formattedMessage).join('\n'));
  return result.contracts;
}

export function firstBuyArtifact() {
  return artifactTask ??= compileFirstBuy().then(result => {
    const compiled = result[SOURCE].CorlaFirstBuyExecutor;
    const template = compiled.evm.deployedBytecode;
    const references = Object.values(template.immutableReferences ?? {}).flat();
    if (!references.length || references.some(row => row.length !== 32)) throw new Error('Unsupported first-buy immutable layout');
    function expectedRuntime(owner) {
      const encoded = zeroPadValue(getAddress(owner), 32).slice(2).toLowerCase();
      let code = template.object;
      for (const row of references) code = code.slice(0, row.start * 2) + encoded + code.slice((row.start + row.length) * 2);
      return '0x' + code;
    }
    return Object.freeze({ abi: compiled.abi, bytecode: '0x' + compiled.evm.bytecode.object,
      expectedRuntime, expectedCodeHash: owner => keccak256(expectedRuntime(owner)) });
  }).catch(error => { artifactTask = undefined; throw error; });
}
