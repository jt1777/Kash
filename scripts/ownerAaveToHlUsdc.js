// scripts/ownerAaveToHlUsdc.js
// Move USDC from Aave to Hyperliquid (borrow USDC from Aave, then deposit to HL spot).
// Use when HL has a margin call and you need to add USDC collateral on Hyperliquid.
//
// Usage (from repo root):
//   USDC_AMOUNT=10000 npx hardhat run scripts/ownerAaveToHlUsdc.js --network arbitrumSepolia
//
// Env (root .env):
//   PRIVATE_KEY, KASH_YIELD_BTC_ADDRESS (or KASH_YIELD_ADDRESS)
//   USDC_AMOUNT  - amount of USDC to borrow and send to HL (human units, e.g. 10000 for 10000 USDC)
//
// USDC has 6 decimals. The contract uses the same USDC address for Aave repay and HL.

require("dotenv").config();
const hre = require("hardhat");

const USDC_DECIMALS = 6;

async function main() {
  const kashYieldAddress =
    process.env.KASH_YIELD_BTC_ADDRESS ||
    process.env.NEXT_PUBLIC_KASH_YIELD_BTC ||
    process.env.KASH_YIELD_ADDRESS;

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error(
      "Set KASH_YIELD_BTC_ADDRESS (or KASH_YIELD_ADDRESS) in .env."
    );
  }

  const amountStr = process.env.USDC_AMOUNT;
  if (!amountStr || amountStr === "") {
    throw new Error(
      "Set USDC_AMOUNT in .env (e.g. USDC_AMOUNT=10000 for 10000 USDC)."
    );
  }

  const amount = hre.ethers.parseUnits(amountStr, USDC_DECIMALS);
  if (amount === 0n) {
    throw new Error("USDC_AMOUNT must be > 0.");
  }

  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(
    "KashYieldBtc",
    kashYieldAddress
  );
  const owner = await kashYield.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the contract owner (${owner}).`
    );
  }

  const usdcAddress = await kashYield.usdcAddress();
  const hlAddress = await kashYield.hyperliquidAddress();
  if (!hlAddress || hlAddress === hre.ethers.ZeroAddress) {
    throw new Error("Hyperliquid address not set on contract.");
  }

  console.log("Move USDC from Aave to Hyperliquid (margin top-up)");
  console.log("═".repeat(50));
  console.log(`Contract:    ${kashYieldAddress}`);
  console.log(`USDC amount: ${amountStr} USDC (${amount} raw)`);
  console.log("");

  console.log("Step 1: Borrow USDC from Aave...");
  const tx1 = await kashYield.borrowFromAave(usdcAddress, amount);
  await tx1.wait();
  console.log("  Done. USDC is now on the contract.");
  console.log("");

  console.log("Step 2: Deposit USDC to Hyperliquid...");
  const tx2 = await kashYield.depositToHyperliquid(amount);
  await tx2.wait();
  console.log("  Done. USDC is now in HL spot.");
  console.log("");
  console.log("Margin top-up complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
