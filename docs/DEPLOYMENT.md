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

5. **Set `exchangeSwitchDelay = 0` for testnet** immediately after deploying KashYieldETH/BTC. The default is 48 hours — registering a second adapter without doing this means waiting 2 days.

6. **`AAVE_USDC_ADDRESS` and `USDC_ADDRESS` are different.** The bot uses `AAVE_USDC_ADDRESS` first (MockUSDC for Aave borrows). Keep both in `bot/.env`. Do not delete either.

7. **All four mock contracts must stay in sync.** After any price change, run `npm run set:asset-price` to update the oracle, MockAaveV3, MockHyperliquid, and MockSpotDex simultaneously.

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
KASH_YIELD_ADDRESS=<KashYieldETH address>
KASH_TOKEN_ADDRESS=<KashTokenEth address>

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

### Step 2 — Deploy MockWETH

**Do this first.** Do not reuse a random ERC-20 address as WETH.

```bash
npx hardhat run scripts/deploy-mock-weth.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
WETH_ADDRESS=<MockWETH address from output>
```

---

### Step 3 — Deploy MockAaveV3 (+ MockUSDC + MockWBTC)

Reuse existing USDC/WBTC if you have them. Pass them explicitly to avoid redeploying.

```bash
# Fresh deploy (creates new MockUSDC and MockWBTC):
WETH_ADDRESS=<MockWETH from step 2> \
npx hardhat run scripts/deploy-mock-aave.js --network arbitrumSepolia

# OR reuse existing USDC/WBTC (only redeploys MockAaveV3):
MOCK_AAVE_USDC_ADDRESS=<existing MockUSDC> \
MOCK_AAVE_WBTC_ADDRESS=<existing MockWBTC> \
WETH_ADDRESS=<MockWETH from step 2> \
npx hardhat run scripts/deploy-mock-aave.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
AAVE_POOL_ADDRESS=<MockAaveV3 from output>
AAVE_USDC_ADDRESS=<MockUSDC from output>   # ← bot .env only (for Aave operations)
USDC_ADDRESS=<MockUSDC from output>        # ← root .env (for deploy scripts)
WBTC_ADDRESS=<MockWBTC from output>
```

> **Every time you redeploy MockAaveV3**, you must re-run `setAavePool.js` and `set:asset-price`.

---

### Step 4 — Deploy MockHyperliquid

**Critical:** pass `MOCK_USDC_ADDRESS`. Without it the script defaults to real USDC → `"Invalid stablecoin"` error on every deposit.

```bash
MOCK_USDC_ADDRESS=<MockUSDC from step 3> \
MOCK_WBTC_ADDRESS=<MockWBTC from step 3> \
npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
HYPERLIQUID_ADDRESS=<MockHyperliquid from output>
```

---

### Step 5 — Deploy HyperliquidAdapter (ETH)

```bash
MOCK_HL_ADDRESS=<MockHyperliquid from step 4> \
USDC_ADDRESS=<MockUSDC from step 3> \
IS_ETH_ASSET=true \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from output>
```

---

### Step 6 — Deploy KashYieldETH

```bash
AAVE_POOL_ADDRESS=<MockAaveV3 from step 3> \
USDC_ADDRESS=<MockUSDC from step 3> \
WETH_ADDRESS=<MockWETH from step 2> \
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from step 5> \
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```

> Setting `HL_ADAPTER_ADDRESS_ETH` here auto-registers the adapter using the first-time bypass — no extra steps needed. If you omit it, register manually in step 8.

Add to root `.env`, `bot/.env`, and `frontend/.env.local`:
```env
KASH_YIELD_ADDRESS=<KashYieldETH from output>     # bot/.env
KASH_TOKEN_ADDRESS=<KashTokenEth from output>     # bot/.env
KASH_YIELD_ETH_ADDRESS=<KashYieldETH>             # frontend/.env.local
KASH_TOKEN_ETH=<KashTokenEth>                     # frontend/.env.local
```

---

### Step 7 — Set timelock to 0 for testnet

