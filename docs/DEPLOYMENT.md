# KashYield Deployment Guide

## Prerequisites

1. **Node.js & npm** – Installed and in use
2. **Hardhat** – Configured in repo (use supported Node version; Hardhat may warn on Node 25+)
3. **dotenv** – Install if not present: `npm install dotenv`

## Environment Setup

Create a `.env` file in the root with:

```env
# Private Key (DO NOT COMMIT - ADD .env TO .gitignore)
PRIVATE_KEY=your_private_key_here

# RPC URLs (optional - defaults provided)
ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_API_KEY
ARBITRUM_ONE_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Arbiscan API Key (for verification)
ARBISCAN_API_KEY=your_arbiscan_api_key

# Gas Reporter (optional)
REPORT_GAS=false

# Mock / existing contract addresses (testnet — reuse across deployments)
HYPERLIQUID_ADDRESS=<deployed MockHyperliquid>
AAVE_POOL_ADDRESS=<deployed MockAaveV3>
USDC_ADDRESS=<deployed MockUSDC>           # REQUIRED for ETH product — no built-in default
WBTC_ADDRESS=<deployed MockWBTC>           # Required for BTC product
BTC_ORACLE_ADDRESS=<deployed MockChainlinkPriceFeed>
```

## Get Testnet Funds

### Arbitrum Sepolia ETH

