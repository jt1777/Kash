import { ethers } from 'ethers';
import { config } from './config';
import { calculateNetPosition, getYesterdayBatchCycle } from './batch/calculateNetPosition';
import { validateConfig, verifyContract } from './utils/validateConfig';

async function main() {
  console.log('🚀 KashYield Bot - Starting...\n');

  // Validate configuration
  try {
    validateConfig();
  } catch (error: any) {
    console.error('❌ Configuration Error:');
    console.error(error.message);
    process.exit(1);
  }

  // Initialize provider
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  console.log(`📡 Connected to RPC: ${config.rpcUrl}`);
  console.log(`📄 Contract Address: ${config.kashYieldAddress}`);
  console.log(`🔗 Chain ID: ${config.chainId}`);
  if (process.env.ARBITRUM_SEPOLIA_RPC_URL) {
    console.log(`ℹ️  Using ARBITRUM_SEPOLIA_RPC_URL from .env`);
  } else if (process.env.RPC_URL) {
    console.log(`ℹ️  Using RPC_URL from .env`);
  } else {
    console.log(`ℹ️  Using default Sepolia RPC`);
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

  // Get yesterday's batch cycle
  const batchCycle = await getYesterdayBatchCycle(provider);
  console.log(`📅 Processing batch cycle: ${batchCycle}`);

  // Calculate net position
  console.log('📊 Calculating net position (mints - redeems)...');
  const netPosition = await calculateNetPosition(provider, batchCycle);

  // Display results
  console.log('\n📈 Net Position Results:');
  console.log('─'.repeat(50));
  console.log(`Batch Cycle:        ${netPosition.batchCycle}`);
  console.log(`Total Mint USD:     ${ethers.formatEther(netPosition.totalMintUSD)} USD`);
  console.log(`Total Redeem USD:   ${ethers.formatEther(netPosition.totalRedeemUSD)} USD`);
  console.log(`Net Position USD:   ${ethers.formatEther(netPosition.netPositionUSD)} USD`);
  console.log(`Mint Requests:      ${netPosition.mintCount}`);
  console.log(`Redeem Requests:    ${netPosition.redeemCount}`);
  console.log('─'.repeat(50));

  // Determine action needed
  if (netPosition.netPositionUSD > 0n) {
    console.log('\n✅ NET MINT: Need to mint Kash tokens');
    console.log(`   Deploy ${ethers.formatEther(netPosition.netPositionUSD)} USD of new capital`);
  } else if (netPosition.netPositionUSD < 0n) {
    console.log('\n❌ NET REDEEM: Need to redeem/burn Kash tokens');
    console.log(`   Free up ${ethers.formatEther(-netPosition.netPositionUSD)} USD of capital`);
  } else {
    console.log('\n⚖️  BALANCED: No net change, only rebalancing if needed');
  }

  console.log('\n✨ Net position calculation complete!');
}

// Run if called directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ Error:', error);
      process.exit(1);
    });
}

export { calculateNetPosition, getYesterdayBatchCycle };
