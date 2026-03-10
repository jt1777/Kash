// scripts/ownerUpdateNAV.js
// Owner calls updateNAV(newNAV) on KashYield to set the on-chain NAV (18 decimals, e.g. 1e18 = $1).
// Use this to test that Phase 2 uses the new NAV for mint/redeem calculations.
//
// Usage (Arbitrum Sepolia):
//   NEW_NAV=1.05e18 npx hardhat run scripts/ownerUpdateNAV.js --network arbitrumSepolia
//   # or for BTC product (default): KASH_YIELD_BTC_ADDRESS=0x... NEW_NAV=1050000000000000000 npx hardhat run ...
//
// Env (root .env):
//   PRIVATE_KEY              - owner wallet
//   NEW_NAV                  - new NAV in 18 decimals (e.g. 1050000000000000000 for $1.05, or 1.05e18 in shell)
//   KASH_YIELD_BTC_ADDRESS   - KashYieldBtc (used if PRODUCT=btc or unset)
//   KASH_YIELD_ADDRESS       - KashYieldETH or KashYieldBtc (fallback)
//
// To test a *different* NAV: set NEW_NAV to something other than current (e.g. 1.02e18 for $1.02).
// The bot normally computes NAV from portfolio + yield and calls updateNAV; this script bypasses that.

require("dotenv").config();
const hre = require("hardhat");

function parseNAV(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?e\d+$/i.test(s)) {
    const [base, exp] = s.toLowerCase().split("e");
    return BigInt(Number(base) * 10 ** Number(exp));
  }
  // Decimal like "1.01" => 1.01e18 (18 decimals)
  if (/^\d+(\.\d+)?$/.test(s)) {
    return hre.ethers.parseEther(s);
  }
  return BigInt(s);
}

async function main() {
  const product = (process.env.PRODUCT || "btc").toLowerCase();
  const kashYieldAddress =
    product === "eth"
      ? process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS
      : process.env.KASH_YIELD_BTC_ADDRESS ||
        process.env.NEXT_PUBLIC_KASH_YIELD_BTC ||
        process.env.KASH_YIELD_ADDRESS;

  if (!kashYieldAddress || !hre.ethers.isAddress(kashYieldAddress)) {
    throw new Error(
      "Set KASH_YIELD_BTC_ADDRESS (or KASH_YIELD_ADDRESS / NEXT_PUBLIC_KASH_YIELD_BTC) in .env."
    );
  }

  let newNAV = parseNAV(process.env.NEW_NAV) ?? parseNAV(process.argv[2]);
  if (newNAV == null || newNAV <= 0n) {
    throw new Error(
      "Set NEW_NAV in env (e.g. NEW_NAV=1.05e18 for $1.05) or pass as first arg (e.g. 1050000000000000000)."
    );
  }

  const contractName = product === "eth" ? "KashYieldETH" : "KashYieldBtc";
  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(
    contractName,
    kashYieldAddress
  );
  const owner = await kashYield.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the contract owner (${owner}). Use PRIVATE_KEY for the owner.`
    );
  }

  const currentNAV = await kashYield.currentNAV();
  const currentStr = hre.ethers.formatEther(currentNAV);
  const newStr = hre.ethers.formatEther(newNAV);
  console.log(`Current NAV: ${currentStr} (raw: ${currentNAV})`);
  console.log(`Setting NAV:  ${newStr} (raw: ${newNAV})...`);

  const tx = await kashYield.updateNAV(newNAV);
  await tx.wait();
  const updated = await kashYield.currentNAV();
  console.log(`Updated NAV: ${hre.ethers.formatEther(updated)}`);
  console.log("\nTo get a bot-computed NAV change: run the bot after a batch with ops. The bot uses");
  console.log("portfolio value + netYield (Aave supply yield - borrow cost + HL funding) / KASH supply.");
  console.log("MockAave: supply yield accrues over time (wBTC); borrow cost is non-zero if USDC is borrowed.");
  console.log("MockHyperliquid: setFundingRatePerDayBps and have a short open 1+ day for funding.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
