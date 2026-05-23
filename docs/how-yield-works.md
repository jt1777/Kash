# How Yield Works

KASH earns yield through a **delta-neutral funding rate strategy**. This page explains what that means and how it benefits you.

---

## The strategy in plain terms

When you deposit ETH into KASH:

1. Your ETH is deposited into a **lending protocol** as collateral
2. The protocol borrows **USDC** against that collateral
3. The USDC is sent to a **perpetuals exchange (perp DEX)**
4. On the perp DEX, the protocol opens a **short ETH position** of equivalent size

The result: the protocol holds ETH (long) and simultaneously holds a short ETH position of the same size. The two positions cancel out — no directional exposure to ETH price. This is what "delta-neutral" means.

**The yield comes from funding rates.** On perpetuals exchanges, when the futures price is greater than the oracle price (or spot market price) traders who are long pay a fee to traders who are short (funding rate is positive). If the futures price is below the oracle price, then trader who are short pay a fee to traders who are long (funding rate is negative).  When longs dominate the market — which is historically common in bull markets — shorts earn a continuous funding rate income. That income accrues to the protocol and flows back to you through an increasing NAV.

---

## Net Asset Value (NAV)

Every KASH token is priced at the current **NAV — Net Asset Value**. NAV represents the total value of everything the protocol holds, divided by the total number of KASH tokens in circulation.

```
NAV = Total Portfolio Value (USD) ÷ Total KASH Supply
```

**What's in the portfolio:**
- ETH / wBTC held in the lending protocol
- USDC in the perp DEX trading account
- Accrued funding fees and interest
- Value of open perpetual positions

**What's subtracted:**
- USDC borrowed from the lending protocol
- Interest owed on borrowings
- Any unrealised losses on positions

NAV starts at $1.00 when the protocol launches. As yield accrues, NAV increases. When you redeem, you receive assets worth your KASH × current NAV.

---

## When is NAV updated?

NAV is updated **once per day** during batch processing (around 23:50–23:59 UTC). The operator calculates the true portfolio value off-chain, then submits the new NAV to the contract before distributing tokens. This means the NAV you see in the app reflects the previous day's closing value.

The contract does not automatically calculate NAV from the portfolio — the operator calculates portfolio value externally and submits it each day. On-chain price feeds are used to value deposits at batch time, but the complete portfolio valuation (collateral positions, perp position values, accrued funding) is computed by the operator and then written to the contract. All NAV submissions are recorded on-chain and publicly verifiable.

> **Roadmap — automated on-chain NAV:** All portfolio balances (lending protocol collateral, borrowed stablecoin, perp DEX spot balance and position value) are readable from on-chain contracts in the current deployment. A planned upgrade will compute NAV directly on-chain from those balances, combined with automated daily execution via Chainlink Automation. This will remove the need for any manual NAV submission and eliminate the operator trust assumption entirely. On mainnet with a cross-chain perp exchange, a compatible cross-chain data solution would also be required for the perp side.

---

## The daily batch cycle

Every 24 hours:

| Time (UTC) | What happens |
|-----------|--------------|
| 00:00 – 23:49 | User window: you can submit deposits and redemptions |
| 23:50 – 23:59 | Processing window: batch runs, no new requests accepted |
| After 23:59 | Batch complete: KASH tokens sent to depositors, assets sent to redeemers |

Your deposit or redemption will be included in the batch for the day you submit it, as long as you submit before **23:50 UTC**.

---


## What determines yield?

The main driver is the **funding rate** on perpetuals markets:

- In sustained bull markets, funding rates for shorts are typically positive — you earn
- In bear markets or sideways conditions, funding rates can turn negative — you pay
- The lending protocol also earns interest on the ETH collateral, which adds a small base return

Historical funding rates on perpetuals have generally been positive over bull cycles, however this is not guaranteed for future periods.
