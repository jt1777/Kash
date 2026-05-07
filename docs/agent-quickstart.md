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
| KASH-ETH | `0x92c5833Deaac65a7aCB47867Cf009cAC1bF1dD5a` | `0x8642483DcCE55270692aD559dCac7cf7eA0F9Bd9` | Native ETH or WETH |
| KASH-BTC | `0x1e7cFC456df4f38e5F1715C585145280aB89bE46` | `0x184E5A30311018Fc0F03140C63515cA6391788D5` | wBTC (`0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`) |

Source of truth in the app:

- Contract addresses: [`frontend/lib/contracts/addresses.ts`](../frontend/lib/contracts/addresses.ts)
- KashYield ABI: [`frontend/lib/contracts/kashYieldABI.ts`](../frontend/lib/contracts/kashYieldABI.ts)
- KASH ERC-20 ABI: [`frontend/lib/contracts/kashTokenABI.ts`](../frontend/lib/contracts/kashTokenABI.ts)

---

## 2. Preflight checks

Run these reads before sending a transaction:

```ts
paused()
isUserWindow()
isProcessingWindow()
getNAV()
feeBps()
getCurrentBatchCycle()
getBatchInfo(batchCycle)
```

Recommended gate:

- Do not mint or redeem if `paused()` is true.
- Only submit mint/redeem requests when `isUserWindow()` is true.
- Confirm `feeBps()` matches your model before sizing a deposit.
- Treat `getNAV()` as the current contract NAV, not a promise of future yield.
- Confirm the current batch and settlement cadence against [How Yield Works](how-yield-works.md).

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

WETH path:

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
  functionName: 'requestMint',
  args: [wethAmount],
});
```

Watch for `MintRequested(user, amountIn, batchCycle)`.

---

## 4. Mint KASH-BTC

KASH-BTC uses wBTC. Approve the BTC vault first:

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
  functionName: 'requestMint',
  args: [wbtcAmount],
});
```

Watch for `MintRequested(user, amountIn, batchCycle)`.

---

## 5. Monitor settlement

Deposits and redemptions are batched. Submit before the documented cutoff, then watch:

```ts
MintRequested
RedeemRequested
BatchProcessed
TokensClaimed
```

Useful reads:

```ts
getPendingMintRequest(user, batchCycle)
getPendingRedeemRequest(user, batchCycle)
getBatchInfo(batchCycle)
balanceOf(user) // on the KASH token
getNAV()
```

Do not assume immediate KASH receipt after `requestMint`. Wait for batch processing and confirm the KASH token balance.

---

## 6. Redeem

Redeems require approving the relevant KASH token to the matching KashYield vault.

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
  functionName: 'requestRedeem',
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
  functionName: 'requestRedeem',
  args: [kashAmount],
});
```

Watch for `RedeemRequested(user, kashAmount, batchCycle)` and then batch settlement.

---

## 7. Risk gate

Before allocating capital, read:

- [How Yield Works](how-yield-works.md)
- [Risks](risks.md)

Agent policy suggestion:

- Set a maximum allocation per product.
- Require `paused() == false`.
- Require `isUserWindow() == true` for mint/redeem.
- Require `feeBps()` within your configured maximum.
- Require NAV and batch state to be read from your own RPC or indexer.
- Size deposits based on current TVL, liquidity, strategy risks, operator assumptions, and your own risk budget.

