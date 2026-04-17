# KashYield Deployment Guide

## Prerequisites

1. **Node.js & npm** – Installed and in use
2. **Hardhat** – Configured in repo (use supported Node version; Hardhat may warn on Node 25+)
3. **dotenv** – Install if not present: `npm install dotenv`

---

## ⚠️ Critical rules — read before deploying

These caused 24+ hours of debugging. Don't skip them.

1. **`WETH_ADDRESS` must be a real WETH9 contract** (has `deposit()` and `withdraw()`). Standard ERC-20 tokens — even ones named "WETH" on the explorer — may not have these. Use `scripts/deploy-mock-weth.js` to deploy a guaranteed-compatible MockWETH for testnet.

2. **MockHyperliquid must be deployed with `MOCK_USDC_ADDRESS`** (your MockUSDC), not the real USDC address. If it's deployed with the real USDC, every Hyperliquid deposit will revert with `"Invalid stablecoin"`.

3. **MockAaveV3 must have `setWethAddress` called** with your MockWETH address. Without it, WETH deposits to Aave will revert with no data (`require(false)` style error).

4. **ETH price must be set on every new MockAaveV3 deploy.** Fresh deployments have `ethPriceInUsd = 0`, which makes every borrow fail with `"Borrow amount exceeds LTV limit"`.

5. **Set `exchangeSwitchDelay = 0` for testnet** immediately after deploying KashYieldETH/BTC. The default on a fresh vault is **24 hours** — registering a **second** perp adapter (after the first is confirmed) waits that long unless you zero the delay on testnet.

6. **`AAVE_USDC_ADDRESS` and `USDC_ADDRESS` are different.** The bot uses `AAVE_USDC_ADDRESS` first (MockUSDC for Aave borrows). Keep both in `bot/.env`. Do not delete either.

7. **All four mock contracts must stay in sync.** After any price change, run `npm run set:asset-price` to update the oracle, MockAaveV3, MockHyperliquid, and MockSpotDex simultaneously.

8. **Owner / treasury reserves (`ownerUsdcReserve`, asset-specific owner buffer).** The products credit on-chain balances that are **not** part of user NAV: call `markOwnerUsdcDeposit` after the owner sends USDC to the contract; on **KashYieldETH** use payable `markOwnerEthDeposit()` for ETH buffers (`ownerEthReserve`); on **KashYieldBtc** use `markOwnerWbtcDeposit` for WBTC (`ownerWbtcReserve`). The bot may call `coverUsdcShortfall` to move reserved USDC into the working float (reverts with `InsufficientOwnerUsdcReserve` if the reserve is too small). Batch phase 2 and `ownerWithdraw*` enforce these cushions so they are not paid to users or swept accidentally. Ops scripts and `snapshotOpsContext` treat **adjusted** balances (raw minus reserves) as the deployable float.

9. **Contract size (EIP-170, 24576 bytes).** `hardhat.config.js` enables the Solidity optimizer (`runs: 1`), `viaIR: true`, and `metadata.bytecodeHash: "none"`. `ProtocolInteraction` uses **`uint8` action codes** (see `contracts/libraries/ProtocolActionCodes.sol`) instead of string labels to keep bytecode smaller. A **deployed external library** still cannot take a `KashYield*` `storage` layout in Solidity 0.8.x for large batch helpers, so batch settlement stays in the main contracts. After `npx hardhat compile`, confirm there is no “contract code size exceeds 24576 bytes” warning before mainnet deploy. Local Hardhat uses `allowUnlimitedContractSize: true` and does **not** enforce the mainnet limit.

---

## Environment Setup

### Root `.env`

```env
# Private Key (DO NOT COMMIT)
PRIVATE_KEY=your_private_key_here

# RPC
ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_API_KEY

# Arbiscan (for verification)
ARBISCAN_API_KEY=your_arbiscan_api_key

# Mock contracts (fill in as you deploy — used by scripts)
WETH_ADDRESS=<deployed MockWETH>            # ← deploy this FIRST
AAVE_POOL_ADDRESS=<deployed MockAaveV3>
USDC_ADDRESS=<deployed MockUSDC>            # REQUIRED — no built-in default
WBTC_ADDRESS=<deployed MockWBTC>
HYPERLIQUID_ADDRESS=<deployed MockHyperliquid>
MOCK_SPOT_DEX_ADDRESS=<deployed MockSpotDex>
BTC_ORACLE_ADDRESS=<deployed MockChainlinkPriceFeed>
```

### `bot/.env`

```env
PRIVATE_KEY=your_private_key_here
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc

PRODUCT=eth                                  # or btc
KASH_YIELD_ETH_ADDRESS=<KashYieldETH address>
KASH_TOKEN_ETH=<KashTokenEth address>

AAVE_POOL_ADDRESS=<MockAaveV3>               # used for price setting
AAVE_USDC_ADDRESS=<MockUSDC>                 # ← bot uses THIS for Aave borrow/repay
USDC_ADDRESS=<real USDC on Arbitrum Sepolia> # reference only — AAVE_USDC_ADDRESS takes priority

WETH_ADDRESS=<MockWETH>
WBTC_ADDRESS=<MockWBTC>
HYPERLIQUID_ADDRESS=<MockHyperliquid>        # used for price setting
MOCK_SPOT_DEX_ADDRESS=<MockSpotDex>
BTC_ORACLE_ADDRESS=<MockChainlink BTC feed>
ETH_ORACLE_ADDRESS=<MockChainlink ETH feed>
```

---

## Get Testnet Funds

1. Sepolia ETH faucet: https://sepoliafaucet.com/ → bridge at https://bridge.arbitrum.io/?l2ChainId=421614
2. Direct Arbitrum Sepolia faucets:
   - https://www.alchemy.com/faucets/arbitrum-sepolia
   - https://faucet.quicknode.com/arbitrum/sepolia

