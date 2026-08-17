# How Yield Works

KASH earns yield through a **delta-neutral funding rate strategy**. This page explains what that means and how it benefits token holders.

---

## The strategy in plain terms

When ETH is deposited into KASH:

1. ETH is deposited into **Aave** as collateral
2. The protocol borrows **USDC** against that collateral
3. Collateral and margin are managed on **Aster**, an Arbitrum-native perp DEX
4. The protocol opens a **short ETH position** sized to hedge the collateral

The result: the protocol holds ETH (long via Aave collateral) and a short on Aster of equivalent economic exposure. The two sides largely cancel out — limited directional exposure to ETH price. This is what “delta-neutral” means.

**The yield comes from funding rates.** On perpetuals exchanges, when the futures price is above the oracle price, longs often pay shorts (positive funding). When funding is positive, the short leg earns income that accrues to the vault and flows to token holders through a rising **NAV**. Funding can turn negative — then shorts pay longs and NAV can stagnate or fall.

---

## Net Asset Value (NAV)

Every KASH token is priced at the current **NAV — Net Asset Value**:

```
NAV = Total Portfolio Value (USD) ÷ Total KASH Supply
```

**What's in the portfolio (typical):**
- ETH / wBTC in Aave collateral
- USDC and position value on **Aster**
- Accrued funding and lending interest
- Vault cash and spot balances

**What's subtracted:**
- USDC borrowed from Aave
- Borrow interest owed
- Unrealised losses on hedges (if any)

NAV starts at **$1.00** per KASH at launch (`1e18` wei). As yield accrues, NAV increases.

---

## When is NAV updated?

NAV is updated **during daily batch processing** (typically in the processing window before settlement). The operator bot:

1. Marks the portfolio to market from on-chain reads (Aave, Aster, vault, Chainlink)
2. Runs batch ops (Aave + Aster + swaps as needed)
3. Submits **`updateNAV`** and settles the batch (Merkle claims for mints and redeems)

The contract does **not** auto-compute NAV from all legs in one on-chain function — the bot submits the value. Submissions are emitted on-chain for audit.

> **Roadmap:** Tighter on-chain NAV checks and **Chainlink Automation** for upkeep are planned to reduce operator trust assumptions further.

---

## The daily batch cycle

Every **24 hours** (cycle length is **fixed at deploy** on Aster vaults — confirm live times in the app):

| Phase | Typical time (UTC) | What happens |
|-------|-------------------|--------------|
| User window | Start of cycle → ~23:40 | `requestMint` / `requestRedeem` accepted |
| Processing window | ~23:40 → end of cycle | Batch ops + settlement; new requests **rejected** |
| After settlement | Same cycle | **`claimMint`** / **`claimRedeem`** with Merkle proofs |

Submit before the processing window cutoff to be included in that day's batch.

**Aster note:** Phase 1 for cycle **N+1** **reverts** if cycle **N** is still in Phase 1 (batch overlap guard).

---

## What determines yield?

The main driver is the **funding rate** on Aster perps:

- Bull markets: funding is often positive — shorts earn
- Bear or sideways: funding can flip negative — vault pays
- Aave supply interest on collateral adds a smaller base return

Historical funding has often been positive in bull cycles; **future funding is not guaranteed**.

The app’s **P.A. Yield** is an **indicative** annualised figure computed in the browser from live **Aster funding** and **Aave** rates plus documented strategy multipliers — not a promise of realised NAV growth.
