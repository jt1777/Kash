// scripts/ownerWithdrawFromAave.js
// Owner withdraws wBTC from Aave back to the KashYieldBtc contract.
// Use the contract address that currently has wBTC in Aave (e.g. the old deployment).
//
// Usage (Arbitrum Sepolia):
//   npx hardhat run scripts/ownerWithdrawFromAave.js --network arbitrumSepolia
//
// Env (root .env):
//   PRIVATE_KEY                    - owner wallet
//   KASH_YIELD_BTC_ADDRESS         - KashYieldBtc contract (the one with wBTC in Aave)
//   NEXT_PUBLIC_KASH_YIELD_BTC      - same, used if KASH_YIELD_BTC_ADDRESS not set
//
// Withdraw amount (wBTC, 8 decimals):
//   WITHDRAW_AMOUNT=1    - withdraw 1 wBTC (default: withdraw all you can)
//   or pass as first argument: npx hardhat run scripts/ownerWithdrawFromAave.js --network arbitrumSepolia 100000000
//   (100000000 = 1e8 = 1 wBTC in raw units)

require("dotenv").config();
const hre = require("hardhat");

const WBTC_DECIMALS = 8;

async function main() {
  const kashYieldBtcAddress =
    process.env.KASH_YIELD_BTC_ADDRESS ||
    process.env.NEXT_PUBLIC_KASH_YIELD_BTC ||
    process.env.KASH_YIELD_ADDRESS;
  if (!kashYieldBtcAddress || !hre.ethers.isAddress(kashYieldBtcAddress)) {
    throw new Error(
      "Set KASH_YIELD_BTC_ADDRESS, NEXT_PUBLIC_KASH_YIELD_BTC, or KASH_YIELD_ADDRESS in .env to the KashYieldBtc contract that has wBTC in Aave."
    );
  }

  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(
    "KashYieldBtc",
    kashYieldBtcAddress
  );
  const owner = await kashYield.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the contract owner (${owner}). Use PRIVATE_KEY for the owner.`
    );
  }

  const aavePoolAddress = await kashYield.aavePoolAddress();
  const wbtcAddress = await kashYield.wbtcAddress();
  const pool = await hre.ethers.getContractAt(
    [
      "function getATokenBalance(address asset, address user) view returns (uint256)",
      "function getUserWbtcBalance(address user) view returns (uint256)",
    ],
    aavePoolAddress
  );
  const aTokenBalance = await pool.getATokenBalance(wbtcAddress, kashYieldBtcAddress);
  // MockAaveV3: withdraw() only allows withdrawing principal (suppliedWbtcAmounts), not principal+yield.
  // getATokenBalance returns principal+yield, so use getUserWbtcBalance (principal) when available.
  let withdrawable = aTokenBalance;
  try {
    const principal = await pool.getUserWbtcBalance(kashYieldBtcAddress);
    withdrawable = principal;
    if (principal < aTokenBalance) {
      console.log(
        "  (MockAave: withdrawable principal",
        principal.toString(),
        "raw; aToken balance includes",
        (aTokenBalance - principal).toString(),
        "raw accrued yield)"
      );
    }
  } catch {
    // Real Aave or pool without getUserWbtcBalance: full aToken balance is withdrawable
  }
  console.log(
    "KashYieldBtc in Aave – withdrawable (raw):",
    withdrawable.toString(),
    "(",
    hre.ethers.formatUnits(withdrawable, WBTC_DECIMALS),
    "wBTC)"
  );

  let amount;
  const arg = process.argv.find((a) => /^\d+$/.test(a));
  if (arg) {
    amount = BigInt(arg);
    console.log("Using amount from argument (raw):", amount.toString());
  } else if (process.env.WITHDRAW_AMOUNT) {
    amount = hre.ethers.parseUnits(
      process.env.WITHDRAW_AMOUNT,
      WBTC_DECIMALS
    );
    console.log(
      "Using WITHDRAW_AMOUNT:",
      process.env.WITHDRAW_AMOUNT,
      "wBTC →",
      amount.toString(),
      "raw"
    );
  } else {
    amount = withdrawable;
    console.log("No amount specified; withdrawing full withdrawable amount.");
  }

  if (amount === 0n) {
    console.log("Nothing to withdraw.");
    return;
  }
  if (amount > withdrawable) {
    throw new Error(
      `Requested ${amount.toString()} raw exceeds withdrawable ${withdrawable.toString()}. Use a lower amount or omit to withdraw all.`
    );
  }

  console.log("Calling withdrawFromAave(" + amount.toString() + ")...");
  const tx = await kashYield.withdrawFromAave(amount);
  console.log("Tx hash:", tx.hash);
  await tx.wait();
  console.log("Done. wBTC is now in the KashYieldBtc contract.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
