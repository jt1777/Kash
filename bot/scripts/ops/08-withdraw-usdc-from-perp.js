/**
 * 08-withdraw-usdc-from-perp — Withdraw USDC from the Hyperliquid adapter → KashYield.
 *
 * Important: Hyperliquid USDC lives on HL first. USDC only appears on Arbitrum at the
 * **adapter** address after an HL withdraw + bridge. `getHyperliquidSpotBalance()` /
 * script 14 only update the **mirror** on the adapter; they do not move coins.
 * If the adapter's Arbitrum USDC balance is 0, this tx still **succeeds** but
 * **transfers 0** to KashYield — run HL withdraw3 to the adapter (or the bot
 * settlement path), wait for the bridge, then re-run this script.
 *
 * Auto: AMOUNT unset → use max(perp mirror, USDC.balanceOf(adapter)).
 * Override: AMOUNT=7.86 (human USDC).
 *
 * Usage:
 *   PRODUCT=btc npx hardhat run bot/scripts/ops/08-withdraw-usdc-from-perp.js --network arbitrumOne
 */
const { ethers } = require("hardhat");
const {
  getContract,
  getExchangeTarget,
  getState,
  displayState,
  parseUsdc,
  fmtUsdc,
  exec,
  PRODUCT,
  assertKashYieldOpsSigner,
  getSigner,
} = require("./_utils");

async function resolveHlAdapter(contract) {
  let active = "";
  try {
    active = await contract.activePerpExchange();
  } catch {
    active = "";
  }
  let adapter = ethers.ZeroAddress;
  if (active) {
    try {
      adapter = await contract.perpExchanges(active);
    } catch {
      adapter = ethers.ZeroAddress;
    }
  }
  if (!adapter || adapter === ethers.ZeroAddress) {
    try {
      adapter = await contract.hyperliquidAddress();
    } catch {
      adapter = ethers.ZeroAddress;
    }
  }
  return adapter;
}

async function main() {
  console.log(`\n08 — Withdraw USDC from perp DEX  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const signer = await getSigner();
  await assertKashYieldOpsSigner(contract, signer.address);

  const vault = await contract.getAddress();
  const adapter = await resolveHlAdapter(contract);
  const usdcAddr = await contract.usdcAddress();
  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider,
  );

  const before = await getState(contract);
  displayState(before, "Before");

  const perpView = before.perpUsdc;
  let adapterStored = 0n;
  let adapterErc20 = 0n;
  if (adapter && adapter !== ethers.ZeroAddress) {
    const adView = new ethers.Contract(
      adapter,
      ["function usdcBalance() view returns (uint256)"],
      ethers.provider,
    );
    try {
      adapterStored = BigInt((await adView.usdcBalance()).toString());
    } catch {
      adapterStored = 0n;
    }
    adapterErc20 = BigInt((await usdc.balanceOf(adapter)).toString());
  }

  const vaultUsdcBefore = BigInt((await usdc.balanceOf(vault)).toString());

  console.log("\n  ── Withdraw checklist ─────────────────────────────────────");
  console.log(`  KashYield:              ${vault}`);
  console.log(`  HL adapter:             ${adapter}`);
  console.log(`  getSpotBalance mirror: ${fmtUsdc(perpView)}`);
  console.log(`  adapter.usdcBalance:    ${fmtUsdc(adapterStored)}`);
  console.log(`  USDC on adapter (Arb):  ${fmtUsdc(adapterErc20)}  ← only this can move on-chain`);
  console.log(`  Vault USDC (raw):       ${fmtUsdc(vaultUsdcBefore)}`);

  let amount;
  if (process.env.AMOUNT) {
    amount = parseUsdc(process.env.AMOUNT);
    console.log(`\n  Request (env AMOUNT): ${fmtUsdc(amount)}`);
  } else {
    amount = perpView > adapterErc20 ? perpView : adapterErc20;
    console.log(
      `\n  Request (auto max of mirror & adapter wallet): ${fmtUsdc(amount)}  ` +
        `(on-chain send = min(request, ${fmtUsdc(adapterErc20)} on adapter))`,
    );
  }

  if (amount === 0n) {
    console.log("\n❌ Nothing to withdraw — mirror and adapter wallet are 0.");
    console.log("   Run 14-hl-sync-state, then if HL still has USDC initiate HL withdraw to the adapter, wait for bridge.");
    return;
  }

  if (adapterErc20 === 0n) {
    console.warn(
      "\n⚠️  Adapter Arbitrum USDC = 0. The tx will likely move 0 USDC to KashYield (still succeeds on-chain).",
    );
    console.warn(
      "   HL USDC must be withdrawn to this adapter via HL withdraw3 / bot; wait for bridge, then re-run 08.\n",
    );
  }

  const { target: ex } = await getExchangeTarget(contract);
  await exec(`withdrawFromHyperliquid(${fmtUsdc(amount)})`, ex.withdrawFromHyperliquid(amount));

  const vaultUsdcAfter = BigInt((await usdc.balanceOf(vault)).toString());
  const adapterErc20After = BigInt((await usdc.balanceOf(adapter)).toString());
  const deltaVault = vaultUsdcAfter - vaultUsdcBefore;

  console.log("\n  ── Result ─────────────────────────────────────────────────");
  console.log(`  Vault USDC after:       ${fmtUsdc(vaultUsdcAfter)}`);
  console.log(`  Vault USDC Δ (raw):     ${fmtUsdc(deltaVault)}`);
  console.log(`  Adapter USDC after:     ${fmtUsdc(adapterErc20After)}`);

  if (deltaVault === 0n && amount > 0n) {
    console.log(
      "\n❌ No USDC arrived on KashYield. The adapter had nothing on Arbitrum to forward (see above).",
    );
    console.log(
      "   Next: HL API/UI withdraw to adapter " + adapter + ", wait 3–5 min, rerun 08 (and optionally 14).",
    );
  } else {
    displayState(await getState(contract), "After");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
