import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Script to withdraw ETH from MockAaveV3
 * This is needed because the contract was using MockAaveV3 before it was updated to real Aave
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

  console.log('🔄 Withdrawing ETH from MockAaveV3');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`Owner: ${wallet.address}\n`);

  // Check if caller is owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Not the owner! Owner is ${owner}, but wallet is ${wallet.address}`);
  }
  console.log('✅ Confirmed as owner\n');

  const mockAaveAddress = '0x1Fbe5029cC02e7bF88AB8d0082272655399379E8';
  const realAaveAddress = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951';
  
  // Check current Aave address
  const currentAaveAddress = await kashYield.aavePoolAddress();
  console.log(`Current Aave Pool Address: ${currentAaveAddress}`);
  
  if (currentAaveAddress.toLowerCase() === mockAaveAddress.toLowerCase()) {
    console.log('   ℹ️  Contract is currently using MockAaveV3\n');
  } else {
    console.log('   ⚠️  Contract is using real Aave, but we need to withdraw from MockAaveV3');
    console.log('   Temporarily switching to MockAaveV3...\n');
    
    // Temporarily switch to MockAaveV3
    const switchTx = await kashYield.setAavePool(mockAaveAddress);
    console.log(`   Transaction sent: ${switchTx.hash}`);
    await switchTx.wait();
    console.log('   ✅ Switched to MockAaveV3\n');
  }

  // Check balances and debt in MockAaveV3
  console.log('📊 Checking balances and debt in MockAaveV3...');
  const mockAaveABI = [
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
      name: "getSuppliedAmount",
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

  const mockAavePool = new ethers.Contract(mockAaveAddress, mockAaveABI, provider);
  
  // Check ETH balance
  let mockEthBalance = 0n;
  try {
    // MockAaveV3 uses address(0) for ETH
    mockEthBalance = await mockAavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
    console.log(`   MockAaveV3 ETH Balance: ${ethers.formatEther(mockEthBalance)} ETH`);
  } catch (error: any) {
    console.log(`   ⚠️  Could not check ETH balance: ${error.message}`);
  }

  // Check USDT debt
  let usdtDebt = 0n;
  try {
    usdtDebt = await mockAavePool.getBorrowedAmount(config.kashYieldAddress);
    console.log(`   MockAaveV3 USDT Debt: ${ethers.formatUnits(usdtDebt, 6)} USDT\n`);
  } catch (error: any) {
    console.log(`   ⚠️  Could not check USDT debt: ${error.message}\n`);
  }

  if (mockEthBalance === 0n && usdtDebt === 0n) {
    console.log('   ℹ️  No ETH or debt in MockAaveV3\n');
    
    // Switch back to real Aave if we switched
    if (currentAaveAddress.toLowerCase() !== mockAaveAddress.toLowerCase()) {
      console.log('   Switching back to real Aave...');
      const switchBackTx = await kashYield.setAavePool(realAaveAddress);
      await switchBackTx.wait();
      console.log('   ✅ Switched back to real Aave\n');
    }
    return;
  }

  // Step 1: Repay USDT debt if any
  if (usdtDebt > 0n) {
    console.log('💰 Step 1: Repaying USDT debt to MockAaveV3...');
    const usdtAddress = await kashYield.usdtAddress();
    
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
    console.log(`   Contract USDT Balance: ${ethers.formatUnits(contractUsdtBalance, 6)} USDT`);
    console.log(`   USDT Debt: ${ethers.formatUnits(usdtDebt, 6)} USDT\n`);
    
    if (contractUsdtBalance < usdtDebt) {
      console.log(`   ⚠️  Warning: Contract has insufficient USDT to repay full debt`);
      console.log(`      Will repay what we have: ${ethers.formatUnits(contractUsdtBalance, 6)} USDT\n`);
    }
    
    const repayAmount = contractUsdtBalance < usdtDebt ? contractUsdtBalance : usdtDebt;
    
    if (repayAmount > 0n) {
      try {
        const repayTx = await kashYield.repayToAave(usdtAddress, repayAmount);
        console.log(`   Transaction sent: ${repayTx.hash}`);
        console.log(`   Waiting for confirmation...`);
        
        const receipt = await repayTx.wait();
        console.log(`   ✅ Repayment confirmed in block ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
        
        // Verify debt is repaid
        const remainingDebt = await mockAavePool.getBorrowedAmount(config.kashYieldAddress);
        if (remainingDebt > 0n) {
          console.log(`   ⚠️  Warning: Still have ${ethers.formatUnits(remainingDebt, 6)} USDT debt`);
          console.log(`      You may need more USDT to fully repay the debt\n`);
        } else {
          console.log(`   ✅ All USDT debt repaid!\n`);
        }
      } catch (error: any) {
        console.error(`   ❌ Error repaying USDT: ${error.message}`);
        if (error.reason) {
          console.error(`   Revert reason: ${error.reason}`);
        }
        throw error;
      }
    } else {
      console.log(`   ⚠️  No USDT available to repay debt. Cannot withdraw ETH with outstanding debt.\n`);
      throw new Error('Cannot withdraw ETH while USDT debt exists and contract has no USDT to repay');
    }
  } else {
    console.log('   ℹ️  No USDT debt to repay\n');
  }

  // Step 2: Withdraw ETH from MockAaveV3 (now that debt is repaid)
  if (mockEthBalance === 0n) {
    console.log('   ℹ️  No ETH in MockAaveV3 to withdraw\n');
    
    // Switch back to real Aave if we switched
    if (currentAaveAddress.toLowerCase() !== mockAaveAddress.toLowerCase()) {
      console.log('   Switching back to real Aave...');
      const switchBackTx = await kashYield.setAavePool(realAaveAddress);
      await switchBackTx.wait();
      console.log('   ✅ Switched back to real Aave\n');
    }
    return;
  }

  console.log('📤 Step 2: Withdrawing ETH from MockAaveV3...');
  console.log(`   Amount: ${ethers.formatEther(mockEthBalance)} ETH`);
  
  try {
    // Use ETH_ADDRESS (address(0)) for MockAaveV3
    const maxUint256 = ethers.MaxUint256;
    const withdrawTx = await kashYield.withdrawFromAave(ethers.ZeroAddress, maxUint256);
    console.log(`   Transaction sent: ${withdrawTx.hash}`);
    console.log(`   Waiting for confirmation...`);
    
    const receipt = await withdrawTx.wait();
    console.log(`   ✅ Withdrawal confirmed in block ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
  } catch (error: any) {
    console.error(`   ❌ Error withdrawing: ${error.message}`);
    if (error.reason) {
      console.error(`   Revert reason: ${error.reason}`);
    }
    
    // Try withdrawing exact amount
    try {
      console.log(`\n   Trying to withdraw exact amount...`);
      const withdrawTx = await kashYield.withdrawFromAave(ethers.ZeroAddress, mockEthBalance);
      console.log(`   Transaction sent: ${withdrawTx.hash}`);
      const receipt = await withdrawTx.wait();
      console.log(`   ✅ Withdrawal confirmed in block ${receipt.blockNumber}\n`);
    } catch (error2: any) {
      console.error(`   ❌ Still failed: ${error2.message}`);
      throw error2;
    }
  }

  // Switch back to real Aave if we switched
  if (currentAaveAddress.toLowerCase() !== mockAaveAddress.toLowerCase()) {
    console.log('🔄 Switching back to real Aave...');
    const switchBackTx = await kashYield.setAavePool(realAaveAddress);
    console.log(`   Transaction sent: ${switchBackTx.hash}`);
    await switchBackTx.wait();
    console.log('   ✅ Switched back to real Aave\n');
  }

  // Verify withdrawal
  console.log('📊 Verifying withdrawal...');
  const finalMockBalance = await mockAavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
  const finalContractBalance = await provider.getBalance(config.kashYieldAddress);
  
  console.log(`   MockAaveV3 ETH: ${ethers.formatEther(finalMockBalance)} ETH`);
  console.log(`   Contract ETH: ${ethers.formatEther(finalContractBalance)} ETH\n`);

  if (finalMockBalance === 0n) {
    console.log('✅ Successfully withdrew all ETH from MockAaveV3!');
  } else {
    console.log(`⚠️  Warning: Still have ${ethers.formatEther(finalMockBalance)} ETH in MockAaveV3`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

