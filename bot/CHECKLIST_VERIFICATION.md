# Checklist Verification – Bot Implementation

Assessment of the current bot code against `CHECKLIST.md`. Verified after merge from `origin/landing-page`.

---

## ✅ Section 1: Fix mainnet vs Sepolia addresses

| # | Status | Notes |
|---|--------|------|
| 1.1 | ✅ Done | `batchProcessor.ts` uses `TOKEN_ADDRESSES` and `AAVE_POOL_ADDRESS` from `config` (lines 6–16). No hardcoded mainnet addresses. |
| 1.2 | ✅ Done | `rebalancerBot.ts` uses `config.tokens` for `TOKEN_ADDRESSES` (lines 5–12). |
| 1.3 | ✅ Done | `liquidationGuardBot.ts` uses `config.aavePoolAddress` (line 24). |
| 1.4 | ✅ Done | `config.ts` has `aavePoolAddress` with Sepolia default (lines 66–67). |

---

## ✅ Section 2: Fix `.env.example`

| # | Status | Notes |
|---|--------|------|
| 2.1 | ✅ Done | Token addresses in `.env.example` are Arbitrum Sepolia (WETH, WBTC, USDT, USDC). Comment says "Arbitrum Sepolia Testnet" and "For mainnet addresses, see the project documentation." |
| 2.2 | ✅ Done | Oracle addresses are Sepolia; same mainnet note. |

---

## ⚠️ Section 3: Wire NET_MINT / NET_REDEEM to contract

| # | Status | Notes |
|---|--------|------|
| 3.1 | ✅ Done | `handleNetMint` calls `depositToAave`, `borrowFromAave`, `depositToHyperliquid`, `openShortOnHyperliquid` in order. |
| 3.2 | ✅ Done | `handleNetRedeem` calls `closeShortOnHyperliquid`, `withdrawFromHyperliquid`, `repayToAave`, `withdrawFromAave`. |
| 3.3 | ✅ Done | `depositToHyperliquid` calls `this.kashYield.depositToHyperliquid(amount)`; checks HL address and has try/catch. |
| 3.4 | ⚠️ Bug | `openShortOnHyperliquid` calls `this.kashYield.getLatestPrice(TOKEN_ADDRESSES.WETH)`. **The KashYield contract does not have `getLatestPrice`.** It has `getTokenUSD(token, amount)`. Use `getTokenUSD(TOKEN_ADDRESSES.WETH, 10n**18n)` to get the USD value of 1 ETH (18 decimals) as the price. **Fixed in code.** |
| 3.5 | ✅ Done | Error handling and "HL not set, skipping" in place. |

**Units (fixed):** The bot now converts USD (18 decimals) to token amounts before all Aave and Hyperliquid calls. Added `usdToTokenAmount(token, usdAmount)` which calls the contract’s `calculateTokenAmount(token, usdValue)`. `handleNetMint` and `handleNetRedeem` use it for deposit/withdraw/borrow/repay and for HL deposit/withdraw (USDC units).

---

## ✅ Section 4: Handle ProtocolInteraction from receipt

| # | Status | Notes |
|---|--------|------|
| 4.1 | ✅ Done | `handleEventsFromReceipt(receipt)` parses `receipt.logs`, decodes `ProtocolInteraction`, and calls `handleNetMint` / `handleNetRedeem` with event args. Invoked after `tx.wait()` (line 100). |
| 4.2 | ✅ Done | Event listener exists as `setupEventListener()` (fallback); primary path is receipt-based. |

---

## ✅ Section 5: (Optional) Net position before processBatch

| # | Status | Notes |
|---|--------|------|
| 5.1 | ✅ Done | Before `processBatch()`, when batch not processed and mint/redeem count > 0, calls `calculateNetPosition(provider, batchCycle)` and logs "Estimated Net Position (pending)" with mint/redeem counts and USD. |

---

## ✅ Section 6: Liquidation guard – Aave user address

| # | Status | Notes |
|---|--------|------|
| 6.1 | ✅ Done | `config.ts` has `aaveUserAddress: process.env.AAVE_USER_ADDRESS || ''` (line 70). |
| 6.2 | ✅ Done | `liquidationGuardBot.ts` uses `config.aaveUserAddress || config.kashYieldAddress` for `getUserAccountData` (line 104) and `getCurrentHealthFactor` (line 295). |

---

## ✅ Section 7: Chainlink Automation (optional)

| # | Status | Notes |
|---|--------|------|
| 7.1 | ✅ Done | `bot/README.md` describes Option 1 (Chainlink Automation: register upkeep, call `performUpkeep`) and Option 2 (off-chain bot on a schedule to call `processBatch()`). |

---

## Section 8: Daily yield and NAV before redeem

| # | Status | Notes |
|---|--------|------|
| 8.1 | ✅ Done | `types.ts` defines `DailyYield`: `aaveSupplyEarned`, `aaveBorrowCost`, `hlFunding`, `netYield` (all USD 18 decimals). |
| 8.2 | ⚠️ Stub | `batch/dailyYield.ts` has `getDailyYield(provider)` returning DailyYield; currently returns zeros. TODOs: Aave supply interest (aToken/reserve index), Aave borrow cost (variableDebt/index), HL funding (API). `computeNAVFromPortfolioAndYield(portfolioValueUSD, netYield, totalKashSupply)` added for when NAV update is wired. |
| 8.3 | ✅ Done | Before `processBatch()`, batch processor calls `getDailyYield(provider)` and logs the three components and net. Comment in code: to reflect in redeems, call `updateNAV((portfolioValue + netYield) / totalSupply)` before processBatch when portfolio value and yield are implemented. |

---

## Section 9: Quick validation

Operational checklist; not verifiable from code. Ensure before go-live: owner key, `KASH_YIELD_ADDRESS`, Aave/HL set on contract, one run in processing window, and dry run if Aave/HL calls are enabled.

---

## Summary

- **Fully implemented:** Sections 1, 2, 4, 5, 6, 7.
- **One code bug fixed:** Section 3.4 – `getLatestPrice` replaced with `getTokenUSD(WETH, 10^18)` in `openShortOnHyperliquid`.
- **Fee/funding tracking (Section 8):** Daily yield types and batch flow are in place; `getDailyYield()` is a stub (returns zeros). To complete: implement Aave supply/borrow accrual and HL funding in `dailyYield.ts`, then optionally call `updateNAV(newNAV)` before processBatch using `computeNAVFromPortfolioAndYield` once portfolio value and total supply are available.
- **Remaining gap:** Section 3 – Aave deposit/withdraw (and possibly borrow/repay) use USD amounts; contract expects token amounts. Add USD→token conversion before calling `depositToAave` / `withdrawFromAave` (and adjust borrow/repay if needed).
