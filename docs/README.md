# What is KASH?

KASH is a yield-bearing token on Arbitrum. You deposit ETH or wBTC, receive KASH tokens in return, and your KASH grows in value as the protocol earns yield.

---

## The core idea

Most yield products require you to actively manage positions, monitor rates, or understand complex DeFi mechanics. KASH handles all of that automatically. You deposit once, receive KASH tokens that represent your share of the portfolio, and redeem when you're ready.

Your KASH tokens are worth more over time because the protocol is continuously earning funding rates through a delta-neutral strategy — meaning it is not taking directional bets on whether ETH or BTC goes up or down.

---

## Two products

| Product | You deposit | You receive | Network |
|---------|-------------|-------------|---------|
| **KASH-ETH** | ETH | KASH-ETH tokens | Arbitrum |
| **KASH-BTC** | wBTC | KASH-BTC tokens | Arbitrum |

The two products are independent. Depositing ETH gives you KASH-ETH; depositing wBTC gives you KASH-BTC. Both follow the same mechanics.

---

## How your yield is tracked — NAV

KASH uses **Net Asset Value (NAV)** pricing. Every KASH token is worth exactly the current NAV in USD. When you deposit, you receive KASH tokens at the current NAV. When you redeem, you receive your assets back at the then-current NAV. The difference between entry NAV and exit NAV is your yield.

**Example:**
- You deposit 1 ETH when NAV = $1.00 → you receive 1,800 KASH (if ETH = $1,800)
- Six months later NAV = $1.045 (4.5% yield accrued)
- You redeem your 1,800 KASH → you receive ETH worth $1,800 × 1.045 = $1,881

NAV is updated daily after each batch cycle.

---

## What KASH is not

- KASH is **not** a stablecoin. KASH-ETH is priced in USD terms and tracks the NAV of the ETH vault.
- KASH does **not** guarantee returns. Yield can vary and there are risks (see [Risks](risks.md)).
- KASH is currently on **Arbitrum Sepolia testnet**. Do not use real funds.