---

# ETH Product Deployment (Arbitrum Sepolia)

Deploy in this exact order. Skipping steps or reusing addresses carelessly is the #1 source of errors.

---

### Step 1 — Compile

```bash
npx hardhat compile
```

---

### Step 2 — Deploy Mock Price Feeds (BTC + ETH)

⚠️ **This step is required.** The `set:asset-price` script always calls `oracle.setPrice()` first — if the oracle address points to a real Chainlink feed (which does not have `setPrice()`), the entire script will revert and no prices will be updated anywhere.

The KashYield contracts also use `getEthPrice()` / `getBtcPrice()` (oracle reads) to calculate how many Kash tokens to mint and how much ETH/BTC to return on redemption. The mock oracle is what keeps the contract's price in sync with MockAaveV3, MockHyperliquid, and MockSpotDex.

```bash
BTC_PRICE_USD=45000 ETH_PRICE_USD=3000 \
npx hardhat run scripts/deploy-mock-price-feeds.js --network arbitrumSepolia
```

Save the output addresses to root `.env` and `bot/.env`:

```env
BTC_ORACLE_ADDRESS=<MockChainlinkPriceFeed BTC from output>
ETH_ORACLE_ADDRESS=<MockChainlinkPriceFeed ETH from output>
```

After this, one `set:asset-price` call updates all four targets atomically — oracle, Aave, Hyperliquid, and SpotDex — so they are always in sync.

---

### Step 3 — Deploy MockWETH

**Do this before Aave.** Do not reuse a random ERC-20 address as WETH.

```bash
npx hardhat run scripts/deploy-mock-weth.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
WETH_ADDRESS=<MockWETH address from output>
```

---

### Step 4 — Deploy MockAaveV3 (+ MockUSDC + MockWBTC)

Reuse existing USDC/WBTC if you have them. Pass them explicitly to avoid redeploying.

```bash
# Fresh deploy (creates new MockUSDC and MockWBTC):
WETH_ADDRESS=<MockWETH from step 3> \
npx hardhat run scripts/deploy-mock-aave.js --network arbitrumSepolia

# OR reuse existing USDC/WBTC (only redeploys MockAaveV3):
# The script accepts MOCK_AAVE_USDC_ADDRESS or USDC_ADDRESS (same for WBTC).
# If USDC_ADDRESS / WBTC_ADDRESS are already in your .env, just run with WETH_ADDRESS:
WETH_ADDRESS=<MockWETH from step 3> \
npx hardhat run scripts/deploy-mock-aave.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
AAVE_POOL_ADDRESS=<MockAaveV3 from output>
AAVE_USDC_ADDRESS=<MockUSDC from output>   # ← bot .env only (for Aave operations)
USDC_ADDRESS=<MockUSDC from output>        # ← root .env (for deploy scripts)
WBTC_ADDRESS=<MockWBTC from output>
```

> **If you redeploy MockAaveV3** (after KashYieldETH already exists): run `setAavePool.js` to point KashYieldETH at the new pool, then `set:asset-price`.  
> On first-time deployment, skip both — KashYieldETH gets the Aave pool in Step 7, and you run `set:asset-price` in Step 13.

---

### Step 5 — Deploy MockHyperliquid

**Critical:** MockHyperliquid must use the same USDC as KashYieldETH (MockUSDC), not the real USDC. The script now reads `USDC_ADDRESS` and `WBTC_ADDRESS` from your `.env` automatically. If those are set, just run:

```bash
npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia
```

If `USDC_ADDRESS` / `WBTC_ADDRESS` are not in your `.env`, pass them explicitly:

```bash
USDC_ADDRESS=<MockUSDC from step 4> WBTC_ADDRESS=<MockWBTC from step 4> \
npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia
```

> The script warns you loudly if it falls back to real USDC — watch for `⚠️ USDC_ADDRESS not set` in the output.

Add to root `.env` and `bot/.env`:
```env
HYPERLIQUID_ADDRESS=<MockHyperliquid from output>
```

---

### Step 6 — Deploy HyperliquidAdapter (ETH)

```bash
MOCK_HL_ADDRESS=<MockHyperliquid from step 5> \
USDC_ADDRESS=<MockUSDC from step 4> \
IS_ETH_ASSET=true \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from output>
```

---

### Step 7 — Deploy KashYieldETH

```bash
AAVE_POOL_ADDRESS=<MockAaveV3 from step 4> \
USDC_ADDRESS=<MockUSDC from step 4> \
WETH_ADDRESS=<MockWETH from step 3> \
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from step 6> \
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```

> Setting `HL_ADAPTER_ADDRESS_ETH` here auto-**registers** the adapter (first-time bypass). You still need Step 9 to **activate** it — registration and activation are two separate calls.

Add to root `.env` and `bot/.env`:
```env
KASH_YIELD_ETH_ADDRESS=<KashYieldETH from output>
KASH_TOKEN_ETH=<KashTokenEth from output>
```

Add to `frontend/.env.local` (must use `NEXT_PUBLIC_` prefix for Next.js client):
```env
NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS=<KashYieldETH from output>
NEXT_PUBLIC_KASH_TOKEN_ETH=<KashTokenEth from output>
```

---

### Step 8 — Set timelock to 0 for testnet

The default perp **`exchangeSwitchDelay`** on a fresh `KashYieldETH` / `KashYieldBtc` is **24 hours** (`86400` seconds). Set it to `0` so you can swap adapters immediately during development.

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> DELAY_SECONDS=0 \
npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia
```

> On mainnet, leave the default **24 hours** or raise it (e.g. `172800` = 48 hours) via `setExchangeSwitchDelay` if you want a longer timelock for **future** adapter changes — never `0`.

---

### Step 9 — Set ETH oracle, register and activate Hyperliquid

⚠️ **All three sub-steps are required.**

```bash
# Point KashYieldETH at the mock ETH price feed deployed in step 2
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
ETH_ORACLE_ADDRESS=<MockChainlinkPriceFeed ETH from step 2> \
npx hardhat run scripts/setEthOracle.js --network arbitrumSepolia

