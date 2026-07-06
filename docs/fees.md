# Fees

KASH involves several types of costs. Only one — the **protocol fee** — is deducted directly from a user's deposit or redemption. Everything else either comes out of the shared vault portfolio (and shows up in **NAV**) or is paid separately by the user's wallet (gas) or the operator's bot (batch execution gas).

Understanding the split matters: the **protocol fee** is explicit and predictable on each mint and redeem. Strategy execution costs during daily batch processing are **not** itemized on your receipt — they are absorbed by the vault and reflected in NAV.

---

## Protocol fee — the charge on your deposit or redemption

The **protocol fee** is KASH's own charge on user flows. It is the **only fee taken directly from your mint or redeem amount**.

| | |
|---|---|
| **Rate** | **`feeBps`** fixed at deploy (typically **0.05% / 5 bps**) — read `feeBps()` on the vault; not changeable after launch on V3 |
| **When charged** | Once per batch, when mints and redeems are settled (~processing window) — not when the request is submitted |
| **On deposits** | Fee is taken from deposited ETH or wBTC before KASH is minted. KASH is minted from the **post-fee** USD value at settlement NAV. |
| **On redemptions** | Fee is taken from the gross asset value of the redemption before payout. The **net amount after the fee** is what you claim. |
| **Where it goes** | Sent to the immutable **`feeReceiver`** address at Phase 2 settlement (V3 has no owner reserve or owner withdrawal) |

**Example — deposit:** A deposit of 1 ETH when ETH = $2,000 and NAV = $1.00 incurs a protocol fee of 0.05% of 1 ETH → 0.0005 ETH. KASH is minted from the remaining value.

**Example — redemption:** Redeeming KASH worth 1 ETH gross at settlement → protocol fee 0.0005 ETH → **0.9995 ETH** claimable (before wallet gas for `claimRedeem`).

This fee is distinct from Uniswap pool fees, **Aster** trading costs, Aave borrow interest, or slippage — none of those are substituted for or included in the protocol fee.

---

## Batch process costs — not billed to you directly

Each daily batch rebalances the vault: Aave collateral, USDC borrow, **Aster** short hedge, Uniswap swaps when needed, NAV updates, and Merkle settlement.

| Cost type | Who pays | How you experience it |
|-----------|----------|------------------------|
| **Protocol fee** | **You** (on your flow) | Explicit deduction at batch settlement |
| **Wallet gas (user txs)** | **You** | Arbitrum gas for request, cancel, claim |
| **Wallet gas (batch txs)** | **Operator bot** | Not passed through as a per-user charge |
| **DeFi protocol fees** | **Vault** (all holders) | Aave interest, Uniswap pool fees, Aster trading — via NAV |
| **Slippage on swaps** | **Vault** (all holders) | Capped by immutable `maxSwapSlippageBps` per swap |

Very short holding periods can underperform: entry and exit pay the **protocol fee twice** plus wallet gas while the vault may also incur rebalancing costs. See [Depositing](depositing.md#minimum-holding-period).

---

## Network gas fees

### User wallet gas

Arbitrum gas is paid for submitting or cancelling requests and for **`claimMint`** / **`claimRedeem`**. The protocol does not reimburse user gas.

### Operator bot gas

Batch transactions are sent by the **bot** wallet. Those costs are operational, funded from protocol fee revenue and/or operator treasury — not deducted from your settlement line item.

---

## Strategy and DeFi costs (affect NAV)

### Aave (lending)

- **Supply yield** on ETH/wBTC collateral — positive for NAV
- **Borrow cost** on USDC — negative for NAV

### Aster (perpetuals)

- **Funding rates** — main yield driver; can be negative
- **Trading / execution costs** on open, close, and chunked rebalance — reduce NAV

### Uniswap V3 (spot swaps)

Pool fees on WETH/USDC and wBTC/USDC routes (typically **0.05%** tier on Arbitrum). Paid from vault assets to LPs.

### Slippage

Bounded by **`maxSwapSlippageBps`** (immutable at deploy, commonly **1%**). Actual slippage is borne by the vault via NAV.

---

## Summary

| Cost type | Who pays | When | Typical impact |
|----------|----------|------|----------------|
| **Protocol fee** | User | Batch settlement | **~0.05%** of mint/redeem amount |
| **User wallet gas** | User | Request, cancel, claim | Small on Arbitrum |
| **Bot batch gas** | Operator | Daily batch | Operational |
| **Aave borrow / supply** | Vault via NAV | Continuous | Net lending spread |
| **Aster funding & trading** | Vault via NAV | Per funding interval / rebalance | Main yield driver |
| **Uniswap pool fees** | Vault via NAV | On swaps | ~0.05% per swap on default routes |
| **Slippage** | Vault via NAV | On swaps | Capped per swap at deploy |

The **protocol fee** is the only charge KASH applies **directly to your deposit or redemption amount**. Other costs are shared through NAV or paid by the operator bot.

---

## Unclaimed claims

If you do not **`claimMint`** or **`claimRedeem`** within **30 days** of settlement, unclaimed amounts may be swept per contract rules (typically to **`feeReceiver`**). See [Risks — Claim expiry](risks.md#claim-expiry).
