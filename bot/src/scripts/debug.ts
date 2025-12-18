import { ethers } from 'ethers';
import { config } from '../config';
import { debugContract, debugTransaction } from '../utils/debugContract';

async function main() {
  const args = process.argv.slice(2);
  const txHash = args[0];

  // Initialize provider
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  console.log(`📡 Connected to: ${config.rpcUrl}`);
  console.log(`📄 Contract: ${config.kashYieldAddress}\n`);

  if (txHash && txHash.startsWith('0x')) {
    // Debug specific transaction
    await debugTransaction(provider, txHash);
  } else {
    // Debug contract state
    await debugContract(provider);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