# Register the adapter (skip if you already set HL_ADAPTER_ADDRESS_ETH in step 7)
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from step 6> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

# ⚠️  ALWAYS run this — activate HL as the live exchange
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
```

---

### Step 10 — Deploy MockSpotDex

One instance serves both ETH and BTC products.

```bash
BTC_PRICE=45000 \
ETH_PRICE=3000 \
WBTC_ADDRESS=<MockWBTC> \
USDC_ADDRESS=<MockUSDC> \
FUND_USDC=50000 \
FUND_WBTC=1 \
FUND_ETH=0.01 \
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/deploy-mock-spot-dex.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
MOCK_SPOT_DEX_ADDRESS=<MockSpotDex from output>
```

---

### Step 11 — Set cycle duration

```bash
CYCLE_SECONDS=3600 PRODUCT=eth KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia
```

Common values: `3600` = 1 hour (testing), `86400` = 1 day (production).

---

### Step 12 — Set initial prices

Run from the `bot/` folder. Updates oracle, MockAaveV3, MockHyperliquid, and MockSpotDex in one shot.

```bash
cd bot
BTC_PRICE_USD=45000 ETH_PRICE_USD=3000 npm run set:asset-price
```

> **Run this after every MockAaveV3 or MockHyperliquid redeploy** — fresh contracts start with price = 0.

---

### Step 13 — Verify configuration

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/diagnose-eth.js --network arbitrumSepolia
```

This shows: ETH balance, aavePool, wethAddress, usdcAddress, ethPriceInUsd, supplied/borrowed amounts. Confirm everything is non-zero before running the bot.

---

### ETH Product — Summary checklist

- [ ] `deploy-mock-price-feeds.js` → save `BTC_ORACLE_ADDRESS`, `ETH_ORACLE_ADDRESS` to `.env`
- [ ] `deploy-mock-weth.js` → save `WETH_ADDRESS`
- [ ] `deploy-mock-aave.js` (with `WETH_ADDRESS`) → save `AAVE_POOL_ADDRESS`, `AAVE_USDC_ADDRESS`, `USDC_ADDRESS`, `WBTC_ADDRESS`
- [ ] `deploy-mock-hyperliquid-arbitrum-sepolia.js` (with `USDC_ADDRESS`, `WBTC_ADDRESS`) → save `HYPERLIQUID_ADDRESS`
- [ ] `deploy-hyperliquid-adapter.js` (with `MOCK_HL_ADDRESS`, `USDC_ADDRESS`, `IS_ETH_ASSET=true`) → save `HL_ADAPTER_ADDRESS_ETH`
- [ ] `deploy-arbitrum-sepolia.js` (with `AAVE_POOL_ADDRESS`, `USDC_ADDRESS`, `WETH_ADDRESS`, `HL_ADAPTER_ADDRESS_ETH`) → save `KASH_YIELD_ETH_ADDRESS`, `KASH_TOKEN_ETH`
- [ ] `setExchangeSwitchDelay.js` → `DELAY_SECONDS=0` for testnet
- [ ] `setEthOracle.js` → point KashYieldETH at `ETH_ORACLE_ADDRESS` from step 2
- [ ] `setHyperliquid.js` → register adapter (skip if auto-registered in deploy step)
- [ ] `setActivePerpExchange.js` (EXCHANGE_NAME=HL) → **always required**, even after auto-registration
- [ ] `deploy-mock-spot-dex.js` → save `MOCK_SPOT_DEX_ADDRESS`
- [ ] `setCycleDuration.js` → `CYCLE_SECONDS=3600` for testing
- [ ] `cd bot && BTC_PRICE_USD=45000 ETH_PRICE_USD=3000 npm run set:asset-price`
- [ ] `diagnose-eth.js` → confirm all values set
- [ ] Update all 3 `.env` files (frontend uses `NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS`, etc.)

---

## BTC Product Deployment (Arbitrum Sepolia)

The BTC product shares MockAaveV3, MockHyperliquid, and MockSpotDex with the ETH product (unless you want separate instances).

### Step 1 — Ensure shared contracts exist

If deploying BTC alongside ETH, MockAaveV3, MockHyperliquid, and MockSpotDex are already deployed. Set these in `.env`:

```env
WBTC_ADDRESS=<MockWBTC>
AAVE_POOL_ADDRESS=<MockAaveV3>
USDC_ADDRESS=<MockUSDC>
# Use the MockChainlinkPriceFeed BTC address deployed in step 2 of the ETH product
BTC_ORACLE_ADDRESS=<MockChainlinkPriceFeed BTC from step 2>
HYPERLIQUID_ADDRESS=<MockHyperliquid>
```

### Step 2 — Deploy HyperliquidAdapter (BTC)

```bash
MOCK_HL_ADDRESS=<MockHyperliquid> \
USDC_ADDRESS=<MockUSDC> \
WBTC_ADDRESS=<MockWBTC> \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia
```

Save `HL_ADAPTER_ADDRESS_BTC=<output>` to `.env`.

### Step 3 — Deploy KashYieldBtc

```bash
npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumSepolia
```

Save `KASH_YIELD_BTC_ADDRESS` and `KASH_TOKEN_BTC` to `.env`.

### Step 4 — Set timelock to 0 for testnet

```bash
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> DELAY_SECONDS=0 \
npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia
```

### Step 5 — Register and activate HL

```bash
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
HL_ADAPTER_ADDRESS_BTC=<HyperliquidAdapter> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
```

### Step 6 — Set MockSpotDex on KashYieldBtc

