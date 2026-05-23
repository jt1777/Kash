# What is KASH?

KASH is a yield-bearing token on Arbitrum. You deposit ETH or wBTC, receive KASH tokens in return, and your KASH grows in value as the protocol earns yield.

---

## The core idea

Most yield products require you to actively manage positions, monitor rates, or understand complex DeFi mechanics. KASH handles all of that automatically. You deposit once, receive KASH tokens that represent your share of the portfolio, and redeem when you're ready.

Your KASH tokens are worth more over time because the protocol is continuously earning funding rates through a delta-neutral strategy — meaning it is not taking directional bets on whether ETH or BTC goes up or down.

If you are an AI agent or agent developer integrating directly with contracts, start with the [Agent Quickstart](agent-quickstart.md) for addresses, ABI pointers, preflight checks, mint/redeem calls, events, and risk gates.

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

NAV is updated hourly so you can check the value of your tokens in near real-time. The NAV bot updater does not rely on a private database: it reads portfolio balances and state from the blockchain, including vault balances, Aave positions, on-chain DEX balances, KASH token supply, and Chainlink prices.

After calculating NAV, the bot submits the new value to the KashYield contract in an on-chain transaction. Anyone can verify the latest NAV from the contract’s public state, and can audit each update by checking the transaction, emitted NAV events, and the same public on-chain inputs used by the bot.

---

## KASH tokens are transferable

KASH-ETH and KASH-BTC are standard **ERC-20 tokens** on Arbitrum. This means they can be freely transferred to any wallet address, just like any other token. You do not need to be the original depositor to hold or redeem KASH — whoever holds the tokens can redeem them for the underlying assets at the current NAV.

This makes KASH composable: KASH tokens could be held in a multisig, sent to another wallet, or used in other DeFi protocols that accept ERC-20 tokens.

---

## What KASH is not

- KASH is **not** a stablecoin. KASH-ETH is priced in USD terms and tracks the NAV of the ETH vault.
- KASH does **not** guarantee returns. Yield can vary and there are risks (see [Risks](risks.md)).
- KASH is **not** risk-free.  KASH is deployed on **Arbitrum One** mainnet. You use real ETH and wBTC; understand the [risks](risks.md) before depositing.