1. Get Sepolia ETH from a faucet (e.g. https://sepoliafaucet.com/)
2. Bridge to Arbitrum Sepolia: https://bridge.arbitrum.io/?l2ChainId=421614

**Or** use direct Arbitrum Sepolia faucets:

- https://www.alchemy.com/faucets/arbitrum-sepolia  
- https://faucet.quicknode.com/arbitrum/sepolia  

---

# Deployment checklist (ETH and BTC products)

## Recovering ETH from the old (pre-rename) contract

If the **old** deployed contract (e.g. at `0x4C39...`) still holds ETH and you are the owner:

- **New KashYieldETH** has `ownerWithdrawEth(uint256 amount)` (onlyOwner). After you deploy the new contract, use this to withdraw excess ETH from the **new** deployment when needed.
- **Old contract** may not have this. Options:
  1. Check the old contract’s ABI: if it has an owner-only withdraw/rescue function, call it (e.g. via cast or Hardhat script).
  2. If there is no such function, you can only reduce the balance by processing **redemptions**. Once migrated to KashYieldETH, you can pause the old contract (if it has `pause`) and treat any remaining ETH as unrecoverable unless you have an older build with a rescue function.

## Now: ETH product only

Deploy in either order. **Recommended:** deploy MockHyperliquid first so you have its address, then deploy KashYieldETH, then set the HL address on KashYieldETH.

### 1. Test locally first

```bash
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.js
```

### 2. Deploy MockHyperliquid (optional; do this first if you want HL on testnet)

```bash
npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia
```

Save the **MockHyperliquid** address. (Use the same USDC/USDT/wBTC addresses as KashYieldETH / frontend, or the script’s defaults.)

### 3. Deploy KashYieldETH

```bash
# .env (required if using mock contracts):
#   AAVE_POOL_ADDRESS=<MockAaveV3>       — overrides the built-in real Aave pool address
#   USDC_ADDRESS=<MockUSDC>              — sets USDC (defaults to 0x0 if omitted — will fail)
#   WETH_ADDRESS=<MockWETH>              — optional override for the built-in WETH address
#
# Optional one-step adapter registration (deploy adapter in step 4 first, then set this):
#   HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter>  — auto-registers and uses first-time bypass
#                                                   (skip step 5 registration if set here)
# If not set, the contract uses its hardcoded real Arbitrum Sepolia Aave/WETH addresses.
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```

Save the printed **KashYieldETH** and **KashTokenEth** addresses. (KashTokenEth is created in the constructor.)

> **Important:** `USDC_ADDRESS` has no built-in default — it must be set or the contract's `usdcAddress` will be `0x0` and all USDC transfers will revert.
>
> **Tip:** Deploy the HyperliquidAdapter (step 4) **before** running this script so you can set `HL_ADAPTER_ADDRESS_ETH` and register the adapter in a single deploy. If you deploy KashYieldETH first and then register the adapter separately (step 5), it still works — just make sure `HYPERLIQUID_ADDRESS` is **not** set in `.env` at deploy time, or it will consume the first-time bypass with the wrong address (MockHL).

### 4. Deploy HyperliquidAdapter (ETH)

The main `KashYieldETH` contract never talks to MockHyperliquid directly — it always goes through an **adapter** implementing `IPerpExchange`. Deploy it first:

```bash
# .env: HYPERLIQUID_ADDRESS=<MockHL from step 2>, USDC_ADDRESS=<USDC>, IS_ETH_ASSET=true
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia
```

Save the printed **HyperliquidAdapter** address (add `HL_ADAPTER_ADDRESS_ETH=...` to `.env`).

### 5. Configure KashYieldETH

**Register and activate HL (first-time — no timelock):**

Because this is the first adapter ever registered on this contract, the registration is **immediate** — no 48-hour wait.

> **Skip step 1** if you already set `HL_ADAPTER_ADDRESS_ETH` during the step 3 deploy — the adapter was auto-registered then. Go straight to step 2.

```bash
# Step 1: Register the adapter (immediate on first use — skip if done during step 3 deploy)
KASH_YIELD_ADDRESS=<KashYieldETH from step 3> HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from step 4> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

# Step 2: Activate HL as the live exchange (always immediate)
KASH_YIELD_ADDRESS=<KashYieldETH from step 3> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
```

> **Adding a second or later adapter (e.g. GMX, Aster):** All registrations after the first require a 48-hour timelock:
> ```bash
> # Propose (starts 48h timelock)
> KASH_YIELD_ADDRESS=... EXCHANGE_NAME=GMX npx hardhat run scripts/confirmPerpExchange.js ...
> # After 48h, confirm registration
> KASH_YIELD_ADDRESS=... EXCHANGE_NAME=GMX npx hardhat run scripts/confirmPerpExchange.js --network arbitrumSepolia
> # Then activate
> KASH_YIELD_ADDRESS=... EXCHANGE_NAME=GMX npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
> ```
> For Hardhat local/testnet testing, fast-forward the timelock:
> ```javascript
> await network.provider.send("evm_increaseTime", [48 * 3600 + 1]);
> await network.provider.send("evm_mine");
> ```

**Set Aave pool** (if different from built-in):

```bash
npx hardhat run scripts/setAavePool.js --network arbitrumSepolia
```

### 5b. Deploy MockSpotDex (shared — serves both ETH and BTC products)

One `MockSpotDex` instance handles both products. It holds all four swap rates (wBTC↔USDC and ETH↔USDC) and registers on both contracts in a single run. Deploy it once and set it on both contracts:

```bash
BTC_PRICE=45000 \
ETH_PRICE=3000 \
WBTC_ADDRESS=<wBTC from your .env> \
USDC_ADDRESS=<USDC from your .env> \
FUND_USDC=500000 \
FUND_WBTC=10 \
FUND_ETH=5 \
KASH_YIELD_ADDRESS=<KashYieldETH from step 3> \
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc — if deployed; omit if deploying ETH product only> \
npx hardhat run scripts/deploy-mock-spot-dex.js --network arbitrumSepolia
```

Save the printed **MockSpotDex** address (`MOCK_SPOT_DEX_ADDRESS=...` in `.env`).

> **Price sync:** Whenever you change the BTC or ETH price on `MockChainlinkPriceFeed`, also update MockSpotDex:
> ```bash
> BTC_PRICE=<new> ETH_PRICE=<new> MOCK_SPOT_DEX_ADDRESS=<addr> WBTC_ADDRESS=<addr> USDC_ADDRESS=<addr> \
> npx hardhat run scripts/update-mock-spot-dex-price.js --network arbitrumSepolia
> ```

### 6. Verify contracts on Arbiscan

```bash
# Verify KashYieldETH (constructor arg: botAddress)
npx hardhat verify --network arbitrumSepolia <KASH_YIELD_ETH_ADDRESS> <BOT_ADDRESS>

# Verify KashTokenEth (no constructor args)
npx hardhat verify --network arbitrumSepolia <KASH_TOKEN_ETH_ADDRESS>

# Verify MockHyperliquid (constructor args: usdc, usdt, wbtc)
npx hardhat verify --network arbitrumSepolia <MOCK_HYPER_ADDRESS> <USDC_ADDRESS> <USDT_ADDRESS> <WBTC_ADDRESS>

# Verify HyperliquidAdapter (constructor args: hlAddress, usdcAddress, assetAddress, isEthAsset)
npx hardhat verify --network arbitrumSepolia <HL_ADAPTER_ADDRESS_ETH> <HYPERLIQUID_ADDRESS> <USDC_ADDRESS> "0x0000000000000000000000000000000000000000" true
```

### 6. Update frontend

In **`frontend/lib/contracts/addresses.ts`** set:

- `kashYieldEth`: deployed KashYieldETH address (from step 3)
- `kashTokenEth`: deployed KashTokenEth address (from step 3)

### 7. Bot

In **`bot/.env`** set:

- `KASH_YIELD_ADDRESS` = KashYieldETH address
- `KASH_TOKEN_ADDRESS` = KashTokenEth address (if the bot uses it)

No bot code changes: it already handles the flow (spot buy/sell, ETH vs BTC by asset). When you add KashYieldBTC later, run `processBatch()` on both contracts and handle each contract’s events.

---

## Redeploy KashYieldBtc (Arbitrum Sepolia)

Use this when you need a fresh KashYieldBtc deployment (e.g. after contract changes). The script **only deploys KashYieldBtc** (and its built-in **KashTokenBtc**). It uses **existing** wBTC, Aave pool, USDC, and BTC oracle from your `.env` — it does not deploy MockUSDC, MockWBTC, MockAaveV3, or the price feed.

**Prerequisites:** You must already have wBTC (or MockWBTC), Aave pool (or MockAaveV3), USDC (or MockUSDC), and a BTC/USD price feed deployed. If you deployed the full stack in the past, use those addresses. For mainnet you will set these to real contract addresses and run the same script.

**KASH-BTC token:** Each KashYieldBtc deployment creates a **new** KashTokenBtc in its constructor. There is no option to reuse an existing KASH-BTC token without a contract change.

### 1. Compile

```bash
npx hardhat compile
```

### 2. Set existing contract addresses in `.env`

The deploy script reads these (all required):

```env
WBTC_ADDRESS=0x...          # wBTC or MockWBTC
AAVE_POOL_ADDRESS=0x...     # Aave pool or MockAaveV3
USDC_ADDRESS=0x...          # USDC or MockUSDC (for HL and Aave)
BTC_ORACLE_ADDRESS=0x...    # BTC/USD price feed or MockChainlinkPriceFeed
```

Optional: `BOT_ADDRESS=0x...` (defaults to deployer).

### 3. Deploy KashYieldBtc only

```bash
npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumSepolia
```

Save the printed **KashYieldBtc** and **KashTokenBtc** addresses and copy to all 3 .env files as well as the addresses.ts file in the frontend Contracts folder. The script configures the new contract with your existing wBTC, Aave, USDC, and oracle.

### 4. Deploy MockHyperliquid (if not already deployed)

Use the same USDC and wBTC as in your `.env`:

```bash
export MOCK_USDC_ADDRESS=$USDC_ADDRESS
export MOCK_WBTC_ADDRESS=$WBTC_ADDRESS

npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia
```

Save the **MockHyperliquid** address to root and bot `.env` files.

### 5. Deploy HyperliquidAdapter (BTC)

```bash
# .env: HYPERLIQUID_ADDRESS=<MockHL from step 4>, USDC_ADDRESS=<USDC>, WBTC_ADDRESS=<wBTC>
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia
```

Save the printed **HyperliquidAdapter** address (add `HL_ADAPTER_ADDRESS_BTC=...` to `.env`).

### 6. Configure KashYieldBtc

**Register and activate HL (first-time — no timelock):**

Because this is the first adapter ever registered on this contract, the registration is **immediate** — no 48-hour wait.

```bash
# Step 1: Register the adapter (immediate on first use)
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc from step 3> HL_ADAPTER_ADDRESS_BTC=<HyperliquidAdapter from step 5> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

# Step 2: Activate HL as the live exchange (always immediate)
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc from step 3> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
```

> **Adding a second or later adapter (e.g. GMX, Aster):** All registrations after the first require a 48-hour timelock:
> ```bash
> # Propose (starts 48h timelock)
> KASH_YIELD_BTC_ADDRESS=... EXCHANGE_NAME=GMX npx hardhat run scripts/setHyperliquid.js ...
> # After 48h, confirm registration
> KASH_YIELD_BTC_ADDRESS=... EXCHANGE_NAME=GMX npx hardhat run scripts/confirmPerpExchange.js --network arbitrumSepolia
> # Then activate
> KASH_YIELD_BTC_ADDRESS=... EXCHANGE_NAME=GMX npx hardhat run scripts/setActivePerpExchange.js --network arbitrumSepolia
> ```
> For Hardhat local/testnet testing, fast-forward the timelock:
> ```javascript
> await network.provider.send("evm_increaseTime", [48 * 3600 + 1]);
> await network.provider.send("evm_mine");
> ```

**Set bot address** (if not set at deploy, or to change it):

```bash
export PRODUCT=btc
export KASH_YIELD_BTC_ADDRESS=<KashYieldBtc from step 3>

npx hardhat run scripts/setBotAddress.js --network arbitrumSepolia
```

### 7. Bot `.env` (bot folder)

```env
PRODUCT=btc
KASH_YIELD_ADDRESS=<KashYieldBtc address from step 3>
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
PRIVATE_KEY=<bot wallet private key — must be contract owner for ops>
AAVE_USDC_ADDRESS=<same as USDC_ADDRESS you used in step 2>
```

Rebuild and run:

```bash
cd bot && npm run build && npm start
```

### 8. Frontend

In **`frontend/.env.local`** (and root `.env` for scripts):

```env
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc from step 3>
KASH_TOKEN_BTC=<KashTokenBtc from step 3>
MOCK_WBTC=<same as WBTC_ADDRESS from step 2>
```

Ensure **`frontend/lib/contracts/addresses.ts`** (or equivalent) uses these for the BTC product.

### 9. Verify on Arbiscan (optional)

```bash
# KashYieldBtc (constructor: botAddress)
npx hardhat verify --network arbitrumSepolia <KASH_YIELD_BTC_ADDRESS> <BOT_ADDRESS>

# HyperliquidAdapter (constructor: hlAddress, usdcAddress, assetAddress, isEthAsset)
npx hardhat verify --network arbitrumSepolia <HL_ADAPTER_ADDRESS_BTC> <HYPERLIQUID_ADDRESS> <USDC_ADDRESS> <WBTC_ADDRESS> false
```

### Summary checklist

- [ ] Existing wBTC, Aave pool, USDC, BTC oracle addresses in `.env` (WBTC_ADDRESS, AAVE_POOL_ADDRESS, USDC_ADDRESS, BTC_ORACLE_ADDRESS)
- [ ] `npx hardhat compile`
- [ ] Deploy KashYieldBtc only; save KashYieldBtc and KashTokenBtc addresses
- [ ] Deploy MockHyperliquid (if needed) with same USDC/wBTC
- [ ] Deploy HyperliquidAdapter (BTC) wrapping MockHyperliquid; save adapter address
- [ ] `setHyperliquid.js`: register adapter (**immediate** — first-time bypass, no 48h wait)
- [ ] `setActivePerpExchange.js` (EXCHANGE_NAME=HL) to activate HL
- [ ] `deploy-mock-spot-dex.js`: deploy MockSpotDex, fund with USDC + wBTC, register on KashYieldBtc
- [ ] setBotAddress on KashYieldBtc (if needed)
- [ ] Bot `.env`: PRODUCT=btc, KASH_YIELD_ADDRESS, AAVE_USDC_ADDRESS
- [ ] Frontend env and addresses updated
- [ ] `bot`: npm run build && npm start

---

## Product overview

| Product        | Section                    | Contract / token          |
|----------------|----------------------------|---------------------------|
| **ETH**        | Now: ETH product only      | KashYieldETH, KashTokenEth |
| **BTC (wBTC)** | Redeploy KashYieldBtc      | KashYieldBtc, KashTokenBtc |

Use the ETH section to deploy and configure the ETH product; use the BTC section to deploy and configure the wBTC product. Both can run on the same chain (e.g. Arbitrum Sepolia). The bot uses `PRODUCT=btc` or `PRODUCT=eth` (and the corresponding `KASH_YIELD_*_ADDRESS`) to target one product per run.

---

## Post-deployment checklist

- [ ] Save deployment addresses (e.g. from script output or `./deployments/` if used)
- [ ] Verify all contracts on Arbiscan
- [ ] Test mint/redeem via Etherscan or scripts
- [ ] Monitor time windows (user window vs processing window)
- [ ] Test batch processing after 24 hours
- [ ] Frontend and bot `.env` / addresses updated as above

---

## Post-deployment configuration

Run these steps after all contracts are deployed and before starting the bot.

### 1. Set cycle duration

Controls how long each mint/redeem batch cycle lasts. Use a short duration for testing, full day for production.

```bash
# ETH product only (1 hour for testing)
CYCLE_SECONDS=3600 PRODUCT=eth KASH_YIELD_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia

# BTC product only
CYCLE_SECONDS=3600 PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia

# Both products at once (requires both addresses in .env)
CYCLE_SECONDS=3600 \
npx hardhat run scripts/setCycleDuration.js --network arbitrumSepolia
```

Common values: `3600` = 1 hour (testing), `86400` = 1 day (production).

### 2. Set initial BTC and/or ETH prices

Run from the `bot/` folder. A single command updates all mock contracts at once:
- MockChainlinkPriceFeed (oracle)
- MockAaveV3 (collateral/borrow valuation)
- MockHyperliquid (perp P&L)
- MockSpotDex swap rates (if `MOCK_SPOT_DEX_ADDRESS` is set)

```bash
cd bot

# BTC only
BTC_PRICE_USD=45000 npm run set:asset-price

# ETH only
ETH_PRICE_USD=3000 npm run set:asset-price

# Both at once (recommended — keeps all mocks in sync)
BTC_PRICE_USD=45000 ETH_PRICE_USD=3000 npm run set:asset-price

# Both + MockSpotDex rates in one shot
BTC_PRICE_USD=45000 ETH_PRICE_USD=3000 MOCK_SPOT_DEX_ADDRESS=<MockSpotDex> npm run set:asset-price
```

Required in `bot/.env`:
```env
PRIVATE_KEY=...
AAVE_POOL_ADDRESS=<MockAaveV3>
HYPERLIQUID_ADDRESS=<MockHyperliquid>
WBTC_ADDRESS=<MockWBTC>           # needed for BTC spot rates
USDC_ADDRESS=<MockUSDC>           # needed for spot rates
BTC_ORACLE_ADDRESS=<MockChainlink BTC feed>   # optional — falls back to config default
ETH_ORACLE_ADDRESS=<MockChainlink ETH feed>   # optional — falls back to config default
MOCK_SPOT_DEX_ADDRESS=<MockSpotDex>           # optional — omit to skip spot rate update
```

> **Run this every time you change prices during testing.** All four mock contracts must stay in sync — if they diverge, the bot's batch calculations will produce inconsistent results.

### 3. (Alternative) Sync MockSpotDex rates only

If you only need to resync MockSpotDex without touching the oracle/Aave/HL:

```bash
BTC_PRICE=45000 ETH_PRICE=3000 \
MOCK_SPOT_DEX_ADDRESS=<MockSpotDex> \
WBTC_ADDRESS=<MockWBTC> \
USDC_ADDRESS=<MockUSDC> \
npx hardhat run scripts/update-mock-spot-dex-price.js --network arbitrumSepolia
```

### 5. Verify configuration

```bash
KASH_YIELD_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/check-contract-config.js --network arbitrumSepolia
```

---

## Useful commands

```bash
# Check account balance
npx hardhat run scripts/checkBalance.js --network arbitrumSepolia

# Interact with deployed contract
npx hardhat console --network arbitrumSepolia

# Clean artifacts and cache
npx hardhat clean

# Get current NAV
npx hardhat run scripts/getNAV.js --network arbitrumSepolia
```

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

## Troubleshooting

### "Insufficient funds"

- Get more testnet ETH from the faucets above.
- Check balance: `npx hardhat run scripts/checkBalance.js --network arbitrumSepolia`

### "Invalid nonce"

- Reset account in MetaMask: Settings → Advanced → Reset Account.

### "Stack too deep" when compiling

- Ensure `hardhat.config.js` has `viaIR: true` in `solidity.settings` (and optimizer enabled).

### Contract verification fails

- Constructor arguments must match exactly.
- Wait a few minutes after deployment before verifying.
- Confirm Arbiscan API key and network.

## Security notes

- Never commit `.env` or private keys.
- Use a separate test wallet for testnets.
- Audit contracts before mainnet.
- Test on testnet thoroughly (e.g. at least one week).
- Consider a professional security audit before mainnet.