The default registration timelock is 48 hours. Set it to 0 so you can swap adapters immediately during development.

```bash
KASH_YIELD_ADDRESS=<KashYieldETH> DELAY_SECONDS=0 \
npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia
```

> Set to `172800` (48 hours) before mainnet.

---

### Step 8 — Activate Hyperliquid (if not done in step 6)

Skip this if you set `HL_ADAPTER_ADDRESS_ETH` during the step 6 deploy.

```bash
# Register (immediate — first-time bypass, no timelock)
KASH_YIELD_ADDRESS=<KashYieldETH> \
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from step 5> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

# Activate
KASH_YIELD_ADDRESS=<KashYieldETH> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
```

---

### Step 9 — Deploy MockSpotDex

One instance serves both ETH and BTC products.

```bash
BTC_PRICE=45000 \
ETH_PRICE=3000 \
WBTC_ADDRESS=<MockWBTC> \
USDC_ADDRESS=<MockUSDC> \
FUND_USDC=500000 \
FUND_WBTC=10 \
FUND_ETH=1 \
KASH_YIELD_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/deploy-mock-spot-dex.js --network arbitrumSepolia
```

Add to root `.env` and `bot/.env`:
```env
MOCK_SPOT_DEX_ADDRESS=<MockSpotDex from output>
```

---

### Step 10 — Set cycle duration

```bash
CYCLE_SECONDS=3600 PRODUCT=eth KASH_YIELD_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia
```

Common values: `3600` = 1 hour (testing), `86400` = 1 day (production).

---

### Step 11 — Set initial prices

Run from the `bot/` folder. Updates oracle, MockAaveV3, MockHyperliquid, and MockSpotDex in one shot.

```bash
cd bot
BTC_PRICE_USD=45000 ETH_PRICE_USD=3000 npm run set:asset-price
```

> **Run this after every MockAaveV3 or MockHyperliquid redeploy** — fresh contracts start with price = 0.

---

### Step 12 — Verify configuration

```bash
KASH_YIELD_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/diagnose-eth.js --network arbitrumSepolia
```

This shows: ETH balance, aavePool, wethAddress, usdcAddress, ethPriceInUsd, supplied/borrowed amounts. Confirm everything is non-zero before running the bot.

---

### ETH Product — Summary checklist

- [ ] `deploy-mock-weth.js` → save `WETH_ADDRESS`
- [ ] `deploy-mock-aave.js` (with `WETH_ADDRESS`) → save `AAVE_POOL_ADDRESS`, `AAVE_USDC_ADDRESS`
- [ ] `deploy-mock-hyperliquid-arbitrum-sepolia.js` (with `MOCK_USDC_ADDRESS`) → save `HYPERLIQUID_ADDRESS`
- [ ] `deploy-hyperliquid-adapter.js` (with `MOCK_HL_ADDRESS`, `USDC_ADDRESS`, `IS_ETH_ASSET=true`) → save `HL_ADAPTER_ADDRESS_ETH`
- [ ] `deploy-arbitrum-sepolia.js` (with `AAVE_POOL_ADDRESS`, `USDC_ADDRESS`, `WETH_ADDRESS`, `HL_ADAPTER_ADDRESS_ETH`) → save `KASH_YIELD_ADDRESS`, `KASH_TOKEN_ADDRESS`
- [ ] `setExchangeSwitchDelay.js` → `DELAY_SECONDS=0` for testnet
- [ ] `setActivePerpExchange.js` (EXCHANGE_NAME=HL) if not auto-registered in deploy
- [ ] `deploy-mock-spot-dex.js` → save `MOCK_SPOT_DEX_ADDRESS`
- [ ] `setCycleDuration.js` → `CYCLE_SECONDS=3600` for testing
- [ ] `cd bot && ETH_PRICE_USD=3000 npm run set:asset-price`
- [ ] `diagnose-eth.js` → confirm all values set
- [ ] Update all 3 `.env` files and `frontend/lib/contracts/addresses.ts`

---

## BTC Product Deployment (Arbitrum Sepolia)

