import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Script to deploy ETH to Aave and borrow USDT
 * 
 * Usage:
 *   ETH_AMOUNT=1.5 BORROW_PERCENT=65 ts-node src/scripts/deploy-aave.ts
 * 
 * Or via command line arguments:
 *   ts-node src/scripts/deploy-aave.ts 1.5 65
 * 
 * Environment variables (optional):
 *   ETH_AMOUNT - Amount of ETH to deploy (default: 1.0)
 *   BORROW_PERCENT - Percentage of ETH value to borrow as USDT (default: 65)
 */
async function main() {
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not set in .env - needed to send transactions');
  }

  // Parse command line arguments or use environment variables
  const args = process.argv.slice(2);
  const ethAmountStr = args[0] || process.env.ETH_AMOUNT || '1.0';
  const borrowPercentStr = args[1] || process.env.BORROW_PERCENT || '65';

  const ethAmount = parseFloat(ethAmountStr);
  const borrowPercent = parseFloat(borrowPercentStr);

  if (isNaN(ethAmount) || ethAmount <= 0) {
    throw new Error(`Invalid ETH amount: ${ethAmountStr}. Must be a positive number.`);
  }

  if (isNaN(borrowPercent) || borrowPercent < 0 || borrowPercent > 100) {
    throw new Error(`Invalid borrow percentage: ${borrowPercentStr}. Must be between 0 and 100.`);
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    wallet
  );

  console.log('🚀 Aave Deployment Script');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`From: ${wallet.address}`);
  console.log(`Network: ${config.rpcUrl}\n`);

  // Check if we're the owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`You are not the contract owner! Owner is: ${owner}`);
  }
  console.log('✅ You are the contract owner\n');

  // Check if contract is paused
  const isPaused = await kashYield.paused();
  if (isPaused) {
    throw new Error('Contract is paused - cannot deploy to Aave');
  }
  console.log('✅ Contract is not paused\n');

  // Check Aave pool address
  const aavePoolAddress = await kashYield.aavePoolAddress();
  console.log(`✅ Aave Pool Address: ${aavePoolAddress}\n`);

  // Step 1: Check contract ETH balance
  console.log('📊 Step 1: Checking contract ETH balance...');
  const contractEthBalance = await provider.getBalance(config.kashYieldAddress);
  const ethAmountWei = ethers.parseEther(ethAmountStr);
  
  console.log(`   Contract ETH Balance: ${ethers.formatEther(contractEthBalance)} ETH`);
  console.log(`   Requested ETH Amount: ${ethAmountStr} ETH\n`);

  if (contractEthBalance < ethAmountWei) {
    throw new Error(
      `Insufficient ETH in contract! ` +
      `Required: ${ethAmountStr} ETH, ` +
      `Available: ${ethers.formatEther(contractEthBalance)} ETH`
    );
  }

  // Step 2: Get ETH price in USD
  console.log('💵 Step 2: Getting ETH price...');
  const ethAddress = ethers.ZeroAddress;
  const ethUsdValue = await kashYield.getTokenUSD(ethAddress, ethAmountWei);
  const ethUsdValueFormatted = ethers.formatEther(ethUsdValue);
  console.log(`   ETH Amount: ${ethAmountStr} ETH`);
  console.log(`   ETH Value: $${ethUsdValueFormatted} USD\n`);

  // Step 3: Calculate USDT borrow amount
  console.log('📈 Step 3: Calculating USDT borrow amount...');
  // Convert percentage to basis points (multiply by 100 to get integer, e.g., 65% = 6500 basis points)
  const borrowBps = BigInt(Math.floor(borrowPercent * 100));
  const borrowUsdValue = (ethUsdValue * borrowBps) / 10000n;
  const borrowUsdValueFormatted = ethers.formatEther(borrowUsdValue);
  
  // USDT has 6 decimals, so convert from 18 decimals
  const usdtAmount = borrowUsdValue / 10n ** 12n; // Divide by 1e12 to convert 18 decimals to 6 decimals
  const usdtAmountFormatted = ethers.formatUnits(usdtAmount, 6);
  
  console.log(`   Borrow Percentage: ${borrowPercent}%`);
  console.log(`   Borrow Value: $${borrowUsdValueFormatted} USD`);
  console.log(`   USDT Amount: ${usdtAmountFormatted} USDT\n`);

  if (usdtAmount === 0n) {
    throw new Error('Borrow amount is too small (rounded to 0 USDT)');
  }

  // Step 4: Deposit ETH to Aave
  console.log('📤 Step 4: Depositing ETH to Aave...');
  console.log(`   Amount: ${ethAmountStr} ETH`);
  try {
    const depositTx = await kashYield.depositToAave(ethAddress, ethAmountWei);
    console.log(`   Transaction sent: ${depositTx.hash}`);
    console.log(`   Waiting for confirmation...`);
    
    const depositReceipt = await depositTx.wait();
    console.log(`   ✅ Deposit confirmed in block ${depositReceipt.blockNumber}`);
    console.log(`   Gas used: ${depositReceipt.gasUsed.toString()}`);
    
    // Wait for Aave to update state (typically 1-2 blocks on Arbitrum)
    // Arbitrum block time is ~2 seconds, so wait ~3-4 seconds to be safe
    console.log(`   ⏳ Waiting for Aave state to update (3 seconds)...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log(`   ✅ Ready to check borrow capacity\n`);
  } catch (error: any) {
    console.error(`   ❌ Failed to deposit ETH: ${error.message}`);
    if (error.reason) {
      console.error(`   Revert reason: ${error.reason}`);
    }
    throw error;
  }

  // Step 5: Check available borrow capacity before borrowing
  console.log('📊 Step 5: Checking Aave borrow capacity...');
  const usdtAddress = await kashYield.usdtAddress();
  
  // Aave Pool ABI for getUserAccountData
  const aavePoolABI = [
    {
      inputs: [{ name: 'user', type: 'address' }],
      name: 'getUserAccountData',
      outputs: [
        { name: 'totalCollateralBase', type: 'uint256' },
        { name: 'totalDebtBase', type: 'uint256' },
        { name: 'availableBorrowsBase', type: 'uint256' },
        { name: 'currentLiquidationThreshold', type: 'uint256' },
        { name: 'ltv', type: 'uint256' },
        { name: 'healthFactor', type: 'uint256' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  
  const aavePool = new ethers.Contract(aavePoolAddress, aavePoolABI, provider);
  
  try {
    const accountData = await aavePool.getUserAccountData(config.kashYieldAddress);
    const availableBorrowsBase = accountData[2]; // availableBorrowsBase is in 8 decimals (USD)
    const ltv = accountData[4]; // LTV in basis points (e.g., 8000 = 80%)
    const healthFactor = accountData[5];
    
    // Convert availableBorrowsBase (8 decimals) to USDT (6 decimals)
    // availableBorrowsBase is in USD with 8 decimals, USDT has 6 decimals
    // So we divide by 100 to convert 8 decimals to 6 decimals
    const availableBorrowsUSDT = availableBorrowsBase / 100n;
    const availableBorrowsFormatted = ethers.formatUnits(availableBorrowsUSDT, 6);
    const ltvPercent = Number(ltv) / 100;
    
    console.log(`   LTV: ${ltvPercent}%`);
    console.log(`   Available Borrows: ${availableBorrowsFormatted} USDT`);
    console.log(`   Health Factor: ${ethers.formatUnits(healthFactor, 18)}`);
    console.log(`   Requested Borrow: ${usdtAmountFormatted} USDT\n`);
    
    if (availableBorrowsUSDT < usdtAmount) {
      console.log(`   ⚠️  Warning: Requested borrow (${usdtAmountFormatted} USDT) exceeds available capacity (${availableBorrowsFormatted} USDT)`);
      console.log(`   Available borrow capacity is only ${availableBorrowsFormatted} USDT`);
      console.log(`   This is likely due to Aave's LTV limit (${ltvPercent}%)`);
      console.log(`   Try reducing the borrow percentage or depositing more collateral.\n`);
      
      // Suggest using available capacity instead
      if (availableBorrowsUSDT > 0n) {
        console.log(`   💡 Suggestion: Borrow ${availableBorrowsFormatted} USDT instead (available capacity)`);
        const useAvailable = process.env.FORCE_BORROW !== 'true';
        if (!useAvailable) {
          throw new Error(
            `Cannot borrow ${usdtAmountFormatted} USDT. Available: ${availableBorrowsFormatted} USDT. ` +
            `Set FORCE_BORROW=true to attempt anyway, or reduce borrow percentage.`
          );
        }
      } else {
        throw new Error(
          `No available borrow capacity. This may be because:` +
          `\n  1. Collateral hasn't been fully processed by Aave yet (wait a block)` +
          `\n  2. LTV limit is lower than expected` +
          `\n  3. There's existing debt`
        );
      }
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check borrow capacity: ${error.message}`);
    console.log(`   Proceeding with borrow attempt anyway...\n`);
  }

  // Step 6: Borrow USDT from Aave
  console.log('📥 Step 6: Borrowing USDT from Aave...');
  console.log(`   USDT Address: ${usdtAddress}`);
  console.log(`   USDT Amount: ${usdtAmountFormatted} USDT`);
  
  try {
    const borrowTx = await kashYield.borrowFromAave(usdtAddress, usdtAmount);
    console.log(`   Transaction sent: ${borrowTx.hash}`);
    console.log(`   Waiting for confirmation...`);
    
    const borrowReceipt = await borrowTx.wait();
    console.log(`   ✅ Borrow confirmed in block ${borrowReceipt.blockNumber}`);
    console.log(`   Gas used: ${borrowReceipt.gasUsed.toString()}\n`);

    // Verify USDT was received
    const erc20ABI = [
      {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
      },
    ];
    const usdtContract = new ethers.Contract(usdtAddress, erc20ABI, provider);
    const contractUsdtBalance = await usdtContract.balanceOf(config.kashYieldAddress);
    console.log(`   Contract USDT balance after borrow: ${ethers.formatUnits(contractUsdtBalance, 6)} USDT\n`);
  } catch (error: any) {
    console.error(`   ❌ Failed to borrow USDT: ${error.message}`);
    if (error.reason) {
      console.error(`   Revert reason: ${error.reason}`);
    }
    throw error;
  }

  console.log('✅ Deployment complete!');
  console.log(`   Deposited: ${ethAmountStr} ETH ($${ethUsdValueFormatted} USD)`);
  console.log(`   Borrowed: ${usdtAmountFormatted} USDT (${borrowPercent}% of $${ethUsdValueFormatted} USD)`);
  
  // Final check - show actual borrow capacity after deposit
  try {
    const finalAccountData = await aavePool.getUserAccountData(config.kashYieldAddress);
    const finalAvailableBorrows = finalAccountData[2] / 100n;
    console.log(`   Remaining Borrow Capacity: ${ethers.formatUnits(finalAvailableBorrows, 6)} USDT`);
  } catch (error) {
    // Ignore errors in final check
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
