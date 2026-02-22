# Deployment checklist (KashYieldETH now, KashYieldBTC later)

## Recovering ETH from the old (pre-rename) contract

If the **old** deployed contract (e.g. at `0x4C39...`) still holds ETH and you are the owner:

- **New KashYieldETH** has `ownerWithdrawEth(uint256 amount)` (onlyOwner). After you deploy the new contract, use this to withdraw excess ETH from the **new** deployment when needed.
- **Old contract** likely does **not** have this function. Options:
  1. Check the old contract’s ABI: if it has an owner-only withdraw/rescue function, call it (e.g. via cast or Hardhat script).
  2. If there is no such function, you can only reduce the balance by processing **redemptions** (users redeem KASH for ETH and the contract sends ETH out). Once you’ve migrated to KashYieldETH, you can pause the old contract (if it has `pause`) and consider any remaining ETH unrecoverable unless you have an older build with a rescue function.

## Now: ETH product only

You can deploy in either order. **Recommended:** deploy MockHyperliquid first so you have its address ready, then deploy KashYieldETH, then set the HL address on KashYieldETH.

### 1. Deploy MockHyperliquid (optional; do this first if you want HL on testnet)

```bash
npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia
```
Save the **MockHyperliquid** address. (Use the same USDC/USDT/wBTC addresses as KashYieldETH / frontend, or the script’s defaults.)

### 2. Deploy KashYieldETH

```bash
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```
Save the printed **KashYieldETH** and **KashTokenEth** addresses. (KashTokenEth is created in the constructor.)

### 3. Configure KashYieldETH

- **Set Hyperliquid** (run after KashYieldETH is deployed; use the MockHyperliquid address from step 1 or your real HL adapter):
  ```bash
  # .env: KASH_YIELD_ADDRESS=<KashYieldETH from step 2>, HYPERLIQUID_ADDRESS=<MockHyperliquid from step 1>
  npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia
  ```

- **Set Aave pool** (if different from built-in):
  ```bash
  npx hardhat run scripts/setAavePool.js --network arbitrumSepolia
  ```

### 4. Update frontend

- In **`frontend/lib/contracts/addresses.ts`** set:
  - `kashYieldEth`: deployed KashYieldETH address (from step 2)
  - `kashTokenEth`: deployed KashTokenEth address (from step 2)

### 5. Bot

- In **`bot/.env`** set:
  - `KASH_YIELD_ADDRESS` = KashYieldETH address
  - `KASH_TOKEN_ADDRESS` = KashTokenEth address (if the bot uses it)

No bot code changes: it already handles the flow (spot buy/sell, ETH vs BTC by asset). When you add KashYieldBTC later, you’ll run `processBatch()` on both contracts and handle each contract’s events.

### 6. Frontend – BTC minting

- **Mint:** Only ETH and wETH are offered; wBTC is disabled with “wBTC (KASH_BTC) coming soon.”
- **Redeem:** Users can redeem KASH_ETH for ETH, wETH, or wBTC (unchanged).

---

## Later: BTC product

1. Deploy **KashYieldBTC** and **KashToken_BTC** (clone of KashYieldETH for wBTC-only).
2. Update frontend: add `kashYieldBtc` / `kashTokenBtc` to addresses; add wBTC to mint tokens in `MintForm`; in RedeemForm, use KASH_BTC when user selects “Receive wBTC.”
3. Bot: call `processBatch()` on both KashYieldETH and KashYieldBTC; handle NET_MINT/NET_REDEEM from each (asset = ETH vs BTC).
