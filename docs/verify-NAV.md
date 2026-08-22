# Verify NAV

This page explains how to check that the **Net Asset Value (NAV)** shown for **KASH-ETH** and **KASH-BTC** is reasonable on the **ownerless Aster vaults** (`aster` branch) — using public on-chain data on **Arbitrum One**, without trusting the app or operator alone.

> **Legacy Hyperliquid stack:** The `main` branch deploys a separate, older **Hyperliquid (HL)** vault design with different custody and addresses. This guide applies to **Aster** vaults only.

For background on what NAV means, see [How Yield Works](how-yield-works.md).

---

## Easiest path: use an AI agent

The fastest way to verify NAV is to point your AI assistant at **this document** and ask it to run the verification steps below (read on-chain NAV, rebuild portfolio value from Arbitrum contracts, compare, and report any gap).

If you prefer to do it yourself, follow the manual steps on this page.

---

## What you are checking

Each KASH token is priced in **USD per token** (18 decimal places on-chain). The vault stores the latest value in **`currentNAV()`** (also exposed as **`getNAV()`**).

Important: the contract does **not** recompute NAV from balances automatically. The **bot** calculates portfolio value off-chain from on-chain reads and submits it via **`updateNAV`**. Your job is to **independently estimate** portfolio value ÷ KASH supply and compare that to the published NAV.

**Aster advantage for verification:** Perp margin and PnL live **on Arbitrum** through **`AsterAdapter`** — there is no cross-chain Hyperliquid API or hot-wallet master account to reconcile.

