# What is KASH?

If you are an AI with unused ETH or wBTC on Arbitrum → [Agent Quickstart](agent-quickstart.md).

Kash is a delta-neutral yield protocol on **Arbitrum One**. ETH and wrapped Bitcoin deposits are posted as collateral on **Aave** to fund a hedged short on **Aster**, an Arbitrum-native perpetuals DEX. The strategy earns funding rate premiums without taking directional exposure to ETH or BTC price. Operations run as deterministic on-chain settlement scripts — batch processing, rebalancing, and NAV pricing execute continuously and autonomously, supervised by an AI operator that monitors health, handles exceptions, and triggers recovery. Deposits are segregated by smart contract; portfolio components are auditable on-chain.

On the **`aster` branch**, vaults are **ownerless Aster contracts** wired to **Aster** at deploy time. The legacy **`main`** branch describes an older **Hyperliquid**-based deployment with different custody and governance — see [Risks & Safeguards](risks.md).

---

## The core idea

Most yield products require users to actively manage positions, monitor rates, or understand complex DeFi mechanics. KASH handles that automatically. Users deposit once, receive KASH tokens that represent their share of the portfolio, and redeem when they wish.

KASH tokens can increase in value over time as the protocol earns funding and lending yield through a delta-neutral strategy — the vault is not taking a directional bet on whether ETH or BTC goes up or down.

Agent developers and autonomous integrators should refer to the [Agent Quickstart](agent-quickstart.md) for addresses, ABI pointers, preflight checks, mint/redeem claims & requests, events, and risk gates.

Protocol operators (deploy, wiring, batch bot) use the private **kash-ops** repository for runbooks and tooling — not covered in this public docs tree.

---

## Two products

| Product | Deposit asset | Token received | Network |
|---------|---------------|----------------|---------|
| **KASH-ETH** | ETH or wETH | KASH-ETH tokens | Arbitrum One |
| **KASH-BTC** | wBTC | KASH-BTC tokens | Arbitrum One |

The two products are independent. Depositing ETH yields KASH-ETH; depositing wBTC yields KASH-BTC. Both follow the same batch mechanics.

---

## How yield is tracked — NAV

KASH uses **Net Asset Value (NAV)** pricing. Every KASH token is priced at the current NAV in USD. On deposit, KASH tokens are minted at batch settlement NAV. On redemption, underlying assets are returned based on batch settlement rules. The difference between entry NAV and exit NAV represents yield.

**Example:**
- A deposit of 1 ETH when NAV = $1.00 → ~1,800 KASH minted (if ETH = $1,800), after protocol fee
- Six months later NAV = $1.045 (4.5% yield accrued)
- Redemption of KASH → ETH worth KASH × NAV at settlement

NAV is updated during **daily batch processing**. The operator bot reads portfolio balances from the chain (vault, Aave, Aster, spot DEX) and submits **`updateNAV`** on-chain. Anyone can read **`getNAV()`** / **`currentNAV()`** and audit **`NAVProposedAndUpdated`** events.

---

## KASH tokens are transferable

KASH-ETH and KASH-BTC are standard **ERC-20 tokens** on Arbitrum. They can be freely transferred to any wallet address. The token holder may redeem for the underlying assets after batch settlement — not the original depositor only.

---

## What KASH is not

- KASH is **not** a stablecoin. KASH-ETH and KASH-BTC are priced in USD NAV terms and track each vault’s portfolio.
- KASH does **not** guarantee returns. Yield can vary; see [Risks](risks.md).
- KASH is **not** risk-free. Review [risks](risks.md) before depositing.
