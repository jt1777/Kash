/**
 * Set the spot DEX adapter on KashYieldETH or KashYieldBtc (owner only).
 *
 * Current vault bytecode: setSpotDex() applies immediately (no router whitelist or timelock).
 *
 * Usage (mainnet — UniswapV3Adapter):
 *   KASH_YIELD_ETH_ADDRESS=0x... SPOT_DEX_ADDRESS=0x... \
 *   npx hardhat run scripts/setSpotDex.js --network arbitrumOne
 *
 * BTC product: PRODUCT=btc and KASH_YIELD_BTC_ADDRESS.
 *
 * Env var aliases: SPOT_DEX_ADDRESS | UNISWAP_ADAPTER_ADDRESS | MOCK_SPOT_DEX_ADDRESS
 */
require("dotenv").config();
const hre = require("hardhat");
const { resolveKashYieldProduct } = require("./resolveKashYieldProduct");

async function main() {
  const spotDexAddress =
    process.env.SPOT_DEX_ADDRESS ||
    process.env.UNISWAP_ADAPTER_ADDRESS ||
    process.env.MOCK_SPOT_DEX_ADDRESS;

  const { kashYieldAddress, contractName } = resolveKashYieldProduct(hre.ethers);

  if (!spotDexAddress || !hre.ethers.isAddress(spotDexAddress)) {
    throw new Error("Set SPOT_DEX_ADDRESS (or UNISWAP_ADAPTER_ADDRESS / MOCK_SPOT_DEX_ADDRESS) in .env");
  }

  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress);
  const owner = await kashYield.owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not owner of ${contractName} (owner: ${owner}). ` +
        `Use the owner wallet's PRIVATE_KEY.`,
    );
  }

  console.log(`Calling setSpotDex(${spotDexAddress}) on ${contractName}...`);
  const tx = await kashYield.setSpotDex(spotDexAddress);
  await tx.wait();

  const currentDex = await kashYield.spotDexAddress();
  if (currentDex.toLowerCase() !== spotDexAddress.toLowerCase()) {
    throw new Error(`setSpotDex tx succeeded but spotDexAddress is still ${currentDex}`);
  }
  console.log(`✅ Spot DEX is live on ${contractName}: ${spotDexAddress}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
