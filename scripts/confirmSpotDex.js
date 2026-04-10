/**
 * confirmSpotDex — Confirm a previously proposed spot DEX adapter after the 48-hour timelock.
 *
 * Run this script 48 hours after setSpotDex was called (via deploy-uniswap-adapter.js or
 * setSpotDex.js). Once confirmed, the new adapter becomes the active spot DEX immediately.
 *
 * Usage:
 *   KASH_YIELD_ETH_ADDRESS=0x... SPOT_DEX_ADDRESS=0x... \
 *     npx hardhat run scripts/confirmSpotDex.js --network arbitrumOne
 *
 *   PRODUCT=btc KASH_YIELD_BTC_ADDRESS=0x... SPOT_DEX_ADDRESS=0x... \
 *     npx hardhat run scripts/confirmSpotDex.js --network arbitrumOne
 *
 * Aliases for SPOT_DEX_ADDRESS: ROUTER_ADDRESS | UNISWAP_ADAPTER_ADDRESS
 */
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const productEnv = (process.env.PRODUCT || "").toLowerCase();
  const kashYieldEthAddr = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  const kashYieldBtcAddr = process.env.KASH_YIELD_BTC_ADDRESS;
  const adapterAddress =
    process.env.SPOT_DEX_ADDRESS ||
    process.env.ROUTER_ADDRESS ||
    process.env.UNISWAP_ADAPTER_ADDRESS;

  const isBtc =
    productEnv === "btc" ||
    (productEnv !== "eth" && kashYieldBtcAddr && hre.ethers.isAddress(kashYieldBtcAddr) && !kashYieldEthAddr);

  const kashYieldAddress = isBtc ? kashYieldBtcAddr : kashYieldEthAddr;
  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";

  if (!adapterAddress || !hre.ethers.isAddress(adapterAddress)) {
    throw new Error("Set SPOT_DEX_ADDRESS (or ROUTER_ADDRESS / UNISWAP_ADAPTER_ADDRESS) to the adapter to confirm.");
  }
  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error("Set KASH_YIELD_ETH_ADDRESS (ETH) or KASH_YIELD_BTC_ADDRESS (BTC) in .env");
  }

  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);
  const owner = await kashYield.owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not owner (owner: ${owner}).`);
  }

  console.log("Network:       ", hre.network.name);
  console.log(`${contractName}:`, kashYieldAddress);
  console.log("Adapter:       ", adapterAddress);

  const readyAt = await kashYield.spotDexPending(adapterAddress);
  if (readyAt === 0n) {
    throw new Error("No pending proposal found for this adapter. Run setSpotDex first.");
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < readyAt) {
    const secondsLeft = Number(readyAt - now);
    const hoursLeft = (secondsLeft / 3600).toFixed(2);
    throw new Error(
      `Timelock not expired. ${hoursLeft} hours remaining (ready at ${new Date(Number(readyAt) * 1000).toISOString()}).`
    );
  }

  const tx = await kashYield.confirmSpotDex(adapterAddress);
  console.log("Tx:            ", tx.hash);
  await tx.wait();

  const active = await kashYield.spotDexAddress();
  console.log(`✅ spotDexAddress is now: ${active}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
