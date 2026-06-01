import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';

/**
 * Debug utility to check contract state and diagnose mint issues
 */
export async function debugContract(provider: ethers.Provider) {
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  console.log('\n🔍 Contract Debug Information');
  console.log('═'.repeat(60));

  try {
    // Check if contract is paused
    const paused = await kashYield.paused();
    console.log(`⏸️  Contract Paused: ${paused ? 'YES ❌' : 'NO ✅'}`);
    if (paused) {
      console.log('   ⚠️  Contract is paused - no mints/redeems allowed!');
    }

    // Check time windows
    const currentTime = await provider.getBlock('latest').then(b => b?.timestamp || 0);
    const timeOfDay = currentTime % 86400;
    const userWindowEnd = 23 * 3600 + 45 * 60; // 23:45
    const isUserWindow = timeOfDay < userWindowEnd;
    const isProcessingWindow = timeOfDay >= userWindowEnd && timeOfDay < 86400;

    console.log(`\n⏰ Time Window Status:`);
    console.log(`   Current Time: ${new Date(currentTime * 1000).toISOString()}`);
    console.log(`   Time of Day (seconds): ${timeOfDay}`);
    console.log(`   User Window (00:00 - 23:45): ${isUserWindow ? '✅ OPEN' : '❌ CLOSED'}`);
    console.log(`   Processing Window (23:45 - 00:00): ${isProcessingWindow ? '✅ ACTIVE' : '❌ INACTIVE'}`);

    if (!isUserWindow && !isProcessingWindow) {
      console.log('   ⚠️  You can only mint during user window (before 23:45 UTC)!');
    }

    // Check current NAV
    const nav = await kashYield.getNAV();
    console.log(`\n💰 Current NAV: ${ethers.formatEther(nav)} USD`);

    // Check current batch cycle
    const currentBatchCycle = await kashYield.getCurrentBatchCycle();
    console.log(`\n📅 Current Batch Cycle: ${currentBatchCycle}`);

    // Check contract balance (ETH)
    const contractBalance = await provider.getBalance(config.kashYieldAddress);
    console.log(`\n💵 Contract ETH Balance: ${ethers.formatEther(contractBalance)} ETH`);

    // Check fee
    const feeBps = await kashYield.feeBps();
    console.log(`\n💸 Fee: ${Number(feeBps) / 100}% (${feeBps} bps)`);

    // Check owner
    const owner = await kashYield.owner();
    console.log(`\n👤 Contract Owner: ${owner}`);

    // Check if contract has code
    const code = await provider.getCode(config.kashYieldAddress);
    if (code === '0x') {
      console.log('\n❌ ERROR: No contract code at this address!');
    } else {
      console.log(`\n✅ Contract code verified (${code.length / 2 - 1} bytes)`);
    }

    // Check supported tokens
    console.log(`\n🪙 Supported Tokens:`);
    const tokens = [
      { name: 'ETH', address: '0x0000000000000000000000000000000000000000' },
      { name: 'WETH', address: config.tokens.WETH },
      { name: 'WBTC', address: config.tokens.WBTC },
      { name: 'USDT', address: config.tokens.USDT },
      { name: 'USDC', address: config.tokens.USDC },
    ];

    for (const token of tokens) {
      try {
        const isSupported = await kashYield.isSupportedToken(token.address);
        console.log(`   ${token.name} (${token.address.slice(0, 10)}...): ${isSupported ? '✅' : '❌'}`);
      } catch (error) {
        console.log(`   ${token.name}: ❌ Error checking`);
      }
    }

    // Check recent batch info
    console.log(`\n📊 Recent Batch Info:`);
    try {
      const yesterdayCycle = currentBatchCycle - 1n;
      const batchInfo = await kashYield.getBatchInfo(yesterdayCycle);
      console.log(`   Batch Cycle ${yesterdayCycle}:`);
      console.log(`     Processed: ${batchInfo.processed ? '✅' : '❌'}`);
      console.log(`     Total Mint USD: ${ethers.formatEther(batchInfo.totalMintUSD)}`);
      console.log(`     Total Redeem USD: ${ethers.formatEther(batchInfo.totalRedeemUSD)}`);
      console.log(`     Mint Users: ${batchInfo.mintUsersCount}`);
      console.log(`     Redeem Users: ${batchInfo.redeemUsersCount}`);
    } catch (error) {
      console.log(`   Could not fetch batch info: ${error}`);
    }

    // Check current batch for pending mints
    console.log(`\n📝 Current Batch (${currentBatchCycle}) Pending Requests:`);
    try {
      const currentBatchInfo = await kashYield.getBatchInfo(currentBatchCycle);
      console.log(`   Mint Users: ${currentBatchInfo.mintUsersCount}`);
      console.log(`   Redeem Users: ${currentBatchInfo.redeemUsersCount}`);
      
      if (currentBatchInfo.mintUsersCount > 0n) {
        console.log(`   ⚠️  There are ${currentBatchInfo.mintUsersCount} pending mint requests in current batch`);
      }
    } catch (error) {
      console.log(`   Could not fetch current batch info: ${error}`);
    }

    // Check token addresses configured in contract
    console.log(`\n🔧 Contract Token Addresses:`);
    try {
      // Note: These are public variables, but we need to check if they're set correctly
      console.log(`   ⚠️  Token addresses are hardcoded in constructor`);
      console.log(`   ⚠️  On Sepolia, these mainnet addresses won't work!`);
      console.log(`   💡 ETH (address(0)) should still work for minting`);
    } catch (error) {
      console.log(`   Error: ${error}`);
    }

  } catch (error: any) {
    console.error('\n❌ Error reading contract state:', error.message);
    if (error.code === 'CALL_EXCEPTION') {
      console.error('   This usually means:');
      console.error('   - Contract address is incorrect');
      console.error('   - Contract is not deployed on this network');
      console.error('   - RPC connection issue');
    }
  }

  console.log('\n' + '═'.repeat(60));
}

/**
 * Check if a specific transaction failed and why
 */
export async function debugTransaction(
  provider: ethers.Provider,
  txHash: string
) {
  console.log(`\n🔍 Debugging Transaction: ${txHash}`);
  console.log('═'.repeat(60));

  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    
    if (!receipt) {
      console.log('❌ Transaction not found or still pending');
      return;
    }

    console.log(`\n📋 Transaction Receipt:`);
    console.log(`   Status: ${receipt.status === 1 ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`   Block: ${receipt.blockNumber}`);
    console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);
    console.log(`   From: ${receipt.from}`);
    console.log(`   To: ${receipt.to}`);

    if (receipt.status === 0) {
      console.log(`\n❌ Transaction Failed!`);
      
      // Try to get the revert reason
      const tx = await provider.getTransaction(txHash);
      if (tx) {
        try {
          // Try to simulate the transaction to get revert reason
          await provider.call({
            to: tx.to || undefined,
            data: tx.data,
            from: tx.from,
            value: tx.value,
            gasLimit: tx.gasLimit,
          });
        } catch (error: any) {
          if (error.reason) {
            console.log(`   Revert Reason: ${error.reason}`);
          } else if (error.data) {
            console.log(`   Error Data: ${error.data}`);
          } else {
            console.log(`   Error: ${error.message}`);
          }
        }
      }

      // Check logs for events
      if (receipt.logs.length > 0) {
        console.log(`\n📝 Events Emitted: ${receipt.logs.length}`);
      }
    }

  } catch (error: any) {
    console.error(`\n❌ Error fetching transaction: ${error.message}`);
  }

  console.log('\n' + '═'.repeat(60));
}
