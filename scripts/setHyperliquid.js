// scripts/setHyperliquid.js
// Sets the Hyperliquid adapter/bridge address on the deployed KashYield contract.
// Usage: npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia
//
// What to put for HYPERLIQUID_ADDRESS:
//
// 1) Arbitrum Sepolia (testnet) – use a DEPLOYED MockHyperliquid contract address.
//    The contract expects an address that implements: depositToSpotWallet(stableToken, amount),
//    withdrawFromSpotWallet(stableToken, amount), openPerpPosition(symbol, size, isLong),
//    closePerpPosition(symbol), getSpotBalance(user), getPosition(user, symbol), etc.
//    Deploy MockHyperliquid first (see contracts/MockHyperliquid.sol) with your
//    Sepolia USDC/USDT/wBTC addresses, then put that deployed address here or in .env
//    as HYPERLIQUID_ADDRESS.
//
// 2) Arbitrum Mainnet – you can use the real Hyperliquid deposit bridge
//    0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 ONLY if it exposes the same interface.
//    Often the bridge has a different ABI; then you need an adapter contract that
//    wraps the bridge and implements the IHyperliquid interface.
//
// 3) To disable Hyperliquid – set address to 0x0000000000000000000000000000000000000000
//    (or leave unset and don’t run this script). Owner can call setHyperliquid(0) later.

require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const KASH_YIELD_ADDRESS =
    process.env.KASH_YIELD_ADDRESS || "0x4C3910E93aB0c5983c6DEE003749485E525E5Db7";
  const HYPERLIQUID_ADDRESS = process.env.HYPERLIQUID_ADDRESS || "";

  if (!HYPERLIQUID_ADDRESS || HYPERLIQUID_ADDRESS === "0x...") {
    throw new Error(
      "Set HYPERLIQUID_ADDRESS in .env (or in this script). " +
        "Use a deployed MockHyperliquid address on Sepolia, or the real HL bridge/adapter on mainnet. " +
        "Use 0x0000000000000000000000000000000000000000 to disable."
    );
  }
  if (!hre.ethers.isAddress(HYPERLIQUID_ADDRESS)) {
    throw new Error("Invalid HYPERLIQUID_ADDRESS");
  }

  console.log("Network:", hre.network.name);
  console.log("KashYield:", KASH_YIELD_ADDRESS);
  console.log("Hyperliquid address:", HYPERLIQUID_ADDRESS);
  console.log("\nConnecting to KashYield...");
  const KashYield = await hre.ethers.getContractAt("KashYield", KASH_YIELD_ADDRESS);

  const owner = await KashYield.owner();
  const [signer] = await hre.ethers.getSigners();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the contract owner (${owner})`);
  }
  console.log("Current Hyperliquid address:", await KashYield.hyperliquidAddress());
  console.log("Setting Hyperliquid address...");
  const tx = await KashYield.setHyperliquid(HYPERLIQUID_ADDRESS);
  console.log("Transaction sent:", tx.hash);
  await tx.wait();
  console.log("✅ Hyperliquid address updated!");
  console.log("New Hyperliquid address:", await KashYield.hyperliquidAddress());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
