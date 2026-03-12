// scripts/ownerCloseHlShort.js
// Closes the BTC (or ETH) perp short on Hyperliquid.
// Run this as the first step before selling HL spot wBTC and recovering USDC to Aave.
//
// Usage (from repo root):
//   npx hardhat run scripts/ownerCloseHlShort.js --network arbitrumSepolia
//
// Env (root .env):
//   PRIVATE_KEY               - owner wallet
//   KASH_YIELD_BTC_ADDRESS    - KashYieldBtc contract (default)
//   PRODUCT                   - "btc" (default) or "eth"
//   SYMBOL                    - perp symbol to close, e.g. "BTC" or "ETH" (default: BTC for btc product, ETH for eth)

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const product = (process.env.PRODUCT || "btc").toLowerCase();
  const symbol = process.env.SYMBOL || (product === "eth" ? "ETH" : "BTC");

  const kashYieldAddress =
    product === "btc"
      ? process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS
      : process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error(
      "Set KASH_YIELD_BTC_ADDRESS (or KASH_YIELD_ETH_ADDRESS / KASH_YIELD_ADDRESS) in .env."
    );
  }

  const [signer] = await hre.ethers.getSigners();
  const contractName = product === "eth" ? "KashYieldETH" : "KashYieldBtc";
  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);

  const owner = await kashYield.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the contract owner (${owner}).`
    );
  }

  const hlAddress = await kashYield.hyperliquidAddress();
  if (!hlAddress || hlAddress === hre.ethers.ZeroAddress) {
    throw new Error("Hyperliquid address not set on contract.");
  }

  // Check current perp position size via MockHyperliquid
  const hl = await hre.ethers.getContractAt(
    [
      "function getPosition(address user, string symbol) view returns (uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive)",
    ],
    hlAddress
  );

  let size = 0n;
  let collateral = 0n;
  let isActive = false;
  try {
    [size, collateral, , , isActive] = await hl.getPosition(kashYieldAddress, symbol);
  } catch (e) {
    console.error(`Could not read position: ${e.message}`);
  }

  if (!isActive || size === 0n) {
    console.log(`No open ${symbol} short found (isActive=${isActive}, size=${size}). Nothing to close.`);
    return;
  }

  const sizeHuman = hre.ethers.formatEther(size);
  console.log(`Open ${symbol} short: ${sizeHuman} ${symbol}, collateral ${hre.ethers.formatUnits(collateral, 6)} USDC`);
  console.log(`Closing via closeShort("${symbol}")...`);

  const tx = await kashYield["closeShort(string)"](symbol);
  await tx.wait();
  console.log(`Done. ${symbol} short is now closed.`);
  console.log(`Next: sell HL spot wBTC → npx hardhat run scripts/ownerSellHlWbtc.js --network arbitrumSepolia`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
