import { ethers } from 'ethers';
import { config } from '../config';
import { calculateNetPosition } from '../batch/calculateNetPosition';
import { validateConfig, verifyContract } from '../utils/validateConfig';
import { kashYieldABI } from '../contracts/kashYieldABI';

async function main() {
  console.log('📊 Calculating Net Position\n');

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

  // Get current batch cycle (today's pending requests)
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );
  const currentBatchCycle = await kashYield.getCurrentBatchCycle();
  const batchCycle = currentBatchCycle; // Check current cycle for pending requests
  console.log(`📅 Checking current batch cycle: ${batchCycle} (today's pending requests)\n`);

  // Debug: Check what oracle addresses the contract is using and get live price
  try {
    const ethOracle = await kashYield.tokenOracles(ethers.ZeroAddress);
    console.log(`🔍 Contract's ETH Oracle: ${ethOracle}`);
    if (ethOracle === '0x0000000000000000000000000000000000000000') {
      console.log(`   ⚠️  No oracle set for ETH!`);
    } else {
      // Try to get the price directly from the oracle
      try {
        const oracleABI = [
          {
            inputs: [],
            name: 'latestRoundData',
            outputs: [
              { name: 'roundId', type: 'uint80' },
              { name: 'answer', type: 'int256' },
              { name: 'startedAt', type: 'uint256' },
              { name: 'updatedAt', type: 'uint256' },
              { name: 'answeredInRound', type: 'uint80' },
            ],
            stateMutability: 'view',
            type: 'function',
          },
        ];
        const oracle = new ethers.Contract(ethOracle, oracleABI, provider);
        const priceData = await oracle.latestRoundData();
        const price = Number(priceData.answer) / 1e8; // Convert from 8 decimals
        console.log(`   📊 Current ETH Price from Oracle: $${price.toFixed(2)}`);
        console.log(`   ⚠️  Note: If this is a MockChainlinkPriceFeed, the price is hardcoded!`);
      } catch (error: any) {
        console.log(`   ⚠️  Could not read price from oracle: ${error.message}`);
      }
    }
    console.log('');
  } catch (error) {
    // Ignore if we can't read oracle
  }

  // Debug: Check batch info first
  try {
    const batchInfo = await kashYield.getBatchInfo(batchCycle);
    console.log(`🔍 Batch Info Debug:`);
    console.log(`   Mint Users Count: ${batchInfo.mintUsersCount}`);
    console.log(`   Redeem Users Count: ${batchInfo.redeemUsersCount}`);
    console.log(`   Processed: ${batchInfo.processed}\n`);
  } catch (error: any) {
    console.log(`⚠️  Could not get batch info: ${error.message}\n`);
  }

  // Debug: Try to query events for this batch cycle
  try {
    const currentBlock = await provider.getBlockNumber();
    
    console.log(`🔍 Querying MintRequested events (will filter by batch cycle ${batchCycle})...`);
    // Query all MintRequested events (can't filter by non-indexed batchCycle)
    const allMintEvents = await kashYield.queryFilter(
      kashYield.filters.MintRequested(),
      undefined, // fromBlock
      currentBlock // toBlock
    );
    
    // Filter manually by batchCycle
    const mintEvents = allMintEvents.filter((event) => {
      if ('args' in event && event.args) {
        const args = event.args as any;
        return BigInt(args.batchCycle?.toString() || '0') === batchCycle;
      }
      return false;
    });
    
    console.log(`   Found ${mintEvents.length} MintRequested event(s) for batch cycle ${batchCycle}`);
    
    if (mintEvents.length > 0) {
      console.log(`   Events:`);
      for (const event of mintEvents) {
        // Type guard to check if it's an EventLog with args
        if ('args' in event && event.args) {
          const args = event.args as any;
          console.log(`     - User: ${args.user}`);
          console.log(`       Token: ${args.tokenIn}`);
          console.log(`       Amount: ${ethers.formatEther(args.amountIn)} ETH`);
          console.log(`       Batch Cycle: ${args.batchCycle}`);
        }
      }
    }
    console.log('');
  } catch (error: any) {
    console.log(`⚠️  Could not query events: ${error.message}\n`);
  }

  // Calculate net position
  console.log('📊 Calculating net position (mints - redeems)...');
  const netPosition = await calculateNetPosition(provider, batchCycle);

  // Display results
  console.log('\n📈 Net Position Results:');
  console.log('═'.repeat(60));
  console.log(`Batch Cycle:        ${netPosition.batchCycle}`);
  console.log(`Total Mint USD:     ${ethers.formatEther(netPosition.totalMintUSD)} USD`);
  console.log(`Total Redeem USD:   ${ethers.formatEther(netPosition.totalRedeemUSD)} USD`);
  console.log(`Net Position USD:   ${ethers.formatEther(netPosition.netPositionUSD)} USD`);
  console.log(`Mint Requests:      ${netPosition.mintCount}`);
  console.log(`Redeem Requests:    ${netPosition.redeemCount}`);
  console.log('═'.repeat(60));

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

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