If MockSpotDex is already deployed, register it on the BTC contract:

```bash
MOCK_SPOT_DEX_ADDRESS=<MockSpotDex> \
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
npx hardhat run scripts/update-mock-spot-dex-price.js --network arbitrumSepolia
```

### Step 7 — Set cycle duration and prices

```bash
CYCLE_SECONDS=3600 PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia

cd bot && BTC_PRICE_USD=45000 npm run set:asset-price
```

### BTC Product — Summary checklist

- [ ] `WBTC_ADDRESS`, `AAVE_POOL_ADDRESS`, `USDC_ADDRESS` in `.env` (reuse from ETH product deploy)
- [ ] `BTC_ORACLE_ADDRESS` in `.env` → use the MockChainlinkPriceFeed BTC deployed in ETH Step 2
- [ ] `deploy-hyperliquid-adapter.js` (BTC, with `MOCK_HL_ADDRESS`, `USDC_ADDRESS`, `WBTC_ADDRESS`) → save `HL_ADAPTER_ADDRESS_BTC`
- [ ] `deploy-kashyieldbtc.js` → save `KASH_YIELD_BTC_ADDRESS`, `KASH_TOKEN_BTC`
- [ ] `setExchangeSwitchDelay.js` → `DELAY_SECONDS=0`
- [ ] `setHyperliquid.js` + `setActivePerpExchange.js` → activate HL
- [ ] Register MockSpotDex on KashYieldBtc
- [ ] `setCycleDuration.js` + `set:asset-price`
- [ ] Update all `.env` files and frontend

---

## Adding a second exchange adapter (GMX, Aster, etc.)

With `exchangeSwitchDelay = 0` (testnet), registration is immediate:

```bash
# Register (use KASH_YIELD_ETH_ADDRESS for ETH product, KASH_YIELD_BTC_ADDRESS for BTC)
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=GMX \
GMX_ADAPTER_ADDRESS=<adapter> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

# Confirm immediately (delay = 0)
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=GMX \
npx hardhat run scripts/confirmPerpExchange.js --network arbitrumSepolia

# Switch active exchange
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=GMX \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
```

For mainnet (non-zero `exchangeSwitchDelay`, typically **24h** by default), wait until the timelock expires between **proposing** a **subsequent** adapter and `confirmPerpExchange`. The first adapter on a fresh contract is still registered immediately.

---

## Updating MockHyperliquid (fixing "Invalid stablecoin")

If MockHyperliquid was deployed with the wrong USDC:

```bash
# Deploys new MockHL with correct USDC, updates adapter in-place (no KashYield redeploy needed)
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter> \
MOCK_USDC_ADDRESS=<MockUSDC> \
npx hardhat run scripts/fix-hl-usdc.js --network arbitrumSepolia

# Then set prices on the new MockHL
cd bot && ETH_PRICE_USD=3000 npm run set:asset-price
```

---

## Diagnosing stuck batches

```bash
# Check all key on-chain state for KashYieldETH
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/diagnose-eth.js --network arbitrumSepolia
```

Output shows: ETH balance, aavePool, wethAddress, usdcAddress, ethPriceInUsd, supplied/borrowed WETH, getATokenBalance results.

### Recovering stranded WETH from an old MockAaveV3

If the bot deposited WETH into an old MockAaveV3 (and KashYieldETH now points to a new one), use:

```bash
OLD_AAVE_ADDRESS=<old MockAaveV3 with the deposit> \
AAVE_POOL_ADDRESS=<current MockAaveV3 to restore to> \
npx hardhat run scripts/recover-eth-from-aave.js --network arbitrumSepolia
```

This withdraws WETH from the old Aave, unwraps it to ETH in KashYieldETH, then restores the active pool.

---

## Verify contracts on Arbiscan

```bash
# KashYieldETH (constructor args: botAddress, weth, usdc)
npx hardhat verify --network arbitrumSepolia <KASH_YIELD_ETH_ADDRESS> <BOT_ADDRESS> <WETH_ADDRESS> <USDC_ADDRESS>

# MockHyperliquid (constructor args: usdc, usdt, wbtc)
npx hardhat verify --network arbitrumSepolia <MOCK_HL_ADDRESS> <USDC> <USDT> <WBTC>

# HyperliquidAdapter ETH (constructor args: hlAddress, usdcAddress, assetAddress, isEthAsset, kashYieldAddress)
npx hardhat verify --network arbitrumSepolia <HL_ADAPTER_ADDRESS_ETH> <HL_ADDR> <USDC> "0x0000000000000000000000000000000000000000" true <KASH_YIELD_ETH_ADDRESS>
```

---

## Troubleshooting

### `require(false)` / empty revert on `depositToAave`
- **Cause:** `WETH_ADDRESS` points to an ERC-20 without a `deposit()` function (e.g. USDT, a non-WETH9 token).
- **Fix:** Deploy `MockWETH` with `deploy-mock-weth.js`, update `WETH_ADDRESS`, call `setWethAddress` on KashYieldETH and MockAaveV3.
- **Diagnose:** Run `diagnose-eth.js` and check `wethAddress`.

### `"Borrow amount exceeds LTV limit"`
- **Cause:** `ethPriceInUsd = 0` on MockAaveV3 (fresh deploy or never set).
- **Fix:** `cd bot && ETH_PRICE_USD=3000 npm run set:asset-price`

### `"Invalid stablecoin"` on Hyperliquid deposit
- **Cause:** MockHyperliquid was deployed with real USDC but KashYieldETH uses MockUSDC.
- **Fix:** Run `scripts/fix-hl-usdc.js` (redeploys MockHL with correct USDC, updates adapter in-place).

