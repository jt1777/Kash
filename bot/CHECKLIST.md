# Bot – Next Steps Checklist

Concrete tasks to get the bot production-ready for Arbitrum Sepolia (and keep it correct for mainnet later). Tick off as you go.

---

## 1. Fix mainnet vs Sepolia addresses in batch/automation

**Goal:** Bot should use the same network as `config` (Sepolia by default). Right now several files hardcode Arbitrum **mainnet** addresses.

| # | File | What to do |
|---|------|------------|
| 1.1 | `src/batch/batchProcessor.ts` | Remove the local `TOKEN_ADDRESSES` and `AAVE_POOL_ADDRESS` (lines 6–15). Import and use `config.tokens` and add `config.aavePoolAddress` (or read Aave pool from contract: `kashYield.aavePoolAddress()`). Use those in `getAssetSymbol()` and anywhere asset/address is needed. |
| 1.2 | `src/batch/rebalancerBot.ts` | Same: remove local `TOKEN_ADDRESSES` (lines 6–12). Use `config.tokens`. Aave pool: add to config or read from contract. |
| 1.3 | `src/batch/liquidationGuardBot.ts` | Replace hardcoded `AAVE_POOL_ADDRESS` (line 24) with a value from config (e.g. `config.aavePoolAddress`) or read from KashYield: `await kashYield.aavePoolAddress()`. |
| 1.4 | `src/config.ts` | Add `aavePoolAddress: process.env.AAVE_POOL_ADDRESS || '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff'` (Arbitrum Sepolia Aave pool) so batch/rebalancer/liquidation can use one source of truth. |

---

## 2. Fix `.env.example` (Sepolia vs mainnet)

**Goal:** Anyone copying `.env.example` gets **Arbitrum Sepolia** values, not mainnet.

| # | File | What to do |
|---|------|------------|
| 2.1 | `bot/.env.example` | Set token addresses to Arbitrum **Sepolia**: WETH `0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9`, WBTC `0x4D8b720b94D341F54df948696747B05998c5FbD5`, USDT `0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1`, USDC `0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5`. |
| 2.2 | `bot/.env.example` | Set oracle addresses to Arbitrum **Sepolia** (e.g. ETH/USD `0x1AdF01abD96C11AEE2f20a41a03fAD11b3D8d2b4` or your current feeds). Add a short comment: “Arbitrum Sepolia; for mainnet see docs.” |

---

## 3. Wire NET_MINT / NET_REDEEM to the contract (batchProcessor)

**Goal:** After `processBatch()`, the bot actually calls KashYield to deploy/withdraw capital (Aave + Hyperliquid).

| # | File | What to do |
|---|------|------------|
| 3.1 | `src/batch/batchProcessor.ts` | In `handleNetMint`: uncomment or add the real contract calls in order: e.g. wrap ETH→wETH if needed, then `depositToAave(asset, amount)` (or equivalent), then `borrowFromAave(USDC, borrowAmount)`, then `depositToHyperliquid(borrowAmount)`, then `openShort("ETH", size)` (contract uses `openShort(symbol, size)` – pass size in the right units). Use the contract’s owner functions; bot signer must be owner. |
| 3.2 | `src/batch/batchProcessor.ts` | In `handleNetRedeem`: uncomment or add the real contract calls in reverse order: e.g. `closeShort("ETH")`, `withdrawFromHyperliquid(amount)`, `repayToAave(USDC, amount)`, `withdrawFromAave(asset, amount)`. |
| 3.3 | `src/batch/batchProcessor.ts` | In `depositToHyperliquid(amount)`: uncomment and use `await this.kashYield.depositToHyperliquid(amount)` (and similarly for `withdrawFromHyperliquid`). Ensure `hyperliquidAddress` is set on the contract (you already have setHyperliquid script). |
| 3.4 | `src/batch/batchProcessor.ts` | In `openShortOnHyperliquid(amount)` and `closeShortOnHyperliquid(amount)`: call `this.kashYield.openShort("ETH", size)` and `this.kashYield.closeShort("ETH")`. Contract expects `openShort(string symbol, uint256 size)` (size in 18 decimals for the mock). Convert `amount` (USD 18 decimals) to size if needed (e.g. size = amount / ethPrice). |
| 3.5 | `src/batch/batchProcessor.ts` | Add basic error handling and logging around each contract call (e.g. “HL not set, skipping” if `hyperliquidAddress` is zero, and catch revert reasons). |