The BTC product shares MockAaveV3, MockHyperliquid, and MockSpotDex with the ETH product (unless you want separate instances).

### Step 1 — Ensure shared contracts exist

If deploying BTC alongside ETH, MockAaveV3, MockHyperliquid, and MockSpotDex are already deployed. Set these in `.env`:

```env
WBTC_ADDRESS=<MockWBTC>
AAVE_POOL_ADDRESS=<MockAaveV3>
USDC_ADDRESS=<MockUSDC>
BTC_ORACLE_ADDRESS=<MockChainlinkPriceFeed>
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
KASH_YIELD_ADDRESS=<KashYieldBtc> DELAY_SECONDS=0 \
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

- [ ] `WBTC_ADDRESS`, `AAVE_POOL_ADDRESS`, `USDC_ADDRESS`, `BTC_ORACLE_ADDRESS` in `.env`
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
# Register
KASH_YIELD_ADDRESS=<contract> EXCHANGE_NAME=GMX \
GMX_ADAPTER_ADDRESS=<adapter> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

# Confirm immediately (delay = 0)
KASH_YIELD_ADDRESS=<contract> EXCHANGE_NAME=GMX \
npx hardhat run scripts/confirmPerpExchange.js --network arbitrumSepolia

# Switch active exchange
KASH_YIELD_ADDRESS=<contract> EXCHANGE_NAME=GMX \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
```

For mainnet (delay = 48h), wait 48 hours between registration and `confirmPerpExchange`.

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
KASH_YIELD_ADDRESS=<KashYieldETH> \
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
# KashYieldETH (constructor arg: botAddress)
npx hardhat verify --network arbitrumSepolia <KASH_YIELD_ETH_ADDRESS> <BOT_ADDRESS>

# MockHyperliquid (constructor args: usdc, usdt, wbtc)
npx hardhat verify --network arbitrumSepolia <MOCK_HL_ADDRESS> <USDC> <USDT> <WBTC>

# HyperliquidAdapter ETH (constructor args: hlAddress, usdcAddress, assetAddress, isEthAsset)
npx hardhat verify --network arbitrumSepolia <HL_ADAPTER_ADDRESS_ETH> <HL_ADDR> <USDC> "0x0000000000000000000000000000000000000000" true
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

### 48-hour wait when registering a new adapter
- **Cause:** `exchangeSwitchDelay` is 48 hours (default).
- **Fix:** `KASH_YIELD_ADDRESS=<addr> DELAY_SECONDS=0 npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia`

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
KASH_YIELD_ADDRESS=<addr> npx hardhat run scripts/diagnose-eth.js --network arbitrumSepolia

# Recover stranded WETH from an old MockAaveV3
OLD_AAVE_ADDRESS=<old> AAVE_POOL_ADDRESS=<current> \
  npx hardhat run scripts/recover-eth-from-aave.js --network arbitrumSepolia

# Fix "Invalid stablecoin" (redeploy MockHL with correct USDC)
HL_ADAPTER_ADDRESS_ETH=<adapter> MOCK_USDC_ADDRESS=<usdc> \
  npx hardhat run scripts/fix-hl-usdc.js --network arbitrumSepolia

# Set adapter registration timelock
KASH_YIELD_ADDRESS=<addr> DELAY_SECONDS=0 \
  npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumSepolia

# Set Aave pool address on KashYieldETH
KASH_YIELD_ADDRESS=<addr> AAVE_POOL_ADDRESS=<pool> \
  npx hardhat run scripts/setAavePool.js --network arbitrumSepolia

# Set USDC address on KashYieldETH
KASH_YIELD_ADDRESS=<addr> USDC_ADDRESS=<usdc> \
  npx hardhat run scripts/setUsdcAddress.js --network arbitrumSepolia

# Check contract configuration
KASH_YIELD_ADDRESS=<addr> npx hardhat run scripts/check-contract-config.js --network arbitrumSepolia

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
- Set `exchangeSwitchDelay = 172800` (48 hours) before mainnet.
- Audit contracts before mainnet.
- Test on testnet for at least one week.
- Consider a professional security audit before mainnet.
