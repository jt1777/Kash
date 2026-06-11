# Fees

KASH involves several types of fees. Some are charged directly on deposit or redemption; others are incurred inside the yield strategy and affect returns through NAV rather than appearing as a separate line item.

---

## Protocol fee (KASH)

The **protocol fee** is KASH’s own charge on user flows. It applies to both **deposits (mints)** and **redemptions**, and is deducted during daily batch processing — not at the moment a request is submitted.

| | |
|---|---|
| **Rate** | **0.05% (5 basis points)** on the amount processed in each batch |
| **When charged** | Once per batch, when mints and redeems are settled (~23:45–23:59 UTC) |
| **On deposits** | Fee is taken from deposited ETH or wBTC before KASH tokens are minted. KASH is minted based on the post-fee USD value at the batch NAV. |
| **On redemptions** | Fee is taken from the gross asset value of the redemption before payout. The net amount after the fee is claimable. |

**Example — deposit:** A deposit of 1 ETH when ETH = $2,000 and NAV = $1.00 incurs a protocol fee of 0.05% of 1 ETH → 0.0005 ETH. KASH is minted from the remaining $1,999 of value.

---

## Network gas fees

**Arbitrum gas** is paid by the wallet for each transaction:

- Submitting a deposit or redemption request
- Cancelling a pending request
- Claiming redeemed assets after batch settlement

Gas on Arbitrum One is typically low compared to Ethereum mainnet. The protocol does not reimburse gas.

---

## Strategy and DeFi fees (affect NAV)

When the protocol deploys capital into its yield strategy, it interacts with external DeFi protocols. These costs and revenues are **not billed separately** to depositors; they are reflected in the portfolio value that drives **NAV**.

### Aave (lending)

- **Supply yield:** ETH or wBTC deposited as collateral earns lending interest, which contributes positively to NAV.
- **Borrow cost:** The protocol borrows USDC against collateral to fund perp margin. **Borrow interest** on that debt reduces NAV over time.

### Hyperliquid (perpetuals)

- **Funding rates:** The main yield driver. When funding is positive, shorts earn; when negative, shorts pay. Funding flows into (or out of) portfolio value and therefore NAV. See [How Yield Works](how-yield-works.md).
- **Trading fees:** Opening, closing, or adjusting perp positions incurs Hyperliquid’s standard trading fees, which reduce NAV.

### Uniswap V3 (spot swaps)

When the bot swaps assets on-chain (for example WETH ↔ USDC), Uniswap pool fees apply. The default route uses the **0.05% (500)** fee tier for WETH/USDC and wBTC/USDC pairs on Arbitrum — the tier with the most liquidity for those pairs.

**Slippage cap:** On-chain swaps are bounded by **`maxSwapSlippageBps`** (default **100 bps = 1%**). This limits how much value can be lost to price impact or adverse execution in a single swap; it is a safeguard, not a fee paid to KASH.

### Rebalancing costs

Each time deposits or redemptions require the protocol to put on or take off hedge positions — depositing to Aave, borrowing, posting margin, opening or closing shorts — the smart contract pays the combined gas and protocol fees of those steps. These costs are spread across the vault and are reflected in NAV.

For this reason, **very short holding periods** are not advised as one round of entry and exit costs can exceed multiple days worth of funding income. KASH is designed for medium- to long-term holding. See [Depositing](depositing.md#minimum-holding-period).

---

## Summary

| Fee type | Who pays | When | Typical impact |
|----------|----------|------|----------------|
| **Protocol fee** | User | Batch settlement on mint & redeem | 0.05% of flow amount |
| **Gas** | User | Each wallet transaction | Small on Arbitrum; varies with network |
| **Aave borrow interest** | Vault (via NAV) | Continuous while USDC is borrowed | Reduces yield |
| **Aave supply interest** | Vault (via NAV) | Continuous on collateral | Adds to yield |
| **Hyperliquid funding** | Vault (via NAV) | Periodic (exchange schedule) | Main yield driver; can be negative |
| **Hyperliquid trading fees** | Vault (via NAV) | On position changes | Reduces yield |
| **Uniswap pool fees** | Vault (via NAV) | On swaps | ~0.05% per swap on default routes |
| **Slippage** | Vault (via NAV) | On swaps | Capped at 1% by contract; actual slippage usually much lower |

The **protocol fee** is the only charge KASH applies directly to a deposit or redemption. Everything else is part of running the delta-neutral strategy and is reflected in how NAV changes over time.
