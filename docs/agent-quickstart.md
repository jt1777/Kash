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
| KASH-ETH | `0xd9c2c8DdCA745EBa7a8c575d0ed0171b8D0565ad` | `0x328d6905bdd90ab1302D70c61ddaDdE77fd863A6` | Native ETH or WETH |
| KASH-BTC | `0xAD3298903584DbD539C2085e099136445AeeCBE9` | `0xf359890E857aB63EcE696a73f647Fcb65A7d82E0` | wBTC (`0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`) |

**Infrastructure (shared or per product):**

| Contract | KASH-ETH | KASH-BTC |
|----------|----------|----------|
| ExchangeFacade | `0x8cF9588aE4b9fF962349C456ddBD04498e41272C` | `0x1a8B86e4C2c664864A104EFF1A61ef489f14a01e` |
| HyperliquidAdapter | `0xb60A539b3377a4cBFb434C7c3a5d3262be874174` | `0xc2d8Fb0f6E20Ba5E10af671d20F37c9e9A86b011` |
| HL account (`hlAccount`) | `0x54BF441Eb2BF0d6EDee63040B1eA2Acd78Eb5E35` | `0x8ab8A21e70a869B0472b20B1fB903E685B0F7B9F` |
| UniswapV3Adapter (spot DEX, shared) | `0xce97BFB848981A89fdCB1b58d9ef27DD4214d1A8` | same |

Confirm `hlAccount` on Arbiscan via `HyperliquidAdapter.hlAccount()` — it changes if the bot wallet is rotated.

Live addresses are the table above (and `HyperliquidAdapter.hlAccount()` on Arbiscan). Do not treat `frontend/lib/contracts/addresses.ts` as the source of truth — that file is filled from deploy env and is `0x0` without Vercel secrets.

ABIs for method names:

* KashYield: [`frontend/lib/contracts/kashYieldABI.ts`](https://github.com/jt1777/Kash/tree/main/frontend/lib/contracts/kashYieldABI.ts)
* KASH ERC-20: [`frontend/lib/contracts/kashTokenABI.ts`](https://github.com/jt1777/Kash/tree/main/frontend/lib/contracts/kashTokenABI.ts)

WETH (KASH-ETH deposits): `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`.

**ABI note:** `kashYieldABI.ts` merges ETH and BTC vault ABIs for the frontend. Some libraries (e.g. web3.py) reject duplicate selectors such as `claimRedeem` and `swapForUsdc`. Filter to one product (dedupe by function `name` + `inputs` types) or use the verified vault ABI from Arbiscan.

**NAV verification:** Step-by-step portfolio rebuild (asset leg + net USDC leg, 18-dec oracle getters) is in [Verify NAV](verify-NAV.md). Published `getNAV()` is the product number; a live rebuild may lag between `updateNAV` writes.

---

## 2. Preflight checks

Before sending a transaction, read from the vault contract (via the KashYield ABI):

- Whether the contract is **paused**
- Whether the **user window** is open (deposits/redemptions allowed)
- Whether the **processing window** is active (batch running) — **not mutually exclusive** with the user window depending on on-chain config; read both
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

**Minimum size:** ~$10 oracle USD is enforced by the frontend and batch ops skip threshold only — **`requestMint` has no on-chain $10 floor**; a smaller deposit can still land on-chain but may receive no strategy deployment until a later batch.

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

Same ~$10 skip threshold as KASH-ETH (frontend + batch ops only; no on-chain floor).

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

Deposits and redemptions are batched. Submit before the documented cutoff, then watch these **events**:

- **MintRequested**
- **RedeemRequested**
- **BatchProcessed**
- **TokensClaimed**

Useful **reads** (not events — method names in KashYield ABI):

- `mintClaimed(batchCycle, user)`, `redeemClaimed(batchCycle, user)`
- Pending mint / redeem request for a user and batch cycle
- Batch info for a cycle; `batchClaimInfo(batchCycle)`
- KASH token balance for the user
- Current NAV

Do not assume immediate KASH receipt after a deposit request. Wait for batch processing (`BatchProcessed`), then load the hosted mint claim proof for the batch and call **`claimMint`**. For redeems, wait for settlement, load the hosted redeem claim proof, then call **`claimRedeem`**.

---

## 6. Claim minted KASH

After **`BatchProcessed`** for a cycle where you had a pending mint, KASH is allocated but not pushed to your wallet. Claim with the Merkle proof published for that batch.

**Pull-claim model:** Phase 2 batch settlement commits a `mintMerkleRoot` on-chain. KASH is **not** transferred automatically — each minter must call `claimMint` with a Merkle proof. Claims expire **30 days** after root commit (`CLAIM_EXPIRY_SECONDS`; see `batchClaimInfo(batchCycle).claimDeadline`).

**Proof manifests** are published by the operator after each batch (same top-level shape as redeem proofs; mint leaves use **`kashAmount`**, redeem leaves use **`amount`**):

```json
{
  "batchCycle": "492518",
  "root": "0x…",
  "leaves": [{ "user": "0x…", "kashAmount": "…", "proof": ["0x…", "…"] }]
}
```

Public proof manifests (use these; do not wait on a frontend env var):

* Mint: `https://rgmuqtp7bm5kimpv.public.blob.vercel-storage.com/mint-proofs/{eth|btc}-mint-batch-{batchCycle}.json`
* Redeem: `https://rgmuqtp7bm5kimpv.public.blob.vercel-storage.com/redeem-proofs/{eth|btc}-batch-{batchCycle}.json`

These URLs are **current production** (Vercel Blob). If you get a 404, the store prefix may have changed — re-check the live base from the [KASH landing page](https://www.kash-token.io) agent JSON (`mintClaimProofs` / `redeemClaimProofs`), or from kash-ops: `cd bot && npm run mint-proof:blob-url` / `npm run redeem-proof:blob-url` (requires `BLOB_READ_WRITE_TOKEN` in `bot/.env`).

The app also tries `NEXT_PUBLIC_MINT_PROOF_BASE_URL` / `NEXT_PUBLIC_REDEEM_PROOF_BASE_URL` and `/mint-proofs/…` / `/redeem-proofs/…` — those are for the website, not for agents. If no hosted manifest is available, rebuild a single-user proof from chain events (`frontend/lib/mintProofs.ts`).

- Leaf hash: `keccak256(abi.encode(batchCycle, user, kashAmount))` — `kashAmount` in the manifest is KASH wei (18 decimals)

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

After settlement, claim the underlying asset with the Merkle proof published for the batch (see §6 for public proof URLs and the analogous **`claimMint`** flow for deposits):

- Leaf hash: `keccak256(abi.encode(batchCycle, user, claimAmount))` — ETH/wBTC wei (18 / 8 decimals respectively)

`claimRedeem` is the same on both vaults. In the merged frontend ABI the amount argument is named `ethAmount`; it is still **asset wei** (18-dec ETH or 8-dec wBTC).

```ts
// ETH: claimAmount is wei. BTC: claimAmount is wBTC base units (8 decimals).
await wallet.writeContract({
  address: kashYieldEth, // or kashYieldBtc
  abi: kashYieldAbi,
  functionName: 'claimRedeem',
  args: [batchCycle, claimAmount, proof],
});
```

Earliest redeem is the batch **after** the deposit batch (deposit in N, redeem in N+1 or later).

---

## 8. Risk gate

Before allocating capital, read:

- [How Yield Works](how-yield-works.md)
- [Risks & Safeguards](risks.md)
