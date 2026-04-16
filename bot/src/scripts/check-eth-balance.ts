import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { ProtocolAction, protocolActionName } from '../contracts/protocolActionCodes';
import { getBalancesFromEvents } from '../batch/getContractBalances';

/**
 * Script to check contract ETH balance vs what events say should be there
 */
async function main() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  console.log('🔍 Checking Contract ETH Balance vs Events\n');
  console.log(`Contract: ${config.kashYieldAddress}\n`);

  // Get current batch cycle
  const currentBatchCycle = await kashYield.getCurrentBatchCycle();
  console.log(`Current Batch Cycle: ${currentBatchCycle}\n`);

  // Check actual ETH balance
  const actualBalance = await provider.getBalance(config.kashYieldAddress);
  console.log(`💰 Actual Contract ETH Balance: ${ethers.formatEther(actualBalance)} ETH\n`);

  // Get what events say should be there - check ALL batches with ETH mints
  console.log('📊 Checking events for all batches with ETH deposits...');
  
  // Query all MintRequested events to find all batches
  const currentBlock = await provider.getBlockNumber();
  const allMintEvents = await kashYield.queryFilter(
    kashYield.filters.MintRequested(),
    undefined,
    currentBlock
  );
  
  // Find all unique batch cycles with ETH mints
  const batchCyclesWithETH = new Set<bigint>();
  const ethMintsByBatch = new Map<bigint, bigint>();
  
  for (const event of allMintEvents) {
    if ('args' in event && event.args) {
      const args = event.args as any;
      const batchCycle = BigInt(args.batchCycle?.toString() || '0');
      const tokenIn = args.tokenIn as string;
      const amountIn = BigInt(args.amountIn?.toString() || '0');
      
      if (tokenIn === ethers.ZeroAddress && amountIn > 0n) {
        batchCyclesWithETH.add(batchCycle);
        const current = ethMintsByBatch.get(batchCycle) || 0n;
        ethMintsByBatch.set(batchCycle, current + amountIn);
      }
    }
  }
  
  // Sort batch cycles
  const sortedBatches = Array.from(batchCyclesWithETH).sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  
  let totalExpectedETH = 0n;
  console.log(`\n   Found ${sortedBatches.length} batch cycle(s) with ETH deposits:\n`);
  
  for (const batchCycle of sortedBatches) {
    const ethAmount = ethMintsByBatch.get(batchCycle) || 0n;
    totalExpectedETH += ethAmount;
    console.log(`   Batch ${batchCycle}: ${ethers.formatEther(ethAmount)} ETH`);
  }
  
  console.log(`\n📈 Total Expected ETH from all batches: ${ethers.formatEther(totalExpectedETH)} ETH`);
  
  // Also get detailed info for the most recent batch (for compatibility)
  if (sortedBatches.length > 0) {
    const mostRecentBatch = sortedBatches[sortedBatches.length - 1];
    const tokenBalances = await getBalancesFromEvents(provider, mostRecentBatch);
    for (const balance of tokenBalances) {
      if (balance.token === ethers.ZeroAddress) {
        console.log(`   (Most recent batch ${mostRecentBatch}: ${balance.amountFormatted} ETH)`);
        break;
      }
    }
  }
  
  const expectedETH = totalExpectedETH;

  console.log(`\n📊 Comparison:`);
  console.log(`   Actual Balance: ${ethers.formatEther(actualBalance)} ETH`);
  console.log(`   Expected from Events: ${ethers.formatEther(expectedETH)} ETH`);
  console.log(`   Difference: ${ethers.formatEther(actualBalance - expectedETH)} ETH\n`);

  if (actualBalance < expectedETH) {
    console.log(`⚠️  Contract has LESS ETH than events indicate!`);
    console.log(`   Missing: ${ethers.formatEther(expectedETH - actualBalance)} ETH`);
    console.log(`\n   Possible reasons:`);
    console.log(`   1. Some mint transactions failed/reverted`);
    console.log(`   2. ETH was withdrawn from the contract`);
    console.log(`   3. ETH was already used for something else`);
  } else if (actualBalance > expectedETH) {
    console.log(`ℹ️  Contract has MORE ETH than events indicate`);
    console.log(`   Extra: ${ethers.formatEther(actualBalance - expectedETH)} ETH`);
  } else {
    console.log(`✅ Balance matches events!`);
  }

  // Check all mint events for all batches to see transaction status
  console.log(`\n🔍 Checking individual mint transactions...`);
  const allMintEventsForCheck = await kashYield.queryFilter(
    kashYield.filters.MintRequested(),
    undefined,
    currentBlock
  );

  // Filter for ETH mints only
  const ethMintEvents = allMintEventsForCheck.filter((event) => {
    if ('args' in event && event.args) {
      const args = event.args as any;
      return args.tokenIn === ethers.ZeroAddress || args.tokenIn === '0x0000000000000000000000000000000000000000';
    }
    return false;
  });

  console.log(`   Found ${ethMintEvents.length} ETH MintRequested event(s) across all batches\n`);

  for (let i = 0; i < ethMintEvents.length; i++) {
    const event = ethMintEvents[i];
    if ('args' in event && event.args) {
      const args = event.args as any;
      const amount = ethers.formatEther(args.amountIn?.toString() || '0');
      const txHash = event.transactionHash;
      
      console.log(`   Event ${i + 1}:`);
      console.log(`     User: ${args.user}`);
      console.log(`     Amount: ${amount} ETH`);
      console.log(`     TX Hash: ${txHash}`);
      
      // Check transaction receipt and actual ETH sent
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        const tx = await provider.getTransaction(txHash);
        
        if (receipt) {
          console.log(`     Status: ${receipt.status === 1 ? '✅ Success' : '❌ Failed'}`);
          console.log(`     Block: ${receipt.blockNumber}`);
          
          if (tx) {
            const ethSent = tx.value;
            console.log(`     ETH Sent (msg.value): ${ethers.formatEther(ethSent)} ETH`);
            
            const eventAmount = BigInt(args.amountIn?.toString() || '0');
            if (ethSent.toString() !== eventAmount.toString()) {
              console.log(`     ⚠️  WARNING: Event shows ${amount} ETH but transaction sent ${ethers.formatEther(ethSent)} ETH`);
            } else {
              console.log(`     ✅ Transaction value matches event amount`);
            }
          }
          
          if (receipt.status === 0) {
            console.log(`     ⚠️  Transaction failed - ETH was not sent to contract`);
          }
        }
      } catch (error: any) {
        console.log(`     ⚠️  Could not fetch receipt: ${error.message}`);
      }
      console.log('');
    }
  }

  // Check what the contract's batchMintsByToken mapping says for all batches
  console.log(`\n📋 Checking contract's batchMintsByToken mapping for all batches...`);
  let totalContractRecordedETH = 0n;
  try {
    for (const batchCycle of sortedBatches) {
      const batchMintsByToken = await kashYield.batchMintsByToken(batchCycle, ethers.ZeroAddress);
      if (batchMintsByToken > 0n) {
        totalContractRecordedETH += BigInt(batchMintsByToken.toString());
        console.log(`   Batch ${batchCycle}: ${ethers.formatEther(batchMintsByToken)} ETH`);
      }
    }
    console.log(`   Total recorded in contract: ${ethers.formatEther(totalContractRecordedETH)} ETH`);
    
    if (totalContractRecordedETH !== expectedETH) {
      console.log(`   ⚠️  Contract mapping (${ethers.formatEther(totalContractRecordedETH)}) doesn't match event total (${ethers.formatEther(expectedETH)})`);
    } else {
      console.log(`   ✅ Contract mapping matches event total`);
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not read batchMintsByToken: ${error.message}`);
  }

  // Check for all incoming ETH transactions to the contract
  console.log(`\n🔍 Checking all incoming ETH transactions to contract...`);
  try {
    const currentBlock = await provider.getBlockNumber();
    const startBlock = Math.max(0, currentBlock - 200000); // Check last ~200k blocks
    
    console.log(`   Scanning blocks ${startBlock} to ${currentBlock}...`);
    
    let totalIncomingETH = 0n;
    let incomingTxCount = 0;
    
    // Check recent blocks for transactions TO the contract
    const recentBlocks = Math.min(500, currentBlock - startBlock);
    
    for (let i = currentBlock; i > currentBlock - recentBlocks; i--) {
      try {
        const block = await provider.getBlock(i, true);
        if (block && block.transactions) {
          for (const txHash of block.transactions) {
            if (typeof txHash === 'string') {
              try {
                const tx = await provider.getTransaction(txHash);
                if (tx && tx.to && tx.to.toLowerCase() === config.kashYieldAddress.toLowerCase() && tx.value > 0n) {
                  totalIncomingETH += tx.value;
                  incomingTxCount++;
                  console.log(`   Found incoming ETH: ${ethers.formatEther(tx.value)} ETH in block ${i}`);
                  console.log(`     TX: ${txHash}`);
                  console.log(`     From: ${tx.from}`);
                }
              } catch (e) {
                // Skip if transaction can't be fetched
              }
            }
          }
        }
      } catch (error) {
        // Skip blocks that can't be fetched
      }
    }
    
    if (incomingTxCount > 0) {
      console.log(`\n   📊 Summary:`);
      console.log(`      Total incoming ETH transactions: ${incomingTxCount}`);
      console.log(`      Total incoming ETH: ${ethers.formatEther(totalIncomingETH)} ETH`);
      console.log(`      Expected from mints: ${ethers.formatEther(expectedETH)} ETH`);
      
      if (totalIncomingETH > expectedETH) {
        const extra = totalIncomingETH - expectedETH;
        console.log(`      ⚠️  Found ${ethers.formatEther(extra)} ETH MORE than expected from mints!`);
        console.log(`      This explains the extra 0.01 ETH in the contract.`);
      } else if (totalIncomingETH < expectedETH) {
        const missing = expectedETH - totalIncomingETH;
        console.log(`      ⚠️  Found ${ethers.formatEther(missing)} ETH LESS than expected from mints`);
      } else {
        console.log(`      ✅ Incoming ETH matches expected mints`);
      }
    } else {
      console.log(`   ℹ️  No incoming ETH transactions found in recent blocks`);
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check incoming transactions: ${error.message}`);
  }

  // Check for any outgoing ETH transactions from the contract
  console.log(`\n🔍 Checking for outgoing ETH transactions from contract...`);
  try {
    const currentBlock = await provider.getBlockNumber();
    const startBlock = Math.max(0, currentBlock - 100000); // Check last ~100k blocks
    
    // Check ETH transfers by looking at transaction receipts
    console.log(`   Note: Checking last 500 blocks for outgoing ETH...`);
    
    let outgoingETH = 0n;
    const recentBlocks = Math.min(500, currentBlock - startBlock);
    
    for (let i = currentBlock; i > currentBlock - recentBlocks; i--) {
      try {
        const block = await provider.getBlock(i, true);
        if (block && block.transactions) {
          for (const txHash of block.transactions) {
            if (typeof txHash === 'string') {
              const tx = await provider.getTransaction(txHash);
              if (tx && tx.from && tx.from.toLowerCase() === config.kashYieldAddress.toLowerCase() && tx.value > 0n) {
                outgoingETH += tx.value;
                console.log(`   Found outgoing ETH: ${ethers.formatEther(tx.value)} ETH in block ${i} (tx: ${txHash})`);
              }
            }
          }
        }
      } catch (error) {
        // Skip blocks that can't be fetched
      }
    }
    
    if (outgoingETH > 0n) {
      console.log(`\n   ⚠️  Total outgoing ETH found: ${ethers.formatEther(outgoingETH)} ETH`);
      console.log(`   This could explain the missing ETH!`);
    } else {
      console.log(`   ✅ No outgoing ETH transactions found in recent blocks`);
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check outgoing transactions: ${error.message}`);
  }

  // Check for ProtocolInteraction events (AAVE_DEPOSIT, etc.)
  console.log(`\n🔍 Checking for ProtocolInteraction events (AAVE deposits, etc.)...`);
  let protocolEvents: any[] = [];
  let totalEthDepositedFromEvents = 0n;
  try {
    const currentBlock = await provider.getBlockNumber();
    
    // Get ProtocolInteraction events
    protocolEvents = await kashYield.queryFilter(
      kashYield.filters.ProtocolInteraction(),
      undefined,
      currentBlock
    );

    if (protocolEvents.length > 0) {
      console.log(`   Found ${protocolEvents.length} ProtocolInteraction event(s):\n`);
      
      let totalEthDeposited = 0n;
      for (const event of protocolEvents) {
        if ('args' in event && event.args) {
          const args = event.args as any;
          const actionRaw = args.action ?? args[0];
          const actionCode = Number(actionRaw);
          const asset = args.asset || args[1];
          const amount = args.amount || args[2];
          
          console.log(`   Event:`);
          console.log(`     Action: ${protocolActionName(actionCode)} (${actionCode})`);
          console.log(`     Asset: ${asset}`);
          console.log(`     Amount: ${ethers.formatEther(amount)} (raw: ${amount.toString()})`);
          console.log(`     Block: ${event.blockNumber}`);
          console.log(`     TX: ${event.transactionHash}\n`);
          
          if (actionCode === ProtocolAction.AAVE_DEPOSIT && (asset === ethers.ZeroAddress || asset === '0x0000000000000000000000000000000000000000')) {
            const depositAmount = BigInt(amount.toString());
            totalEthDeposited += depositAmount;
            totalEthDepositedFromEvents += depositAmount;
            console.log(`     ⚠️  This is an ETH deposit to Aave!`);
          }
        }
      }
      
      if (totalEthDeposited > 0n) {
        console.log(`\n   ⚠️  Total ETH deposited to Aave: ${ethers.formatEther(totalEthDeposited)} ETH`);
        console.log(`   This explains where the missing ETH went!`);
        console.log(`   Expected: ${ethers.formatEther(expectedETH)} ETH`);
        console.log(`   Deposited to Aave: ${ethers.formatEther(totalEthDeposited)} ETH`);
        console.log(`   Remaining in contract: ${ethers.formatEther(actualBalance)} ETH`);
        const missing = expectedETH - totalEthDeposited - actualBalance;
        if (missing > 0n) {
          console.log(`   Still missing: ${ethers.formatEther(missing)} ETH`);
        } else {
          console.log(`   ✅ All ETH accounted for!`);
        }
      }
    } else {
      console.log(`   ✅ No ProtocolInteraction events found`);
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check ProtocolInteraction events: ${error.message}`);
  }

  // Check the actual deposit transaction to see how much ETH was sent
  console.log(`\n🔍 Checking actual Aave deposit transaction...`);
  try {
    if (protocolEvents.length > 0) {
      for (const event of protocolEvents) {
        if ('args' in event && event.args) {
          const args = event.args as any;
          const actionCode = Number(args.action ?? args[0]);
          const asset = args.asset || args[1];
          
          if (actionCode === ProtocolAction.AAVE_DEPOSIT && (asset === ethers.ZeroAddress || asset === '0x0000000000000000000000000000000000000000')) {
            const txHash = event.transactionHash;
            console.log(`   Checking deposit transaction: ${txHash}`);
            
            const tx = await provider.getTransaction(txHash);
            const receipt = await provider.getTransactionReceipt(txHash);
            
            if (tx) {
              console.log(`     ETH sent in transaction (msg.value): ${ethers.formatEther(tx.value)} ETH`);
              console.log(`     From: ${tx.from}`);
              console.log(`     To: ${tx.to}`);
              
              // Check contract balance before and after the transaction
              if (receipt) {
                const blockBefore = receipt.blockNumber - 1;
                const blockAfter = receipt.blockNumber;
                
                try {
                  const balanceBefore = await provider.getBalance(config.kashYieldAddress, blockBefore);
                  const balanceAfter = await provider.getBalance(config.kashYieldAddress, blockAfter);
                  console.log(`     Contract balance before: ${ethers.formatEther(balanceBefore)} ETH`);
                  console.log(`     Contract balance after: ${ethers.formatEther(balanceAfter)} ETH`);
                  console.log(`     Change: ${ethers.formatEther(balanceAfter - balanceBefore)} ETH`);
                } catch (e) {
                  // Block might not be available
                }
              }
            }
          }
        }
      }
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check deposit transaction: ${error.message}`);
  }

  // Check actual Aave balance for ETH
  console.log(`\n🔍 Checking actual Aave ETH balance...`);
  try {
    const aavePoolAddress = await kashYield.aavePoolAddress();
    console.log(`   Aave Pool Address: ${aavePoolAddress}`);
    
    // Aave Pool ABI - minimal interface for getATokenBalance
    const aavePoolABI = [
      {
        inputs: [
          { name: "asset", type: "address" },
          { name: "user", type: "address" }
        ],
        name: "getATokenBalance",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ];
    
    const aavePool = new ethers.Contract(aavePoolAddress, aavePoolABI, provider);
    
    // Get WETH address from contract (Aave uses WETH for ETH deposits)
    const wethAddress = await kashYield.wethAddress();
    
    // Check ETH balance in Aave (use WETH address since contract wraps ETH to WETH)
    const aaveEthBalance = await aavePool.getATokenBalance(wethAddress, config.kashYieldAddress);
    const aaveEthBalanceFormatted = ethers.formatEther(aaveEthBalance);
    
    console.log(`   📊 Actual ETH balance in Aave: ${aaveEthBalanceFormatted} ETH`);
    console.log(`   (This is the aToken balance, which includes accrued yield)`);
    
    // Compare with what events say was deposited (already calculated above)
    if (totalEthDepositedFromEvents > 0n) {
      console.log(`\n   📈 Comparison:`);
      console.log(`      Deposited (from events): ${ethers.formatEther(totalEthDepositedFromEvents)} ETH`);
      console.log(`      Current Aave balance: ${aaveEthBalanceFormatted} ETH`);
      
      const difference = aaveEthBalance - totalEthDepositedFromEvents;
      if (difference > 0n) {
        console.log(`      ✅ Balance increased by ${ethers.formatEther(difference)} ETH (accrued yield)`);
      } else if (difference < 0n) {
        console.log(`      ⚠️  Balance decreased by ${ethers.formatEther(-difference)} ETH`);
        console.log(`      This could indicate withdrawals or issues`);
      } else {
        console.log(`      ⚠️  Balance matches exactly (no yield accrued yet or using mock)`);
      }
      
      // Total reconciliation - this is the key check
      const totalAccounted = actualBalance + aaveEthBalance;
      console.log(`\n   💰 Total Reconciliation:`);
      console.log(`      Contract ETH: ${ethers.formatEther(actualBalance)} ETH`);
      console.log(`      Aave ETH: ${aaveEthBalanceFormatted} ETH`);
      console.log(`      Total: ${ethers.formatEther(totalAccounted)} ETH`);
      console.log(`      Expected from mints: ${ethers.formatEther(expectedETH)} ETH`);
      
      const totalDifference = totalAccounted - expectedETH;
      if (totalDifference > 0n) {
        console.log(`      ⚠️  Total is ${ethers.formatEther(totalDifference)} ETH MORE than expected!`);
        console.log(`      This suggests the contract has ETH from another source.`);
        console.log(`      The 0.01 ETH in contract should NOT be there if all 0.031 was deposited.`);
      } else if (totalDifference < 0n) {
        console.log(`      ⚠️  Total is ${ethers.formatEther(-totalDifference)} ETH less than expected`);
      } else {
        console.log(`      ✅ Total matches expected exactly`);
      }
    } else {
      if (aaveEthBalance > 0n) {
        console.log(`   ⚠️  Found ETH in Aave but no deposit events recorded`);
      } else {
        console.log(`   ℹ️  No ETH found in Aave`);
      }
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check Aave balance: ${error.message}`);
    console.log(`   Error details: ${error.stack || 'N/A'}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
