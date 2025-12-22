import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Script to close Aave position:
 * 1. Repay all borrowed USDT to Aave
 * 2. Withdraw all ETH from Aave
 */
async function main() {
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not set in .env');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    wallet
  );

  console.log('🔄 Closing Aave Position');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`Owner: ${wallet.address}\n`);

  // Check if caller is owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Not the owner! Owner is ${owner}, but wallet is ${wallet.address}`);
  }
  console.log('✅ Confirmed as owner\n');

  // Get Aave Pool address and token addresses
  const aavePoolAddress = await kashYield.aavePoolAddress();
  const usdtAddress = await kashYield.usdtAddress();
  console.log(`Aave Pool Address: ${aavePoolAddress}`);
  console.log(`USDT Address: ${usdtAddress}\n`);

  // Step 1: Check USDT debt in Aave
  console.log('📊 Step 1: Checking USDT debt in Aave...');
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
    {
      inputs: [{ name: "user", type: "address" }],
      name: "getBorrowedAmount",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
  ];

  const aavePool = new ethers.Contract(aavePoolAddress, aavePoolABI, provider);
  
  let usdtDebt = 0n;
  try {
    usdtDebt = await aavePool.getBorrowedAmount(config.kashYieldAddress);
    console.log(`   USDT Debt: ${ethers.formatUnits(usdtDebt, 6)} USDT\n`);
  } catch (error: any) {
    // MockAaveV3 might use different function name or not support it
    console.log(`   ⚠️  Could not get debt directly, will try to repay max amount\n`);
  }

  // Check contract USDT balance
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
  console.log(`   Contract USDT Balance: ${ethers.formatUnits(contractUsdtBalance, 6)} USDT\n`);

  // Step 2: Repay USDT debt
  if (usdtDebt > 0n || contractUsdtBalance > 0n) {
    console.log('💰 Step 2: Repaying USDT debt to Aave...');
    
    // Use the debt amount if we got it, otherwise use contract balance (repay all we have)
    const repayAmount = usdtDebt > 0n ? usdtDebt : contractUsdtBalance;
    
    if (repayAmount === 0n) {
      console.log('   ℹ️  No USDT debt to repay\n');
    } else if (contractUsdtBalance < repayAmount) {
      console.log(`   ⚠️  Warning: Contract has insufficient USDT to repay full debt`);
      console.log(`      Debt: ${ethers.formatUnits(usdtDebt, 6)} USDT`);
      console.log(`      Available: ${ethers.formatUnits(contractUsdtBalance, 6)} USDT`);
      console.log(`      Will repay: ${ethers.formatUnits(contractUsdtBalance, 6)} USDT\n`);
      
      // Repay what we have
      if (contractUsdtBalance > 0n) {
        try {
          const repayTx = await kashYield.repayToAave(usdtAddress, contractUsdtBalance);
          console.log(`   Transaction sent: ${repayTx.hash}`);
          console.log(`   Waiting for confirmation...`);
          
          const receipt = await repayTx.wait();
          console.log(`   ✅ Repayment confirmed in block ${receipt.blockNumber}`);
          console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
        } catch (error: any) {
          console.error(`   ❌ Error repaying USDT: ${error.message}`);
          if (error.reason) {
            console.error(`   Revert reason: ${error.reason}`);
          }
          throw error;
        }
      }
    } else {
      console.log(`   Repaying ${ethers.formatUnits(repayAmount, 6)} USDT...`);
      try {
        const repayTx = await kashYield.repayToAave(usdtAddress, repayAmount);
        console.log(`   Transaction sent: ${repayTx.hash}`);
        console.log(`   Waiting for confirmation...`);
        
        const receipt = await repayTx.wait();
        console.log(`   ✅ Repayment confirmed in block ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
      } catch (error: any) {
        console.error(`   ❌ Error repaying USDT: ${error.message}`);
        if (error.reason) {
          console.error(`   Revert reason: ${error.reason}`);
        }
        // Try repaying max amount instead
        console.log(`\n   Trying to repay max amount instead...`);
        try {
          const maxUint256 = ethers.MaxUint256;
          const repayTx = await kashYield.repayToAave(usdtAddress, maxUint256);
          console.log(`   Transaction sent: ${repayTx.hash}`);
          const receipt = await repayTx.wait();
          console.log(`   ✅ Repayment confirmed in block ${receipt.blockNumber}`);
        } catch (error2: any) {
          console.error(`   ❌ Still failed: ${error2.message}`);
          throw error2;
        }
      }
    }
  } else {
    console.log('   ℹ️  No USDT debt to repay\n');
  }

  // Step 3: Check ETH balance in Aave
  console.log('📊 Step 3: Checking ETH balance in Aave...');
  let aaveEthBalance = 0n;
  let aaveSuppliedAmount = 0n;
  try {
    // getATokenBalance includes yield, but we can only withdraw the original supplied amount
    aaveEthBalance = await aavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
    console.log(`   Aave ETH Balance (with yield): ${ethers.formatEther(aaveEthBalance)} ETH`);
    
    // Try to get the actual supplied amount (original deposit without yield)
    try {
      const getSuppliedAmountABI = [
        {
          inputs: [{ name: "user", type: "address" }],
          name: "getSuppliedAmount",
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
          type: "function",
        },
      ];
      const aavePoolWithSupplied = new ethers.Contract(aavePoolAddress, [...aavePoolABI, ...getSuppliedAmountABI], provider);
      aaveSuppliedAmount = await aavePoolWithSupplied.getSuppliedAmount(config.kashYieldAddress);
      console.log(`   Aave ETH Supplied (withdrawable): ${ethers.formatEther(aaveSuppliedAmount)} ETH\n`);
    } catch (error: any) {
      // If getSuppliedAmount doesn't exist, use aToken balance (might work for real Aave)
      console.log(`   ⚠️  Could not get supplied amount, using aToken balance\n`);
      aaveSuppliedAmount = aaveEthBalance;
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check Aave ETH balance: ${error.message}\n`);
  }

  // Step 4: Withdraw all ETH from Aave
  // Use the supplied amount (withdrawable) instead of aToken balance (includes yield)
  const withdrawableAmount = aaveSuppliedAmount > 0n ? aaveSuppliedAmount : aaveEthBalance;
  
  if (withdrawableAmount > 0n) {
    console.log('📤 Step 4: Withdrawing all ETH from Aave...');
    console.log(`   Withdrawable amount: ${ethers.formatEther(withdrawableAmount)} ETH`);
    try {
      // Try withdrawing max amount first (withdraws all)
      const maxUint256 = ethers.MaxUint256;
      const withdrawTx = await kashYield.withdrawFromAave(ethers.ZeroAddress, maxUint256);
      console.log(`   Transaction sent: ${withdrawTx.hash}`);
      console.log(`   Waiting for confirmation...`);
      
      const receipt = await withdrawTx.wait();
      console.log(`   ✅ Withdrawal confirmed in block ${receipt.blockNumber}`);
      console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
    } catch (error: any) {
      console.error(`   ❌ Error withdrawing max amount: ${error.message}`);
      if (error.reason) {
        console.error(`   Revert reason: ${error.reason}`);
      }
      // Try withdrawing the withdrawable amount
      console.log(`\n   Trying to withdraw withdrawable amount (${ethers.formatEther(withdrawableAmount)} ETH)...`);
      try {
        const withdrawTx = await kashYield.withdrawFromAave(ethers.ZeroAddress, withdrawableAmount);
        console.log(`   Transaction sent: ${withdrawTx.hash}`);
        const receipt = await withdrawTx.wait();
        console.log(`   ✅ Withdrawal confirmed in block ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
      } catch (error2: any) {
        console.error(`   ❌ Still failed: ${error2.message}`);
        // Try withdrawing a slightly smaller amount (in case of rounding issues)
        if (withdrawableAmount > 1000n) {
          const slightlyLess = withdrawableAmount - 1000n; // Subtract 1000 wei
          console.log(`\n   Trying to withdraw slightly less (${ethers.formatEther(slightlyLess)} ETH) to account for rounding...`);
          try {
            const withdrawTx = await kashYield.withdrawFromAave(ethers.ZeroAddress, slightlyLess);
            console.log(`   Transaction sent: ${withdrawTx.hash}`);
            const receipt = await withdrawTx.wait();
            console.log(`   ✅ Withdrawal confirmed in block ${receipt.blockNumber}`);
            console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
          } catch (error3: any) {
            console.error(`   ❌ Final attempt failed: ${error3.message}`);
            throw error3;
          }
        } else {
          throw error2;
        }
      }
    }
  } else {
    console.log('   ℹ️  No ETH in Aave to withdraw\n');
  }

  // Final summary
  console.log('📊 Final Balances:');
  const finalContractEth = await provider.getBalance(config.kashYieldAddress);
  const finalContractUsdt = await usdtContract.balanceOf(config.kashYieldAddress);
  
  let finalAaveEth = 0n;
  let finalAaveUsdtDebt = 0n;
  try {
    finalAaveEth = await aavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
    finalAaveUsdtDebt = await aavePool.getBorrowedAmount(config.kashYieldAddress);
  } catch (error: any) {
    // Ignore errors for final check
  }
  
  console.log(`   Contract ETH: ${ethers.formatEther(finalContractEth)} ETH`);
  console.log(`   Contract USDT: ${ethers.formatUnits(finalContractUsdt, 6)} USDT`);
  console.log(`   Aave ETH: ${ethers.formatEther(finalAaveEth)} ETH`);
  console.log(`   Aave USDT Debt: ${ethers.formatUnits(finalAaveUsdtDebt, 6)} USDT\n`);

  if (finalAaveEth === 0n && finalAaveUsdtDebt === 0n) {
    console.log('✅ Successfully closed Aave position!');
  } else {
    if (finalAaveEth > 0n) {
      console.log(`⚠️  Warning: Still have ${ethers.formatEther(finalAaveEth)} ETH in Aave`);
    }
    if (finalAaveUsdtDebt > 0n) {
      console.log(`⚠️  Warning: Still have ${ethers.formatUnits(finalAaveUsdtDebt, 6)} USDT debt in Aave`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
