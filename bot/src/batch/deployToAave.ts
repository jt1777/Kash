import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';
import { getBalancesFromEvents, TokenBalance } from './getContractBalances';

/**
 * Deploy net assets to Aave and borrow USDT
 * 
 * This function:
 * 1. Checks what tokens are actually in the contract (ETH, USDT, USDC, wBTC, wETH)
 * 2. For ETH/wETH: Deposits to Aave
 * 3. For other tokens: Optionally deposits them to Aave or keeps as reserves
 * 4. Borrows USDT equal to 65% of the USD value of deposited collateral
 * 5. This is legacy code but may be useful in the future, do not delete yet.
 * 
 * @param provider Ethers provider
 * @param wallet Wallet with owner private key
 * @param netPositionUSD Net position in USD (18 decimals) - positive means net mints
 * @param batchCycle Batch cycle to check for token deposits
 * @returns Transaction hashes for deposit and borrow operations
 */
export async function deployToAave(
  provider: ethers.Provider,
  wallet: ethers.Wallet,
  netPositionUSD: bigint,
  batchCycle: bigint
): Promise<{ depositTxHashes: string[]; borrowTxHash: string }> {
  if (!config.kashYieldAddress || !ethers.isAddress(config.kashYieldAddress)) {
    throw new Error('Invalid KASH_YIELD_ADDRESS in configuration');
  }

  if (netPositionUSD <= 0n) {
    throw new Error('Net position must be positive (net mints) to deploy to Aave');
  }

  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    wallet
  );

  console.log('🏦 Deploying to Aave');
  console.log('═'.repeat(60));
  console.log(`Net Position USD: ${ethers.formatEther(netPositionUSD)} USD`);
  console.log(`Batch Cycle: ${batchCycle.toString()}\n`);

  // Check if contract is paused
  const isPaused = await kashYield.paused();
  if (isPaused) {
    throw new Error('Contract is paused - cannot deploy to Aave');
  }
  console.log('✅ Contract is not paused');

  // Check Aave pool address
  const aavePoolAddress = await kashYield.aavePoolAddress();
  console.log(`✅ Aave Pool Address: ${aavePoolAddress}\n`);

  // Step 1: Check what tokens are actually in the contract
  console.log('📊 Step 1: Checking contract token balances...');
  const tokenBalances = await getBalancesFromEvents(provider, batchCycle);
  
  if (tokenBalances.length === 0) {
    throw new Error('No token balances found in contract for this batch cycle');
  }

  console.log(`\n   Found ${tokenBalances.length} token type(s) in contract:`);
  let totalDepositedUSD = 0n;
  for (const balance of tokenBalances) {
    console.log(`   - ${balance.symbol}: ${balance.amountFormatted} ($${balance.usdValueFormatted})`);
    totalDepositedUSD += balance.usdValue;
  }
  console.log(`   Total: $${ethers.formatEther(totalDepositedUSD)} USD\n`);

  // Step 2: Determine which tokens to deposit to Aave
  // Strategy: Deposit ETH/wETH/wBTC to Aave (collateral assets)
  // Keep USDT/USDC as reserves (or optionally deposit them too)
  const tokensToDeposit: TokenBalance[] = [];
  const tokensToKeep: TokenBalance[] = [];

  const wethAddress = await kashYield.wethAddress();
  const wbtcAddress = await kashYield.wbtcAddress();
  const usdtTokenAddress = await kashYield.usdtAddress();
  const usdcTokenAddress = await kashYield.usdcAddress();

  for (const balance of tokenBalances) {
    const tokenLower = balance.token.toLowerCase();
    if (
      balance.token === ethers.ZeroAddress || // ETH
      tokenLower === wethAddress.toLowerCase() || // wETH
      tokenLower === wbtcAddress.toLowerCase() // wBTC
    ) {
      tokensToDeposit.push(balance);
    } else if (
      tokenLower === usdtTokenAddress.toLowerCase() ||
      tokenLower === usdcTokenAddress.toLowerCase()
    ) {
      // Keep stablecoins as reserves (or deposit them too if you want)
      tokensToKeep.push(balance);
      console.log(`   ℹ️  Keeping ${balance.symbol} as reserve (not depositing to Aave)`);
    }
  }

  if (tokensToDeposit.length === 0) {
    throw new Error(
      'No collateral tokens (ETH/wETH/wBTC) found to deposit to Aave. ' +
      'Only stablecoins (USDT/USDC) were deposited, which should be kept as reserves.'
    );
  }

  // Step 3: Calculate total collateral USD value
  let totalCollateralUSD = 0n;
  for (const balance of tokensToDeposit) {
    totalCollateralUSD += balance.usdValue;
  }

  console.log(`\n💰 Step 2: Preparing to deposit collateral to Aave...`);
  console.log(`   Total Collateral Value: $${ethers.formatEther(totalCollateralUSD)} USD\n`);

  // Step 4: Check Aave balances and adjust deposit amounts to only deposit what's actually in contract
  console.log(`\n🔍 Step 2.5: Checking Aave balances and contract balances...`);
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
  
  // Adjust deposit amounts based on actual contract balances (not event amounts)
  const adjustedTokensToDeposit: TokenBalance[] = [];
  let adjustedTotalCollateralUSD = 0n;
  
  for (const balance of tokensToDeposit) {
    if (balance.token === ethers.ZeroAddress) {
      // Check ETH balance in contract
      const contractEthBalance = await provider.getBalance(config.kashYieldAddress);
      console.log(`   Contract ETH Balance: ${ethers.formatEther(contractEthBalance)} ETH`);
      
      // Check ETH already in Aave
      // Get WETH address since contract wraps ETH to WETH for Aave
      const wethAddress = await kashYield.wethAddress();
      let aaveEthBalance = 0n;
      try {
        aaveEthBalance = await aavePool.getATokenBalance(wethAddress, config.kashYieldAddress);
        if (aaveEthBalance > 0n) {
          console.log(`   ETH already in Aave: ${ethers.formatEther(aaveEthBalance)} ETH`);
        }
      } catch (error: any) {
        // Error checking Aave balance, continue
      }
      
      // Only deposit what's actually in the contract
      if (contractEthBalance > 0n) {
        const adjustedBalance: TokenBalance = {
          ...balance,
          amount: contractEthBalance,
          amountFormatted: ethers.formatEther(contractEthBalance),
        };
        // Recalculate USD value for adjusted amount
        try {
          const usdValue = await kashYield.getTokenUSD(ethers.ZeroAddress, contractEthBalance);
          adjustedBalance.usdValue = BigInt(usdValue.toString());
          adjustedBalance.usdValueFormatted = ethers.formatEther(adjustedBalance.usdValue);
        } catch (error: any) {
          // Use proportional USD value if getTokenUSD fails
          adjustedBalance.usdValue = (balance.usdValue * contractEthBalance) / balance.amount;
          adjustedBalance.usdValueFormatted = ethers.formatEther(adjustedBalance.usdValue);
        }
        adjustedTokensToDeposit.push(adjustedBalance);
        adjustedTotalCollateralUSD += adjustedBalance.usdValue;
        console.log(`   ✅ Will deposit: ${adjustedBalance.amountFormatted} ETH ($${adjustedBalance.usdValueFormatted})`);
      } else {
        console.log(`   ⚠️  No ETH in contract to deposit (may already be in Aave)`);
      }
    } else {
      // Check ERC20 balance
      const erc20ABI = [
        {
          inputs: [{ name: 'account', type: 'address' }],
          name: 'balanceOf',
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        },
      ];
      const tokenContract = new ethers.Contract(balance.token, erc20ABI, provider);
      const tokenBalance = await tokenContract.balanceOf(config.kashYieldAddress);
      const decimals = balance.symbol === 'WBTC' ? 8 : 18;
      console.log(`   Contract ${balance.symbol} Balance: ${ethers.formatUnits(tokenBalance, decimals)}`);
      
      if (tokenBalance > 0n) {
        const adjustedBalance: TokenBalance = {
          ...balance,
          amount: tokenBalance,
          amountFormatted: ethers.formatUnits(tokenBalance, decimals),
        };
        // Recalculate USD value for adjusted amount
        try {
          const usdValue = await kashYield.getTokenUSD(balance.token, tokenBalance);
          adjustedBalance.usdValue = BigInt(usdValue.toString());
          adjustedBalance.usdValueFormatted = ethers.formatEther(adjustedBalance.usdValue);
        } catch (error: any) {
          // Use proportional USD value if getTokenUSD fails
          adjustedBalance.usdValue = (balance.usdValue * tokenBalance) / balance.amount;
          adjustedBalance.usdValueFormatted = ethers.formatEther(adjustedBalance.usdValue);
        }
        adjustedTokensToDeposit.push(adjustedBalance);
        adjustedTotalCollateralUSD += adjustedBalance.usdValue;
        console.log(`   ✅ Will deposit: ${adjustedBalance.amountFormatted} ${balance.symbol} ($${adjustedBalance.usdValueFormatted})`);
      } else {
        console.log(`   ⚠️  No ${balance.symbol} in contract to deposit`);
      }
    }
  }
  
  if (adjustedTokensToDeposit.length === 0) {
    throw new Error('No tokens available in contract to deposit to Aave. They may already be deposited.');
  }
  
  // Update tokensToDeposit and totalCollateralUSD with adjusted values
  tokensToDeposit.length = 0;
  tokensToDeposit.push(...adjustedTokensToDeposit);
  totalCollateralUSD = adjustedTotalCollateralUSD;
  
  console.log(`\n   ✅ Adjusted total collateral value: $${ethers.formatEther(totalCollateralUSD)} USD\n`);

  // Step 5: Deposit each collateral token to Aave
  const depositTxHashes: string[] = [];
  
  for (const balance of tokensToDeposit) {
    console.log(`📤 Depositing ${balance.amountFormatted} ${balance.symbol} to Aave...`);
    try {
      const depositTx = await kashYield.depositToAave(balance.token, balance.amount);
      console.log(`   Transaction sent: ${depositTx.hash}`);
      console.log(`   Waiting for confirmation...`);
      
      const depositReceipt = await depositTx.wait();
      console.log(`   ✅ Deposit confirmed in block ${depositReceipt.blockNumber}`);
      console.log(`   Gas used: ${depositReceipt.gasUsed.toString()}\n`);
      
      depositTxHashes.push(depositTx.hash);
    } catch (error: any) {
      console.error(`   ❌ Failed to deposit ${balance.symbol}:`, error.message);
      if (error.reason) {
        console.error(`   Revert reason: ${error.reason}`);
      }
      throw error;
    }
  }

  // Step 6: Calculate USDT amount to borrow (65% of collateral USD value)
  const usdtAmountUSD = (totalCollateralUSD * 65n) / 100n; // 65% of collateral value
  console.log(`\n💵 Step 3: Calculating USDT to borrow...`);
  console.log(`   Collateral Value: $${ethers.formatEther(totalCollateralUSD)} USD`);
  console.log(`   Borrow Amount (65%): $${ethers.formatEther(usdtAmountUSD)} USD`);
  
  // USDT has 6 decimals, so convert from 18 decimals
  // Check if amount is large enough to avoid rounding to 0
  if (usdtAmountUSD < 10n ** 12n) {
    console.log(`   ⚠️  Warning: Borrow amount is too small (< $1 USD), skipping borrow`);
    console.log(`   (Amount would round to 0 USDT due to decimal conversion)`);
    return {
      depositTxHashes,
      borrowTxHash: '',
    };
  }
  
  const usdtAmount = usdtAmountUSD / 10n ** 12n; // Divide by 1e12 to convert 18 decimals to 6 decimals
  const usdtAmountFormatted = ethers.formatUnits(usdtAmount, 6);
  console.log(`   USDT Amount: ${usdtAmountFormatted} USDT`);
  
  if (usdtAmount === 0n) {
    console.log(`   ⚠️  Warning: Borrow amount rounded to 0, skipping borrow`);
    return {
      depositTxHashes,
      borrowTxHash: '',
    };
  }

  // Step 7: Borrow USDT from Aave
  console.log(`\n📥 Step 5: Borrowing ${usdtAmountFormatted} USDT from Aave...`);
  console.log(`   USDT Address: ${usdtTokenAddress}`);
  console.log(`   USDT Amount (raw): ${usdtAmount.toString()}`);
  
  // Verify Aave has USDT available (optional check)
  try {
    const aavePoolABI = [
      {
        inputs: [],
        name: "totalBorrowed",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ];
    const aavePool = new ethers.Contract(aavePoolAddress, aavePoolABI, provider);
    const totalBorrowed = await aavePool.totalBorrowed();
    console.log(`   Aave total borrowed: ${ethers.formatUnits(totalBorrowed, 6)} USDT`);
    
    // Check if Aave has enough USDT (optional check)
    const erc20ABI = [
      {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
      },
    ];
    const usdtContract = new ethers.Contract(usdtTokenAddress, erc20ABI, provider);
    const aaveUsdtBalance = await usdtContract.balanceOf(aavePoolAddress);
    console.log(`   Aave USDT balance: ${ethers.formatUnits(aaveUsdtBalance, 6)} USDT`);
    
    if (aaveUsdtBalance < usdtAmount) {
      console.log(`   ⚠️  Warning: Aave has insufficient USDT balance!`);
      console.log(`      Required: ${usdtAmountFormatted} USDT`);
      console.log(`      Available: ${ethers.formatUnits(aaveUsdtBalance, 6)} USDT`);
      console.log(`      This borrow will fail. Please fund Aave with USDT first.`);
    }
  } catch (error: any) {
    // Can't check balance, continue anyway (real Aave should have liquidity)
    console.log(`   ℹ️  Could not verify Aave USDT balance (this is OK for real Aave)`);
  }
  
  try {
    const borrowTx = await kashYield.borrowFromAave(usdtTokenAddress, usdtAmount);
    console.log(`   Transaction sent: ${borrowTx.hash}`);
    console.log(`   Waiting for confirmation...`);
    
    const borrowReceipt = await borrowTx.wait();
    console.log(`   ✅ Borrow confirmed in block ${borrowReceipt.blockNumber}`);
    console.log(`   Gas used: ${borrowReceipt.gasUsed.toString()}`);
    
    // Verify USDT was actually received
    const usdtContract = new ethers.Contract(
      usdtTokenAddress,
      [{ inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }],
      provider
    );
    const contractUsdtBalance = await usdtContract.balanceOf(config.kashYieldAddress);
    console.log(`   Contract USDT balance after borrow: ${ethers.formatUnits(contractUsdtBalance, 6)} USDT`);

    console.log('\n✅ Successfully deployed to Aave!');
    console.log(`   Deposited:`);
    for (const balance of tokensToDeposit) {
      console.log(`     - ${balance.amountFormatted} ${balance.symbol} ($${balance.usdValueFormatted})`);
    }
    console.log(`   Borrowed: ${usdtAmountFormatted} USDT (65% of $${ethers.formatEther(totalCollateralUSD)} USD)`);

    return {
      depositTxHashes,
      borrowTxHash: borrowTx.hash,
    };
  } catch (error: any) {
    console.error('❌ Error borrowing from Aave:', error.message);
    if (error.reason) {
      console.error('   Revert reason:', error.reason);
    }
    if (error.data) {
      console.error('   Error data:', error.data);
    }
    if (error.transaction) {
      console.error('   Transaction:', error.transaction);
    }
    console.error('\n⚠️  Borrow failed, but deposits were successful.');
    console.error('   You can try borrowing manually or check Aave configuration.');
    // Don't throw - deposits succeeded, only borrow failed
    return {
      depositTxHashes,
      borrowTxHash: '',
    };
  }
}
