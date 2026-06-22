# Fees

KASH involves several types of costs. Only one — the **protocol fee** — is deducted directly from a user's deposit or redemption. Everything else either comes out of the shared vault portfolio (and shows up in **NAV**) or is paid separately by the user's wallet (gas) or the operator's bot (batch execution gas).

Understanding the split matters: the **0.05% protocol fee** is explicit and predictable on each mint and redeem. The costs of running the delta-neutral strategy during daily batch processing are **not** added as a separate line on a user's transaction — they are absorbed by the vault and reflected in how NAV moves over time.

---

## Protocol fee — the charge on your deposit or redemption

The **protocol fee** is KASH's own charge on user flows. It is the **only fee taken directly from your mint or redeem amount**.

| | |
|---|---|
| **Rate** | **0.05% (5 basis points)** on the amount processed in each batch |
| **When charged** | Once per batch, when mints and redeems are settled (~23:40–23:59 UTC) — not when the request is submitted |
| **On deposits** | Fee is taken from deposited ETH or wBTC before KASH tokens are minted. KASH is minted from the **post-fee** USD value at the batch NAV. |
| **On redemptions** | Fee is taken from the gross asset value of the redemption before payout. The **net amount after the fee** is what you claim. |
| **Where it goes** | Credited to the protocol owner's reserve on-chain (`ownerEthReserve` / `ownerWbtcReserve`). It is **not** redeployed into the yield strategy. |

**Example — deposit:** A deposit of 1 ETH when ETH = $2,000 and NAV = $1.00 incurs a protocol fee of 0.05% of 1 ETH → 0.0005 ETH. KASH is minted from the remaining $1,999 of value.

**Example — redemption:** Redeeming KASH worth 1 ETH gross at settlement → protocol fee 0.0005 ETH → **0.9995 ETH** claimable (before any separate wallet gas for the claim transaction).

This fee is applied in contract code at batch settlement (`feeBps` on mint and redeem flows). It is distinct from Uniswap pool fees, Hyperliquid trading fees, borrow interest, or slippage — none of those are substituted for or included in the protocol fee.

---

## Batch process costs — not billed to you directly

Each daily batch does more than settle user requests. The **bot** (operator) rebalances the vault: posting collateral to Aave, borrowing USDC, moving margin to Hyperliquid, opening or adjusting shorts, swapping on Uniswap when needed, updating NAV, and running on-chain settlement.

Those steps incur **real costs**, but they are **not** itemized on an individual user's mint or redeem receipt. Instead they fall into three buckets:

| Cost type | Who pays | How you experience it |
|-----------|----------|------------------------|
| **Protocol fee** | **You** (on your flow) | Explicit deduction from your deposit or redemption amount at batch settlement |
| **Wallet gas (user txs)** | **You** | Arbitrum gas when submitting, cancelling, or claiming — separate from the protocol fee |
| **Wallet gas (batch txs)** | **Operator bot** | Gas for `performUpkeep`, Aave/HL/DEX calls, NAV updates, etc. — paid by the bot wallet, **not** passed through as a per-user charge |
| **DeFi protocol fees** | **Vault** (all holders) | Aave borrow interest, Uniswap pool fees (~0.05% on default routes), Hyperliquid trading fees — reduce portfolio value → lower NAV growth |
| **Slippage on swaps** | **Vault** (all holders) | Less output than the ideal quote on a swap — also reduces portfolio value → NAV; capped by `maxSwapSlippageBps` (default **1%**) per swap |

**In short:** the protocol fee is paid by the user on entry (minting) and exit (redemption). Strategy execution costs during the batch are **shared across the vault** via NAV — every KASH holder bears a proportional share, including users who neither minted nor redeemed that day.

