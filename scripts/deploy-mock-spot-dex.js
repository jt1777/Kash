// scripts/deploy-mock-spot-dex.js
// Deploys MockSpotDex on Arbitrum Sepolia (or any testnet).
// MockSpotDex simulates token swaps at configurable rates — a stand-in for UniswapV3Adapter
// when no real Uniswap liquidity pools exist for MockWBTC/MockUSDC pairs.
//
// What it does:
//   1. Deploys MockSpotDex
//   2. Sets BTC and/or ETH swap rates (from env vars)
//   3. Optionally funds the mock with USDC, wBTC, and/or ETH
//   4. Optionally registers it on KashYieldBtc and/or KashYieldETH via setSpotDex()
//
// Required env vars (at least one token set must be provided):
//   WBTC_ADDRESS or MOCK_WBTC         — for BTC product rates
//   USDC_ADDRESS or MOCK_USDC_ADDRESS — for both products
//
// Optional env vars:
//   BTC_PRICE                 — BTC price in USD (default: 45000)
//   ETH_PRICE                 — ETH price in USD (default: 3000)
//   FUND_USDC                 — USDC to deposit into the mock (whole tokens, e.g. 500000)
//   FUND_WBTC                 — wBTC to deposit into the mock (whole tokens, e.g. 10)
//   FUND_ETH                  — ETH to deposit as native ETH (e.g. 5)
//   KASH_YIELD_BTC_ADDRESS    — if set, calls setSpotDex on KashYieldBtc
//   KASH_YIELD_ADDRESS        — if set, calls setSpotDex on KashYieldETH
//
// Usage:
//   BTC_PRICE=45000 WBTC_ADDRESS=0x... USDC_ADDRESS=0x... FUND_USDC=500000 FUND_WBTC=10 \
//   KASH_YIELD_BTC_ADDRESS=0x... \
//   npx hardhat run scripts/deploy-mock-spot-dex.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("Deploying MockSpotDex to", network);
  console.log("Deployer:", deployer.address);

  // ── Resolve addresses ──────────────────────────────────────────────────
  const wbtcAddress = process.env.WBTC_ADDRESS   || process.env.MOCK_WBTC;
  const usdcAddress = process.env.USDC_ADDRESS   || process.env.MOCK_USDC_ADDRESS;
  const btcPrice    = parseInt(process.env.BTC_PRICE || "45000");
  const ethPrice    = parseInt(process.env.ETH_PRICE || "3000");

  if (!usdcAddress || !hre.ethers.isAddress(usdcAddress)) {
    throw new Error("Set USDC_ADDRESS (or MOCK_USDC_ADDRESS) in .env");
  }

  // ── Deploy ────────────────────────────────────────────────────────────
  const MockSpotDex = await hre.ethers.getContractFactory("MockSpotDex");
  const mockSpotDex = await MockSpotDex.deploy();
  await mockSpotDex.waitForDeployment();
  const mockSpotDexAddress = await mockSpotDex.getAddress();
  console.log("✅ MockSpotDex:", mockSpotDexAddress);

  // ── Set rates ─────────────────────────────────────────────────────────
  if (wbtcAddress && hre.ethers.isAddress(wbtcAddress)) {
    const tx = await mockSpotDex.setBtcRates(wbtcAddress, usdcAddress, btcPrice);
    await tx.wait();
    // wBTC(8dec) → USDC(6dec): rate = btcPrice * 1e16
    // USDC(6dec) → wBTC(8dec): rate = 1e20 / btcPrice
    console.log(`✅ BTC rates set at $${btcPrice.toLocaleString()}`);
    console.log(`   wBTC → USDC: rate = ${btcPrice} * 1e16`);
    console.log(`   USDC → wBTC: rate = 1e20 / ${btcPrice} ≈ ${Math.round(1e20 / btcPrice)}`);
  }

  // ETH rates (address(0) = native ETH)
  {
    const tx = await mockSpotDex.setEthRates(usdcAddress, ethPrice);
    await tx.wait();
    // ETH(18dec) → USDC(6dec): rate = ethPrice * 1e6
    // USDC(6dec) → ETH(18dec): rate = 1e30 / ethPrice
    console.log(`✅ ETH rates set at $${ethPrice.toLocaleString()}`);
    console.log(`   ETH  → USDC: rate = ${ethPrice} * 1e6 = ${ethPrice * 1e6}`);
    console.log(`   USDC → ETH:  rate = 1e30 / ${ethPrice}`);
  }

  // ── Fund with tokens ──────────────────────────────────────────────────
  const fundUsdc = process.env.FUND_USDC ? parseFloat(process.env.FUND_USDC) : 0;
  const fundWbtc = process.env.FUND_WBTC ? parseFloat(process.env.FUND_WBTC) : 0;
  const fundEth  = process.env.FUND_ETH  ? process.env.FUND_ETH : "0";

  const USDC = await hre.ethers.getContractAt(
    ["function approve(address,uint256) returns(bool)", "function decimals() view returns(uint8)"],
    usdcAddress
  );

  if (fundUsdc > 0) {
    const usdcDecimals = await USDC.decimals();
    const usdcAmount = BigInt(Math.round(fundUsdc * 10 ** Number(usdcDecimals)));
    const approveTx = await USDC.approve(mockSpotDexAddress, usdcAmount);
    await approveTx.wait();
    const fundTx = await mockSpotDex.fund(usdcAddress, usdcAmount);
    await fundTx.wait();
    console.log(`✅ Funded with ${fundUsdc.toLocaleString()} USDC`);
  }

  if (fundWbtc > 0 && wbtcAddress && hre.ethers.isAddress(wbtcAddress)) {
    const WBTC = await hre.ethers.getContractAt(
      ["function approve(address,uint256) returns(bool)", "function decimals() view returns(uint8)"],
      wbtcAddress
    );
    const wbtcDecimals = await WBTC.decimals();
    const wbtcAmount = BigInt(Math.round(fundWbtc * 10 ** Number(wbtcDecimals)));
    const approveTx = await WBTC.approve(mockSpotDexAddress, wbtcAmount);
    await approveTx.wait();
    const fundTx = await mockSpotDex.fund(wbtcAddress, wbtcAmount);
    await fundTx.wait();
    console.log(`✅ Funded with ${fundWbtc} wBTC`);
  }

  if (fundEth !== "0") {
    const ethWei = hre.ethers.parseEther(fundEth);
    const fundTx = await mockSpotDex.fundEth({ value: ethWei });
    await fundTx.wait();
    console.log(`✅ Funded with ${fundEth} ETH`);
  }

  // ── Register on KashYield contracts ───────────────────────────────────
  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const kashYieldEthAddress = process.env.KASH_YIELD_ADDRESS;

  if (kashYieldBtcAddress && hre.ethers.isAddress(kashYieldBtcAddress)) {
    const kashYieldBtc = await hre.ethers.getContractAt("KashYieldBtc", kashYieldBtcAddress);
    const tx = await kashYieldBtc.setSpotDex(mockSpotDexAddress);
    await tx.wait();
    console.log("✅ setSpotDex on KashYieldBtc:", kashYieldBtcAddress);
  }

  if (kashYieldEthAddress && hre.ethers.isAddress(kashYieldEthAddress)) {
    const kashYieldEth = await hre.ethers.getContractAt("KashYieldETH", kashYieldEthAddress);
    const tx = await kashYieldEth.setSpotDex(mockSpotDexAddress);
    await tx.wait();
    console.log("✅ setSpotDex on KashYieldETH:", kashYieldEthAddress);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("\n====================================");
  console.log("📋 MOCK SPOT DEX");
  console.log("====================================");
  console.log("  MockSpotDex:  ", mockSpotDexAddress);
  console.log("  USDC:         ", usdcAddress);
  if (wbtcAddress) console.log("  wBTC:         ", wbtcAddress);
  console.log(`  BTC price:     $${btcPrice.toLocaleString()}`);
  console.log(`  ETH price:     $${ethPrice.toLocaleString()}`);
  console.log("====================================");
  console.log("\nAdd to .env:");
  console.log(`  MOCK_SPOT_DEX_ADDRESS=${mockSpotDexAddress}`);

  if (!kashYieldBtcAddress && !kashYieldEthAddress) {
    console.log("\nTo register on KashYield contracts, re-run with:");
    console.log("  KASH_YIELD_BTC_ADDRESS=0x... and/or KASH_YIELD_ADDRESS=0x...");
    console.log("  Or call setSpotDex(address) directly on each contract.");
  }

  console.log("\n⚠️  IMPORTANT: When you change the BTC/ETH price on the oracle,");
  console.log("   also update MockSpotDex rates to match:");
  console.log(`   BTC_PRICE=<new_price> MOCK_SPOT_DEX_ADDRESS=${mockSpotDexAddress} WBTC_ADDRESS=<wbtc> USDC_ADDRESS=<usdc> \\`);
  console.log("   npx hardhat run scripts/update-mock-spot-dex-price.js --network", network);

  // ── Save deployment ───────────────────────────────────────────────────
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const info = {
    network,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: { mockSpotDex: mockSpotDexAddress },
    config: { usdcAddress, wbtcAddress, btcPrice, ethPrice },
  };
  const filepath = path.join(deploymentsDir, `mock-spot-dex-${network}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log("💾 Saved:", filepath);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
