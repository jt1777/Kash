// scripts/ownerWithdrawWbtcToUser.js
// Withdraws owner-marked vault asset (`ownerWbtcReserve` / `ownerEthReserve`) to a user address.
// Supports PRODUCT=btc (wBTC, KashYieldBtc) or PRODUCT=eth (native ETH, KashYieldETH).
// Flow: contract -> owner (ownerWithdrawWbtc / ownerWithdrawEth) -> user (transfer).
//
// Usage (wBTC to user):
//   USER_ADDRESS=0x... npx hardhat run scripts/ownerWithdrawWbtcToUser.js --network arbitrumSepolia
//
// Usage (ETH to user):
//   USER_ADDRESS=0x... PRODUCT=eth npx hardhat run scripts/ownerWithdrawWbtcToUser.js --network arbitrumSepolia
//
// Usage to send to the owner (set USER_ADDRESS to owner address or use same flow).
//
// Env (root .env):
//   PRIVATE_KEY                 - owner wallet
//   USER_ADDRESS                - recipient address
//   PRODUCT                     - "btc" (default) or "eth"
//   KASH_YIELD_BTC_ADDRESS      - KashYieldBtc; used when PRODUCT=btc
//   KASH_YIELD_ETH_ADDRESS      - KashYieldETH; used when PRODUCT=eth
//
// Amount (human-readable; default: all owner reserve):
//   WITHDRAW_AMOUNT=0.25        - withdraw 0.25 (wBTC or ETH)
//   WITHDRAW_AMOUNT=all         - withdraw all owner reserve (default if omitted)

require("dotenv").config();
const hre = require("hardhat");

const WBTC_DECIMALS = 8;

async function runBtc(signer, kashYield, contractAddress, userAddress, amountArg) {
  const wbtcAddress = await kashYield.wbtcAddress();
  const wbtc = await hre.ethers.getContractAt(
    [
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address, uint256) returns (bool)",
    ],
    wbtcAddress
  );

  const contractBalance = await wbtc.balanceOf(contractAddress);
  const ownerReserve = await kashYield.ownerWbtcReserve();
  const withdrawable =
    ownerReserve > 0n && contractBalance < ownerReserve
      ? contractBalance
      : ownerReserve;
  if (withdrawable === 0n) {
    console.log("No owner wBTC reserve in the contract. Nothing to withdraw.");
    return;
  }

  let amount;
  if (!amountArg || amountArg.toLowerCase() === "all") {
    amount = withdrawable;
    console.log(
      `Withdrawing all owner reserve: ${hre.ethers.formatUnits(amount, WBTC_DECIMALS)} wBTC`
    );
  } else {
    amount = hre.ethers.parseUnits(amountArg, WBTC_DECIMALS);
    if (amount > withdrawable) {
      throw new Error(
        `Requested ${amountArg} wBTC but only ${hre.ethers.formatUnits(withdrawable, WBTC_DECIMALS)} wBTC owner reserve available.`
      );
    }
    console.log(
      `Withdrawing ${hre.ethers.formatUnits(amount, WBTC_DECIMALS)} wBTC to ${userAddress}`
    );
  }

  console.log("Step 1: ownerWithdrawWbtc (contract -> owner)...");
  const tx1 = await kashYield.ownerWithdrawWbtc(amount);
  await tx1.wait();
  console.log("  Done.");

  console.log("Step 2: Transfer wBTC to user...");
  const tx2 = await wbtc.transfer(userAddress, amount);
  await tx2.wait();
  console.log("  Done.");

  console.log(
    `Sent ${hre.ethers.formatUnits(amount, WBTC_DECIMALS)} wBTC to ${userAddress}.`
  );
}

async function runEth(signer, kashYield, contractAddress, userAddress, amountArg) {
  const contractBalance = await hre.ethers.provider.getBalance(contractAddress);
  const ownerReserve = await kashYield.ownerEthReserve();
  const withdrawable =
    ownerReserve > 0n && contractBalance < ownerReserve
      ? contractBalance
      : ownerReserve;
  if (withdrawable === 0n) {
    console.log("No owner ETH reserve in the contract. Nothing to withdraw.");
    return;
  }

  let amount;
  if (!amountArg || amountArg.toLowerCase() === "all") {
    amount = withdrawable;
    console.log(
      `Withdrawing all owner reserve: ${hre.ethers.formatEther(amount)} ETH`
    );
  } else {
    amount = hre.ethers.parseEther(amountArg);
    if (amount > withdrawable) {
      throw new Error(
        `Requested ${amountArg} ETH but only ${hre.ethers.formatEther(withdrawable)} ETH owner reserve available.`
      );
    }
    console.log(
      `Withdrawing ${hre.ethers.formatEther(amount)} ETH to ${userAddress}`
    );
  }

  console.log("Step 1: ownerWithdrawEth (contract -> owner)...");
  const tx1 = await kashYield.ownerWithdrawEth(amount);
  await tx1.wait();
  console.log("  Done.");

  console.log("Step 2: Transfer ETH to user...");
  const tx2 = await signer.sendTransaction({
    to: userAddress,
    value: amount,
  });
  await tx2.wait();
  console.log("  Done.");

  console.log(
    `Sent ${hre.ethers.formatEther(amount)} ETH to ${userAddress}.`
  );
}

async function main() {
  const product = (process.env.PRODUCT || "btc").toLowerCase();
  if (product !== "btc" && product !== "eth") {
    throw new Error('PRODUCT must be "btc" or "eth".');
  }

  const userAddress = process.env.USER_ADDRESS;
  if (!userAddress || !hre.ethers.isAddress(userAddress)) {
    throw new Error("Set USER_ADDRESS in .env to the recipient address.");
  }

  const [signer] = await hre.ethers.getSigners();

  if (product === "btc") {
    const kashYieldBtcAddress =
      process.env.KASH_YIELD_BTC_ADDRESS ||
      process.env.KASH_YIELD_ADDRESS;
    if (!kashYieldBtcAddress || !hre.ethers.isAddress(kashYieldBtcAddress)) {
      throw new Error(
        "Set KASH_YIELD_BTC_ADDRESS in .env"
      );
    }

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

    await runBtc(
      signer,
      kashYield,
      kashYieldBtcAddress,
      userAddress,
      process.env.WITHDRAW_AMOUNT
    );
  } else {
    const kashYieldEthAddress =
      process.env.KASH_YIELD_ETH_ADDRESS ||
      process.env.KASH_YIELD_ADDRESS;
    if (!kashYieldEthAddress || !hre.ethers.isAddress(kashYieldEthAddress)) {
      throw new Error(
        "Set KASH_YIELD_ETH_ADDRESS in .env"
      );
    }

    const kashYield = await hre.ethers.getContractAt(
      "KashYieldETH",
      kashYieldEthAddress
    );
    const owner = await kashYield.owner();
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `Signer ${signer.address} is not the contract owner (${owner}). Use PRIVATE_KEY for the owner.`
      );
    }

    await runEth(
      signer,
      kashYield,
      kashYieldEthAddress,
      userAddress,
      process.env.WITHDRAW_AMOUNT
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
