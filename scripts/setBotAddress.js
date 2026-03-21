// scripts/setBotAddress.js
// Sets the bot address on the deployed KashYieldETH or KashYieldBtc contract.
// Usage:
//   ETH: KASH_YIELD_ETH_ADDRESS=0xf78854... BOT_ADDRESS=0x... npx hardhat run scripts/setBotAddress.js --network arbitrumSepolia
//   BTC: PRODUCT=btc KASH_YIELD_BTC_ADDRESS=0x897a20... BOT_ADDRESS=0x... npx hardhat run scripts/setBotAddress.js --network arbitrumSepolia

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const isBtc = (process.env.PRODUCT || "").toLowerCase() === "btc";
  const defaultAddress = isBtc ? "0x897a206c1C7494C1593C2a9b7900D8fd4EbFFD7b" : "0xf78854a9B5D28DdB1B35a60553e22481fE87d759";
  const KASH_YIELD_ADDRESS = (isBtc ? process.env.KASH_YIELD_BTC_ADDRESS : process.env.KASH_YIELD_ETH_ADDRESS) || process.env.KASH_YIELD_ADDRESS || defaultAddress;
  const BOT_ADDRESS = process.env.BOT_ADDRESS || "";

  if (!BOT_ADDRESS) {
    throw new Error(
      "Set BOT_ADDRESS in .env to the bot wallet address (e.g. 0x1545E727962c2B822FBAff39190A579787019750)"
    );
  }
  if (!hre.ethers.isAddress(BOT_ADDRESS)) {
    throw new Error("Invalid BOT_ADDRESS");
  }

  const contractName = isBtc ? "KashYieldBtc" : "KashYieldETH";
  console.log("Network:", hre.network.name);
  console.log("Contract:", contractName, KASH_YIELD_ADDRESS);
  console.log("New bot address:", BOT_ADDRESS);
  console.log("\nConnecting...");
  const kashYield = await hre.ethers.getContractAt(contractName, KASH_YIELD_ADDRESS);

  const owner = await kashYield.owner();
  const [signer] = await hre.ethers.getSigners();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the contract owner (${owner})`);
  }

  console.log("Current bot address:", await kashYield.botAddress());
  console.log("Setting bot address...");
  const tx = await kashYield.setBotAddress(BOT_ADDRESS);
  console.log("Transaction sent:", tx.hash);
  await tx.wait();
  console.log("✅ Bot address updated!");
  console.log("New bot address:", await kashYield.botAddress());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
