# Verify NAV

This page explains how to check that the **Net Asset Value (NAV)** shown for KASH-ETH and KASH-BTC is reasonable — using public on-chain data and market APIs, without trusting the app or operator alone.

For background on what NAV means, see [How Yield Works](how-yield-works.md).

---

## Easiest path: use an AI agent

The fastest way to verify NAV is to point your AI assistant or autonomous agent at **this document** and ask it to run the verification steps below (read on-chain NAV, rebuild portfolio value, compare, and report any gap).

If you prefer to do it yourself, follow the manual steps in the rest of this page.

---

## What you are checking

Each KASH token is priced in **USD per token** (18 decimal places on-chain). The vault stores the latest value in **`currentNAV()`** (also exposed as **`getNAV()`**).

Important: the contract does **not** recompute NAV from balances automatically. The operator bot calculates portfolio value off-chain and submits it via **`updateNAV`**. Your job is to **independently estimate** portfolio value ÷ KASH supply and compare that to the published NAV.

Live vault addresses are in [Agent Quickstart](agent-quickstart.md#1-network-and-addresses) and [Getting Started](getting-started.md#live-contract-addresses-arbitrum-one).

---

## Step 1 — Read the published NAV

Pick the product (**KASH-ETH** or **KASH-BTC**) and read from its **KashYield** vault on **Arbitrum One** (chain ID `42161`):

| Read | Meaning |
|------|---------|
| `currentNAV()` or `getNAV()` | USD per KASH token (18 decimals; `1e18` = $1.00) |
| `kashTokenEth()` / `kashTokenBtc()` | KASH ERC-20 address |
| `totalSupply()` on the KASH token | Outstanding KASH (18 decimals) |

**Ways to read:**

- **App** — “Current NAV” on the ETH or BTC tab (mirrors `currentNAV()`).
- **Arbiscan** — open the vault → **Contract** → **Read Contract** → call `getNAV()` and the KASH token’s `totalSupply()`.
- **Wallet / script** — any Arbitrum RPC + the KashYield ABI ([`frontend/lib/contracts/kashYieldABI.ts`](../frontend/lib/contracts/kashYieldABI.ts)).

**Total vault AUM (USD):**

```
Total NAV (USD) = currentNAV × totalSupply ÷ 1e18
```

Both values use 18 decimals.

---

## Step 2 — The verification formula

The operator uses the same core math as below. In plain terms:

```
Portfolio value (USD)  =  asset leg (USD)  +  net USDC leg (USD)
NAV per KASH (USD)     =  Portfolio value (USD)  ÷  KASH total supply
```

### Asset leg (ETH or wBTC, in USD)

Sum **user-owned** collateral across three places, then mark to market:

1. **On the vault contract** — native ETH (ETH product) or wBTC balance (BTC product), **minus**:
   - `ownerEthReserve()` / `ownerWbtcReserve()` (owner buffer, not user NAV)
   - `lockedClaimEth()` / `lockedClaimWbtc()` (wBTC/ETH reserved for unclaimed redeem Merkle payouts)
2. **On Aave V3** — supplied WETH or wBTC collateral for the vault address (Aave pool: `aavePoolAddress()` on the vault).
3. **On Hyperliquid (via adapter)** — spot ETH/wBTC synced on the adapter (`getExchangeAssetBalance()` on the vault).

Convert the total to USD using the vault’s Chainlink oracle:

- KASH-ETH: `getEthPrice()` (8 decimals)
- KASH-BTC: `getBtcPrice()` (8 decimals)

```
asset USD  =  total ETH/wBTC units  ×  oracle price  ÷  10^assetDecimals
```

(assetDecimals = 18 for ETH, 8 for wBTC; oracle is 8 decimals.)

### Net USDC leg (USD)

```
net USDC (6 decimals)  =  USDC on vault  +  HL account equity  −  Aave USDC debt
```

- **USDC on vault** — ERC-20 `balanceOf(vault)` minus `ownerUsdcReserve()`.
- **HL account equity** — Hyperliquid **perp account value** (includes unrealized PnL and spot USDC). This is read from the Hyperliquid public API for the vault’s HL account (the adapter’s `hlAccount()` or equivalent). The on-chain adapter may lag until synced; the bot refreshes from the API before NAV writes.
- **Aave USDC debt** — variable USDC borrow against the vault on Aave V3 (includes accrued interest).

Convert to 18-decimal USD: `net USDC USD = net USDC × 10^12` (USDC has 6 decimals).

Also subtract **`totalOwnerCoverUsdc()`** (owner USDC receivable accounting — not part of user NAV).

### Pending mints (snapshot timing)

When checking NAV **between batches**, subtract the USD value of **pending mint requests** still sitting on the vault (they belong to future minters, not existing KASH holders). The bot excludes these at pre-batch reads. During batch settlement the rules adjust for mint/redeem fees and supply changes — for a spot check outside batch processing, excluding pending mint collateral is the right conservative step.

### Final NAV check

```
computed NAV  =  portfolio USD × 1e18 ÷ totalSupply
```

Compare **`computed NAV`** to **`currentNAV()`**. Small differences can appear from HL API vs adapter sync timing, oracle staleness, or rounding. A large or persistent gap warrants investigation.

---

## Step 3 — Manual checklist (Arbiscan + public APIs)

### KASH-ETH

1. Note `currentNAV()` and KASH-ETH `totalSupply()`.
2. Read vault **ETH balance** (Arbiscan balance), minus `ownerEthReserve()` and `lockedClaimEth()`.
3. On **Aave V3** Arbitrum pool (`aavePoolAddress()`), read supplied **WETH** for the vault (`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`).
4. Call vault **`getExchangeAssetBalance()`** for HL spot ETH (after adapter sync).
5. Read **`getEthPrice()`** on the vault; compute asset USD.
6. Read vault **USDC** balance (`usdcAddress()`), minus `ownerUsdcReserve()`.
7. Query **Hyperliquid** account value for the vault’s HL master/agent address (see adapter on Arbiscan).
8. Read **Aave USDC variable debt** for the vault.
9. Subtract **`totalOwnerCoverUsdc()`** and pending-mint collateral if applicable.
10. Compute portfolio ÷ supply; compare to `currentNAV()`.

### KASH-BTC

Same flow, replacing ETH with **wBTC** (`wbtcAddress()`), `ownerWbtcReserve()`, `lockedClaimWbtc()`, and `getBtcPrice()`.

### Hyperliquid API (account equity)

The public HL **info** endpoint is `https://api.hyperliquid.xyz/info`. Query clearinghouse / account state for the protocol’s Hyperliquid account (the address configured on the **HyperliquidAdapter** — readable on Arbiscan). This is the main off-chain input a manual verifier must replicate.

---

## Step 4 — Audit past NAV updates

Every NAV write emits **`NAVProposedAndUpdated`** on the vault with:

- `newNAV`
- `usdcBalance`, `assetBalance`, `perpPnL` (snapshot arguments)
- `timestamp`

On **Arbiscan** → vault → **Events**, filter by `NAVProposedAndUpdated` to see history and compare day-over-day moves.

On-chain guard: each `updateNAV` call may move NAV by at most **±15%** from the previous value (`NAV_MAX_DEVIATION_BPS = 1500`). Larger jumps require multiple batch updates.

---

## What “good” looks like

| Check | Expectation |
|-------|-------------|
| App vs `getNAV()` | Should match (same RPC read) |
| Computed vs on-chain NAV | Close under normal conditions; investigate large gaps |
| NAV history | Gradual moves with yield and costs; no single-step jump > 15% |
| After batch | NAV updates appear in the processing window (~23:40–23:59 UTC); see [How Yield Works](how-yield-works.md) |

---

## Limits (read before relying on verification)

- **Operator trust remains for settlement NAV** — you can verify inputs and spot-check math, but Phase 2 mint/redeem sizing uses the NAV the bot submits at batch time. Malicious or buggy NAV submission is a known risk; see [Risks & Safeguards](risks.md).
- **Hyperliquid is off-chain** — full verification requires the HL API (or trusting adapter sync state). Planned upgrades may move more valuation on-chain; see [How Yield Works](how-yield-works.md#when-is-nav-updated).
- **Between batches**, on-chain NAV may **lag** live portfolio MTM until the next `updateNAV`.
- **Indicative APY** in the app (P.A. Yield) is a **forward-looking estimate** from funding and Aave rates — it is **not** realized NAV growth. Do not confuse it with verified NAV.

---

## Related pages

- [How Yield Works](how-yield-works.md) — strategy and NAV definition
- [Agent Quickstart](agent-quickstart.md) — contract addresses and preflight reads
- [Risks & Safeguards](risks.md) — operator and oracle risks
- [Fees](fees.md) — what affects portfolio value vs NAV over time
