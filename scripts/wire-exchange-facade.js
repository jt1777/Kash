/**
 * Wire ExchangeFacade to KashYield vault + HyperliquidAdapter (owner key).
 *
 * Runs after deploy-exchange-facade.js and deploy-hyperliquid-adapter.js:
 *   1. vault.setExchangeFacade(facade)
 *   2. facade.setHyperliquid(hlAdapter)
 *   3. facade.setActivePerpExchange("HL")
 *   4. hlAdapter.setAuthorizedCaller(facade)
 *
 * Usage (BTC):
 *   PRODUCT=btc \
 *   KASH_YIELD_BTC_ADDRESS=0x... \
 *   EXCHANGE_FACADE_BTC=0x... \
 *   HL_ADAPTER_ADDRESS_BTC=0x... \
 *   npx hardhat run scripts/wire-exchange-facade.js --network arbitrumOne
 *
 * Usage (ETH):
 *   PRODUCT=eth \
 *   KASH_YIELD_ETH_ADDRESS=0x... \
 *   EXCHANGE_FACADE_ETH=0x... \
 *   HL_ADAPTER_ADDRESS_ETH=0x... \
 *   npx hardhat run scripts/wire-exchange-facade.js --network arbitrumOne
 *
 * Aliases: EXCHANGE_FACADE_ADDRESS, HL_ADAPTER_ADDRESS, KASH_YIELD_ADDRESS
 */
require("dotenv").config();

const hre = require("hardhat");
const { ethers } = hre;
const { resolveKashYieldProduct } = require("./resolveKashYieldProduct");

function resolveFacadeAddress(isBtc) {
  const addr =
    process.env.EXCHANGE_FACADE_ADDRESS ||
    (isBtc ? process.env.EXCHANGE_FACADE_BTC : process.env.EXCHANGE_FACADE_ETH);
  if (!addr || !ethers.isAddress(addr)) {
    throw new Error(
      isBtc
        ? "Set EXCHANGE_FACADE_BTC or EXCHANGE_FACADE_ADDRESS"
        : "Set EXCHANGE_FACADE_ETH or EXCHANGE_FACADE_ADDRESS",
    );
  }
  return addr;
}

function resolveHlAdapterAddress(isBtc) {
  const addr =
    process.env.HL_ADAPTER_ADDRESS ||
    (isBtc ? process.env.HL_ADAPTER_ADDRESS_BTC : process.env.HL_ADAPTER_ADDRESS_ETH);
  if (!addr || !ethers.isAddress(addr)) {
    throw new Error(
      isBtc
        ? "Set HL_ADAPTER_ADDRESS_BTC or HL_ADAPTER_ADDRESS"
        : "Set HL_ADAPTER_ADDRESS_ETH or HL_ADAPTER_ADDRESS",
    );
  }
  return addr;
}

async function runStep(label, fn) {
  console.log(`\n→ ${label}...`);
  const receipt = await fn();
  if (receipt && receipt.status !== 1 && receipt.status !== 1n) {
    throw new Error(`${label} failed (receipt.status=${receipt.status})`);
  }
  console.log(`  ✅ ${label}${receipt?.hash ? ` — tx ${receipt.hash}` : ""}`);
}

async function main() {
  const { isBtc, kashYieldAddress, contractName } = resolveKashYieldProduct(ethers);
  const facadeAddress = resolveFacadeAddress(isBtc);
  const hlAdapterAddress = resolveHlAdapterAddress(isBtc);
  const productLabel = isBtc ? "BTC" : "ETH";

  const [signer] = await ethers.getSigners();
  const vault = await ethers.getContractAt(contractName, kashYieldAddress, signer);
  const facade = await ethers.getContractAt("ExchangeFacade", facadeAddress, signer);
  const hlAdapter = await ethers.getContractAt("HyperliquidAdapter", hlAdapterAddress, signer);

  const vaultOwner = await vault.owner();
  const facadeOwner = await facade.owner();
  const adapterOwner = await hlAdapter.owner();
  if (
    signer.address.toLowerCase() !== vaultOwner.toLowerCase() ||
    signer.address.toLowerCase() !== facadeOwner.toLowerCase() ||
    signer.address.toLowerCase() !== adapterOwner.toLowerCase()
  ) {
    throw new Error(
      `Signer ${signer.address} must be owner of vault, facade, and HL adapter ` +
        `(owners: vault=${vaultOwner}, facade=${facadeOwner}, adapter=${adapterOwner}).`,
    );
  }

  console.log(`\nWire ExchangeFacade (${productLabel})`);
  console.log(`  signer:     ${signer.address}`);
  console.log(`  vault:      ${kashYieldAddress}`);
  console.log(`  facade:     ${facadeAddress}`);
  console.log(`  hlAdapter:  ${hlAdapterAddress}`);

  const currentFacade = await vault.exchangeFacade();
  if (currentFacade.toLowerCase() === facadeAddress.toLowerCase()) {
    console.log("\n  ℹ️  vault.exchangeFacade already set — skipping setExchangeFacade");
  } else if (currentFacade !== ethers.ZeroAddress) {
    throw new Error(
      `vault.exchangeFacade is already ${currentFacade}; refusing to overwrite with ${facadeAddress}`,
    );
  } else {
    await runStep("vault.setExchangeFacade", async () =>
      (await vault.setExchangeFacade(facadeAddress)).wait(),
    );
  }

  const registeredHl = await facade.hyperliquidAddress();
  if (registeredHl.toLowerCase() === hlAdapterAddress.toLowerCase()) {
    console.log("  ℹ️  facade.hyperliquidAddress already set — skipping setHyperliquid");
  } else if (registeredHl !== ethers.ZeroAddress) {
    throw new Error(
      `facade.hyperliquidAddress is already ${registeredHl}; refusing to overwrite`,
    );
  } else {
    await runStep("facade.setHyperliquid", async () =>
      (await facade.setHyperliquid(hlAdapterAddress)).wait(),
    );
  }

  const active = await facade.activePerpExchange();
  if (active === "HL") {
    console.log("  ℹ️  facade.activePerpExchange already HL — skipping setActivePerpExchange");
  } else {
    await runStep('facade.setActivePerpExchange("HL")', async () =>
      (await facade.setActivePerpExchange("HL")).wait(),
    );
  }

  const authorized = await hlAdapter.authorizedCaller();
  if (authorized.toLowerCase() === facadeAddress.toLowerCase()) {
    console.log("  ℹ️  hlAdapter.authorizedCaller already facade — skipping setAuthorizedCaller");
  } else if (authorized !== ethers.ZeroAddress) {
    throw new Error(
      `hlAdapter.authorizedCaller is already ${authorized}; refusing to overwrite`,
    );
  } else {
    await runStep("hlAdapter.setAuthorizedCaller", async () =>
      (await hlAdapter.setAuthorizedCaller(facadeAddress)).wait(),
    );
  }

  console.log("\nReadback:");
  console.log("  vault.exchangeFacade()   =", await vault.exchangeFacade());
  console.log("  facade.hyperliquidAddress() =", await facade.hyperliquidAddress());
  console.log('  facade.activePerpExchange() =', await facade.activePerpExchange());
  console.log("  hlAdapter.authorizedCaller() =", await hlAdapter.authorizedCaller());
  console.log("\n✅ ExchangeFacade wiring complete. Next: approveHlAgent.js for this HL adapter.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
