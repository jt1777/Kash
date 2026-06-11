# Getting Started

This guide covers the prerequisites for making a first deposit.

---

## Requirements

- **A wallet** — Rabby, Coinbase Wallet, or Rainbow wallet. Metamask wallet is not recommended as it indiscriminately blocks legitimate contracts.
- **Arbitrum One** added to the wallet (chain ID **42161**)
- **ETH** on Arbitrum One for gas, and **ETH** (for KASH-ETH) or **wBTC** (for KASH-BTC) to deposit

> KASH runs on **Arbitrum One**. The protocol uses **real assets** — only amounts that can be affordably lost should be deposited, and [Risks](risks.md) should be reviewed first.

---

## Step 1 — Add Arbitrum One to the wallet

If Arbitrum One is not already configured, add it manually:

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

**ETH on Arbitrum** is required to pay gas and to use KASH-ETH.

**Common options:**

- Bridge ETH from Ethereum L1 with the [Arbitrum Bridge](https://bridge.arbitrum.io/)
- Withdraw from a centralized exchange directly to Arbitrum One
- Use another L2 bridge or on-ramp that supports Arbitrum

For **KASH-BTC**, **wBTC** must be held on Arbitrum One (`0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`). wBTC can be acquired via a DEX or bridge, then the app can be used on the BTC tab.

---

## Step 3 — Connect the wallet to the app

1. On the homepage, click **Launch App**
2. Click **Connect Wallet** in the top-right corner
3. Select the wallet and approve the connection
4. Ensure the wallet is on **Arbitrum One** — the app will show **Wrong network** if another chain is selected

---

## Step 4 — Choose a product

Once connected, two tabs are available:

- **KASH-ETH** — deposit ETH, earn yield
- **KASH-BTC** — deposit wBTC, earn yield

Select the desired product.

---

## Ready to deposit

Deposits can proceed via [Depositing](depositing.md).
