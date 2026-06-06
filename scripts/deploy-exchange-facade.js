/**
 * Deploy ExchangeFacade for a KashYield vault (ETH or BTC).
 *
 * Usage:
 *   KASH_YIELD_ADDRESS=0x... PRIMARY_ASSET=0x0 npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
 *   PRIMARY_ASSET=wbtc address for BTC product
 */
require("dotenv").config();

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const kashYield = process.env.KASH_YIELD_ADDRESS;
  const usdc = process.env.USDC_ADDRESS || "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const primaryAsset = process.env.PRIMARY_ASSET || ethers.ZeroAddress;
  const bot = process.env.BOT_ADDRESS;

  if (!kashYield || !ethers.isAddress(kashYield)) throw new Error("Set KASH_YIELD_ADDRESS");
  if (!bot || !ethers.isAddress(bot)) throw new Error("Set BOT_ADDRESS");

  const [owner] = await ethers.getSigners();
  const ExchangeFacade = await ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(owner.address, bot, usdc, primaryAsset, kashYield);
  await facade.waitForDeployment();

  console.log("ExchangeFacade:", await facade.getAddress());
  console.log("Next:");
  console.log("  1. kashYield.setExchangeFacade(facade)");
  console.log("  2. facade.setHyperliquid(adapter); facade.setActivePerpExchange('HL')");
  console.log("  3. hlAdapter.setAuthorizedCaller(facade)  // allow facade → adapter HL ops");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
