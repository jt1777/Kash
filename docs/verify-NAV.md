# Verify NAV

This page explains how to check that the **Net Asset Value (NAV)** shown for **KASH-ETH** and **KASH-BTC** is reasonable on the **4626/7540 Aster vaults** (`aster` branch) — using public on-chain data on **Arbitrum One**, without trusting the app or operator alone.

> **Legacy Hyperliquid stack:** The `main` branch deploys a separate, older **Hyperliquid (HL)** vault design with different custody and addresses. This guide applies to **Aster** vaults only.

For background on what NAV means, see [How Yield Works](how-yield-works.md).

---

## Easiest path: use an AI agent

The fastest way to verify NAV is to point your AI assistant at **this document** and ask it to run the verification steps below (read on-chain NAV, rebuild portfolio value from Arbitrum contracts, compare, and report any gap).

If you prefer to do it yourself, follow the manual steps on this page.

---

## What you are checking

Each KASH share is priced in **USD per share** (18 decimal places on-chain). The vault exposes **`getNAV()`** (also **`currentNAV()`**).

The contract **computes NAV on-chain** from Aster Clearing House `getAccountValue(adapter)`, Aave aToken / variable-debt balances, idle WETH/wBTC/USDC, and Chainlink. The bot cannot inject NAV or the redeem pool.

**Aster advantage for verification:** Perp margin and PnL live **on Arbitrum** through **`AsterAdapter`** — there is no cross-chain Hyperliquid API or hot-wallet master account to reconcile.

Vault addresses are **environment-specific** after deploy. Find yours in the app footer, [`frontend/lib/contracts/addresses.ts`](../frontend/lib/contracts/addresses.ts), or [Getting Started](getting-started.md#live-contract-addresses-arbitrum-one). The **share token is the vault**.

---

## Step 1 — Read the published NAV

Pick the product (**KASH-ETH** or **KASH-BTC**) and read from its **vault** on **Arbitrum One** (chain ID `42161`):

| Read | Meaning |
|------|---------|
| `currentNAV()` or `getNAV()` | USD per share (18 decimals; `1e18` = $1.00) |
| `share()` / `address(this)` | Share token = vault |
| `totalSupply()` | Outstanding shares (18 decimals) |
| `totalAssets()` | AUM in asset units (WETH wei / wBTC 8-dec) |
| `botAddress()` | Operator that triggers batches and trades |
| `exchangeFacade()` | Immutable router to Aave, Aster, and spot DEX |

**Ways to read:**

- **App** — “Current NAV” on the ETH or BTC tab (mirrors `getNAV()`).
- **Arbiscan** — vault → **Contract** → **Read Contract**.
- **Wallet / script** — Arbitrum RPC + product ABI ([`kashVaultEthABI.ts`](../frontend/lib/contracts/kashVaultEthABI.ts) / [`kashVaultBtcABI.ts`](../frontend/lib/contracts/kashVaultBtcABI.ts)).

**Total vault AUM (USD):**

```
Total NAV (USD) = getNAV × totalSupply ÷ 1e18
```

---

## Step 2 — The verification formula

In plain terms:

```
Portfolio value (USD)  =  idle asset USD  +  Aave net USD  +  Aster account value (USD)
NAV per share (USD)    =  Portfolio value (USD)  ÷  share total supply
```

### Asset leg (ETH or wBTC, in USD)

1. **Idle vault asset** — WETH or wBTC `balanceOf(vault)`, minus `lockedClaimAsset` (reserved for unclaimed redeem payouts), minus pending deposit assets that have not minted yet.
2. **On Aave V3** — aToken balance for the vault (pool: typically `0x794a61358D6845594F94dc1DB02A252b5b4814aD` on Arbitrum One).

Convert with the vault’s Chainlink oracle:

- KASH-ETH: `getEthPrice()` (18-decimal USD)
- KASH-BTC: `getBtcPrice()` (18-decimal USD)

### Aster equity (USD)

Read **Clearing House** `getAccountValue(asterAdapter)` — 18-dec USD at Aster’s mark. Do **not** also add `getBalance` on the Aster vault (that would double-count).

Known Aster **Clearing House** on Arbitrum One: `0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5`.

### Net USDC / Aave debt

```
net USDC  =  USDC on vault  −  Aave variable USDC debt  (+ aToken USDC if any)
```

### Pending mints

Pending deposit assets sit on the vault but do not belong to existing shareholders until shares mint at Phase 2. Subtract them from idle+Aave so they do not inflate NAV.

### Final NAV check

```
computed NAV  =  portfolio USD × 1e18 ÷ totalSupply
```

Compare **`computed NAV`** to **`getNAV()`**. Small gaps can come from rounding. A large or persistent gap warrants investigation.

---

## Step 3 — Manual checklist (Arbiscan)

### Confirm the Aster stack

1. On the vault: `exchangeFacade()` → open the facade on Arbiscan.
2. On the facade: `perpExchangeAddress()` → should be your **AsterAdapter**.
3. On AsterAdapter: `clearingHouse()` / `vault()` point at Aster protocol contracts.

### KASH-ETH

1. Note `getNAV()` and vault `totalSupply()`.
2. Vault **WETH** balance minus `lockedClaimAsset` minus pending deposits.
3. **Aave V3** — vault’s aWETH.
4. **`getEthPrice()`**; compute asset USD.
5. Vault **USDC** and Aave USDC variable debt.
6. Clearing House **`getAccountValue(adapter)`**.
7. Compute portfolio ÷ supply; compare to `getNAV()`.

### KASH-BTC

Same flow with **wBTC** and `getBtcPrice()`.

---

## Step 4 — On-chain NAV guards

- Each NAV write (Phase 1/2) is capped at **±15%** vs previous NAV and vs `cycleStartNAV` (`NAV_MAX_DEVIATION_BPS = 1500`).
- Phase 2 settlement vs `cycleStartNAV` must stay within **`SETTLEMENT_DEVIATION_BPS` (200)**. Excess reverts (`SettlementDeviationTooLarge` / `NavMonitorTripped`).
- Owner `correctNAV` is bounded to **±5%** of `cycleStartNAV` (`CORRECT_NAV_MAX_DEVIATION_BPS = 500`).

There is **no** `updateNAV` on these vaults.

---

## What “good” looks like

| Check | Expectation |
|-------|-------------|
| App vs `getNAV()` | Should match (same RPC read) |
| Facade → AsterAdapter | Immutable; matches deploy docs / Arbiscan |
| Computed vs on-chain NAV | Close under normal conditions; investigate large gaps |
| After batch | Settlement NAV vs Phase-1 anchor within 200 bps |

---

## Limits (read before relying on verification)

- **Aster mark** — the short is marked at Aster’s on-chain mark, not Chainlink. Flash-manipulation is mitigated by the batch-time settlement band and an optional off-chain watcher.
- **Owner / watcher** — owner can pause, rotate bot/watcher, and nudge NAV ±5%. Watcher can pause only. Anyone can unpause after 7 days.
- **Indicative APY** in the app (P.A. Yield) is a **forward-looking estimate** — not realized NAV growth.

---

## Related pages

- [How Yield Works](how-yield-works.md) — strategy and NAV definition
- [Agent Quickstart](agent-quickstart.md) — 7540 call sequence, ABIs, preflight reads
- [Risks & Safeguards](risks.md) — Aster custody vs legacy HL, operator risks
- [Fees](fees.md) — protocol fee and portfolio costs vs NAV
