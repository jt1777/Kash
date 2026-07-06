# Agent Quickstart

This page is for autonomous agents, agent developers, and scripts that want to evaluate or integrate KASH without relying on the frontend.

KASH is not a guaranteed-yield product. Before allocating capital, verify contract state, NAV, fee, batch window, and risk assumptions yourself.

This guide targets **V3 ownerless vaults** on the **`aster` branch** ( **Aster** perp DEX ). Legacy **Hyperliquid V2** vaults on `main` differ — see [Risks](risks.md).

---

## 1. Network and addresses

- Network: **Arbitrum One**
- Chain ID: `42161`
- Public RPC: `https://arb1.arbitrum.io/rpc`
- Explorer: `https://arbiscan.io`

| Product | KashYield vault | KASH token | Deposit asset |
|---------|-----------------|------------|---------------|
| KASH-ETH | `NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS` | `NEXT_PUBLIC_KASH_TOKEN_ETH` | Native ETH or WETH |
| KASH-BTC | `NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS` | `NEXT_PUBLIC_KASH_TOKEN_BTC` | wBTC (`0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`) |

**Infrastructure (per product, V3 Aster stack):**

| Contract | Purpose |
|----------|---------|
| **ExchangeFacade** | Immutable router for Aave + perp + spot writes |
| **AsterAdapter** | On-chain Aster perp integration (`IPerpExchange`) |
| **UniswapV3Adapter** | Spot DEX (often shared address across products) |

Source of truth:

- [`frontend/lib/contracts/addresses.ts`](../frontend/lib/contracts/addresses.ts)
- [`frontend/lib/contracts/kashYieldABI.ts`](../frontend/lib/contracts/kashYieldABI.ts)
- [`frontend/lib/contracts/kashTokenABI.ts`](../frontend/lib/contracts/kashTokenABI.ts)

After deploy, read on-chain wiring:

- `kashYield.exchangeFacade()` → facade
- `facade.perpExchangeAddress()` → **AsterAdapter**
- `facade.kashYieldAddress()` → vault
- `kashYield.botAddress()` → batch operator

---

## 2. Preflight checks

Before sending a transaction, read from the vault (KashYield ABI):

- Whether the **user window** is open (`isUserWindow()`)
- Whether the **processing window** is active (`isProcessingWindow()`)
- Current **NAV** (`getNAV()` / `currentNAV()`)
- Immutable **fee** (`feeBps()`)
- Current **batch cycle** (`getCurrentBatchCycle()`) and **batch phase** (`batchPhase(cycle)`)
- **Batch info** for the cycle (`getBatchInfo`)

**V3 notes:**

- There is **no `pause()`** and **no `owner()`** — do not gate on pause.
- `botAddress`, `feeReceiver`, cycle timing, and caps are **immutable** — verify deploy config once.

Recommended gate:

- Only submit mint/redeem when **`isUserWindow()`** is true and **`batchPhase(currentCycle) == 0`**.
- Confirm **`feeBps`** matches your model.
- Treat on-chain NAV as indicative until batch settlement completes.
- See [How Yield Works](how-yield-works.md) for batch timing.

---

## 3. Mint KASH-ETH

Native ETH path:

```ts
await wallet.writeContract({
  address: kashYieldEth,
  abi: kashYieldAbi,
  functionName: 'requestMint',
  args: [0n],
  value: depositWei,
});
```

WETH path — approve WETH, then:

```ts
await wallet.writeContract({
  address: kashYieldEth,
  abi: kashYieldAbi,
  functionName: 'requestMint',
  args: [wethAmount],
});
```

Watch for **MintRequested**.

---

## 4. Mint KASH-BTC

Approve wBTC to the BTC vault, then `requestMint(wbtcAmount)`. Watch for **MintRequested**.

---

## 5. Monitor settlement

Deposits and redemptions are batched. Submit before the processing-window cutoff, then watch:

- **MintRequested** / **RedeemRequested**
- **BatchPhaseUpdated** (phases 1 → 2 → 3)
- **BatchProcessed**
- **TokensClaimed**

Useful reads: pending mint/redeem requests, `getBatchInfo`, `batchClaimInfo`, `mintClaimed` / redeem claimed flags.

After **BatchProcessed**, load hosted Merkle proofs and call **`claimMint`** or **`claimRedeem`**. Claims expire in **30 days** (`batchClaimInfo(cycle).claimDeadline`).

---

## 6. Claim minted KASH

Phase 2 commits `mintMerkleRoot`. Each minter calls **`claimMint(batchCycle, kashAmount, proof)`**.

Proof manifests (operator-hosted):

- `NEXT_PUBLIC_MINT_PROOF_BASE_URL/{product}-mint-batch-{cycle}.json` or `/mint-proofs/...`
- Leaf: `keccak256(abi.encode(batchCycle, user, kashAmount))`

See `frontend/lib/mintProofs.ts` for rebuild helpers.

---

## 7. Redeem

Approve KASH to the vault, then **`requestRedeem(kashAmount)`**. After settlement, **`claimRedeem(batchCycle, claimAmount, proof)`** with redeem proof JSON.

- Redeem proofs: `NEXT_PUBLIC_REDEEM_PROOF_BASE_URL/{product}-batch-{cycle}.json`
- Leaf: `keccak256(abi.encode(batchCycle, user, claimAmount))`

---

## 8. Risk gate

Before allocating capital, read:

- [How Yield Works](how-yield-works.md)
- [Risks & Safeguards](risks.md)
- [Fees](fees.md)
