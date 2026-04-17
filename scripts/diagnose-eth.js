/**
 * Diagnose KashYieldETH state: key addresses and Aave position summary.
 * Usage:
 *   KASH_YIELD_ETH_ADDRESS=0x... npx hardhat run scripts/diagnose-eth.js --network arbitrumOne
 *   KASH_YIELD_ETH_ADDRESS=0x... npx hardhat run scripts/diagnose-eth.js --network arbitrumSepolia
 */
const hre = require("hardhat");

/** Immutable pool in KashYieldETH (Arbitrum One Aave V3 Pool). */
const ARBITRUM_ONE_AAVE_V3_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

async function main() {
  const provider = hre.ethers.provider;
  const raw =
    process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS || "";
  if (!raw || !hre.ethers.isAddress(raw)) {
    throw new Error(
      "Set KASH_YIELD_ETH_ADDRESS (or KASH_YIELD_ADDRESS) to your KashYieldETH contract address."
    );
  }
  const kashYieldAddress = hre.ethers.getAddress(raw);

  const abi = [
    "function aavePoolAddress() view returns (address)",
    "function wethAddress() view returns (address)",
    "function usdcAddress() view returns (address)",
    "function botAddress() view returns (address)",
    "function owner() view returns (address)",
  ];
  const mockAaveAbi = [
    "function wethAddress() view returns (address)",
    "function ethPriceInUsd() view returns (uint256)",
    "function suppliedAmounts(address) view returns (uint256)",
    "function borrowedAmounts(address) view returns (uint256)",
    "function getATokenBalance(address asset, address user) view returns (uint256)",
  ];
  const aaveV3PoolAbi = [
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
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
  const { chainId } = await provider.getNetwork();
  const poolAddr = hre.ethers.getAddress(aavePool);
  const canonicalPool = hre.ethers.getAddress(ARBITRUM_ONE_AAVE_V3_POOL);
  const useRealAaveUi =
    chainId === 42161n && poolAddr === canonicalPool;

  console.log("\n=== KashYieldETH State ===");
  console.log("Address:      ", kashYieldAddress);
  console.log("Owner:        ", owner);
  console.log("Bot:          ", bot);
  console.log("ETH balance:  ", hre.ethers.formatEther(ethBalance), "ETH");
  console.log("aavePool:     ", aavePool);
  console.log("wethAddress:  ", weth);
  console.log("usdcAddress:  ", usdc);
  console.log("chainId:      ", chainId.toString());

  if (aavePool === hre.ethers.ZeroAddress) {
    return;
  }

  if (useRealAaveUi) {
    console.log("\n=== Aave V3 Pool (live — Arbitrum One) ===");
    console.log("Address:      ", aavePool);
    const pool = new hre.ethers.Contract(aavePool, aaveV3PoolAbi, provider);
    try {
      const d = await pool.getUserAccountData(kashYieldAddress);
      const hf = d.healthFactor;
      const hfReadable =
        d.totalDebtBase === 0n ? "∞ (no debt)" : hre.ethers.formatEther(hf);
      console.log(
        "totalCollateralBase (8 dec USD):",
        hre.ethers.formatUnits(d.totalCollateralBase, 8)
      );
      console.log(
        "totalDebtBase (8 dec USD):       ",
        hre.ethers.formatUnits(d.totalDebtBase, 8)
      );
      console.log(
        "availableBorrowsBase (8 dec):    ",
        hre.ethers.formatUnits(d.availableBorrowsBase, 8)
      );
      console.log("ltv (bps):                       ", d.ltv.toString());
      console.log("liquidationThreshold (bps):      ", d.currentLiquidationThreshold.toString());
      console.log("healthFactor (wei-style):        ", hfReadable);
    } catch (e) {
      console.log("Could not read getUserAccountData:", e.shortMessage || e.message);
    }
    return;
  }

  console.log("\n=== MockAaveV3 / test pool (mock ABI) ===");
  console.log("Address:      ", aavePool);
  const aave = new hre.ethers.Contract(aavePool, mockAaveAbi, provider);
  try {
    const aaveWeth = await aave.wethAddress();
    const ethPrice = await aave.ethPriceInUsd();
    const supplied = await aave.suppliedAmounts(kashYieldAddress);
    const borrowed = await aave.borrowedAmounts(kashYieldAddress);
    console.log("wethAddress:  ", aaveWeth);
    console.log("ethPriceInUsd:", hre.ethers.formatUnits(ethPrice, 18), "USD");
    console.log("suppliedAmounts[KashYieldETH]:", hre.ethers.formatEther(supplied), "WETH");
    console.log("borrowedAmounts[KashYieldETH]:", hre.ethers.formatUnits(borrowed, 6), "USDC");

    try {
      const balZero = await aave.getATokenBalance(hre.ethers.ZeroAddress, kashYieldAddress);
      console.log("getATokenBalance(address(0)):  ", hre.ethers.formatEther(balZero), "ETH");
    } catch (e) {
      console.log("getATokenBalance(address(0)):   REVERTED:", e.shortMessage || e.message);
    }

    try {
      const balWeth = await aave.getATokenBalance(weth, kashYieldAddress);
      console.log("getATokenBalance(wethAddr):    ", hre.ethers.formatEther(balWeth), "WETH");
    } catch (e) {
      console.log("getATokenBalance(wethAddr):     REVERTED:", e.shortMessage || e.message);
    }
  } catch (e) {
    console.log("Could not read mock Aave state:", e.shortMessage || e.message);
    console.log(
      "Hint: On Arbitrum One you should see chainId 42161 and the script uses the live Pool API."
    );
  }
}

main().catch(console.error);
