// scripts/update-mock-spot-dex-price.js
// Updates swap rates on a deployed MockSpotDex to match a new asset price.
// Also supports funding with ETH and registering on KashYield contracts.
// Run this every time you change the BTC/ETH price on MockChainlinkPriceFeed,
// so that MockSpotDex swap outputs stay in sync with the oracle.
//
// Usage (update rates only):
//   BTC_PRICE=40000 ETH_PRICE=2500 MOCK_SPOT_DEX_ADDRESS=0x... WBTC_ADDRESS=0x... USDC_ADDRESS=0x... \
//   npx hardhat run scripts/update-mock-spot-dex-price.js --network arbitrumSepolia
//
// Optional extras (can combine with rate updates or use standalone):
//   FUND_ETH=0.05                — send ETH to the MockSpotDex for ETH→USDC swaps
//   KASH_YIELD_ETH_ADDRESS=0x... — call setSpotDex on KashYieldETH
//   KASH_YIELD_BTC_ADDRESS=0x... — call setSpotDex on KashYieldBtc

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  const mockAddr  = process.env.MOCK_SPOT_DEX_ADDRESS;
  const usdcAddr  = process.env.USDC_ADDRESS || process.env.MOCK_USDC_ADDRESS;
  const wbtcAddr  = process.env.WBTC_ADDRESS || process.env.MOCK_WBTC;
  const btcPrice  = process.env.BTC_PRICE ? parseInt(process.env.BTC_PRICE) : null;
  const ethPrice  = process.env.ETH_PRICE ? parseInt(process.env.ETH_PRICE) : null;

  if (!mockAddr || !hre.ethers.isAddress(mockAddr)) {
    throw new Error("Set MOCK_SPOT_DEX_ADDRESS in env");
  }
  if (!usdcAddr || !hre.ethers.isAddress(usdcAddr)) {
    throw new Error("Set USDC_ADDRESS (or MOCK_USDC_ADDRESS) in env");
  }
  const fundEth          = process.env.FUND_ETH || "0";
  const kashYieldEthAddr = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  const kashYieldBtcAddr = process.env.KASH_YIELD_BTC_ADDRESS;

  if (!btcPrice && !ethPrice && fundEth === "0" && !kashYieldEthAddr && !kashYieldBtcAddr) {
    throw new Error("Set at least one of: BTC_PRICE, ETH_PRICE, FUND_ETH, KASH_YIELD_ETH_ADDRESS, KASH_YIELD_BTC_ADDRESS");
  }

  console.log("Network:", network);
  console.log("MockSpotDex:", mockAddr);
  console.log("Signer:", signer.address);

  const mock = await hre.ethers.getContractAt("MockSpotDex", mockAddr);

  if (btcPrice) {
    if (!wbtcAddr || !hre.ethers.isAddress(wbtcAddr)) {
      throw new Error("Set WBTC_ADDRESS (or MOCK_WBTC) in env for BTC rate update");
    }
    const tx = await mock.setBtcRates(wbtcAddr, usdcAddr, btcPrice);
    await tx.wait();
    console.log(`✅ BTC rates updated at $${btcPrice.toLocaleString()}`);
    console.log(`   wBTC → USDC: rate = ${btcPrice} * 1e16`);
    console.log(`   USDC → wBTC: rate = 1e20 / ${btcPrice} ≈ ${Math.round(1e20 / btcPrice)}`);
  }

  if (ethPrice) {
    const tx = await mock.setEthRates(usdcAddr, ethPrice);
    await tx.wait();
    console.log(`✅ ETH rates updated at $${ethPrice.toLocaleString()}`);
    console.log(`   ETH  → USDC: rate = ${ethPrice} * 1e6 = ${ethPrice * 1e6}`);
    console.log(`   USDC → ETH:  rate = 1e30 / ${ethPrice}`);
  }

  if (fundEth !== "0") {
    const ethWei = hre.ethers.parseEther(fundEth);
    const tx = await mock.fundEth({ value: ethWei });
    await tx.wait();
    console.log(`✅ Funded with ${fundEth} ETH`);
  }

  if (kashYieldEthAddr && hre.ethers.isAddress(kashYieldEthAddr)) {
    try {
      const kashYieldEth = await hre.ethers.getContractAt("KashYieldETH", kashYieldEthAddr);
      const tx = await kashYieldEth.setSpotDex(mockAddr);
      await tx.wait();
      console.log("✅ setSpotDex on KashYieldETH:", kashYieldEthAddr);
    } catch (e) {
      console.warn("⚠️  setSpotDex on KashYieldETH failed (skipping):", e.message?.split("\n")[0]);
    }
  }

  if (kashYieldBtcAddr && hre.ethers.isAddress(kashYieldBtcAddr)) {
    try {
      const kashYieldBtc = await hre.ethers.getContractAt("KashYieldBtc", kashYieldBtcAddr);
      const tx = await kashYieldBtc.setSpotDex(mockAddr);
      await tx.wait();
      console.log("✅ setSpotDex on KashYieldBtc:", kashYieldBtcAddr);
    } catch (e) {
      console.warn("⚠️  setSpotDex on KashYieldBtc failed (skipping):", e.message?.split("\n")[0]);
    }
  }

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
