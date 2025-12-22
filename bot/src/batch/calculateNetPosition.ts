import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';
import { NetPosition, MintRequest, RedeemRequest } from '../types';

/**
 * Calculate net position (mints - redeems) for a given batch cycle
 * This is the first step in batch processing to determine if we need to mint or redeem Kash tokens
 * 
 * @param provider Ethers provider
 * @param batchCycle Batch cycle to process (typically yesterday's cycle)
 * @returns Net position information
 */
export async function calculateNetPosition(
  provider: ethers.Provider,
  batchCycle: bigint
): Promise<NetPosition> {
  if (!config.kashYieldAddress || !ethers.isAddress(config.kashYieldAddress)) {
    throw new Error('Invalid KASH_YIELD_ADDRESS in configuration');
  }

  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  // Get batch info to check if already processed and get user counts
  let batchInfo;
  try {
    batchInfo = await kashYield.getBatchInfo(batchCycle);
  } catch (error: any) {
    // If batch doesn't exist, return zero net position
    console.log(`ℹ️  Batch cycle ${batchCycle} doesn't exist yet - returning zero net position`);
    return {
      netPositionUSD: 0n,
      totalMintUSD: 0n,
      totalRedeemUSD: 0n,
      mintCount: 0,
      redeemCount: 0,
      batchCycle,
    };
  }
  
  if (batchInfo.processed) {
    // If already processed, return the stored totals
    const totalMint = BigInt(batchInfo.totalMintUSD.toString());
    const totalRedeem = BigInt(batchInfo.totalRedeemUSD.toString());
    const netPositionUSD = totalMint - totalRedeem;
    return {
      netPositionUSD,
      totalMintUSD: totalMint,
      totalRedeemUSD: totalRedeem,
      mintCount: Number(batchInfo.mintUsersCount),
      redeemCount: Number(batchInfo.redeemUsersCount),
      batchCycle,
    };
  }

  // Check if batch has any activity
  const mintCount = Number(batchInfo.mintUsersCount);
  const redeemCount = Number(batchInfo.redeemUsersCount);
  
  if (mintCount === 0 && redeemCount === 0) {
    // No activity in this batch
    console.log(`ℹ️  Batch cycle ${batchCycle} has no mint or redeem requests`);
    return {
      netPositionUSD: 0n,
      totalMintUSD: 0n,
      totalRedeemUSD: 0n,
      mintCount: 0,
      redeemCount: 0,
      batchCycle,
    };
  }

  // Get current NAV for redeem calculations
  const currentNAV = await kashYield.getNAV() as bigint;

  // Get users from public mappings (much more efficient than querying events)
  // Handle potential reverts if batch doesn't exist or has no users
  let mintUsersRaw: string[] = [];
  let redeemUsersRaw: string[] = [];

  // If we have a count from batchInfo, try to get the users
  // But if that fails, fall back to querying events
  if (mintCount > 0) {
    try {
      mintUsersRaw = await kashYield.batchMintUsers(batchCycle) as string[];
      console.log(`✅ Retrieved ${mintUsersRaw.length} mint users from batchMintUsers`);
    } catch (error: any) {
      // If batchMintUsers reverts but we know there are users, query events as fallback
      console.log(`⚠️  batchMintUsers() failed, querying events as fallback...`);
      try {
        const currentBlock = await provider.getBlockNumber();
        const mintEvents = await kashYield.queryFilter(
          kashYield.filters.MintRequested(),
          undefined,
          currentBlock
        );
        // Filter events by batch cycle (batchCycle is not indexed, so we filter manually)
        const filteredEvents = mintEvents.filter((event) => {
          if ('args' in event && event.args) {
            const args = event.args as any;
            return BigInt(args.batchCycle?.toString() || '0') === batchCycle;
          }
          return false;
        });
        mintUsersRaw = [...new Set(filteredEvents.map((e) => {
          if ('args' in e && e.args) {
            return (e.args as any).user;
          }
          return null;
        }).filter((u): u is string => u !== null))];
        console.log(`✅ Found ${mintUsersRaw.length} mint users from events`);
      } catch (eventError: any) {
        console.log(`⚠️  Could not query events: ${eventError.message}`);
        mintUsersRaw = [];
      }
    }
  }

  if (redeemCount > 0) {
    try {
      redeemUsersRaw = await kashYield.batchRedeemUsers(batchCycle) as string[];
      console.log(`✅ Retrieved ${redeemUsersRaw.length} redeem users from batchRedeemUsers`);
    } catch (error: any) {
      // If batchRedeemUsers reverts but we know there are users, query events as fallback
      console.log(`⚠️  batchRedeemUsers() failed, querying events as fallback...`);
      try {
        const currentBlock = await provider.getBlockNumber();
        const redeemEvents = await kashYield.queryFilter(
          kashYield.filters.RedeemRequested(),
          undefined,
          currentBlock
        );
        // Filter events by batch cycle
        const filteredEvents = redeemEvents.filter((event) => {
          if ('args' in event && event.args) {
            const args = event.args as any;
            return BigInt(args.batchCycle?.toString() || '0') === batchCycle;
          }
          return false;
        });
        redeemUsersRaw = [...new Set(filteredEvents.map((e) => {
          if ('args' in e && e.args) {
            return (e.args as any).user;
          }
          return null;
        }).filter((u): u is string => u !== null))];
        console.log(`✅ Found ${redeemUsersRaw.length} redeem users from events`);
      } catch (eventError: any) {
        console.log(`⚠️  Could not query events: ${eventError.message}`);
        redeemUsersRaw = [];
      }
    }
  }

  // Filter out zero addresses (in case of empty slots)
  const mintUsers = (mintUsersRaw || []).filter(
    (addr) => addr && addr !== ethers.ZeroAddress
  );
  const redeemUsers = (redeemUsersRaw || []).filter(
    (addr) => addr && addr !== ethers.ZeroAddress
  );

  // Calculate total mint USD value
  // IMPORTANT: Process ALL events, not just stored requests, because the contract
  // overwrites previous requests when the same user makes multiple requests in the same batch
  let totalMintUSD = 0n;
  const mintRequests: MintRequest[] = [];

  // Query all MintRequested events for this batch cycle to get ALL requests
  // (including multiple requests from the same user)
  try {
    const currentBlock = await provider.getBlockNumber();
    const allMintEvents = await kashYield.queryFilter(
      kashYield.filters.MintRequested(),
      undefined,
      currentBlock
    );
    
    // Filter events by batch cycle
    const batchMintEvents = allMintEvents.filter((event) => {
      if ('args' in event && event.args) {
        const args = event.args as any;
        return BigInt(args.batchCycle?.toString() || '0') === batchCycle;
      }
      return false;
    });

    console.log(`📊 Processing ${batchMintEvents.length} mint event(s) for batch ${batchCycle}`);

    // Process each event (this captures ALL requests, even from the same user)
    for (const event of batchMintEvents) {
      if ('args' in event && event.args) {
        const args = event.args as any;
        const user = args.user as string;
        const tokenIn = args.tokenIn as string;
        const amountIn = BigInt(args.amountIn?.toString() || '0');
        const eventBatchCycle = BigInt(args.batchCycle?.toString() || '0');

        if (user && user !== ethers.ZeroAddress && amountIn > 0n) {
          // Calculate USD value using the contract's getTokenUSD function
          try {
            const usdValue = await kashYield.getTokenUSD(tokenIn, amountIn);
            const usdValueBigInt = BigInt(usdValue.toString());
            totalMintUSD += usdValueBigInt;

            mintRequests.push({
              user,
              tokenIn,
              amountIn,
              amountInUSD: usdValueBigInt,
              batchCycle: eventBatchCycle,
            });

            // Log calculation details for ETH
            if (tokenIn === ethers.ZeroAddress) {
              const ethAmount = ethers.formatEther(amountIn);
              const usdAmount = ethers.formatEther(usdValueBigInt);
              const ethPrice = Number(usdAmount) / Number(ethAmount);
              console.log(`   💰 Mint Request: ${ethAmount} ETH`);
              console.log(`      ETH Price: $${ethPrice.toFixed(2)}`);
              console.log(`      USD Value: $${usdAmount}`);
            }
          } catch (error: any) {
            console.warn(`Failed to get USD value for mint event: ${error.message}`);
            // Continue processing other events
          }
        }
      }
    }
  } catch (error: any) {
    console.warn(`Failed to query mint events, falling back to stored requests: ${error.message}`);
    
    // Fallback to stored requests (old behavior, but may miss multiple requests from same user)
    for (const user of mintUsers) {
      try {
        const request = await kashYield.getPendingMintRequest(user, batchCycle);
        
        if (request.user !== ethers.ZeroAddress && request.amountIn > 0n) {
          mintRequests.push({
            user: request.user,
            tokenIn: request.tokenIn,
            amountIn: request.amountIn,
            amountInUSD: request.amountInUSD,
            batchCycle: request.batchCycle,
          });

          if (request.amountInUSD === 0n) {
            try {
              const usdValue = await kashYield.getTokenUSD(request.tokenIn, request.amountIn);
              const usdValueBigInt = BigInt(usdValue.toString());
              totalMintUSD += usdValueBigInt;
              
              if (request.tokenIn === ethers.ZeroAddress) {
                const ethAmount = ethers.formatEther(request.amountIn);
                const usdAmount = ethers.formatEther(usdValueBigInt);
                const ethPrice = Number(usdAmount) / Number(ethAmount);
                console.log(`   💰 Mint Request: ${ethAmount} ETH`);
                console.log(`      ETH Price: $${ethPrice.toFixed(2)}`);
                console.log(`      USD Value: $${usdAmount}`);
              }
            } catch (error: any) {
              console.warn(`Failed to get USD value for ${request.tokenIn}: ${error.message}`);
            }
          } else {
            totalMintUSD += request.amountInUSD;
            
            if (request.tokenIn === ethers.ZeroAddress) {
              const ethAmount = ethers.formatEther(request.amountIn);
              const usdAmount = ethers.formatEther(request.amountInUSD);
              const ethPrice = Number(usdAmount) / Number(ethAmount);
              console.log(`   💰 Mint Request: ${ethAmount} ETH (already valued)`);
              console.log(`      ETH Price: $${ethPrice.toFixed(2)}`);
              console.log(`      USD Value: $${usdAmount}`);
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to get mint request for user ${user}:`, error);
      }
    }
  }

  // Calculate total redeem USD value
  // Process ALL events to capture multiple requests from the same user
  let totalRedeemUSD = 0n;
  const redeemRequests: RedeemRequest[] = [];

  try {
    const currentBlock = await provider.getBlockNumber();
    const allRedeemEvents = await kashYield.queryFilter(
      kashYield.filters.RedeemRequested(),
      undefined,
      currentBlock
    );
    
    // Filter events by batch cycle
    const batchRedeemEvents = allRedeemEvents.filter((event) => {
      if ('args' in event && event.args) {
        const args = event.args as any;
        return BigInt(args.batchCycle?.toString() || '0') === batchCycle;
      }
      return false;
    });

    console.log(`📊 Processing ${batchRedeemEvents.length} redeem event(s) for batch ${batchCycle}`);

    // Process each event
    for (const event of batchRedeemEvents) {
      if ('args' in event && event.args) {
        const args = event.args as any;
        const user = args.user as string;
        const kashAmount = BigInt(args.kashAmount?.toString() || '0');
        const tokenOut = args.tokenOut as string;
        const eventBatchCycle = BigInt(args.batchCycle?.toString() || '0');

        if (user && user !== ethers.ZeroAddress && kashAmount > 0n) {
          // Calculate USD value using current NAV
          // USD value = (kashAmount * NAV) / 1e18
          const navBigInt = BigInt(currentNAV.toString());
          const divisor = 10n ** 18n;
          const usdValue = (kashAmount * navBigInt) / divisor;
          totalRedeemUSD += usdValue;

          redeemRequests.push({
            user,
            kashAmount,
            tokenOut,
            batchCycle: eventBatchCycle,
          });
        }
      }
    }
  } catch (error: any) {
    console.warn(`Failed to query redeem events, falling back to stored requests: ${error.message}`);
    
    // Fallback to stored requests
    for (const user of redeemUsers) {
      try {
        const request = await kashYield.getPendingRedeemRequest(user, batchCycle);
        
        if (request.user !== ethers.ZeroAddress && request.kashAmount > 0n) {
          redeemRequests.push({
            user: request.user,
            kashAmount: request.kashAmount,
            tokenOut: request.tokenOut,
            batchCycle: request.batchCycle,
          });

          const navBigInt = BigInt(currentNAV.toString());
          const divisor = 10n ** 18n;
          const usdValue = (request.kashAmount * navBigInt) / divisor;
          totalRedeemUSD += usdValue;
        }
      } catch (error) {
        console.warn(`Failed to get redeem request for user ${user}:`, error);
      }
    }
  }

  // Calculate net position
  // Positive = net mints (need to mint Kash tokens)
  // Negative = net redeems (need to redeem/burn Kash tokens)
  const netPositionUSD = totalMintUSD - totalRedeemUSD;

  return {
    netPositionUSD,
    totalMintUSD,
    totalRedeemUSD,
    mintCount: mintRequests.length,
    redeemCount: redeemRequests.length,
    batchCycle,
  };
}

/**
 * Get the batch cycle for yesterday (the cycle to process)
 * @param provider Ethers provider
 * @returns Yesterday's batch cycle
 */
export async function getYesterdayBatchCycle(
  provider: ethers.Provider
): Promise<bigint> {
  if (!config.kashYieldAddress || !ethers.isAddress(config.kashYieldAddress)) {
    throw new Error('Invalid KASH_YIELD_ADDRESS in configuration');
  }

  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  try {
    const currentCycle = await kashYield.getCurrentBatchCycle();
    // Yesterday's cycle is current - 1
    return BigInt(currentCycle.toString()) - 1n;
  } catch (error: any) {
    if (error.code === 'BAD_DATA' || error.value === '0x') {
      throw new Error(
        `Failed to call contract at ${config.kashYieldAddress}. ` +
        `This usually means:\n` +
        `  1. The contract address is incorrect\n` +
        `  2. The contract is not deployed at this address\n` +
        `  3. The contract doesn't have the getCurrentBatchCycle() function\n\n` +
        `Please verify your KASH_YIELD_ADDRESS in .env file.`
      );
    }
    throw error;
  }
}
