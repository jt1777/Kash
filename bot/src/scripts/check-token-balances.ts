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
  console.log(`Aave Pool: ${aavePoolAddress}\n`);

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

  // Check ETH in Aave (MockAaveV3 only supports ETH)
  let aaveEthBalance = 0n;
  try {
    aaveEthBalance = await aavePool.getATokenBalance(ethers.ZeroAddress, config.kashYieldAddress);
    if (aaveEthBalance > 0n) {
      console.log(`📊 Aave ETH: ${ethers.formatEther(aaveEthBalance)} ETH`);
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not check Aave ETH balance: ${error.message}`);
  }

  // Check WETH in Aave (only if not using MockAaveV3)
  try {
    const aaveWethBalance = await aavePool.getATokenBalance(wethAddress, config.kashYieldAddress);
    if (aaveWethBalance > 0n) {
      console.log(`📊 Aave WETH: ${ethers.formatUnits(aaveWethBalance, 18)} WETH`);
    }
  } catch (error: any) {
    // MockAaveV3 doesn't support non-ETH tokens, so we silently skip
    if (!error.message.includes('Mock only supports ETH')) {
      console.log(`   ⚠️  Could not check Aave WETH balance: ${error.message}`);
    }
  }

  // Check WBTC in Aave (only if not using MockAaveV3)
  try {
    const aaveWbtcBalance = await aavePool.getATokenBalance(wbtcAddress, config.kashYieldAddress);
    if (aaveWbtcBalance > 0n) {
      console.log(`📊 Aave WBTC: ${ethers.formatUnits(aaveWbtcBalance, 8)} WBTC`);
    }
  } catch (error: any) {
    // MockAaveV3 doesn't support non-ETH tokens, so we silently skip
    if (!error.message.includes('Mock only supports ETH')) {
      console.log(`   ⚠️  Could not check Aave WBTC balance: ${error.message}`);
    }
  }

  // Check USDT in Aave (only if not using MockAaveV3)
  try {
    const aaveUsdtBalance = await aavePool.getATokenBalance(usdtAddress, config.kashYieldAddress);
    if (aaveUsdtBalance > 0n) {
      console.log(`📊 Aave USDT: ${ethers.formatUnits(aaveUsdtBalance, 6)} USDT`);
    }
  } catch (error: any) {
    // MockAaveV3 doesn't support non-ETH tokens, so we silently skip
    if (!error.message.includes('Mock only supports ETH')) {
      console.log(`   ⚠️  Could not check Aave USDT balance: ${error.message}`);
    }
  }

  // Check USDC in Aave (only if not using MockAaveV3)
  try {
    const aaveUsdcBalance = await aavePool.getATokenBalance(usdcAddress, config.kashYieldAddress);
    if (aaveUsdcBalance > 0n) {
      console.log(`📊 Aave USDC: ${ethers.formatUnits(aaveUsdcBalance, 6)} USDC`);
    }
  } catch (error: any) {
    // MockAaveV3 doesn't support non-ETH tokens, so we silently skip
    if (!error.message.includes('Mock only supports ETH')) {
      console.log(`   ⚠️  Could not check Aave USDC balance: ${error.message}`);
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