### Stage 1 keeps retrying even though it already succeeded
- **Cause:** Old MockAaveV3 code — `getATokenBalance(wethAddr)` reverts instead of returning the balance. Bot catches the error, gets 0, and thinks deposit never happened. Then `depositToAave` fails because KashYieldETH has no ETH left.
- **Fix:** Redeploy MockAaveV3 (the current code is fixed). Or run `recover-eth-from-aave.js` to reclaim the stranded WETH, then retry.

### `setHyperliquidAddress` reverts on the adapter
- **Cause:** Adapter was deployed before `setHyperliquidAddress` was added — old bytecode.
- **Fix:** Run `fix-hl-usdc.js` (also redeploys the adapter logic indirectly via a new MockHL + adapter update). If the adapter itself is old, redeploy with `deploy-hyperliquid-adapter.js`.

### Timelock wait when registering a new adapter
- **Cause:** `exchangeSwitchDelay` is non-zero (default **24 hours** on a fresh vault; longer if you raised it on mainnet).
- **Fix (testnet):** `KASH_YIELD_ETH_ADDRESS=<addr> DELAY_SECONDS=0 npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia`

### `"Insufficient funds"` when funding MockSpotDex
- **Cause:** Trying to send too much ETH from the deployer wallet.
- **Fix:** Reduce `FUND_ETH` amount (e.g. `FUND_ETH=0.5`), or fund later with `update-mock-spot-dex-price.js`.

### Bot uses wrong USDC for Aave
- **Cause:** `AAVE_USDC_ADDRESS` not set in `bot/.env` → falls back to `USDC_ADDRESS` (real USDC).
- **Fix:** Ensure `bot/.env` has `AAVE_USDC_ADDRESS=<MockUSDC address>`.

---

## Useful scripts

```bash
# Diagnose KashYieldETH on-chain state
KASH_YIELD_ETH_ADDRESS=<addr> npx hardhat run scripts/diagnose-eth.js --network arbitrumSepolia

# Recover stranded WETH from an old MockAaveV3
OLD_AAVE_ADDRESS=<old> AAVE_POOL_ADDRESS=<current> \
  npx hardhat run scripts/recover-eth-from-aave.js --network arbitrumSepolia

# Fix "Invalid stablecoin" (redeploy MockHL with correct USDC)
HL_ADAPTER_ADDRESS_ETH=<adapter> MOCK_USDC_ADDRESS=<usdc> \
  npx hardhat run scripts/fix-hl-usdc.js --network arbitrumSepolia

# Set adapter registration timelock
KASH_YIELD_ETH_ADDRESS=<addr> DELAY_SECONDS=0 \
  npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia

# Set Aave pool address on KashYieldETH
KASH_YIELD_ETH_ADDRESS=<addr> AAVE_POOL_ADDRESS=<pool> \
  npx hardhat run scripts/setAavePool.js --network arbitrumSepolia

# Set USDC address on KashYieldETH
KASH_YIELD_ETH_ADDRESS=<addr> USDC_ADDRESS=<usdc> \
  npx hardhat run scripts/setUsdcAddress.js --network arbitrumSepolia

# Check contract configuration
KASH_YIELD_ETH_ADDRESS=<addr> npx hardhat run scripts/check-contract-config.js --network arbitrumSepolia

# Check account balance
npx hardhat run scripts/checkBalance.js --network arbitrumSepolia

# Get current NAV
npx hardhat run scripts/getNAV.js --network arbitrumSepolia
```

---

## Network details

### Arbitrum Sepolia
- **Chain ID**: 421614
- **RPC**: https://sepolia-rollup.arbitrum.io/rpc
- **Explorer**: https://sepolia.arbiscan.io
- **Faucet**: https://www.alchemy.com/faucets/arbitrum-sepolia

### Arbitrum One (mainnet)
- **Chain ID**: 42161
- **RPC**: https://arb1.arbitrum.io/rpc
- **Explorer**: https://arbiscan.io

---

## Security notes

- Never commit `.env` or private keys.
- Use a separate test wallet for testnets.
- On mainnet, **`exchangeSwitchDelay` must not be `0`**; fresh vaults default to **24 hours**. Optionally set `172800` (48 hours) if you want a longer timelock for future perp adapter changes.
- Audit contracts before mainnet.
- Test on testnet for at least one week.
- Consider a professional security audit before mainnet.

---

# Mainnet Deployment (Arbitrum One)

## ⚠️ Pre-launch requirements

**Pre-launch checklist:**
- [ ] Smart contract security audit completed
- [ ] Bot operated without errors (ideally including a testnet or staging period before mainnet)
- [ ] `exchangeSwitchDelay` is **not** `0` on mainnet (default **24 hours** / `86400`; optional **48 hours** / `172800` via `setExchangeSwitchDelay`)
- [ ] Deployer wallet is a hardware wallet or multisig, not a hot wallet
- [ ] Bot wallet is separate from the deployer/owner wallet
- [ ] All contracts verified on Arbiscan

---

## Protocol contract addresses (Arbitrum One)

No mock contracts. All addresses below are the canonical, live protocol contracts.

### Tokens

| Token | Address |
|-------|---------|
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| USDC (native) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| wBTC | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` |

> Use **native USDC** (`0xaf88...`), not bridged USDC.e (`0xff970a...`). Aave and Hyperliquid both use native USDC on Arbitrum.

### Aave V3

| Contract | Address |
|----------|---------|
| Pool | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| WrappedTokenGatewayV3 | `0x5283BEcEd7ADF6D003225C13896E536f2D4264FF` |

### Chainlink price feeds

| Feed | Address |
|------|---------|
| ETH / USD | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |
| BTC / USD | `0x6ce185860a4963106506C203335A2910413708e9` |

### Uniswap V3

| Contract | Address |
|----------|---------|
| SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| UniswapV3Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |

Key pools (0.05% fee tier):
- WETH/USDC: look up via `factory.getPool(WETH, USDC, 500)`
- wBTC/USDC: look up via `factory.getPool(wBTC, USDC, 500)`

### Hyperliquid

| Contract | Address |
|----------|---------|
| Bridge 2 (Arbitrum → HL) | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` |

