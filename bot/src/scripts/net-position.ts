import { ethers } from 'ethers';
import { config } from '../config';
import { validateConfig, verifyContract } from '../utils/validateConfig';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { getAggregatedNetPosition } from '../batch/getAllUnprocessedBatches';

async function main() {
  console.log('📊 Calculating Net Position (All Unprocessed Batches)\n');

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
  console.log(`📄 Contract Address: ${config.kashYieldAddress}\n`);

  // Verify contract exists
  try {
    await verifyContract(provider);
  } catch (error: any) {
    console.error('❌ Contract Verification Failed:');
    console.error(error.message);
    process.exit(1);
  }

  // Get aggregated net position across all unprocessed batches
  console.log('🔍 Finding all unprocessed batch cycles...\n');

  // Get aggregated net position
  const { aggregated, batches } = await getAggregatedNetPosition(provider);

  if (batches.length === 0) {
    console.log('ℹ️  No unprocessed batches found\n');
    return;
  }

  // Display individual batch results
  console.log('\n📊 Individual Batch Results:');
  console.log('═'.repeat(60));
  for (const { batchCycle, netPosition } of batches) {
    console.log(`Batch ${batchCycle}:`);
    console.log(`   Mints:   ${ethers.formatEther(netPosition.totalMintUSD)} USD (${netPosition.mintCount} requests)`);
    console.log(`   Redeems: ${ethers.formatEther(netPosition.totalRedeemUSD)} USD (${netPosition.redeemCount} requests)`);
    console.log(`   Net:     ${ethers.formatEther(netPosition.netPositionUSD)} USD`);
    console.log('');
  }

  // Display aggregated results
  console.log('📈 Aggregated Net Position (All Unprocessed Batches):');
  console.log('═'.repeat(60));
  console.log(`Total Mint USD:     ${ethers.formatEther(aggregated.totalMintUSD)} USD`);
  console.log(`Total Redeem USD:   ${ethers.formatEther(aggregated.totalRedeemUSD)} USD`);
  console.log(`Net Position USD:   ${ethers.formatEther(aggregated.netPositionUSD)} USD`);
  console.log(`Total Mint Requests: ${aggregated.mintCount}`);
  console.log(`Total Redeem Requests: ${aggregated.redeemCount}`);
  console.log(`Unprocessed Batches: ${batches.length}`);
  console.log('═'.repeat(60));

  // Determine action needed
  if (aggregated.netPositionUSD > 0n) {
    console.log('\n✅ NET MINT: Need to mint Kash tokens');
    console.log(`   Deploy ${ethers.formatEther(aggregated.netPositionUSD)} USD of new capital`);
  } else if (aggregated.netPositionUSD < 0n) {
    console.log('\n❌ NET REDEEM: Need to redeem/burn Kash tokens');
    console.log(`   Free up ${ethers.formatEther(-aggregated.netPositionUSD)} USD of capital`);
  } else {
    console.log('\n⚖️  BALANCED: No net change, only rebalancing if needed');
  }

  console.log('\n✨ Net position calculation complete!');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
