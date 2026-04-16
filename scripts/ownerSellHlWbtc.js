// scripts/ownerSellHlWbtc.js
// Owner sells wBTC in Hyperliquid spot to USDC (on HL). Run this before recover-hl-usdc-to-aave
// so the USDC can be withdrawn and repaid to Aave.
//
// Usage (from repo root):
//   npx hardhat run scripts/ownerSellHlWbtc.js --network arbitrumSepolia
//
// Env (root .env): PRIVATE_KEY (bot or keeper), KASH_YIELD_BTC_ADDRESS (or KASH_YIELD_ADDRESS)
// Network must match where KashYieldBtc and MockHyperliquid are deployed.

require("dotenv").config();
const hre = require("hardhat");
const { assertKashYieldOpsSigner } = require("./opsAccessChecks");

async function main() {
  const kashYieldAddress =
    process.env.KASH_YIELD_BTC_ADDRESS ||
    process.env.KASH_YIELD_ADDRESS;

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error(
      "Set KASH_YIELD_BTC_ADDRESS (or KASH_YIELD_ADDRESS) in .env."
    );
  }

  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(
    "KashYieldBtc",
    kashYieldAddress
  );
  await assertKashYieldOpsSigner(kashYield, signer.address);

  const hlAddress = await kashYield.hyperliquidAddress();
  if (!hlAddress || hlAddress === hre.ethers.ZeroAddress) {
    throw new Error("Hyperliquid address not set on contract.");
  }

  const hl = await hre.ethers.getContractAt(
    ["function btcBalance(address) view returns (uint256)"],
    hlAddress
  );
  const amount = await hl.btcBalance(kashYieldAddress);
  if (amount === 0n) {
    console.log("HL spot wBTC balance is 0. Nothing to sell.");
    return;
  }

  const amountHuman = hre.ethers.formatEther(amount);
  console.log(`HL spot wBTC (contract): ${amountHuman} wBTC`);
  console.log(`Selling via spotSellOnHyperliquid(${amount})...`);

  const tx = await kashYield.spotSellOnHyperliquid(amount);
  await tx.wait();
  console.log("Done. HL spot wBTC has been sold to USDC on Hyperliquid.");
  console.log("Next: run recover-hl-usdc-to-aave to withdraw that USDC and repay Aave:");
  console.log("  cd bot && npm run owner:recover-hl-usdc");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
