import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';
import { calculateNetPosition } from './calculateNetPosition';
import { NetPosition } from '../types';

/**
 * Find all unprocessed batch cycles that have mint or redeem requests
 * @param provider Ethers provider
 * @returns Array of unprocessed batch cycles
 */
export async function getAllUnprocessedBatchCycles(
  provider: ethers.Provider
): Promise<bigint[]> {
  if (!config.kashYieldAddress || !ethers.isAddress(config.kashYieldAddress)) {
    throw new Error('Invalid KASH_YIELD_ADDRESS in configuration');
  }

  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  // Query all MintRequested and RedeemRequested events to find all batch cycles
  const currentBlock = await provider.getBlockNumber();
  const allMintEvents = await kashYield.queryFilter(
    kashYield.filters.MintRequested(),
    undefined,
    currentBlock
  );
  const allRedeemEvents = await kashYield.queryFilter(
    kashYield.filters.RedeemRequested(),
    undefined,
    currentBlock
  );

  // Extract unique batch cycles from events
  const batchCycles = new Set<bigint>();
  
  for (const event of allMintEvents) {
    if ('args' in event && event.args) {
      const args = event.args as any;
      const batchCycle = BigInt(args.batchCycle?.toString() || '0');
      if (batchCycle > 0n) {
        batchCycles.add(batchCycle);
      }
    }
  }

  for (const event of allRedeemEvents) {
    if ('args' in event && event.args) {
      const args = event.args as any;
      const batchCycle = BigInt(args.batchCycle?.toString() || '0');
      if (batchCycle > 0n) {
        batchCycles.add(batchCycle);
      }
    }
  }

  // Check which batches are unprocessed
  const unprocessedBatches: bigint[] = [];
  
  for (const batchCycle of batchCycles) {
    try {
      const batchInfo = await kashYield.getBatchInfo(batchCycle);
      if (!batchInfo.processed) {
        // Check if batch has any activity
        if (batchInfo.mintUsersCount > 0n || batchInfo.redeemUsersCount > 0n) {
          unprocessedBatches.push(batchCycle);
        }
      }
    } catch (error) {
      // If getBatchInfo fails, assume batch exists and is unprocessed
      // (might be a very old batch or edge case)
      unprocessedBatches.push(batchCycle);
    }
  }

  // Sort batch cycles (oldest first)
  return unprocessedBatches.sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

/**
 * Calculate aggregated net position across all unprocessed batches
 * @param provider Ethers provider
 * @returns Aggregated net position and list of individual batch positions
 */
export async function getAggregatedNetPosition(
  provider: ethers.Provider
): Promise<{
  aggregated: NetPosition;
  batches: Array<{ batchCycle: bigint; netPosition: NetPosition }>;
}> {
  const unprocessedBatches = await getAllUnprocessedBatchCycles(provider);

  if (unprocessedBatches.length === 0) {
    // Return zero position if no unprocessed batches
    return {
      aggregated: {
        netPositionUSD: 0n,
        totalMintUSD: 0n,
        totalRedeemUSD: 0n,
        mintCount: 0,
        redeemCount: 0,
        batchCycle: 0n,
      },
      batches: [],
    };
  }

  console.log(`📋 Found ${unprocessedBatches.length} unprocessed batch cycle(s):`);
  for (const batchCycle of unprocessedBatches) {
    console.log(`   - Batch ${batchCycle}`);
  }
  console.log('');

  // Calculate net position for each batch
  const batchPositions: Array<{ batchCycle: bigint; netPosition: NetPosition }> = [];
  let totalMintUSD = 0n;
  let totalRedeemUSD = 0n;
  let totalMintCount = 0;
  let totalRedeemCount = 0;

  for (const batchCycle of unprocessedBatches) {
    try {
      const netPosition = await calculateNetPosition(provider, batchCycle);
      batchPositions.push({ batchCycle, netPosition });
      
      totalMintUSD += netPosition.totalMintUSD;
      totalRedeemUSD += netPosition.totalRedeemUSD;
      totalMintCount += netPosition.mintCount;
      totalRedeemCount += netPosition.redeemCount;
    } catch (error: any) {
      console.warn(`⚠️  Could not calculate net position for batch ${batchCycle}: ${error.message}`);
    }
  }

  const aggregated: NetPosition = {
    netPositionUSD: totalMintUSD - totalRedeemUSD,
    totalMintUSD,
    totalRedeemUSD,
    mintCount: totalMintCount,
    redeemCount: totalRedeemCount,
    batchCycle: unprocessedBatches[0], // Use first batch cycle as reference
  };

  return {
    aggregated,
    batches: batchPositions,
  };
}