USDC is the only token the bridge accepts. Minimum deposit: 5 USDC.

---

## Architecture note: Hyperliquid on mainnet

This is the most important difference from the testnet setup.

**On testnet**, `MockHyperliquid` is a smart contract on Arbitrum. Every action — deposit, spot buy, open short, close short, spot sell, withdraw — is an Arbitrum transaction that settles synchronously.

**On mainnet**, real Hyperliquid is its own L1 chain. The flow is:

| Action | How it works |
|--------|-------------|
| Deposit USDC | On-chain: send USDC to bridge `0x2Df1c51E...` on Arbitrum |
| Spot buy ETH | **Off-chain**: call HL API (not an Arbitrum tx) |
| Open/close short | **Off-chain**: call HL API (not an Arbitrum tx) |
| Sell spot ETH → USDC | **Off-chain**: call HL API (not an Arbitrum tx) |
| Withdraw USDC | Off-chain: sign withdrawal on HL, validators settle back to Arbitrum (~3–4 min) |

The deployed **`HyperliquidAdapter`** contract therefore only handles deposits (bridge call) and withdrawal receipts. The trading operations (steps 04–07 in the ops scripts) become **pure bot API calls** that do not involve the KashYield contract at all.

This means the ops scripts for HL trading on mainnet will not call `contract.spotBuyOnHyperliquid()` etc. — they will call the HL REST API directly and update local state tracking.

**USDC collateral is confirmed.** HL only accepts USDC — no ETH or wBTC can be deposited as collateral. This is already reflected in the ops scripts:
- Script `03` deposits USDC to HL ✅
- Script `04` buys spot ETH/wBTC using USDC on HL ✅
- Script `07` sells spot ETH/wBTC back to USDC on HL ✅
- Script `08` withdraws USDC from HL (never ETH/wBTC) ✅
- Scripts `03b` and `12` are exclusively for asset-collateral DEXs (Aster), not HL ✅

---

## Architecture note: Uniswap V3 adapter

The `UniswapV3Adapter` must implement `ISpotDex` and wrap Uniswap V3's `SwapRouter02`:

```solidity
interface ISpotDex {
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external payable returns (uint256 amountOut);
}
```

Key implementation points:
- Use `SwapRouter02.exactInputSingle(...)` with `fee = 500` (0.05%) for WETH/USDC and wBTC/USDC
- Set reasonable `amountOutMinimum` (e.g. 0.5% slippage) — never pass `0` on mainnet
- `KashYieldETH.swapForUsdc` calls `ISpotDex.swapExactIn{value: ethAmount}(ETH_ADDRESS, usdc, …)` — **native ETH** in, USDC out (adapter unwraps / routes per its implementation)
- `KashYieldETH.swapFromUsdc` approves USDC on the spot adapter, then `swapExactIn(usdc, ETH_ADDRESS, …)` — USDC in, **native ETH** to the vault
- Approvals: KashYield uses `forceApprove` / payable `swapExactIn` as appropriate; the standalone `UniswapV3Adapter` wraps the router

---

## Mainnet environment setup

### Root `.env` (mainnet)

```env
PRIVATE_KEY=your_hardware_wallet_deployer_key

# Hardhat network `arbitrumOne` reads this (see hardhat.config.js):
ARBITRUM_ONE_RPC_URL=https://arb1.g.alchemy.com/v2/YOUR_API_KEY
# Used only for local fork tests — not for deploy/verify to mainnet:
# ARBITRUM_MAINNET_RPC_URL=...
ARBISCAN_API_KEY=your_arbiscan_api_key

# No mock contracts — use real addresses
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
AAVE_POOL_ADDRESS=0x794a61358D6845594F94dc1DB02A252b5b4814aD
UNISWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
BTC_ORACLE_ADDRESS=0x6ce185860a4963106506C203335A2910413708e9
HL_BRIDGE_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7

# Filled in as you deploy:
UNISWAP_ADAPTER_ADDRESS=<UniswapV3Adapter>
KASH_YIELD_ETH_ADDRESS=<KashYieldETH>
KASH_TOKEN_ETH=<KashTokenEth>
# HL_ADAPTER_* — add only after deploying HyperliquidAdapter (Step 4 ETH / BTC flow). Must be absent during Step 3; see Step 3 warning.
# HL_ADAPTER_ADDRESS_ETH=
# HL_ADAPTER_ADDRESS_BTC=
```

### `bot/.env` (mainnet)

```env
PRIVATE_KEY=your_bot_operator_key   # separate key from deployer
HYPERLIQUID_API_PRIVATE_KEY=your_bot_operator_key   # HL API signer (same key in direct mode)
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz

# Bot resolves RPC_URL first (see bot/src/config.ts); set this for Arbitrum One:
RPC_URL=https://arb1.g.alchemy.com/v2/YOUR_API_KEY

PRODUCT=eth
KASH_YIELD_ETH_ADDRESS=<KashYieldETH>
KASH_TOKEN_ETH=<KashTokenEth>

AAVE_POOL_ADDRESS=0x794a61358D6845594F94dc1DB02A252b5b4814aD
AAVE_USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831   # same as USDC on mainnet
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831      # same address
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
BTC_ORACLE_ADDRESS=0x6ce185860a4963106506C203335A2910413708e9

# No set:asset-price command on mainnet — prices come from Chainlink
```

---

## Mainnet deployment steps (ETH product)

> **Deployment order matters.** `KashYieldETH` must be deployed before `HyperliquidAdapter` because the adapter constructor now requires the KashYield contract address.

### Step 1 — Compile

```bash
npx hardhat compile
```

