# Getting Started

This guide covers the prerequisites for making a first deposit.

---

## Requirements

- **A wallet** — Rabby, Coinbase Wallet, or Rainbow wallet. Metamask wallet is not recommended as it indiscriminately blocks legitimate contracts.
- **Arbitrum One** added to the wallet (chain ID **42161**). See below for more details.
- **ETH** on Arbitrum One for gas, and **ETH** or **wETH** (for KASH-ETH) or **wBTC** (for KASH-BTC) to deposit

> KASH runs on **Arbitrum One**. The protocol uses **real assets** — only amounts that can be affordably lost should be deposited, and [Risks](risks.md) should be reviewed first.

---

## Step 1 — Add Arbitrum One to the wallet

KASH is deployed on **Arbitrum One** — not on Ethereum mainnet. Arbitrum One is a Layer 2 network built on Ethereum: lower fees and faster confirmations while inheriting Ethereum’s security model.

Wallets default to Ethereum L1, so **Arbitrum One must be added** before connecting to the app.

| Setting | Value |
|---------|-------|
| Network name | Arbitrum One |
| RPC URL | `https://arb1.arbitrum.io/rpc` (or a preferred provider, e.g. Alchemy) |
| Chain ID | `42161` |
| Currency symbol | `ETH` |
| Block explorer | `https://arbiscan.io` |

Most wallets also support adding the network from [Chainlist](https://chainlist.org/chain/42161).

---

## Step 2 — Get ETH and wBTC on Arbitrum One

**ETH on Arbitrum** is required to pay gas and to deposit into **KASH-ETH** (native ETH or wETH).

**Common options:**

- Bridge ETH from Ethereum L1 with the [Arbitrum Bridge](https://bridge.arbitrum.io/)
- Withdraw from a centralized exchange directly to Arbitrum One
- Use another L2 bridge or on-ramp that supports Arbitrum

For **KASH-BTC**, **wBTC** must be held on Arbitrum One (`0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`).

---

## Step 3 — Connect the wallet to the app

1. On the homepage, click **Launch App**
2. Click **Connect Wallet** in the top-right corner
3. Select the wallet and approve the connection
4. Ensure the wallet is on **Arbitrum One** — the app will show **Wrong network** if another chain is selected

---

## Live contract addresses (Arbitrum One)

Vault and token addresses are **environment-specific**. After a Aster deploy, they appear in:

- The app **footer** (Contract Address links)
- [`frontend/lib/contracts/addresses.ts`](../frontend/lib/contracts/addresses.ts)
- Your deployment `.env` / `frontend/.env.local`

Programmatic integrators: see [Agent Quickstart](agent-quickstart.md) for ABIs, adapter/facade reads, and Merkle claim flows.

> **Note:** The legacy **Hyperliquid** deployment on the `main` branch uses **different addresses and contract versions** (owner-gated HL). Do not assume addresses from old docs or screenshots apply to Aster vaults.

---

## Step 4 — Choose a product

Once connected, two tabs are available:

- **KASH-ETH** — deposit ETH or wETH, earn yield
- **KASH-BTC** — deposit wBTC, earn yield

Select the desired product.

---

## Ready to deposit

Deposits can proceed via [Depositing](depositing.md).
