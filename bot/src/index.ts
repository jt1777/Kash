import { ethers } from 'ethers';
import { config } from './config';
import { BatchProcessor } from './batch/batchProcessor';
import { validateConfig, verifyContract } from './utils/validateConfig';

async function main() {
  const productLabel = config.product === 'btc' ? 'KashYieldBtc (wBTC)' : 'KashYieldETH';
  console.log(`🚀 KashYield Bot - Starting (${productLabel})...\n`);

  // Validate configuration
  try {
    validateConfig();
  } catch (error: any) {
    console.error('❌ Configuration Error:');
    console.error(error.message);
    process.exit(1);
  }

  // Initialize provider and signer (60s timeout; static network to avoid extra RPC on startup)
  const fetchRequest = new ethers.FetchRequest(config.rpcUrl);
  fetchRequest.timeout = 60000;
  const networkName =
    config.chainId === 42161 ? 'arbitrum' : config.chainId === 421614 ? 'arbitrum-sepolia' : 'custom';
  const network = { chainId: config.chainId, name: networkName };
  const provider = new ethers.JsonRpcProvider(fetchRequest, network);
  
  if (!config.privateKey) {
    console.error('❌ Private key not configured. Set PRIVATE_KEY in .env');
    process.exit(1);
  }
  
  const wallet = new ethers.Wallet(config.privateKey, provider);
  console.log(`🔑 Bot Wallet: ${wallet.address}`);
  
  // Check wallet balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`💰 Wallet Balance: ${ethers.formatEther(balance)} ETH\n`);
  
  if (balance === 0n) {
    console.error('❌ Wallet has no ETH for gas. Please fund the bot wallet.');
    process.exit(1);
  }

  console.log(`📡 Connected to RPC: ${config.rpcUrl}`);
  console.log(`📦 Product: ${config.product.toUpperCase()} (${productLabel})`);
  console.log(`📄 Contract Address: ${config.kashYieldAddress}`);
  console.log(`🔗 Chain ID: ${config.chainId}`);
  if (config.batchStep !== 'full') {
    console.log(`🔀 Batch step: ${config.batchStep} only`);
  }
  if (config.batchCycleOverride !== null) {
    console.log(`📅 Batch override: ${config.batchCycleOverride}`);
  }
  if (config.allowProcessedBatch) {
    console.log('⚠️  Allow processed batch: yes (--allow-processed)');
  }
  console.log('');

  // Verify contract exists
  try {
    await verifyContract(provider);
    console.log('✅ Contract verified at address\n');
  } catch (error: any) {
    console.error('❌ Contract Verification Failed:');
    console.error(error.message);
    process.exit(1);
  }

  // Create batch processor
  const processor = new BatchProcessor(provider, wallet);

  // Run the processor
  try {
    await processor.run();
    console.log('\n✨ Bot execution complete!');
  } catch (error: any) {
    console.error('\n❌ Bot execution failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ Unhandled Error:', error);
      process.exit(1);
    });
}

export { BatchProcessor };
