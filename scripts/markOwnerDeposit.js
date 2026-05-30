// scripts/markOwnerDeposit.js
// Owner: one-shot approve (ERC-20) or send native ETH + mark owner reserve on KashYield.
// Credits ownerUsdcReserve / ownerEthReserve / ownerWbtcReserve (excluded from user NAV).
//
// Usage — USDC (ETH or BTC vault):
//   PRODUCT=btc ASSET=usdc DEPOSIT_AMOUNT=15.365427 npx hardhat run scripts/markOwnerDeposit.js --network arbitrumOne
//
// Usage — native ETH (KashYieldETH only):
//   ASSET=eth DEPOSIT_AMOUNT=0.05 npx hardhat run scripts/markOwnerDeposit.js --network arbitrumOne
//
// Usage — wBTC (KashYieldBtc only):
//   ASSET=wbtc DEPOSIT_AMOUNT=0.001 npx hardhat run scripts/markOwnerDeposit.js --network arbitrumOne
//
// Env (root .env):
//   PRIVATE_KEY              - vault owner (must match KashYield.owner())
//   ASSET                    - usdc | eth | wbtc | btc (btc alias for wbtc); default usdc
//   PRODUCT                  - eth | btc (required when both vault addresses are set; inferred for eth/wbtc asset)
//   DEPOSIT_AMOUNT or AMOUNT   - human units (USDC 6 dec, ETH 18 dec, wBTC 8 dec)

require("dotenv").config();
const hre = require("hardhat");
const { resolveKashYieldProduct } = require("./resolveKashYieldProduct");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

function parseAsset() {
  const raw = (process.env.ASSET || process.env.OWNER_DEPOSIT_ASSET || "usdc").trim().toLowerCase();
  if (raw === "btc") return "wbtc";
  if (raw === "usdc" || raw === "eth" || raw === "wbtc") return raw;
  throw new Error('ASSET must be "usdc", "eth", "wbtc", or "btc" (alias for wbtc).');
}

function parseAmount(asset, amountStr) {
  if (!amountStr) {
    throw new Error("Set DEPOSIT_AMOUNT (or AMOUNT) in human units.");
  }
  try {
    if (asset === "usdc") return hre.ethers.parseUnits(amountStr, 6);
    if (asset === "wbtc") return hre.ethers.parseUnits(amountStr, 8);
    return hre.ethers.parseEther(amountStr);
  } catch {
    throw new Error(`Invalid DEPOSIT_AMOUNT "${amountStr}" for ASSET=${asset}.`);
  }
}

