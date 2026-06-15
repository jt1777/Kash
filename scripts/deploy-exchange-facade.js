/**
 * Deploy ExchangeFacade for a KashYield vault (ETH or BTC).
 *
 * Usage (BTC):
 *   KASH_YIELD_ADDRESS=0x... PRIMARY_ASSET=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
 *   BOT_ADDRESS=0x... npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
 *
 * Usage (ETH):
 *   KASH_YIELD_ADDRESS=0x... PRIMARY_ASSET=0x0 BOT_ADDRESS=0x... \
 *   npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
 */
require("dotenv").config();

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;

async function main() {
  const network = hre.network.name;
  const kashYield = process.env.KASH_YIELD_ADDRESS;
  const usdc = process.env.USDC_ADDRESS || "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const primaryAsset = process.env.PRIMARY_ASSET || ethers.ZeroAddress;
  const bot = process.env.BOT_ADDRESS;
  const isEth = primaryAsset === ethers.ZeroAddress;

  if (!kashYield || !ethers.isAddress(kashYield)) throw new Error("Set KASH_YIELD_ADDRESS");
  if (!bot || !ethers.isAddress(bot)) throw new Error("Set BOT_ADDRESS");
  if (!ethers.isAddress(primaryAsset)) throw new Error("Set PRIMARY_ASSET (wBTC address or 0x0 for ETH)");

  const [owner] = await ethers.getSigners();
  const label = process.env.EXCHANGE_FACADE_LABEL || (isEth ? "ETH" : "BTC");

  console.log("Deploying ExchangeFacade to", network);
  console.log("  Product:      ", label);
  console.log("  Owner:        ", owner.address);
  console.log("  Bot:          ", bot);
  console.log("  USDC:         ", usdc);
  console.log("  Primary asset:", isEth ? "(native ETH)" : primaryAsset);
  console.log("  KashYield:    ", kashYield);
  console.log("");

  const ExchangeFacade = await ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(owner.address, bot, usdc, primaryAsset, kashYield);
  await facade.waitForDeployment();

  const facadeAddr = await facade.getAddress();
  console.log(`✅ ExchangeFacade (${label}):`, facadeAddr);

  const envVarName = isEth ? "EXCHANGE_FACADE_ETH_ADDRESS" : "EXCHANGE_FACADE_BTC_ADDRESS";
  console.log("\nAdd to .env and kash-ops .env:");
  console.log(`  ${envVarName}=${facadeAddr}`);
  console.log("\nNext (kash-ops repo):");
  console.log("  npx hardhat run scripts/wire-exchange-facade.js --network", network);
  console.log("  Owner must call vault.setExchangeFacade(facade) if not done in wire script.");

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const info = {
    network,
    timestamp: new Date().toISOString(),
    deployer: owner.address,
    product: label,
    contracts: {
      exchangeFacade: facadeAddr,
      kashYield,
      usdc,
      primaryAsset,
      bot,
    },
  };
  const filepath = path.join(deploymentsDir, `exchange-facade-${label.toLowerCase()}-${network}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log("💾 Saved:", filepath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
