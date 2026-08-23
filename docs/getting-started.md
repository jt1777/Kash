# Getting Started

This guide covers the prerequisites for making a first deposit.

---

## Requirements

- **A wallet** — Rabby, Coinbase Wallet, or Rainbow wallet. Metamask wallet is not recommended as it indiscriminately blocks legitimate contracts.
- **Arbitrum One** added to the wallet (chain ID **42161**). See below for more details.
- **ETH** on Arbitrum One for gas, and **ETH** (for KASH-ETH) or **wBTC** (for KASH-BTC) to deposit

> KASH runs on **Arbitrum One**. The protocol uses **real assets** — only amounts that can be affordably lost should be deposited, and [Risks](risks.md) should be reviewed first.

---

## Step 1 — Add Arbitrum One to the wallet

KASH is deployed on **Arbitrum One** (or just Arbitrum) — not on Ethereum mainnet.  Arbitrum One is a Layer 2 (L2) network built on top of Ethereum. Instead of running every transaction on Ethereum mainnet (often called “L1”), Arbitrum processes them on a separate chain and periodically posts the results back to Ethereum for security. That design keeps fees much lower and confirmations faster, while still inheriting Ethereum’s security model.

Wallets default to Ethereum L1, so **Arbitrum One must be selected as a network** before connecting to the app or sending a deposit. On Arbitrum One, **ETH** is still used to pay gas (the same asset as on mainnet, but on a different chain).

If Arbitrum is not already selected, choose it from the list of popular networks or add it manually if it is not listed as an option:

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

**ETH on Arbitrum** is required to pay gas and to use as a deposit asset for KASH-ETH.  Note both ETH and wETH can be used as a deposit for the KASH-ETH contract.

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
4. Ensure the wallet is on **Arbitrum One** (Arbitrum) — the app will show **Wrong network** if another chain is selected

---

## Step 4 — Choose a product

Once connected, two tabs are available:

- **KASH-ETH** — deposit ETH or wETH, earn yield
- **KASH-BTC** — deposit wBTC, earn yield

Select the desired product.

---

## Live contract addresses (Arbitrum One)

| Product | Vault | KASH token |
|---------|-------|------------|
| KASH-ETH | `0xd9c2c8DdCA745EBa7a8c575d0ed0171b8D0565ad` | `0x328d6905bdd90ab1302D70c61ddaDdE77fd863A6` |
| KASH-BTC | `0xAD3298903584DbD539C2085e099136445AeeCBE9` | `0xf359890E857aB63EcE696a73f647Fcb65A7d82E0` |

Programmatic integrators: see [Agent Quickstart](agent-quickstart.md) for adapter/facade addresses, ABIs, and Merkle claim flows.

---

## Ready to deposit

Deposits can proceed via [Depositing](depositing.md).