async function assertOwner(kashYield, signer) {
  const owner = await kashYield.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not contract owner (${owner}). Use owner PRIVATE_KEY in root .env.`
    );
  }
}

async function approveErc20IfNeeded(token, owner, spender, amount, label) {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) {
    console.log(`Step 1: skip approve (${label} allowance sufficient).`);
    return;
  }
  console.log(`Step 1: approve(vault, amount) [${label}]...`);
  const txApprove = await token.approve(spender, amount);
  await txApprove.wait();
  console.log("  Done.", txApprove.hash);
}

async function runUsdc(kashYield, kashYieldAddress, signer, amount, amountStr) {
  const usdcAddress = await kashYield.usdcAddress();
  const usdc = await hre.ethers.getContractAt(ERC20_ABI, usdcAddress, signer);

  const ownerBal = await usdc.balanceOf(signer.address);
  if (ownerBal < amount) {
    throw new Error(
      `Owner USDC ${hre.ethers.formatUnits(ownerBal, 6)} < DEPOSIT_AMOUNT ${amountStr}.`
    );
  }

  const reserveBefore = await kashYield.ownerUsdcReserve();
  const vaultBefore = await usdc.balanceOf(kashYieldAddress);

  console.log("Asset:             USDC", usdcAddress);
  console.log("Deposit:           ", hre.ethers.formatUnits(amount, 6), "USDC");
  console.log("ownerUsdcReserve:  ", hre.ethers.formatUnits(reserveBefore, 6), "(before)");
  console.log("Vault USDC (raw):  ", hre.ethers.formatUnits(vaultBefore, 6), "(before)");
  console.log("");

  await approveErc20IfNeeded(usdc, signer.address, kashYieldAddress, amount, "USDC");

  console.log("Step 2: markOwnerUsdcDeposit(amount)...");
  const tx = await kashYield.markOwnerUsdcDeposit(amount);
  await tx.wait();
  console.log("  Done.", tx.hash);

  const reserveAfter = await kashYield.ownerUsdcReserve();
  const vaultAfter = await usdc.balanceOf(kashYieldAddress);
  console.log("");
  console.log("ownerUsdcReserve:  ", hre.ethers.formatUnits(reserveAfter, 6), "(after)");
  console.log("Vault USDC (raw):  ", hre.ethers.formatUnits(vaultAfter, 6), "(after)");
}

async function runEth(kashYield, kashYieldAddress, signer, amount, amountStr) {
  const ownerBal = await hre.ethers.provider.getBalance(signer.address);
  if (ownerBal < amount) {
    throw new Error(
      `Owner ETH ${hre.ethers.formatEther(ownerBal)} < DEPOSIT_AMOUNT ${amountStr}.`
    );
  }

  const reserveBefore = await kashYield.ownerEthReserve();
  const vaultBefore = await hre.ethers.provider.getBalance(kashYieldAddress);

  console.log("Asset:             native ETH");
  console.log("Deposit:           ", hre.ethers.formatEther(amount), "ETH");
  console.log("ownerEthReserve:   ", hre.ethers.formatEther(reserveBefore), "(before)");
  console.log("Vault ETH (raw):   ", hre.ethers.formatEther(vaultBefore), "(before)");
  console.log("");

  console.log("Step 1: markOwnerEthDeposit({ value: amount })...");
  const tx = await kashYield.markOwnerEthDeposit({ value: amount });
  await tx.wait();
  console.log("  Done.", tx.hash);

  const reserveAfter = await kashYield.ownerEthReserve();
  const vaultAfter = await hre.ethers.provider.getBalance(kashYieldAddress);
  console.log("");
  console.log("ownerEthReserve:   ", hre.ethers.formatEther(reserveAfter), "(after)");
  console.log("Vault ETH (raw):   ", hre.ethers.formatEther(vaultAfter), "(after)");
}

async function runWbtc(kashYield, kashYieldAddress, signer, amount, amountStr) {
  const wbtcAddress = await kashYield.wbtcAddress();
  const wbtc = await hre.ethers.getContractAt(ERC20_ABI, wbtcAddress, signer);

  const ownerBal = await wbtc.balanceOf(signer.address);
  if (ownerBal < amount) {
    throw new Error(
      `Owner wBTC ${hre.ethers.formatUnits(ownerBal, 8)} < DEPOSIT_AMOUNT ${amountStr}.`
    );
  }

  const reserveBefore = await kashYield.ownerWbtcReserve();
  const vaultBefore = await wbtc.balanceOf(kashYieldAddress);

  console.log("Asset:             wBTC", wbtcAddress);
  console.log("Deposit:           ", hre.ethers.formatUnits(amount, 8), "wBTC");
  console.log("ownerWbtcReserve:  ", hre.ethers.formatUnits(reserveBefore, 8), "(before)");
  console.log("Vault wBTC (raw):  ", hre.ethers.formatUnits(vaultBefore, 8), "(before)");
  console.log("");

  await approveErc20IfNeeded(wbtc, signer.address, kashYieldAddress, amount, "wBTC");

  console.log("Step 2: markOwnerWbtcDeposit(amount)...");
  const tx = await kashYield.markOwnerWbtcDeposit(amount);
  await tx.wait();
  console.log("  Done.", tx.hash);

  const reserveAfter = await kashYield.ownerWbtcReserve();
  const vaultAfter = await wbtc.balanceOf(kashYieldAddress);
  console.log("");
  console.log("ownerWbtcReserve:  ", hre.ethers.formatUnits(reserveAfter, 8), "(after)");
  console.log("Vault wBTC (raw):  ", hre.ethers.formatUnits(vaultAfter, 8), "(after)");
}

async function main() {
  const asset = parseAsset();
  const amountStr = (process.env.DEPOSIT_AMOUNT || process.env.AMOUNT || "").trim();
  const amount = parseAmount(asset, amountStr);
  if (amount <= 0n) {
    throw new Error("DEPOSIT_AMOUNT must be positive.");
  }

  if (asset === "eth") process.env.PRODUCT = "eth";
  if (asset === "wbtc") process.env.PRODUCT = "btc";

  const { contractName, kashYieldAddress, isBtc } = resolveKashYieldProduct(hre.ethers);
  if (asset === "eth" && isBtc) {
    throw new Error("ASSET=eth requires KashYieldETH (PRODUCT=eth).");
  }
  if (asset === "wbtc" && !isBtc) {
    throw new Error("ASSET=wbtc requires KashYieldBtc (PRODUCT=btc).");
  }

  const [signer] = await hre.ethers.getSigners();
  const kashYield = await hre.ethers.getContractAt(contractName, kashYieldAddress, signer);
  await assertOwner(kashYield, signer);

  console.log("Network:           ", hre.network.name);
  console.log("Vault:             ", contractName, kashYieldAddress);
  console.log("Owner:             ", signer.address);
  console.log("ASSET:             ", asset);
  console.log("");

  if (asset === "usdc") {
    await runUsdc(kashYield, kashYieldAddress, signer, amount, amountStr);
  } else if (asset === "eth") {
    await runEth(kashYield, kashYieldAddress, signer, amount, amountStr);
  } else {
    await runWbtc(kashYield, kashYieldAddress, signer, amount, amountStr);
  }

  console.log(
    "Owner reserve credited (excluded from user NAV). USDC reserve is released via coverUsdcShortfall during bot ops."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
