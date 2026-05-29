// scripts/ownerWithdrawToUser.js
// Withdraws vault asset to a user via ownerWithdraw* then transfer.
// Supports PRODUCT=btc (wBTC, KashYieldBtc) or PRODUCT=eth (native ETH, KashYieldETH).
//
// Withdraw mode (auto-detected unless WITHDRAW_MODE is set):
//   - legacy excess — deployed vaults: balance minus getReservedBtc/getReservedEth
//   - owner reserve — new vaults: ownerWbtcReserve / ownerEthReserve only
//
// Usage (wBTC to user):
//   USER_ADDRESS=0x... npx hardhat run scripts/ownerWithdrawToUser.js --network arbitrumOne
//
// Usage (ETH to user):
//   USER_ADDRESS=0x... PRODUCT=eth npx hardhat run scripts/ownerWithdrawToUser.js --network arbitrumOne
//
// Env (root .env):
//   PRIVATE_KEY                 - owner wallet
//   USER_ADDRESS                - recipient address
//   PRODUCT                     - "btc" (default) or "eth"
//   KASH_YIELD_BTC_ADDRESS      - KashYieldBtc; used when PRODUCT=btc
//   KASH_YIELD_ETH_ADDRESS      - KashYieldETH; used when PRODUCT=eth
//   WITHDRAW_MODE               - optional: "legacy" | "reserve" (default: auto)
//
// Amount (human-readable; default: all available):
//   WITHDRAW_AMOUNT=0.25        - withdraw 0.25 (wBTC or ETH)
//   WITHDRAW_AMOUNT=all         - withdraw all available (default if omitted)

require("dotenv").config();
const hre = require("hardhat");

const WBTC_DECIMALS = 8;

const LEGACY_ABI = [
  "function getReservedBtc() view returns (uint256)",
  "function getReservedEth() view returns (uint256)",
  "function ownerWithdrawWbtc(uint256 amount)",
  "function ownerWithdrawEth(uint256 amount)",
  "function ownerWbtcReserve() view returns (uint256)",
  "function ownerEthReserve() view returns (uint256)",
];

async function legacyExcess(kashYieldAddress, isBtc, contractBalance) {
  const legacy = new hre.ethers.Contract(
    kashYieldAddress,
    LEGACY_ABI,
    hre.ethers.provider
  );
  const reserved = isBtc
    ? await legacy.getReservedBtc()
    : await legacy.getReservedEth();
  return contractBalance > reserved ? contractBalance - reserved : 0n;
}

async function ownerReserveWithdrawable(kashYield, isBtc, contractBalance) {
  let ownerReserve = 0n;
  try {
    ownerReserve = isBtc
      ? await kashYield.ownerWbtcReserve()
      : await kashYield.ownerEthReserve();
  } catch {
    return 0n;
  }
  return ownerReserve > 0n && contractBalance < ownerReserve
    ? contractBalance
    : ownerReserve;
}