### Step 2 — Deploy UniswapV3Adapter

Constructor is **`(swapRouter, weth)`** only — no USDC argument. On `arbitrumOne` / `arbitrumSepolia` the script fills defaults; override with `UNISWAP_ROUTER_ADDRESS` / `WETH_ADDRESS` if needed.

```bash
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

(Optional explicit overrides:)

```bash
UNISWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

Save to root `.env`:
```env
UNISWAP_ADAPTER_ADDRESS=<UniswapV3Adapter from output>
```

### Step 3 — Deploy KashYieldETH

Hardhat loads your **root `.env`** on every run (`hardhat.config.js`). `deploy-arbitrum-sepolia.js` **optionally** calls `setHyperliquid(HL_ADAPTER_ADDRESS_ETH)` **during this deploy** if `HL_ADAPTER_ADDRESS_ETH` is set to a valid address. That is useful on testnet when the adapter already exists; on **this** mainnet order (KashYield before HyperliquidAdapter), you must **not** have `HL_ADAPTER_ADDRESS_ETH` in `.env` yet — remove it, comment it out, or leave it empty. Otherwise KashYield binds HL to an old or placeholder adapter at deploy time, and a later Step 4 deploy will **not** replace it unless you run `setHyperliquid.js` again (then the 48h timelock applies).

```bash
BOT_ADDRESS=<your_bot_wallet> \
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumOne
```

(`AAVE_POOL_ADDRESS` is not read by this deploy script — the Aave pool is **immutable** inside `KashYieldETH` at `0x794a…`.)

Save to root `.env`, `bot/.env`, and `frontend/.env.local`:
```env
KASH_YIELD_ETH_ADDRESS=<KashYieldETH from output>
KASH_TOKEN_ETH=<KashTokenEth from output>
```
```env
# frontend/.env.local
NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS=<KashYieldETH from output>
NEXT_PUBLIC_KASH_TOKEN_ETH=<KashTokenEth from output>
```

### Step 4 — Deploy HyperliquidAdapter (ETH)

> Requires `KASH_YIELD_ETH_ADDRESS` from Step 3.