That is why very short holding periods can underperform: one round of entry and exit pays the **protocol fee twice** (mint + redeem) and wallet gas, while the vault may also incur rebalancing costs that dilute NAV for everyone. As such, KASH is better utilized for medium- to long-term holdings, not short term trading. See [Depositing](depositing.md#minimum-holding-period).

---

## Network gas fees

### User wallet gas

**Arbitrum gas** is paid by the connected wallet for:

- Submitting a deposit or redemption request
- Cancelling a pending request
- Claiming redeemed assets after batch settlement

Gas on Arbitrum One is typically low compared to Ethereum mainnet. The protocol does not reimburse user gas.

### Operator bot gas

Batch processing transactions — settlement, collateral deployment, swaps, NAV submission — are sent by the **operator bot**. That wallet pays its own Arbitrum gas. Those costs are an **operational expense of running the protocol**, not an extra line item deducted from a user's deposit. In practice they are funded from protocol fee revenue and/or operator treasury, not from individual user balances at settlement time.

---

## Strategy and DeFi costs (affect NAV)

When the protocol deploys capital into its yield strategy, it interacts with external DeFi protocols. These costs and revenues are **not billed separately** to depositors at mint or redeem time; they are reflected in the portfolio value that drives **NAV**.

### Aave (lending)

- **Supply yield:** ETH or wBTC deposited as collateral earns lending interest, which contributes positively to NAV.
- **Borrow cost:** The protocol borrows USDC against collateral to fund perp margin. **Borrow interest** on that debt reduces NAV over time.

### Hyperliquid (perpetuals)

- **Funding rates:** The main yield driver. When funding is positive, shorts earn; when negative, shorts pay. Funding flows into (or out of) portfolio value and therefore NAV. See [How Yield Works](how-yield-works.md).
- **Trading fees:** Opening, closing, or adjusting perp positions incurs Hyperliquid's standard trading fees, which reduce NAV.

### Uniswap V3 (spot swaps)

When the bot swaps assets on-chain (for example WETH ↔ USDC), Uniswap **pool fees** apply. The default route uses the **0.05% (500)** fee tier for WETH/USDC and wBTC/USDC pairs on Arbitrum — the tier with the most liquidity for those pairs. These fees are paid from vault assets to Uniswap LPs, not to KASH.

### Slippage (execution cost, not a protocol fee)

**Slippage** is the gap between the expected swap output and what the vault actually receives — caused by price impact, timing, or market depth. It is **not** a fee paid to KASH or a third-party protocol in the same way as pool fees; it is value left on the table during execution.

On-chain swaps are bounded by **`maxSwapSlippageBps`** (default **100 bps = 1%**). The contract rejects swaps that would lose more than this cap in a single trade. Actual slippage is usually much lower, but whatever occurs is borne by the **vault** and shows up in NAV, shared across all token holders.

### Rebalancing during batch

When deposits or redemptions require the protocol to add or remove hedge exposure — Aave supply/withdraw, borrow/repay, Hyperliquid margin, perp open/close, spot swaps — the **third-party fees and slippage** above are paid from vault assets. The **bot** separately pays **Arbitrum gas** to submit those transactions. Neither is added as an extra percentage on top of the protocol fee at your settlement line item; together they affect long-run returns through NAV.

---

## Summary

| Cost type | Who pays | When | Typical impact |
|----------|----------|------|----------------|
| **Protocol fee** | User (on their flow) | Batch settlement on mint & redeem | **0.05%** of deposit/redemption amount — explicit, only direct KASH charge |
| **User wallet gas** | User | Each wallet transaction (request, cancel, claim) | Small on Arbitrum; varies with network |
| **Bot batch gas** | Operator bot | Daily batch execution txs | Operational; not deducted from user settlement |
| **Aave borrow interest** | Vault → all holders via NAV | Continuous while USDC is borrowed | Reduces yield |
| **Aave supply interest** | Vault → all holders via NAV | Continuous on collateral | Adds to yield |
| **Hyperliquid funding** | Vault → all holders via NAV | Periodic (exchange schedule) | Main yield driver; can be negative |
| **Hyperliquid trading fees** | Vault → all holders via NAV | On position changes | Reduces yield |
| **Uniswap pool fees** | Vault → all holders via NAV | On swaps | ~0.05% per swap on default routes |
| **Slippage** | Vault → all holders via NAV | On swaps | Capped at 1% per swap by contract; actual slippage usually much lower |

The **protocol fee** is the only charge KASH applies **directly to your deposit or redemption amount**. Batch rebalancing costs — DeFi fees, slippage, and bot gas — are part of operating the strategy; DeFi fees and slippage are shared by all holders through NAV, while bot gas is an operator expense separate from your settlement math.
