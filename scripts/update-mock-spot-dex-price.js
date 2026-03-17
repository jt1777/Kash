// scripts/update-mock-spot-dex-price.js
// Updates swap rates on a deployed MockSpotDex to match a new asset price.
// Run this every time you change the BTC/ETH price on MockChainlinkPriceFeed,
// so that MockSpotDex swap outputs stay in sync with the oracle.
//
// Usage (BTC product):
//   BTC_PRICE=40000 MOCK_SPOT_DEX_ADDRESS=0x... WBTC_ADDRESS=0x... USDC_ADDRESS=0x... \
//   npx hardhat run scripts/update-mock-spot-dex-price.js --network arbitrumSepolia
//
// Usage (ETH product):
//   ETH_PRICE=2500 MOCK_SPOT_DEX_ADDRESS=0x... USDC_ADDRESS=0x... \
//   npx hardhat run scripts/update-mock-spot-dex-price.js --network arbitrumSepolia
//
// Set both BTC_PRICE and ETH_PRICE to update both in one call.

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
  if (!btcPrice && !ethPrice) {
    throw new Error("Set BTC_PRICE and/or ETH_PRICE in env");
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

  console.log("\nDone. MockSpotDex rates are now in sync with the oracle.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
