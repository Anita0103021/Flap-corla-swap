import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { keccak256 } from 'ethers';
import solc from 'solc';
import { compileFirstBuy, PROJECT_ROOT } from '../test/helpers/firstbuy-lab.mjs';

const result = (await compileFirstBuy())['contracts/CorlaFirstBuyExecutor.sol'].CorlaFirstBuyExecutor;
const artifact = { contractName: 'CorlaFirstBuyExecutor', compiler: solc.version(), evmVersion: 'paris',
  optimizer: { enabled: true, runs: 200 }, viaIR: true, abi: result.abi,
  bytecode: '0x' + result.evm.bytecode.object, runtimeTemplate: '0x' + result.evm.deployedBytecode.object,
  bytecodeHash: keccak256('0x' + result.evm.bytecode.object) };
const directory = join(PROJECT_ROOT, 'reports', 'firstbuy-build');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'CorlaFirstBuyExecutor.json'), JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({ compiled: true, compiler: artifact.compiler,
  initBytes: result.evm.bytecode.object.length / 2, runtimeBytes: result.evm.deployedBytecode.object.length / 2,
  artifact: 'reports/firstbuy-build/CorlaFirstBuyExecutor.json', deployed: false }));
