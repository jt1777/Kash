/**
 * Diagnose KashYieldETH state: shows all key addresses and Aave balances.
 * Usage:
 *   KASH_YIELD_ADDRESS=0x... npx hardhat run scripts/diagnose-eth.js --network arbitrumSepolia
 */
const hre = require("hardhat");

async function main() {
  const provider = hre.ethers.provider;
  const kashYieldAddress = process.env.KASH_YIELD_ADDRESS || "0x8da4FC6A0EAEC834c88f1543Aeb91e25aFDE4BDF";

  const abi = [
    "function aavePoolAddress() view returns (address)",
    "function wethAddress() view returns (address)",
    "function usdcAddress() view returns (address)",
    "function botAddress() view returns (address)",
    "function owner() view returns (address)",
  ];
  const aaveAbi = [
    "function wethAddress() view returns (address)",
    "function ethPriceInUsd() view returns (uint256)",
    "function suppliedAmounts(address) view returns (uint256)",
    "function borrowedAmounts(address) view returns (uint256)",
    "function getATokenBalance(address asset, address user) view returns (uint256)",
  ];

  const kashYield = new hre.ethers.Contract(kashYieldAddress, abi, provider);

  const [aavePool, weth, usdc, bot, owner] = await Promise.all([
    kashYield.aavePoolAddress(),
    kashYield.wethAddress(),
    kashYield.usdcAddress(),
    kashYield.botAddress(),
    kashYield.owner(),
  ]);

  const ethBalance = await provider.getBalance(kashYieldAddress);

  console.log("\n=== KashYieldETH State ===");
  console.log("Address:      ", kashYieldAddress);
  console.log("Owner:        ", owner);
  console.log("Bot:          ", bot);
  console.log("ETH balance:  ", hre.ethers.formatEther(ethBalance), "ETH");
  console.log("aavePool:     ", aavePool);
  console.log("wethAddress:  ", weth);
  console.log("usdcAddress:  ", usdc);

  if (aavePool !== hre.ethers.ZeroAddress) {
    console.log("\n=== MockAaveV3 State ===");
    console.log("Address:      ", aavePool);
    const aave = new hre.ethers.Contract(aavePool, aaveAbi, provider);
    try {
      const aaveWeth = await aave.wethAddress();
      const ethPrice = await aave.ethPriceInUsd();
      const supplied = await aave.suppliedAmounts(kashYieldAddress);
      const borrowed = await aave.borrowedAmounts(kashYieldAddress);
      console.log("wethAddress:  ", aaveWeth);
      console.log("ethPriceInUsd:", hre.ethers.formatUnits(ethPrice, 18), "USD");
      console.log("suppliedAmounts[KashYieldETH]:", hre.ethers.formatEther(supplied), "WETH");
      console.log("borrowedAmounts[KashYieldETH]:", hre.ethers.formatUnits(borrowed, 6), "USDC");

      // Try getATokenBalance both ways
      try {
        const balZero = await aave.getATokenBalance(hre.ethers.ZeroAddress, kashYieldAddress);
        console.log("getATokenBalance(address(0)):  ", hre.ethers.formatEther(balZero), "ETH");
      } catch (e) { console.log("getATokenBalance(address(0)):   REVERTED:", e.shortMessage || e.message); }

      try {
        const balWeth = await aave.getATokenBalance(weth, kashYieldAddress);
        console.log("getATokenBalance(wethAddr):    ", hre.ethers.formatEther(balWeth), "WETH");
      } catch (e) { console.log("getATokenBalance(wethAddr):     REVERTED:", e.shortMessage || e.message); }

    } catch (e) { console.log("Could not read Aave state:", e.message); }
  }
}

main().catch(console.error);