Pass the **Bridge2** address as **`MOCK_HL_ADDRESS`** (or **`HYPERLIQUID_ADDRESS`** — the script accepts either; see `deploy-hyperliquid-adapter.js`). On Arbitrum One this is the live bridge ([table above](#hyperliquid)), not `MockHyperliquid`.

```bash
MOCK_HL_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
IS_ETH_ASSET=true \
KASH_YIELD_ADDRESS=<KASH_YIELD_ETH_ADDRESS from step 3> \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Save to root `.env`:
```env
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from output>
```

### Step 4a — Set direct deposit mode (required)

Immediately configure the adapter so the HL account is the bot EOA:

- `directDepositMode=true`
- `hlAccount=<bot wallet address>`

This avoids the contract-address account trap (contract addresses cannot directly sign HL API actions like `order`, `withdraw3`, `approveAgent`).

From repo root:

```bash
npx hardhat console --network arbitrumOne
```

Paste line-by-line:

```javascript
const [signer] = await ethers.getSigners()
const adapter = await ethers.getContractAt("HyperliquidAdapter", "<HL_ADAPTER_ADDRESS_ETH>", signer)
const tx = await adapter.setDirectDepositMode(true, "<BOT_EOA_ADDRESS>")
await tx.wait()
console.log("directDepositMode =", await adapter.directDepositMode())
console.log("hlAccount =", await adapter.hlAccount())
```

Expected output:
- `directDepositMode = true`
- `hlAccount = <BOT_EOA_ADDRESS>`

> This setting affects new deposits only. It does not migrate funds already sitting in an old HL account.

### Step 5 — Set Chainlink oracle

`KashYieldETH` already defaults **`ethOracle`** to the Arbitrum One ETH/USD feed (`0x639Fe6…`). This step is **optional on mainnet** but recommended so deployment docs and on-chain state explicitly match the feed you expect (and matches `diagnose-eth.js` checks).

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612 \
npx hardhat run scripts/setEthOracle.js --network arbitrumOne
```

### Step 6 — Set exchange switch delay (optional)

Fresh **`KashYieldETH`** already defaults **`exchangeSwitchDelay`** to **24 hours** (`86400`), matching the in-contract mainnet guidance. That timelock applies only when you **later** propose **another** perp adapter (or replace HL). The **first-ever** registration via `setHyperliquid` / `setPerpExchange` is **immediate** — it does not wait on this delay (contract NatSpec: “First-ever registration is immediate”).

**Skip this step** if 24 hours is enough. **Optionally** lengthen to 48 hours for future adapter changes:

```bash
# 172800 = 48 hours
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> DELAY_SECONDS=172800 \
npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumOne
```

### Step 7 — Register and activate HL adapter

**Initial mainnet deploy:** register HL, then activate — no perp timelock wait and no `confirmPerpExchange` (there is nothing pending to confirm). `setHyperliquid.js` prints which path ran; on first registration you should see “First-time registration … no timelock”.

```bash
# 1. Register HL adapter (first deploy: confirmed immediately)
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
HYPERLIQUID_ADDRESS=<HL_ADAPTER_ADDRESS_ETH from step 4> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumOne

# 2. Activate HL as the live exchange (always immediate once the adapter is in the registry)
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumOne
```

**Later — replacing HL or adding another named exchange:** a new proposal uses the Step 6 delay. Then wait until the timelock expires, confirm, then activate if needed:

```bash
# After setPerpExchange / setHyperliquid proposed a change (script will show expiry time)
# … wait for exchangeSwitchDelay …

KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=HL \
npx hardhat run scripts/confirmPerpExchange.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumOne
```

### Step 8 — Set Uniswap adapter as spot DEX

The first-ever call to `setSpotDex` is **immediate** (no timelock). Subsequent changes require a 48-hour `spotDexTimelock` wait followed by `confirmSpotDex`. The script handles both cases automatically.

The constructor only pre-whitelists **Uniswap SwapRouter02** (`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`). Each **deployed UniswapV3Adapter** (Step 2) has its **own** address and must be whitelisted before `setSpotDex`:

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
ROUTER_ADDRESS=<UNISWAP_ADAPTER_ADDRESS from step 2> \
npx hardhat run scripts/setAllowedSpotDexRouter.js --network arbitrumOne
```

Then:

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
SPOT_DEX_ADDRESS=<UNISWAP_ADAPTER_ADDRESS from step 2> \
npx hardhat run scripts/setSpotDex.js --network arbitrumOne
```

The script will confirm whether the DEX was applied immediately or a timelock was started. If a timelock was started, wait until **`spotDexTimelock`** expires (default **24 hours** on a fresh vault), then run `confirmSpotDex` (see `setSpotDex.js` / contract `confirmSpotDex`).

### Step 9 — Set cycle duration

```bash
# 86400 = 24 hours (daily batch cycle)
CYCLE_SECONDS=86400 PRODUCT=eth KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumOne
```

### Step 10 — Verify on Arbiscan

```bash
# KashYieldETH (constructor args: botAddress, weth, usdc)
npx hardhat verify --network arbitrumOne <KASH_YIELD_ETH_ADDRESS> <BOT_ADDRESS> \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831

# UniswapV3Adapter (constructor args: swapRouter, weth)
npx hardhat verify --network arbitrumOne <UNISWAP_ADAPTER_ADDRESS> \
  0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1

# HyperliquidAdapter (constructor args: hlBridge, usdc, assetAddress, isEthAsset, kashYieldAddress)
npx hardhat verify --network arbitrumOne <HL_ADAPTER_ADDRESS_ETH> \
  0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  "0x0000000000000000000000000000000000000000" true \
  <KASH_YIELD_ETH_ADDRESS>
```

### Step 11 — Post-deployment verification

Run the diagnose script to confirm every address and the Chainlink price feed are wired correctly before starting the bot.

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/diagnose-eth.js --network arbitrumOne
```

Expected: Aave pool, WETH, USDC, oracle, spot DEX, and active perp exchange are all non-zero; Chainlink ETH price is a reasonable USD value.

---

## Mainnet deployment — Summary checklist

- [ ] Step 2 — `UniswapV3Adapter` deployed and `UNISWAP_ADAPTER_ADDRESS` saved
- [ ] Step 3 — `KashYieldETH` deployed and `KASH_YIELD_ETH_ADDRESS` saved
- [ ] Step 4 — `HyperliquidAdapter` deployed and `HL_ADAPTER_ADDRESS_ETH` saved
- [ ] Step 5 — `setEthOracle.js` — Chainlink `0x639Fe6...` set
- [ ] Step 6 — _(Optional)_ `setExchangeSwitchDelay.js` — default is already **24h**; use `DELAY_SECONDS=172800` only if you want **48h** for **future** perp adapter proposals
- [ ] Step 7 — `setHyperliquid.js` then `setActivePerpExchange.js` — HL registered and active (first deploy: **no** wait, **no** `confirmPerpExchange`)
- [ ] _(Only when proposing a **subsequent** HL/adapter change)_ Wait for timelock → `confirmPerpExchange.js` → `setActivePerpExchange.js` if needed
- [ ] Step 8 — `setSpotDex.js` — UniswapV3Adapter set (immediate on first deploy; default **24h** `spotDexTimelock` on subsequent DEX changes)
- [ ] Step 9 — `setCycleDuration.js` — `CYCLE_SECONDS=86400` (daily)
- [ ] Step 10 — All three contracts verified on Arbiscan
- [ ] Step 11 — `diagnose-eth.js` — all addresses non-zero, Chainlink price non-zero
- [ ] `bot/.env` updated with all mainnet addresses
- [ ] `frontend/.env.local` updated

---

## Ops scripts on mainnet

The `bot/scripts/ops/` scripts work on mainnet with two important differences:

### 1. Pass `--network arbitrumOne`

Replace `--network arbitrumSepolia` with `--network arbitrumOne` in every command. For example:

```bash
PRODUCT=eth npx hardhat run bot/scripts/ops/00-status.js --network arbitrumOne
```

### 2. HL trading steps are API calls, not contract calls

Scripts `04` (spot buy), `05` (open short), `06` (close short), and `07` (spot sell) trigger on-chain function calls on testnet because `MockHyperliquid` is an Arbitrum contract. On mainnet, those trading operations happen via the Hyperliquid API (off-chain).

For mainnet operations:
- **Steps 01–03** (Aave deposit, borrow, HL deposit): unchanged — these are on-chain Arbitrum transactions.
- **Steps 04–07** (spot buy, open short, close short, spot sell): call the HL REST API directly using the HL SDK or manually via the HL UI. **`HyperliquidAdapter.syncBalances` / `syncPosition`** (or your bot’s polling path) records the resulting state on-chain after API trades.
- **Steps 08–12** (USDC withdraw from HL, Aave repay, Aave withdraw, Uniswap swaps): unchanged — these are on-chain Arbitrum transactions.

The HL USDC collateral model is confirmed correct for all scripts:
| Script | HL mainnet behaviour |
|--------|---------------------|
| `03` — deposit USDC to HL | Sends USDC to bridge `0x2Df1c51E...` ✅ |
| `04` — spot buy ETH/wBTC | HL API call (not on-chain) |
| `07` — spot sell ETH/wBTC → USDC | HL API call (not on-chain) |
| `08` — withdraw USDC from HL | Validator-settled withdrawal, USDC only ✅ |
| `03b`, `12` — asset deposit/withdraw | Aster/asset-collateral path only, skip for HL ✅ |
