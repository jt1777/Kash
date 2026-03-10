// scripts/ownerWithdrawWbtcToUser.js
// Withdraws excess collateral from KashYield to a user address.
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
// Amount (human-readable; default: all excess):
//   WITHDRAW_AMOUNT=0.25        - withdraw 0.25 (wBTC or ETH)
//   WITHDRAW_AMOUNT=all         - withdraw all excess (default if omitted)

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
  const reserved = await kashYield.getReservedBtc();
  const excess =
    contractBalance > reserved ? contractBalance - reserved : 0n;
  if (excess === 0n) {
    console.log("No excess wBTC in the contract. Nothing to withdraw.");
    return;
  }

  let amount;
  if (!amountArg || amountArg.toLowerCase() === "all") {
    amount = excess;
    console.log(
      `Withdrawing all excess: ${hre.ethers.formatUnits(amount, WBTC_DECIMALS)} wBTC`
    );
  } else {
    amount = hre.ethers.parseUnits(amountArg, WBTC_DECIMALS);
    if (amount > excess) {
      throw new Error(
        `Requested ${amountArg} wBTC but only ${hre.ethers.formatUnits(excess, WBTC_DECIMALS)} wBTC excess available.`
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
  const reserved = await kashYield.getReservedEth();
  const excess =
    contractBalance > reserved ? contractBalance - reserved : 0n;
  if (excess === 0n) {
    console.log("No excess ETH in the contract. Nothing to withdraw.");
    return;
  }

  let amount;
  if (!amountArg || amountArg.toLowerCase() === "all") {
    amount = excess;
    console.log(
      `Withdrawing all excess: ${hre.ethers.formatEther(amount)} ETH`
    );
  } else {
    amount = hre.ethers.parseEther(amountArg);
    if (amount > excess) {
      throw new Error(
        `Requested ${amountArg} ETH but only ${hre.ethers.formatEther(excess)} ETH excess available.`
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