async function resolveWithdrawable(
  signer,
  kashYield,
  kashYieldAddress,
  isBtc,
  contractBalance
) {
  const modeEnv = (process.env.WITHDRAW_MODE || "").trim().toLowerCase();
  const ownerFn = isBtc ? "ownerWithdrawWbtc" : "ownerWithdrawEth";

  let excess = null;
  try {
    excess = await legacyExcess(kashYieldAddress, isBtc, contractBalance);
  } catch {
    /* getReserved* not on this deployment */
  }

  const reserve = await ownerReserveWithdrawable(
    kashYield,
    isBtc,
    contractBalance
  );

  if (modeEnv === "legacy" || modeEnv === "excess") {
    if (excess === null) {
      throw new Error(
        "WITHDRAW_MODE=legacy but getReservedBtc/getReservedEth is not on this contract."
      );
    }
    return { withdrawable: excess, mode: "legacy excess (getReserved*)" };
  }

  if (modeEnv === "reserve") {
    return { withdrawable: reserve, mode: "owner reserve" };
  }

  // Auto: prefer legacy excess when the on-chain ownerWithdraw allows it.
  if (excess !== null && excess > 0n) {
    try {
      await kashYield.connect(signer)[ownerFn].staticCall(excess);
      return { withdrawable: excess, mode: "legacy excess (getReserved*)" };
    } catch {
      /* new bytecode caps ownerWithdraw at owner reserve */
    }
  }

  if (reserve > 0n) {
    return { withdrawable: reserve, mode: "owner reserve" };
  }

  return { withdrawable: 0n, mode: "none" };
}

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
  const { withdrawable, mode } = await resolveWithdrawable(
    signer,
    kashYield,
    contractAddress,
    true,
    contractBalance
  );

  if (withdrawable === 0n) {
    console.log("No withdrawable wBTC on this vault. Nothing to do.");
    return;
  }

  console.log(`Withdraw mode: ${mode}`);

  let amount;
  if (!amountArg || amountArg.toLowerCase() === "all") {
    amount = withdrawable;
    console.log(
      `Withdrawing all available: ${hre.ethers.formatUnits(amount, WBTC_DECIMALS)} wBTC`
    );
  } else {
    amount = hre.ethers.parseUnits(amountArg, WBTC_DECIMALS);
    if (amount > withdrawable) {
      throw new Error(
        `Requested ${amountArg} wBTC but only ${hre.ethers.formatUnits(withdrawable, WBTC_DECIMALS)} wBTC available (${mode}).`
      );
    }
    console.log(
      `Withdrawing ${hre.ethers.formatUnits(amount, WBTC_DECIMALS)} wBTC to ${userAddress}`
    );
  }

  console.log("Step 1: ownerWithdrawWbtc (contract -> owner)...");
  const tx1 = await kashYield.connect(signer).ownerWithdrawWbtc(amount);
  await tx1.wait();
  console.log("  Done.");

  console.log("Step 2: Transfer wBTC to user...");
  const tx2 = await wbtc.connect(signer).transfer(userAddress, amount);
  await tx2.wait();
  console.log("  Done.");

  console.log(
    `Sent ${hre.ethers.formatUnits(amount, WBTC_DECIMALS)} wBTC to ${userAddress}.`
  );
}

async function runEth(signer, kashYield, contractAddress, userAddress, amountArg) {
  const contractBalance = await hre.ethers.provider.getBalance(contractAddress);
  const { withdrawable, mode } = await resolveWithdrawable(
    signer,
    kashYield,
    contractAddress,
    false,
    contractBalance
  );

  if (withdrawable === 0n) {
    console.log("No withdrawable ETH on this vault. Nothing to do.");
    return;
  }

  console.log(`Withdraw mode: ${mode}`);

  let amount;
  if (!amountArg || amountArg.toLowerCase() === "all") {
    amount = withdrawable;
    console.log(`Withdrawing all available: ${hre.ethers.formatEther(amount)} ETH`);
  } else {
    amount = hre.ethers.parseEther(amountArg);
    if (amount > withdrawable) {
      throw new Error(
        `Requested ${amountArg} ETH but only ${hre.ethers.formatEther(withdrawable)} ETH available (${mode}).`
      );
    }
    console.log(
      `Withdrawing ${hre.ethers.formatEther(amount)} ETH to ${userAddress}`
    );
  }

  console.log("Step 1: ownerWithdrawEth (contract -> owner)...");
  const tx1 = await kashYield.connect(signer).ownerWithdrawEth(amount);
  await tx1.wait();
  console.log("  Done.");

  console.log("Step 2: Transfer ETH to user...");
  const tx2 = await signer.sendTransaction({
    to: userAddress,
    value: amount,
  });
  await tx2.wait();
  console.log("  Done.");

  console.log(`Sent ${hre.ethers.formatEther(amount)} ETH to ${userAddress}.`);
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
