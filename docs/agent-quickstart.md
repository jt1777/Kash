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

Optional **ERC-7575 Pipes** (not a second vault asset — the vault `asset()` stays WETH/wBTC):

| Pipe | Env | `asset()` | `share()` |
|------|-----|-----------|-----------|
| USDC → KASH-ETH | `NEXT_PUBLIC_KASH_PIPE_USDC_ETH` | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | ETH vault |
| USDC → KASH-BTC | `NEXT_PUBLIC_KASH_PIPE_USDC_BTC` | USDC | BTC vault |
| USDT → KASH-ETH | `NEXT_PUBLIC_KASH_PIPE_USDT_ETH` | USDT `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | ETH vault |
| USDT → KASH-BTC | `NEXT_PUBLIC_KASH_PIPE_USDT_BTC` | USDT | BTC vault |

ABI: [`frontend/lib/contracts/kashPipeABI.ts`](../frontend/lib/contracts/kashPipeABI.ts) (one ABI for both stables).

There is **no separate KASH token contract**. `share()` on the vault returns the vault address. On a Pipe, `share()` returns the **vault**.

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
- [`frontend/lib/contracts/kashPipeABI.ts`](../frontend/lib/contracts/kashPipeABI.ts)

One ABI per vault — do not merge ETH and BTC. Pipe ABI is shared (`kashPipeABI.ts`).

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

## 3b. Optional USDC / USDT Pipe (not a second vault asset)

A **KashPipe** converts between a stable (USDC/USDT) and the vault asset through a closed spot DEX route. It is **not** a second vault asset — `asset()` on the vault stays WETH/wBTC. The Pipe holds **no balances** after each call. Accidental tokens sent to the Pipe are unrecoverable by design (no sweep).

### Deposit (stable → KASH)

`minAssetOut` is **mandatory and non-zero**. The Pipe also applies `maxSlippageBps` vs `quoteExactIn` (stricter of the two wins).

Handoff (do not invert):

- `controller` = **you** (you claim **shares** on the vault)
- `owner_` = **the Pipe** (it pays WETH/wBTC). No `setOperator`.

```ts
await wallet.writeContract({
  address: usdc,
  abi: erc20Abi,
  functionName: 'approve',
  args: [pipe, usdcAmount],
});
const quoted = await publicClient.readContract({
  address: pipe,
  abi: kashPipeAbi,
  functionName: 'quoteAssetOut',
  args: [usdcAmount],
});
await wallet.writeContract({
  address: pipe,
  abi: kashPipeAbi,
  functionName: 'requestDepositStable',
  args: [usdcAmount, minAssetOutWithSlippage, controller],
});
```

Pending credit is `pendingDepositRequest(cycle, controller)` on the **vault**, in **asset units**. Claim shares with vault `deposit` / `mint` (section 6). The Pipe cannot claim deposits (`Unauthorized`).

### Redeem (KASH → stable)

N+1 is checked on **owner**. The Pipe therefore uses `owner_ = you` and must be a 7540 operator:

```ts
await wallet.writeContract({
  address: vault,
  abi: kashVaultAbi,
  functionName: 'setOperator',
  args: [pipe, true],
});
await wallet.writeContract({
  address: pipe,
  abi: kashPipeAbi,
  functionName: 'requestRedeemStable',
  args: [shares, controller],
});
```

You can also `requestRedeem` on the vault directly (no operator). After settlement, to take USDC instead of WETH/wBTC:

```ts
await wallet.writeContract({
  address: pipe,
  abi: kashPipeAbi,
  functionName: 'claimRedeemStable',
  args: [shares, minStableOut, receiver],
});
```

`minStableOut` must be non-zero (`quoteStableOut`). Direct vault `redeem` still pays WETH/wBTC. Cancel on the vault returns shares to you.

USDT uses the same ABI; approve is non-standard — the Pipe uses `forceApprove`. USDT pools are thinner; expect a higher slippage ceiling.

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

Optional USDC/USDT: `setOperator(pipe, true)` once, then `claimRedeemStable(shares, minStableOut, receiver)` on the Pipe (section 3b). `requestRedeemStable` is the same request with the Pipe as operator so N+1 still keys off you.

---

## 8. Risk gate

Before allocating capital, read:

- [How Yield Works](how-yield-works.md)
- [Risks & Safeguards](risks.md)
- [Fees](fees.md)
- [Verify NAV](verify-NAV.md)
