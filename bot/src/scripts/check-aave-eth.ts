import { ethers } from 'ethers';
import { config } from '../config';

/**
 * Script to check which Aave address has ETH and verify where deposits went
 */
async function main() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  
  const mockAaveAddress = '0x1Fbe5029cC02e7bF88AB8d0082272655399379E8';
  const realAaveAddress = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951';
  const contractAddress = config.kashYieldAddress;

  console.log('🔍 Checking Aave Addresses for ETH\n');
  console.log(`Contract: ${contractAddress}\n`);

  // Check ETH balances
  console.log('💰 Checking ETH balances...');
  const mockBalance = await provider.getBalance(mockAaveAddress);
  const realBalance = await provider.getBalance(realAaveAddress);
  
  console.log(`Mock Aave (${mockAaveAddress}):`);
  console.log(`   ETH Balance: ${ethers.formatEther(mockBalance)} ETH\n`);
  
  console.log(`Real Aave (${realAaveAddress}):`);
  console.log(`   ETH Balance: ${ethers.formatEther(realBalance)} ETH\n`);

  // Check WETH balances (since real Aave uses WETH)
  console.log('💰 Checking WETH balances...');
  const wethAddress = '0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9';
  const wethABI = [
    {
      inputs: [{ name: 'account', type: 'address' }],
      name: 'balanceOf',
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  
  const wethContract = new ethers.Contract(wethAddress, wethABI, provider);
  
  try {
    const mockWethBalance = await wethContract.balanceOf(mockAaveAddress);
    console.log(`Mock Aave WETH: ${ethers.formatUnits(mockWethBalance, 18)} WETH`);
  } catch (error: any) {
    console.log(`Mock Aave WETH: Could not check (${error.message})`);
  }
  
  try {
    const realWethBalance = await wethContract.balanceOf(realAaveAddress);
    console.log(`Real Aave WETH: ${ethers.formatUnits(realWethBalance, 18)} WETH\n`);
  } catch (error: any) {
    console.log(`Real Aave WETH: Could not check (${error.message})\n`);
  }

  // Check contract's current Aave address setting
  const kashYieldABI = [
    {
      inputs: [],
      name: 'aavePoolAddress',
      outputs: [{ name: '', type: 'address' }],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  const kashYield = new ethers.Contract(contractAddress, kashYieldABI, provider);
  const contractAaveAddress = await kashYield.aavePoolAddress();
  
  console.log('📋 Contract Configuration:');
  console.log(`   Contract's Aave Pool Address: ${contractAaveAddress}`);
  
  if (contractAaveAddress.toLowerCase() === mockAaveAddress.toLowerCase()) {
    console.log(`   ⚠️  Contract is configured to use MockAaveV3`);
  } else if (contractAaveAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
    console.log(`   ✅ Contract is configured to use real Aave V3`);
  }

  // Check recent transactions from contract to Aave addresses
  console.log('\n🔍 Checking recent transactions from contract...');
  try {
    const currentBlock = await provider.getBlockNumber();
    const startBlock = Math.max(0, currentBlock - 10000); // Check last 10k blocks
    
    console.log(`   Scanning blocks ${startBlock} to ${currentBlock}...`);
    
    let foundTransactions = false;
    
    // Check transactions to mock Aave
    for (let i = currentBlock; i > startBlock && i > currentBlock - 1000; i--) {
      try {
        const block = await provider.getBlock(i, true);
        if (block && block.transactions) {
          for (const txHash of block.transactions) {
            if (typeof txHash === 'string') {
              const tx = await provider.getTransaction(txHash);
              if (tx && tx.from && tx.to) {
                if (tx.from.toLowerCase() === contractAddress.toLowerCase() && 
                    tx.to.toLowerCase() === mockAaveAddress.toLowerCase() && 
                    tx.value > 0n) {
                  console.log(`\n   📤 Found transaction to Mock Aave:`);
                  console.log(`      Block: ${i}`);
                  console.log(`      TX: ${tx.hash}`);
                  console.log(`      Amount: ${ethers.formatEther(tx.value)} ETH`);
                  foundTransactions = true;
                }
                if (tx.from.toLowerCase() === contractAddress.toLowerCase() && 
                    tx.to.toLowerCase() === realAaveAddress.toLowerCase() && 
                    tx.value > 0n) {
                  console.log(`\n   📤 Found transaction to Real Aave:`);
                  console.log(`      Block: ${i}`);
                  console.log(`      TX: ${tx.hash}`);
                  console.log(`      Amount: ${ethers.formatEther(tx.value)} ETH`);
                  foundTransactions = true;
                }
              }
            }
          }
        }
      } catch (error) {
        // Skip blocks that can't be fetched
      }
    }
    
    if (!foundTransactions) {
      console.log(`   ℹ️  No direct ETH transfers found in recent blocks`);
      console.log(`   (ETH is wrapped to WETH before sending to Aave)`);
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check transactions: ${error.message}`);
  }

  // Summary
  console.log('\n📋 Summary:');
  if (mockBalance > 0n) {
    console.log(`   ⚠️  Mock Aave has ${ethers.formatEther(mockBalance)} ETH`);
    console.log(`      This ETH is likely stuck (MockAaveV3 is not the real Aave)`);
  }
  if (realBalance > 0n) {
    console.log(`   ℹ️  Real Aave has ${ethers.formatEther(realBalance)} ETH`);
    console.log(`      This is normal (Aave may hold some ETH for operations)`);
  }
  
  // Check aToken balances using Aave Pool interface
  console.log('\n🔍 Checking aToken balances (actual deposits)...');
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
  
  // Check real Aave
  try {
    const realAavePool = new ethers.Contract(realAaveAddress, aavePoolABI, provider);
    const wethBalance = await realAavePool.getATokenBalance(wethAddress, contractAddress);
    if (wethBalance > 0n) {
      console.log(`   ✅ Real Aave: ${ethers.formatEther(wethBalance)} WETH deposited`);
    } else {
      console.log(`   Real Aave: 0 WETH deposited`);
    }
  } catch (error: any) {
    console.log(`   Real Aave: Could not check (${error.message})`);
  }
  
  // Check mock Aave
  try {
    const mockAavePool = new ethers.Contract(mockAaveAddress, aavePoolABI, provider);
    const mockEthBalance = await mockAavePool.getATokenBalance(ethers.ZeroAddress, contractAddress);
    if (mockEthBalance > 0n) {
      console.log(`   ⚠️  Mock Aave: ${ethers.formatEther(mockEthBalance)} ETH deposited`);
      console.log(`      This ETH is in MockAaveV3 and needs to be withdrawn!`);
    } else {
      console.log(`   Mock Aave: 0 ETH deposited`);
    }
  } catch (error: any) {
    console.log(`   Mock Aave: Could not check (${error.message})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