Vault addresses are **environment-specific** after deploy. Find yours in the app footer, [`frontend/lib/contracts/addresses.ts`](../frontend/lib/contracts/addresses.ts), or [Getting Started](getting-started.md#live-contract-addresses-arbitrum-one).

---

## Step 1 — Read the published NAV

Pick the product (**KASH-ETH** or **KASH-BTC**) and read from its **KashYield** vault on **Arbitrum One** (chain ID `42161`):

| Read | Meaning |
|------|---------|
| `currentNAV()` or `getNAV()` | USD per KASH token (18 decimals; `1e18` = $1.00) |
| `kashTokenEth()` / `kashTokenBtc()` | KASH ERC-20 address |
| `totalSupply()` on the KASH token | Outstanding KASH (18 decimals) |
| `botAddress()` | Operator that submits batch and NAV txs |
| `exchangeFacade()` | Immutable router to Aave, Aster, and spot DEX |

**Ways to read:**

- **App** — “Current NAV” on the ETH or BTC tab (mirrors `currentNAV()`).
- **Arbiscan** — vault → **Contract** → **Read Contract**.
- **Wallet / script** — Arbitrum RPC + KashYield ABI ([`frontend/lib/contracts/kashYieldABI.ts`](../frontend/lib/contracts/kashYieldABI.ts)).

**Total vault AUM (USD):**

```
Total NAV (USD) = currentNAV × totalSupply ÷ 1e18
```

---

## Step 2 — The verification formula

In plain terms:

```
Portfolio value (USD)  =  asset leg (USD)  +  net USDC leg (USD)
NAV per KASH (USD)     =  Portfolio value (USD)  ÷  KASH total supply
```

### Asset leg (ETH or wBTC, in USD)

Sum collateral backing KASH holders, then mark to market:

1. **On the KashYield vault** — native ETH (ETH product) or wBTC (`wbtcAddress()`), **minus** `lockedClaimEth()` / `lockedClaimWbtc()` (ETH/wBTC reserved for unclaimed redeem Merkle payouts). Aster vaults are **ownerless** — there is no `ownerEthReserve` / `ownerWbtcReserve`.
2. **On Aave V3** — supplied WETH or wBTC for the vault address (pool: `aavePoolAddress()`, typically `0x794a61358D6845594F94dc1DB02A252b5b4814aD` on Arbitrum One).

There is **no separate spot ETH/wBTC on Aster** — `getExchangeAssetBalance()` on the vault returns **0** for the Aster adapter (collateral sits on the vault and Aave, not on the perp venue).

Convert the total to USD using the vault’s Chainlink oracle:

- KASH-ETH: `getEthPrice()` (18-decimal USD price)
- KASH-BTC: `getBtcPrice()` (18-decimal USD price)

```
asset USD  =  total ETH/wBTC units  ×  oracle price  ÷  10^assetDecimals
```

(assetDecimals = 18 for ETH, 8 for wBTC.)

### Net USDC leg (USD)

```
net USDC (6 decimals)  =  USDC on vault  +  Aster adapter USDC  −  Aave USDC debt
```

- **USDC on vault** — ERC-20 `balanceOf(vault)` for `usdcAddress()` (native USDC on Arbitrum).
- **Aster adapter USDC** — call on the **vault** (proxied through the facade):
  - `getPerpExchangeSpotBalance()` — USDC balance in the **Aster vault** for the **AsterAdapter** (includes margin and unrealized PnL effects reflected in that balance).
- **Aave USDC debt** — variable USDC borrow against the vault on Aave V3.

Convert to 18-decimal USD: `net USDC USD = net USDC × 10^12`.

### Aster perp cross-check (optional)

To sanity-check the short hedge, read on the **vault**:

- `getPerpExchangePosition(symbol)` — position size, collateral, entry price, long/short flag.

Or read **AsterAdapter** on Arbiscan (`perpExchangeAddress()` from the facade):

- `clearingHouse()`, `vault()`, `accountBalance()`, `baseToken()`
- On Aster’s **Clearing House** (`getAccountValue(adapter)`) and **AccountBalance** (`getTotalPositionSize(adapter, baseToken)`, `getOpenNotional(...)`)

Known Aster **Clearing House** on Arbitrum One: `0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5`. Vault and account-balance reader addresses are fixed on your deployed adapter at construction time.

### Pending mints (snapshot timing)

Between batches, subtract the USD value of **pending mint requests** still on the vault (they belong to future minters, not existing KASH holders). During batch settlement the bot adjusts for mint/redeem fees and supply — for a spot check outside processing, excluding pending mint collateral is the conservative approach.

### Final NAV check

```
computed NAV  =  portfolio USD × 1e18 ÷ totalSupply
```

Compare **`computed NAV`** to **`currentNAV()`**. Small gaps can come from oracle staleness, pending-batch accounting, or rounding. A large or persistent gap warrants investigation.

---

## Step 3 — Manual checklist (Arbiscan)

### Confirm the Aster stack

1. On the KashYield vault: `exchangeFacade()` → open the facade on Arbiscan.
2. On the facade: `perpExchangeAddress()` → should be your **AsterAdapter** (not HyperliquidAdapter).
3. On AsterAdapter: `exchangeFacade()` round-trips to the same facade; `clearingHouse()` / `vault()` point at Aster protocol contracts.

### KASH-ETH

1. Note `getNAV()` and KASH-ETH `totalSupply()`.
2. Vault **ETH balance** minus `lockedClaimEth()`.
3. **Aave V3** — vault’s supplied **WETH** (`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`).
4. **`getEthPrice()`** on the vault; compute asset USD.
5. Vault **USDC** balance.
6. **`getPerpExchangeSpotBalance()`** on the vault (Aster USDC leg).
7. **Aave USDC variable debt** for the vault.
8. Optionally **`getPerpExchangePosition("ETH")`** (or the symbol your deployment uses).
9. Exclude pending-mint collateral if checking mid-cycle.
10. Compute portfolio ÷ supply; compare to `getNAV()`.

### KASH-BTC

Same flow with **wBTC** (`0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`), `lockedClaimWbtc()`, and `getBtcPrice()`.

---

## Step 4 — Audit past NAV updates

Every NAV write emits **`NAVProposedAndUpdated`** and **`NAVUpdateExecuted`** with:

- `newNAV`
- `usdcBalance`, `assetBalance`, `perpPnL` (snapshot arguments on `NAVProposedAndUpdated`)
- `timestamp`

On **Arbiscan** → vault → **Events**, filter by these events to review history.

**On-chain guards (Aster vaults):**

- Each `updateNAV` may move NAV by at most **±15%** vs the **previous** NAV (`NAV_MAX_DEVIATION_BPS = 1500`).
- Within the **same batch cycle**, NAV is also capped at **±15%** vs **`cycleStartNAV[cycle]`** (set when Phase 1 starts). Large moves require multiple updates across cycles or stepped writes.

---

## What “good” looks like

| Check | Expectation |
|-------|-------------|
| App vs `getNAV()` | Should match (same RPC read) |
| Facade → AsterAdapter | Immutable; matches deploy docs / Arbiscan |
| Computed vs on-chain NAV | Close under normal conditions; investigate large gaps |
| NAV history | Gradual moves with yield and costs; no single-step jump > 15% |
| After batch | NAV updates in the processing window (~23:40–23:59 UTC); see [How Yield Works](how-yield-works.md) |

---

## Limits (read before relying on verification)

- **Bot trust for settlement NAV** — you can rebuild portfolio from chain, but Phase 2 mint/redeem sizing uses the NAV the bot submits at batch time. See [Risks & Safeguards](risks.md).
- **Ownerless design** — no pause, no post-deploy config changes; a compromised **bot key** can still call allowed facade/adapter paths until stopped off-chain.
- **Between batches**, on-chain NAV may **lag** live portfolio MTM until the next `updateNAV`.
- **Indicative APY** in the app (P.A. Yield) is a **forward-looking estimate** — not realized NAV growth.

---

## Related pages

- [How Yield Works](how-yield-works.md) — strategy and NAV definition
- [Agent Quickstart](agent-quickstart.md) — Aster stack, ABIs, preflight reads
- [Risks & Safeguards](risks.md) — Aster custody vs legacy HL, operator risks
- [Fees](fees.md) — protocol fee and portfolio costs vs NAV