---

## 4. Reliably handle ProtocolInteraction after processBatch

**Goal:** Don’t depend on the event subscription firing before the process exits; use the tx receipt when possible.

| # | File | What to do |
|---|------|------------|
| 4.1 | `src/batch/batchProcessor.ts` | After `const receipt = await tx.wait()`, parse `receipt.logs` for `ProtocolInteraction` (decode with contract interface). For each NET_MINT / NET_REDEEM event, call `handleNetMint(amount, asset)` or `handleNetRedeem(amount, asset)` with the event’s `amount` and `asset`. |
| 4.2 | `src/batch/batchProcessor.ts` | Optionally keep the `this.kashYield.on('ProtocolInteraction', ...)` listener for long-running or duplicate-safe setups, but treat “handle from receipt” as the primary path so a one-off `npm start` run always processes the event. |

---

## 5. (Optional) Net position before processBatch

**Goal:** When the batch is not yet processed, show a sensible “pending” net position instead of 0.

| # | File | What to do |
|---|------|------------|
| 5.1 | `src/batch/batchProcessor.ts` | Before calling `processBatch()`, if `!batchInfo.processed` and (mintUsersCount > 0 or redeemUsersCount > 0), optionally call the same logic as `calculateNetPosition(provider, batchCycle)` (from `batch/calculateNetPosition.ts`) and log “Estimated net position (pending): X USD” so operators see expected direction/size. |

---

## 6. Liquidation guard – Aave user address

**Goal:** Support the case where the Aave “user” is not KashYield (e.g. a separate vault).

| # | File | What to do |
|---|------|------------|
| 6.1 | `src/config.ts` | Add optional `aaveUserAddress: process.env.AAVE_USER_ADDRESS || config.kashYieldAddress` so the Aave user can be overridden. |
| 6.2 | `src/batch/liquidationGuardBot.ts` | Use `config.aaveUserAddress` (or config.kashYieldAddress if not set) when calling `getUserAccountData(...)` instead of hardcoding the KashYield address. |

---

## 7. Chainlink Automation (optional / later)

**Goal:** Document or wire how this bot relates to on-chain `checkUpkeep`/`performUpkeep`.

| # | File | What to do |
|---|------|------------|
| 7.1 | `bot/README.md` | Add a short section: “The contract has on-chain checkUpkeep/performUpkeep (Chainlink). You can either (a) register an upkeep that calls the contract’s performUpkeep so a Chainlink node runs processBatch, or (b) run this bot on a schedule (cron) to call processBatch() yourself.” |
| 7.2 | (Optional) | If you want the bot to be the “performer” for Chainlink: ensure the bot’s `performUpkeep` path (e.g. in `chainlinkAutomation.ts`) only calls the contract’s `processBatch()` (or the contract’s `performUpkeep`) and that registration docs point to the contract address, not the bot. |

---

## 8. Quick validation before going live

| # | What to do |
|---|------------|
| 8.1 | Set `PRIVATE_KEY` to the **contract owner** wallet (the deployer of KashYield). |
| 8.2 | Set `KASH_YIELD_ADDRESS` to your deployed KashYield on Arbitrum Sepolia. |
| 8.3 | Ensure KashYield has Aave pool set (`setAavePool.js`) and, if using HL, Hyperliquid set (`setHyperliquid.js` with MockHyperliquid address). |
| 8.4 | Run `npm run build` and `npm start` once in the processing window and confirm: processBatch() is sent, receipt is received, and (after 4.1) NET_MINT/NET_REDEEM handlers run. |
| 8.5 | If you enabled Aave/HL calls (section 3), do a dry run on testnet with small amounts and verify Aave/HL state changes. |

---

## Priority order (suggested)

1. **1 + 2** – Address consistency and .env.example (avoids wrong network).
2. **3 + 4** – Wire NET_MINT/NET_REDEEM and handle events from receipt (core batch behavior).
3. **6** – Aave user address in config (if you ever use a separate vault).
4. **5** – Optional better logging for pending net position.
5. **7** – Documentation / Chainlink clarity.
6. **8** – Final validation before production.

You can copy this into a tracking doc or tick items directly in this file.
