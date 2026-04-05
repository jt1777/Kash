/**
 * Whitelist (or remove) a spot DEX adapter contract on KashYieldETH / KashYieldBtc.
 * `setSpotDex` only accepts addresses with allowedSpotDexRouters[addr] == true.
 *
 * The constructor pre-whitelists Uniswap SwapRouter02 (0x68b3…), not your deployed
 * UniswapV3Adapter — add each adapter deployment here before setSpotDex.
 *
 * Usage (ETH):
 *   KASH_YIELD_ETH_ADDRESS=0x... ROUTER_ADDRESS=0x... \
 *   npx hardhat run scripts/setAllowedSpotDexRouter.js --network arbitrumOne
 *
 * Usage (BTC):
 *   PRODUCT=btc KASH_YIELD_BTC_ADDRESS=0x... ROUTER_ADDRESS=0x... \
 *   npx hardhat run scripts/setAllowedSpotDexRouter.js --network arbitrumOne
 *
 * To revoke: ALLOWED=false ROUTER_ADDRESS=0x... (same other env vars).
 *
 * Aliases: ROUTER_ADDRESS | SPOT_DEX_ADDRESS | UNISWAP_ADAPTER_ADDRESS
 */
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const productEnv = (process.env.PRODUCT || "").toLowerCase();
  const kashYieldBtcAddress = process.env.KASH_YIELD_BTC_ADDRESS;
  const kashYieldEthAddress = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  const routerAddress =
    process.env.ROUTER_ADDRESS ||
    process.env.SPOT_DEX_ADDRESS ||
    process.env.UNISWAP_ADAPTER_ADDRESS;

  const isBtc =
    productEnv === "btc" ||
    (productEnv !== "eth" &&
      kashYieldBtcAddress &&
      hre.ethers.isAddress(kashYieldBtcAddress) &&
      !kashYieldEthAddress);
  const kashYieldAddress = isBtc ? kashYieldBtcAddress : kashYieldEthAddress;
  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";

  if (!routerAddress || !hre.ethers.isAddress(routerAddress)) {
    throw new Error(
      "Set ROUTER_ADDRESS (or SPOT_DEX_ADDRESS / UNISWAP_ADAPTER_ADDRESS) to the spot adapter contract."
    );
  }
  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error("Set KASH_YIELD_ETH_ADDRESS (ETH) or KASH_YIELD_BTC_ADDRESS (BTC) in .env");
  }

  const allowed = (process.env.ALLOWED || "true").toLowerCase() !== "false";

  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);
  const owner = await kashYield.owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not owner (owner: ${owner}).`);
  }

  console.log("Network:       ", hre.network.name);
  console.log(`${contractName}:`, kashYieldAddress);
  console.log("Adapter:       ", routerAddress);
  console.log("Allowed:       ", allowed);

  const tx = await kashYield.setAllowedSpotDexRouter(routerAddress, allowed);
  console.log("Tx:            ", tx.hash);
  await tx.wait();

  const ok = await kashYield.allowedSpotDexRouters(routerAddress);
  console.log(`✅ allowedSpotDexRouters[adapter] = ${ok}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
