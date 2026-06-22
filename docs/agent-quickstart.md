# Agent Quickstart

This page is for autonomous agents, agent developers, and scripts that want to evaluate or integrate KASH without relying on the frontend.

KASH is not a guaranteed-yield product. Before allocating capital, verify the contract state, NAV, fee, batch window, and risk assumptions yourself.

---

## 1. Network and addresses

- Network: **Arbitrum One**
- Chain ID: `42161`
- Public RPC: `https://arb1.arbitrum.io/rpc`
- Explorer: `https://arbiscan.io`

| Product | KashYield vault | KASH token | Deposit asset |
|---------|-----------------|------------|---------------|
| KASH-ETH | `0xC5C8B1Dc1fFF6728869C8BCCe6105Caa6Df9E68d` | `0xf29483f62502D714c14CB3141944C6D8CCDF9962` | Native ETH or WETH |
| KASH-BTC | `0x86B0095f866c05F53363AE31F994E9540033fC2E` | `0x4f628402227a2Fe292641db7aDa1Fae744568445` | wBTC (`0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`) |

**Infrastructure (shared or per product):**

| Contract | KASH-ETH | KASH-BTC |
|----------|----------|----------|
| ExchangeFacade | `0x552f7161FdEb53131DF590a36560Cc6B386AE267` | `0x6362722b469850e0Fee60B312D7dc253bfC4cd15` |
| HyperliquidAdapter | `0x88699f0D22654dCa99a95e64efA994BDA79faa72` | `0x753E9232f48eb512A5C06257196046bb09EfF628` |
| UniswapV3Adapter (spot DEX, shared) | `0x43e4283eAc834A6738C8a125Aa4438b8fC91e759` | same |

Source of truth in the app:

- Contract addresses: [`frontend/lib/contracts/addresses.ts`](../frontend/lib/contracts/addresses.ts)
- KashYield ABI: [`frontend/lib/contracts/kashYieldABI.ts`](../frontend/lib/contracts/kashYieldABI.ts)
- KASH ERC-20 ABI: [`frontend/lib/contracts/kashTokenABI.ts`](../frontend/lib/contracts/kashTokenABI.ts)

Use the ABI files for exact read and write method names.

---

## 2. Preflight checks

Before sending a transaction, read from the vault contract (via the KashYield ABI):

- Whether the contract is **paused**
- Whether the **user window** is open (deposits/redemptions allowed)
- Whether the **processing window** is active (batch running)
- Current **NAV** (`currentNAV()`; `getNAV()` is also available)
- Protocol **fee** in basis points
- Current **batch cycle** and **batch info** for that cycle

Recommended gate:

- Do not mint or redeem if the contract is paused.
- Only submit deposit or redeem requests when the user window is open.
- Confirm the fee matches your model before sizing a deposit.
- Treat the on-chain NAV as the current contract NAV, not a promise of future yield.
- Confirm the current batch and settlement cadence against [How Yield Works](how-yield-works.md).

---

## 3. Mint KASH-ETH

Native ETH path — submit a deposit request with ETH attached (see KashYield ABI for the native-ETH deposit entrypoint):

```ts
await wallet.writeContract({
  address: kashYieldEth,
  abi: kashYieldAbi,
  functionName: 'requestMint', // see kashYieldABI.ts
  args: [0n],
  value: depositWei,
});
```

WETH path — approve WETH to the vault, then submit the deposit request:

```ts
await wallet.writeContract({
  address: weth,
  abi: erc20Abi,
  functionName: 'approve',
  args: [kashYieldEth, wethAmount],
});

await wallet.writeContract({
  address: kashYieldEth,
  abi: kashYieldAbi,
  functionName: 'requestMint', // see kashYieldABI.ts
  args: [wethAmount],
});
```

Watch for the **MintRequested** event (user, amount, batch cycle).

---

## 4. Mint KASH-BTC

KASH-BTC uses wBTC. Approve the BTC vault first, then submit the deposit request:

```ts
await wallet.writeContract({
  address: wbtc,
  abi: erc20Abi,
  functionName: 'approve',
  args: [kashYieldBtc, wbtcAmount],
});

await wallet.writeContract({
  address: kashYieldBtc,
  abi: kashYieldAbi,
  functionName: 'requestMint', // see kashYieldABI.ts
  args: [wbtcAmount],
});
```

Watch for **MintRequested**.

---

## 5. Monitor settlement

Deposits and redemptions are batched. Submit before the documented cutoff, then watch these events:

- **MintRequested**
- **RedeemRequested**
- **BatchProcessed**
- **TokensClaimed**

Useful reads (method names in KashYield ABI):

