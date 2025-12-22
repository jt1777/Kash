import { ethers } from 'ethers';
import { config } from '../config';
import { deployToAave } from '../batch/deployToAave';
import { getAggregatedNetPosition, getAllUnprocessedBatchCycles } from '../batch/getAllUnprocessedBatches';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Script to deploy net assets to Aave and borrow USDT
 * Processes all unprocessed batches
 */
async function main() {
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not set in .env - needed to send transactions');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  console.log('🚀 Aave Deployment Script (All Unprocessed Batches)');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`From: ${wallet.address}`);
  console.log(`Network: ${config.rpcUrl}\n`);

  // Get aggregated net position across all unprocessed batches
  console.log('🔍 Finding all unprocessed batch cycles...\n');
  const { aggregated, batches } = await getAggregatedNetPosition(provider);

  if (batches.length === 0) {
    console.log('ℹ️  No unprocessed batches found - nothing to deploy');
    return;
  }

  console.log('\n📈 Aggregated Net Position:');
  console.log(`   Total Mint USD: ${ethers.formatEther(aggregated.totalMintUSD)}`);
  console.log(`   Total Redeem USD: ${ethers.formatEther(aggregated.totalRedeemUSD)}`);
  console.log(`   Net Position USD: ${ethers.formatEther(aggregated.netPositionUSD)}`);
  console.log(`   Unprocessed Batches: ${batches.length}\n`);

  if (aggregated.netPositionUSD <= 0n) {
    console.log('ℹ️  No net mints - nothing to deploy to Aave');
    console.log('   (Net position must be positive to deploy)');
    return;
  }

  // Check if we're the owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`You are not the contract owner! Owner is: ${owner}`);
  }

  console.log('✅ You are the contract owner\n');

  // Get all unprocessed batch cycles (for token balance checking)
  const unprocessedBatches = await getAllUnprocessedBatchCycles(provider);
  // Use the oldest unprocessed batch for token balance checking
  // (since tokens accumulate across batches)
  const oldestBatch = unprocessedBatches[0];

  // Deploy to Aave using aggregated net position
  try {
    const result = await deployToAave(provider, wallet, aggregated.netPositionUSD, oldestBatch);
    console.log('\n✅ Deployment complete!');
    console.log(`   Deposit TXs: ${result.depositTxHashes.join(', ')}`);
    console.log(`   Borrow TX: ${result.borrowTxHash}`);
  } catch (error: any) {
    console.error('\n❌ Deployment failed:', error.message);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
