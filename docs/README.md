# What is KASH?

Kash is an AI-managed, leveraged yield protocol built on Arbitrum, an Ethereum L2. ETH and wrapped Bitcoin deposits are posted as collateral on Aave to fund a perpetual futures position on Hyperliquid. The strategy is market-neutral — it earns funding rate premiums without taking directional risk. An AI agent runs the entire operational stack: batch settlement, rebalancing, and NAV pricing, autonomously and continuously. Deposits are segregated by smart contract, and all positions are independently auditable on-chain in real time.

---

## The core idea

Most yield products require users to actively manage positions, monitor rates, or understand complex DeFi mechanics. KASH handles all of that automatically. Users deposit once, receive KASH tokens that represent their share of the portfolio, and redeem as they wish.

KASH tokens are worth more over time because the protocol is continuously earning funding rates through a delta-neutral strategy — meaning it is not taking directional bets on whether ETH or BTC goes up or down.

Agent developers and autonomous integrators should refer to the [Agent Quickstart](agent-quickstart.md) for addresses, ABI pointers, preflight checks, mint/redeem claims & requests, events, and risk gates.

---

## Two products

| Product | Deposit asset | Token received | Network |
|---------|---------------|----------------|---------|
| **KASH-ETH** | ETH | KASH-ETH tokens | Arbitrum |
| **KASH-BTC** | wBTC | KASH-BTC tokens | Arbitrum |

The two products are independent. Depositing ETH yields KASH-ETH; depositing wBTC yields KASH-BTC. Both follow the same mechanics.

---

## How yield is tracked — NAV

KASH uses **Net Asset Value (NAV)** pricing. Every KASH token is priced at the current NAV in USD. On deposit, KASH tokens are minted at the current NAV. On redemption, underlying assets are returned at the then-current NAV. The difference between entry NAV and exit NAV represents yield.

**Example:**
- A deposit of 1 ETH when NAV = $1.00 → 1,800 KASH minted (if ETH = $1,800)
- Six months later NAV = $1.045 (4.5% yield accrued)
- Redemption of 1,800 KASH → ETH worth $1,800 × 1.045 = $1,881

NAV is updated periodically throughout the day so token value can be checked in near real-time. The NAV bot updater does not rely on a private database: it reads portfolio balances and state from the blockchain, including vault balances, Aave positions, on-chain DEX balances, KASH token supply, and Chainlink prices.

After calculating NAV, the bot submits the new value to the KashYield contract in an on-chain transaction. Anyone can verify the latest NAV from the contract’s public state, and can audit each update by checking the transaction, emitted NAV events, and the same public on-chain inputs used by the bot.

---

## KASH tokens are transferable

KASH-ETH and KASH-BTC are standard **ERC-20 tokens** on Arbitrum. They can be freely transferred to any wallet address, like any other token. Original depositor status is not required to hold or redeem KASH — the token holder may redeem for the underlying assets at the current NAV.

This makes KASH composable: KASH tokens can be held in a multisig, sent to another wallet, or used in other DeFi protocols that accept ERC-20 tokens.

---

## What KASH is not

- KASH is **not** a stablecoin. KASH-ETH is priced in USDC terms and tracks the NAV of the ETH vault.
- KASH does **not** guarantee returns. Yield can vary and there are risks (see [Risks](risks.md)).
- KASH is **not** risk-free. The protocol is deployed on **Arbitrum One** mainnet using real ETH and wBTC; participants should review the [risks](risks.md) before depositing.