- Pending mint request for a user and batch cycle
- Pending redeem request for a user and batch cycle
- Batch info for a cycle
- KASH token balance for the user
- Current NAV
- Mint claim info and claimed status, when monitoring settled mints
- Redeem claim info and claimed status, when monitoring settled redeems

Do not assume immediate KASH receipt after a deposit request. Wait for batch processing (`BatchProcessed`), then load the hosted mint claim proof for the batch and call **`claimMint`**. For redeems, wait for settlement, load the hosted redeem claim proof, then call **`claimRedeem`**.

---

## 6. Claim minted KASH

After **`BatchProcessed`** for a cycle where you had a pending mint, KASH is allocated but not pushed to your wallet. Claim with the Merkle proof published for that batch.

**Pull-claim model:** Phase 2 batch settlement commits a `mintMerkleRoot` on-chain. KASH is **not** transferred automatically — each minter must call `claimMint` with a Merkle proof. Claims expire **30 days** after root commit (`CLAIM_EXPIRY_SECONDS`; see `batchClaimInfo(batchCycle).claimDeadline`).

**Proof manifests** are published by the operator after each batch (same JSON shape as redeem proofs):

```json
{
  "batchCycle": "492518",
  "root": "0x…",
  "leaves": [{ "user": "0x…", "amount": "…", "proof": ["0x…", "…"] }]
}
```

- Hosted paths: `NEXT_PUBLIC_MINT_PROOF_BASE_URL/{product}-mint-batch-{cycle}.json` or `/mint-proofs/{product}-mint-batch-{cycle}.json` (`product` = `eth` or `btc`)
- Leaf hash: `keccak256(abi.encode(batchCycle, user, kashAmount))` — `amount` in the manifest is KASH wei (18 decimals)
- If no manifest is available, the frontend can rebuild a single-user proof from chain events (see `frontend/lib/mintProofs.ts`)

KASH-ETH example:

```ts
await wallet.writeContract({
  address: kashYieldEth,
  abi: kashYieldAbi,
  functionName: 'claimMint',
  args: [batchCycle, kashAmount, proof],
});
```

KASH-BTC example:

```ts
await wallet.writeContract({
  address: kashYieldBtc,
  abi: kashYieldAbi,
  functionName: 'claimMint',
  args: [batchCycle, kashAmount, proof],
});
```

Useful reads before claiming:

- `batchClaimInfo(batchCycle)` — includes `mintMerkleRoot`, `totalMintClaimable`, `claimDeadline`
- `mintClaimed(batchCycle, user)` — whether you already claimed
- `getPendingMintRequest(user, batchCycle)` — confirms your deposit was in that batch

Watch for **`TokensClaimed`** after a successful claim.

The frontend resolves proofs from hosted manifests (`NEXT_PUBLIC_MINT_PROOF_BASE_URL` or `/mint-proofs/{product}-mint-batch-{cycle}.json`) and can rebuild from chain when manifests are unavailable.

---

## 7. Redeem

Redeems require approving the relevant KASH token to the matching KashYield vault, then submitting a redeem request (see KashYield ABI).

KASH-ETH redeem:

```ts
await wallet.writeContract({
  address: kashTokenEth,
  abi: erc20Abi,
  functionName: 'approve',
  args: [kashYieldEth, kashAmount],
});

await wallet.writeContract({
  address: kashYieldEth,
  abi: kashYieldAbi,
  functionName: 'requestRedeem', // see kashYieldABI.ts
  args: [kashAmount],
});
```

KASH-BTC redeem:

```ts
await wallet.writeContract({
  address: kashTokenBtc,
  abi: erc20Abi,
  functionName: 'approve',
  args: [kashYieldBtc, kashAmount],
});

await wallet.writeContract({
  address: kashYieldBtc,
  abi: kashYieldAbi,
  functionName: 'requestRedeem', // see kashYieldABI.ts
  args: [kashAmount],
});
```

Watch for **RedeemRequested**, then batch settlement.

After settlement, claim the underlying asset with the Merkle proof published for the batch (see §6 for the analogous **`claimMint`** flow for deposits):

- Redeem proof manifests: `NEXT_PUBLIC_REDEEM_PROOF_BASE_URL/{product}-batch-{cycle}.json` or `/redeem-proofs/{product}-batch-{cycle}.json`
- Leaf hash: `keccak256(abi.encode(batchCycle, user, claimAmount))` — ETH/wBTC wei (18 / 8 decimals respectively)

```ts
await wallet.writeContract({
  address: kashYieldBtc,
  abi: kashYieldAbi,
  functionName: 'claimRedeem',
  args: [batchCycle, claimAmount, proof],
});
```

---

## 8. Risk gate

Before allocating capital, read:

- [How Yield Works](how-yield-works.md)
- [Risks & Safeguards](risks.md)
