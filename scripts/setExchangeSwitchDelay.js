/**
 * Set the adapter registration timelock duration on KashYieldETH or KashYieldBtc.
 * Use 0 for testnet/development, 172800 (48 hours) for mainnet.
 *
 * Usage:
 *   KASH_YIELD_ETH_ADDRESS=0x... DELAY_SECONDS=0 \
 *   npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia
 *
 *   BTC: KASH_YIELD_BTC_ADDRESS=0x... DELAY_SECONDS=0 PRODUCT=btc \
 *   npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia
 */
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const productEnv = (process.env.PRODUCT || "").toLowerCase();
  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const kashYieldEthAddress = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  const isBtc =
    productEnv === "btc" ||
    (productEnv !== "eth" && kashYieldBtcAddress && hre.ethers.isAddress(kashYieldBtcAddress) && !kashYieldEthAddress);
  const kashYieldAddress = isBtc ? kashYieldBtcAddress : kashYieldEthAddress;

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error("Set KASH_YIELD_ETH_ADDRESS (ETH) or KASH_YIELD_BTC_ADDRESS (BTC) in .env");
  }

  const delaySeconds = process.env.DELAY_SECONDS !== undefined
    ? BigInt(process.env.DELAY_SECONDS)
    : 0n;

  const abi = [
    "function exchangeSwitchDelay() view returns (uint256)",
    "function setExchangeSwitchDelay(uint256) external",
  ];
  const contract = new hre.ethers.Contract(kashYieldAddress, abi, deployer);

  const before = await contract.exchangeSwitchDelay();
  console.log(`\nContract:        ${kashYieldAddress}`);
  console.log(`Current delay:   ${before.toString()}s (${Number(before) / 3600}h)`);
  console.log(`New delay:       ${delaySeconds.toString()}s (${Number(delaySeconds) / 3600}h)`);

  const tx = await contract.setExchangeSwitchDelay(delaySeconds);
  await tx.wait();
  console.log(`✅ Delay updated!`);
}

main().catch((e) => { console.error(e); process.exit(1); });
