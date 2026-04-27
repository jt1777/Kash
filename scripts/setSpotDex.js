/**
 * Propose and (if eligible) confirm a spot DEX adapter on KashYieldETH or KashYieldBtc.
 *
 * Behaviour:
 *   - First-ever call:  setSpotDex() is immediate — no timelock. This script detects that
 *                       case and prints confirmation that it is already live.
 *   - Subsequent calls: setSpotDex() starts a spotDexTimelock countdown (default 24 h).
 *                       Run this script again after the timelock to call confirmSpotDex().
 *
 * The adapter address must be on the contract's allowedSpotDexRouters whitelist.
 * UniswapV3Adapter is whitelisted by default. Add others via setAllowedSpotDexRouter().
 *
 * Usage (mainnet — UniswapV3Adapter):
 *   KASH_YIELD_ETH_ADDRESS=0x... SPOT_DEX_ADDRESS=0x... \
 *   npx hardhat run scripts/setSpotDex.js --network arbitrumOne
 *
 * Usage (testnet):
 *   KASH_YIELD_ETH_ADDRESS=0x... SPOT_DEX_ADDRESS=0x... \
 *   npx hardhat run scripts/setSpotDex.js --network arbitrumSepolia
 *
 * BTC product: add PRODUCT=btc and use KASH_YIELD_BTC_ADDRESS instead.
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

  const [signer]   = await hre.ethers.getSigners();
  const kashYield  = await hre.ethers.getContractAt(contractName, kashYieldAddress);
  const owner      = await kashYield.owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not owner of ${contractName} (owner: ${owner}). ` +
      `Use the owner wallet's PRIVATE_KEY.`
    );
  }

  // Check whitelist
  const isWhitelisted = await kashYield.allowedSpotDexRouters(spotDexAddress);
  if (!isWhitelisted) {
    throw new Error(
      `${spotDexAddress} is not on the allowedSpotDexRouters whitelist.\n` +
      `Add it first (owner key), e.g.:\n` +
      `  KASH_YIELD_ETH_ADDRESS=${kashYieldAddress} ROUTER_ADDRESS=${spotDexAddress} \\\n` +
      `  npx hardhat run scripts/setAllowedSpotDexRouter.js --network ${hre.network.name}`
    );
  }

  // Check if there is a pending proposal for this address
  const pendingAt = await kashYield.spotDexPending(spotDexAddress);
  const now       = BigInt(Math.floor(Date.now() / 1000));

  if (pendingAt > 0n) {
    // A proposal already exists — check if the timelock has expired
    if (now < pendingAt) {
      const readyDate = new Date(Number(pendingAt) * 1000).toUTCString();
      console.log(`⏳ Timelock not yet expired for ${spotDexAddress}.`);
      console.log(`   Ready at: ${readyDate}`);
      console.log(`   Re-run this script after that time to call confirmSpotDex().`);
      return;
    }

    // Timelock expired — confirm
    console.log(`Timelock expired. Calling confirmSpotDex(${spotDexAddress})...`);
    const tx = await kashYield.confirmSpotDex(spotDexAddress);
    await tx.wait();
    console.log(`✅ confirmSpotDex() — ${contractName} spot DEX is now live: ${spotDexAddress}`);
    return;
  }

  // No pending proposal — call setSpotDex (may be immediate if first-ever)
  console.log(`Calling setSpotDex(${spotDexAddress}) on ${contractName}...`);
  const tx = await kashYield.setSpotDex(spotDexAddress);
  await tx.wait();

  // Check if it was applied immediately (first-ever, no timelock)
  const currentDex = await kashYield.spotDexAddress();
  if (currentDex.toLowerCase() === spotDexAddress.toLowerCase()) {
    console.log(`✅ setSpotDex() — immediate (first-time bypass). Spot DEX is live: ${spotDexAddress}`);
  } else {
    const newPendingAt = await kashYield.spotDexPending(spotDexAddress);
    const readyDate    = new Date(Number(newPendingAt) * 1000).toUTCString();
    console.log(`✅ setSpotDex() — timelock started.`);
    console.log(`   Adapter: ${spotDexAddress}`);
    console.log(`   Ready at: ${readyDate}`);
    console.log(`   Re-run this script after that time to call confirmSpotDex().`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
