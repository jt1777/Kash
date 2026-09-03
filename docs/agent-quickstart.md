# Agent Quickstart

This page is for autonomous agents, agent developers, and scripts that want to evaluate or integrate KASH without relying on the frontend.

KASH is not a guaranteed-yield product. Before allocating capital, verify contract state, NAV, fee, batch window, and risk assumptions yourself.

This guide targets **ERC-4626/7540 Aster vaults** on the **`aster` branch** (**Aster** perp DEX). The vault **is** the share token. Legacy **Hyperliquid (HL)** vaults on `main` differ — see [Risks](risks.md).

---

## 1. Network and addresses

- Network: **Arbitrum One**
- Chain ID: `42161`
- Public RPC: `https://arb1.arbitrum.io/rpc`
- Explorer: `https://arbiscan.io`

| Product | Vault (= share token) | `asset()` | Deposit |
|---------|----------------------|-----------|---------|
| KASH-ETH | `NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS` | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | Native ETH (`requestDepositETH`) or WETH |
| KASH-BTC | `NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS` | wBTC `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` | wBTC |

There is **no separate KASH token contract**. `share()` returns the vault address.

**Infrastructure (per product, Aster stack):**

| Contract | Purpose |
|----------|---------|
| **ExchangeFacade** | Immutable router for Aave + perp + spot writes |
| **AsterAdapter** | On-chain Aster perp integration |
| **UniswapV3Adapter** | Spot DEX (often shared across products) |

Source of truth:

- [`frontend/lib/contracts/addresses.ts`](../frontend/lib/contracts/addresses.ts)
- [`frontend/lib/contracts/kashVaultEthABI.ts`](../frontend/lib/contracts/kashVaultEthABI.ts)
- [`frontend/lib/contracts/kashVaultBtcABI.ts`](../frontend/lib/contracts/kashVaultBtcABI.ts)

One ABI per vault — do not merge ETH and BTC.

After deploy, read on-chain wiring:

- `vault.exchangeFacade()` → facade
- `facade.perpExchangeAddress()` → **AsterAdapter**
- `facade.kashYieldAddress()` → vault
- `vault.botAddress()` / `vault.owner()` / `vault.watcher()`

---

## 2. Preflight checks

Read from the vault:

- Whether the vault is **paused** (`paused()`)
- Whether the **user window** is open (`isUserWindow()`)
- Whether the **processing window** is active (`isProcessingWindow()`)
- Current **NAV** (`getNAV()` / `currentNAV()`) — computed on-chain from Aster + Aave + Chainlink
- Immutable **fee** (`feeBps()`)
- Current **batch cycle** (`getCurrentBatchCycle()`) and **batch phase** (`batchPhase(cycle)`)
- Pending / claimable: `pendingDepositRequest(cycle, controller)`, `claimableDepositRequest(cycle, controller)` (and redeem equivalents)

**7540 notes:**

- `previewDeposit` / `previewMint` / `previewRedeem` / `previewWithdraw` **revert** (`PreviewNotSupported`).
- `maxDeposit(controller)` / `maxMint` / `maxWithdraw` / `maxRedeem` are **claimable** amounts after settlement, **not** “how much can I put in”.
- `requestId` = batch cycle. Never `0`.
- A generic 4626 router that calls `deposit()` with no prior request reverts (nothing claimable).

Recommended gate:

- Only submit requests when **`isUserWindow()`** is true, **`!paused()`**, and **`batchPhase(currentCycle) == 0`**.
- Confirm **`feeBps`** matches your model.
- See [How Yield Works](how-yield-works.md) for batch timing.

---

## 3. Deposit KASH-ETH

Native ETH path:

```ts
await wallet.writeContract({
  address: vaultEth,
  abi: kashVaultEthAbi,
  functionName: 'requestDepositETH',
  args: [controller],
  value: depositWei,
});
```

WETH path — approve WETH to the vault, then:

```ts
await wallet.writeContract({
  address: vaultEth,
  abi: kashVaultEthAbi,
  functionName: 'requestDeposit',
  args: [wethAmount, controller, owner],
});
```

Watch for **DepositRequest**.

---

## 4. Deposit KASH-BTC

Approve wBTC to the BTC vault, then `requestDeposit(wbtcAmount, controller, owner)`. Watch for **DepositRequest**.

---

## 5. Monitor settlement

Deposits and redemptions are batched. Submit before the processing-window cutoff, then watch:

- **DepositRequest** / **RedeemRequest**
- **BatchProcessed**
- **Deposit** / **Withdraw** (on claim)
- **NavMonitorTripped** (Phase 2 settlement vs anchor failed)
- **Paused** / **Unpaused** / **BotAddressSet** / **NavCorrected** / **OperatorSet**

Useful reads: `pendingDepositRequest` / `claimableDepositRequest`, `batchPhase`, `batchProcessed`, `claimOpenAt`.

After **BatchProcessed**, wait until `block.timestamp >= claimOpenAt(cycle)` (6h hold), then claim. Claims expire in **30 days**.

---

## 6. Claim deposited shares

No Merkle. Call **`deposit(assets, receiver[, controller])`** or **`mint(shares, receiver[, controller])`**. FIFO oldest cycle first if multiple claimable cycles exist.

---

## 7. Redeem

Call **`requestRedeem(shares, controller, owner)`**. The vault locks shares immediately (no approve). N+1: shares minted in cycle N cannot enter `requestRedeem` until cycle ≥ N+1.

After settlement, **`redeem(shares, receiver[, controller])`** or **`withdraw(assets, receiver[, controller])`** pays WETH / wBTC.

---

## 8. Risk gate

Before allocating capital, read:

- [How Yield Works](how-yield-works.md)
- [Risks & Safeguards](risks.md)
- [Fees](fees.md)
- [Verify NAV](verify-NAV.md)
