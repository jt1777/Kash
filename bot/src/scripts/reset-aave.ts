import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Script to reset Aave positions and withdraw all ETH
 * This will:
 * 1. Check current Aave ETH balance
 * 2. Withdraw all ETH from Aave
 * 3. Show final balances
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

  console.log('🔄 Aave Reset Script');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`Owner: ${wallet.address}\n`);

  // Check if caller is owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Not the owner! Owner is ${owner}, but wallet is ${wallet.address}`);
  }
  console.log('✅ Confirmed as owner\n');

  // Get Aave Pool address
  const aavePoolAddress = await kashYield.aavePoolAddress();
  console.log(`Aave Pool Address: ${aavePoolAddress}\n`);

  // Check current contract ETH balance
  const contractEthBalance = await provider.getBalance(config.kashYieldAddress);
  console.log(`💰 Contract ETH Balance: ${ethers.formatEther(contractEthBalance)} ETH\n`);

  // Check Aave ETH balance
  console.log('🔍 Checking Aave ETH balance...');
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
  const aaveEthBalance = await aavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
  const aaveEthBalanceFormatted = ethers.formatEther(aaveEthBalance);
  
  console.log(`   Aave ETH Balance: ${aaveEthBalanceFormatted} ETH\n`);

  if (aaveEthBalance === 0n) {
    console.log('ℹ️  No ETH in Aave to withdraw\n');
  } else {
    console.log(`📤 Withdrawing ${aaveEthBalanceFormatted} ETH from Aave...`);
    try {
      // Withdraw all ETH from Aave (use type(uint256).max to withdraw all)
      const maxUint256 = ethers.MaxUint256;
      const withdrawTx = await kashYield.withdrawFromAave(ethers.ZeroAddress, maxUint256);
      console.log(`   Transaction sent: ${withdrawTx.hash}`);
      console.log(`   Waiting for confirmation...`);
      
      const receipt = await withdrawTx.wait();
      console.log(`   ✅ Withdrawal confirmed in block ${receipt.blockNumber}`);
      console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
    } catch (error: any) {
      console.error(`   ❌ Error withdrawing from Aave: ${error.message}`);
      if (error.reason) {
        console.error(`   Revert reason: ${error.reason}`);
      }
      // Try withdrawing exact amount instead
      console.log(`\n   Trying to withdraw exact amount instead...`);
      try {
        const withdrawTx = await kashYield.withdrawFromAave(ethers.ZeroAddress, aaveEthBalance);
        console.log(`   Transaction sent: ${withdrawTx.hash}`);
        const receipt = await withdrawTx.wait();
        console.log(`   ✅ Withdrawal confirmed in block ${receipt.blockNumber}`);
      } catch (error2: any) {
        console.error(`   ❌ Still failed: ${error2.message}`);
        throw error2;
      }
    }
  }

  // Check final balances
  console.log('📊 Final Balances:');
  const finalContractBalance = await provider.getBalance(config.kashYieldAddress);
  const finalAaveBalance = await aavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
  
  console.log(`   Contract ETH: ${ethers.formatEther(finalContractBalance)} ETH`);
  console.log(`   Aave ETH: ${ethers.formatEther(finalAaveBalance)} ETH`);
  console.log(`   Total: ${ethers.formatEther(finalContractBalance + finalAaveBalance)} ETH\n`);

  if (finalAaveBalance === 0n) {
    console.log('✅ Successfully reset Aave position!');
  } else {
    console.log(`⚠️  Warning: Still have ${ethers.formatEther(finalAaveBalance)} ETH in Aave`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
