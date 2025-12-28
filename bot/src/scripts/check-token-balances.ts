import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Script to check all token balances in the contract (ETH, USDT, USDC, wETH, wBTC)
 */
async function main() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  console.log('🔍 Checking Contract Token Balances\n');
  console.log(`Contract: ${config.kashYieldAddress}\n`);

  // Get token addresses from contract
  const ethAddress = ethers.ZeroAddress;
  const wethAddress = await kashYield.wethAddress();
  const wbtcAddress = await kashYield.wbtcAddress();
  const usdtAddress = await kashYield.usdtAddress();
  const usdcAddress = await kashYield.usdcAddress();

  console.log('Token Addresses:');
  console.log(`  ETH: ${ethAddress}`);
  console.log(`  WETH: ${wethAddress}`);
  console.log(`  WBTC: ${wbtcAddress}`);
  console.log(`  USDT: ${usdtAddress}`);
  console.log(`  USDC: ${usdcAddress}\n`);

  // ERC20 ABI for balanceOf
  const erc20ABI = [
    {
      inputs: [{ name: 'account', type: 'address' }],
      name: 'balanceOf',
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ];

  // Check ETH balance
  const ethBalance = await provider.getBalance(config.kashYieldAddress);
  console.log(`💰 ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);

  // Check WETH balance
  const wethContract = new ethers.Contract(wethAddress, erc20ABI, provider);
  const wethBalance = await wethContract.balanceOf(config.kashYieldAddress);
  console.log(`💰 WETH Balance: ${ethers.formatUnits(wethBalance, 18)} WETH`);

  // Check WBTC balance
  const wbtcContract = new ethers.Contract(wbtcAddress, erc20ABI, provider);
  const wbtcBalance = await wbtcContract.balanceOf(config.kashYieldAddress);
  console.log(`💰 WBTC Balance: ${ethers.formatUnits(wbtcBalance, 8)} WBTC`);

  // Check USDT balance
  const usdtContract = new ethers.Contract(usdtAddress, erc20ABI, provider);
  const usdtBalance = await usdtContract.balanceOf(config.kashYieldAddress);
  console.log(`💰 USDT Balance: ${ethers.formatUnits(usdtBalance, 6)} USDT`);

  // Check USDC balance
  const usdcContract = new ethers.Contract(usdcAddress, erc20ABI, provider);
  const usdcBalance = await usdcContract.balanceOf(config.kashYieldAddress);
  console.log(`💰 USDC Balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);

  // Check Aave balances (if any tokens are deposited)
  console.log(`\n🔍 Checking Aave balances...`);
  const aavePoolAddress = await kashYield.aavePoolAddress();
  const realAaveAddress = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951'; // Arbitrum Sepolia
  const mockAaveAddress = '0x1Fbe5029cC02e7bF88AB8d0082272655399379E8';
  
  console.log(`Aave Pool: ${aavePoolAddress}`);
  if (aavePoolAddress.toLowerCase() === mockAaveAddress.toLowerCase()) {
    console.log(`   ⚠️  WARNING: Contract is using MockAaveV3 address!`);
    console.log(`   Update contract to use real Aave: ${realAaveAddress}`);
    console.log(`   Call: kashYield.setAavePool("${realAaveAddress}")\n`);
  } else if (aavePoolAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
    console.log(`   ✅ Using real Aave V3 Pool\n`);
  } else {
    console.log(`   ⚠️  Unknown Aave Pool address\n`);
  }

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

  // Check ETH in Aave (use WETH address since contract wraps ETH to WETH for real Aave)
  let aaveEthBalance = 0n;
  try {
    // Contract wraps ETH to WETH before depositing to Aave
    aaveEthBalance = await aavePool.getATokenBalance(wethAddress, config.kashYieldAddress);
    if (aaveEthBalance > 0n) {
      console.log(`📊 Aave ETH (as WETH): ${ethers.formatEther(aaveEthBalance)} ETH`);
    } else {
      console.log(`📊 Aave ETH (as WETH): 0 ETH`);
    }
  } catch (error: any) {
    const errorMsg = error.message || error.reason || 'Unknown error';
    if (errorMsg.includes('Mock only supports ETH')) {
      console.log(`   ⚠️  MockAaveV3 detected - only supports ETH, not WETH`);
      // Try with ETH address for mock
      try {
        aaveEthBalance = await aavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
        if (aaveEthBalance > 0n) {
          console.log(`📊 Aave ETH (Mock): ${ethers.formatEther(aaveEthBalance)} ETH`);
        }
      } catch (mockError: any) {
        console.log(`   ⚠️  Could not check Aave ETH balance: ${errorMsg}`);
      }
    } else {
      console.log(`   ⚠️  Could not check Aave ETH balance: ${errorMsg}`);
    }
  }

  // Check WETH in Aave (only for real Aave, mock doesn't support this)
  if (aavePoolAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
    try {
      const aaveWethBalance = await aavePool.getATokenBalance(wethAddress, config.kashYieldAddress);
      if (aaveWethBalance > 0n) {
        console.log(`📊 Aave WETH: ${ethers.formatUnits(aaveWethBalance, 18)} WETH`);
      }
    } catch (error: any) {
      // Silently skip - might not have WETH deposited separately
    }
  }

  // Check WBTC in Aave (only for real Aave)
  if (aavePoolAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
    try {
      const aaveWbtcBalance = await aavePool.getATokenBalance(wbtcAddress, config.kashYieldAddress);
      if (aaveWbtcBalance > 0n) {
        console.log(`📊 Aave WBTC: ${ethers.formatUnits(aaveWbtcBalance, 8)} WBTC`);
      }
    } catch (error: any) {
      // Silently skip - might not have WBTC deposited
    }
  }

  // Check USDT in Aave (only for real Aave, mock doesn't support this)
  if (aavePoolAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
    try {
      const aaveUsdtBalance = await aavePool.getATokenBalance(usdtAddress, config.kashYieldAddress);
      if (aaveUsdtBalance > 0n) {
        console.log(`📊 Aave USDT: ${ethers.formatUnits(aaveUsdtBalance, 6)} USDT`);
      }
    } catch (error: any) {
      // Silently skip - might not have USDT deposited
    }
  }

  // Check USDC in Aave (only for real Aave)
  if (aavePoolAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
    try {
      const aaveUsdcBalance = await aavePool.getATokenBalance(usdcAddress, config.kashYieldAddress);
      if (aaveUsdcBalance > 0n) {
        console.log(`📊 Aave USDC: ${ethers.formatUnits(aaveUsdcBalance, 6)} USDC`);
      }
    } catch (error: any) {
      // Silently skip - might not have USDC deposited
    }
  }

  // Summary
  console.log(`\n📋 Summary:`);
  console.log(`   Contract ETH: ${ethers.formatEther(ethBalance)} ETH`);
  console.log(`   Contract USDT: ${ethers.formatUnits(usdtBalance, 6)} USDT`);
  console.log(`   Contract USDC: ${ethers.formatUnits(usdcBalance, 6)} USDC`);
  if (aaveEthBalance > 0n) {
    console.log(`   Aave ETH: ${ethers.formatEther(aaveEthBalance)} ETH`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
