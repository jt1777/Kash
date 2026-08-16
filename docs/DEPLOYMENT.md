# Deploying KashYield

This guide covers compiling and deploying the KashYield smart contracts on **Arbitrum One**.

For post-deploy wiring and operational setup, see the private **kash-ops** repository.

## Prerequisites

- Node.js (Hardhat-compatible version)
- `npm install` at repo root
- Copy `.env.example` to `.env` and fill in deployer key, RPC, `BOT_ADDRESS`, and token addresses

## Compile

```bash
npx hardhat compile
```

## Deployment order (per product)

Each product (KASH-ETH or KASH-BTC) is a **separate stack**. Deploy in this order:

```text
1. KashYield vault + KASH token     (deploy-kashyieldeth.js / deploy-kashyieldbtc.js)
2. HyperliquidAdapter               (deploy-hyperliquid-adapter.js — one per vault)
3. ExchangeFacade                   (deploy-exchange-facade.js — one per vault)
4. UniswapV3Adapter                 (optional; deploy-uniswap-adapter.js)
5. Wire facade + adapters           (kash-ops: wire-exchange-facade.js)
6. Owner: vault.setExchangeFacade   (if not done in step 5)
```

### What each contract does

| Contract | Role |
|----------|------|
| **KashYieldBtc / KashYieldETH** | User mint/redeem, batch phases, Aave, spot swaps, NAV |
| **KashTokenBtc / KashTokenEth** | ERC-20 KASH; created in the vault constructor |
| **HyperliquidAdapter** | `IPerpExchange` wrapper around HL Bridge2; HL REST signing when adapter is master |
| **ExchangeFacade** | Perp registry + HL write ops (deposit/withdraw USDC, open/close perp). Pulls USDC from the **bound vault** only. Deployed separately for bytecode headroom. |
| **UniswapV3Adapter** | On-chain spot swaps (optional) |

**ExchangeFacade is not shared** between ETH and BTC. Each vault gets its own facade deployment, bound at construction to that vault’s address and primary asset (native ETH = `0x0`, BTC = wBTC).

---

## Deploy

All commands use `--network arbitrumOne`.

### Step 1 — Deploy vault

**KashYieldBtc:**

```bash
BOT_ADDRESS=0x... npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumOne
```

Record from script output:

- `KASH_YIELD_BTC_ADDRESS`
- `KASH_TOKEN_BTC`

Also saved under `deployments/kashyieldbtc-arbitrumOne-*.json`.

**KashYieldETH:**

```bash
BOT_ADDRESS=0x... npx hardhat run scripts/deploy-kashyieldeth.js --network arbitrumOne
```

Record `KASH_YIELD_ETH_ADDRESS` and `KASH_TOKEN_ETH`.

### Step 2 — Deploy HyperliquidAdapter (one per vault)

**BTC product:**

```bash
KASH_YIELD_BTC_ADDRESS=0x... \
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
HL_BRIDGE_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
IS_ETH_ASSET=false \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Record `HL_ADAPTER_ADDRESS_BTC`. Saved under `deployments/hl-adapter-btc-arbitrumOne-*.json`.

**ETH product** (when deployed): same script with `IS_ETH_ASSET=true` and `KASH_YIELD_ETH_ADDRESS` and remove `WBTC_ADDRESS`.

### Step 3 — Deploy ExchangeFacade (one per vault)

The facade constructor binds permanently to one vault:

```solidity
constructor(address _owner, address _bot, address _usdc, address _primaryAsset, address _kashYield)
```

**BTC product:**

```bash
KASH_YIELD_ADDRESS=0x... \
PRIMARY_ASSET=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
BOT_ADDRESS=0x... \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
```

(`KASH_YIELD_ADDRESS` = your `KASH_YIELD_BTC_ADDRESS`.)

**ETH product:**

```bash
KASH_YIELD_ADDRESS=0x... \
PRIMARY_ASSET=0x0000000000000000000000000000000000000000 \
BOT_ADDRESS=0x... \
npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
```

Record **`EXCHANGE_FACADE_BTC_ADDRESS`** or **`EXCHANGE_FACADE_ETH_ADDRESS`** from script output. Also saved under `deployments/exchange-facade-*-arbitrumOne-*.json`.

Add to `.env`:

```bash
EXCHANGE_FACADE_BTC_ADDRESS=0x...
HL_ADAPTER_ADDRESS_BTC=0x...
KASH_YIELD_BTC_ADDRESS=0x...
```

### Step 4 — UniswapV3Adapter (optional)

```bash
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

### Step 5 — Wire facade (kash-ops)

Owner wiring connects vault ↔ facade ↔ HL adapter. Run from **kash-ops**:

```bash
npx hardhat run scripts/wire-exchange-facade.js --network arbitrumOne
```

Typical wiring (also doable manually):

1. **Vault:** `setExchangeFacade(facadeAddress)` — owner only
2. **Facade:** `setHyperliquid(hlAdapterAddress)` — first registration is immediate
3. **Facade:** `setActivePerpExchange("HL")`
4. **HyperliquidAdapter:** `setAuthorizedCaller(facadeAddress)` — so the facade can call deposit/withdraw

Confirm on Arbiscan:

- `KashYieldBtc.exchangeFacade()` → your facade address
- `ExchangeFacade.kashYieldAddress()` → your vault address
- `ExchangeFacade.hyperliquidAddress()` → your HL adapter address

---

## Address checklist (KASH-BTC example)

After a full BTC deploy, `.env` should include:

| Variable | Contract |
|----------|----------|
| `KASH_YIELD_BTC_ADDRESS` | Vault |
| `KASH_TOKEN_BTC` | KASH-BTC ERC-20 |
| `HL_ADAPTER_ADDRESS_BTC` | HyperliquidAdapter |
| `EXCHANGE_FACADE_BTC_ADDRESS` | ExchangeFacade |
| `UNISWAP_ADAPTER_ADDRESS` | UniswapV3Adapter (if used) |

Update **`frontend/.env.local`** with `NEXT_PUBLIC_*` addresses for each live product (see `frontend/.env.example`). Mark verified vaults/tokens in **`frontend/lib/contracts/addresses.ts`** (`ARBISCAN_VERIFIED_*` sets) after Arbiscan verification.

---

## Verify on Arbiscan

Set **`ETHERSCAN_API_KEY`** in `.env` (unified key from [etherscan.io/myapikey](https://etherscan.io/myapikey); `ARBISCAN_API_KEY` still works as a legacy alias). Hardhat uses Etherscan API v2 with `chainid=42161` for `arbitrumOne`.

```bash
npx hardhat verify --network arbitrumOne CONTRACT_ADDRESS CONSTRUCTOR_ARG1 ...
```

Example (KashYieldETH):

```bash
npx hardhat verify --network arbitrumOne 0x... 0xBot 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
```

Success means no “deprecated V1 endpoint” warning. Bytecode or constructor mismatches are a separate issue — use manual verification below.

### Manual verification (Standard-Json-Input)

If Hardhat verify fails on bytecode/constructor args, upload compiled JSON on Arbiscan with the same compiler settings as `hardhat.config.js` (optimizer on, runs 1, viaIR, bytecodeHash none).

### Generate upload file

```bash
npx hardhat compile

node -e "
const fs = require('fs');
const contract = process.argv[1];
for (const f of fs.readdirSync('artifacts/build-info')) {
  const j = JSON.parse(fs.readFileSync('artifacts/build-info/' + f, 'utf8'));
  if (!Object.keys(j.input?.sources || {}).some(s => s.includes(contract))) continue;
  const out = contract.replace('.sol','') + '-standard-input.json';
  fs.writeFileSync(out, JSON.stringify(j.input, null, 2));
  console.log('Wrote', out);
  break;
}
" ExchangeFacade.sol
```

Upload that JSON on Arbiscan. **Contract name** examples:

- `contracts/ExchangeFacade.sol:ExchangeFacade`
- `contracts/adapters/HyperliquidAdapter.sol:HyperliquidAdapter`
- `contracts/KashYieldBtc.sol:KashYieldBtc`

### ExchangeFacade constructor args (ABI-encoded, one line)

Five addresses: `_owner`, `_bot`, `_usdc`, `_primaryAsset`, `_kashYield`.

```bash
node -e "
const { AbiCoder } = require('ethers');
console.log(AbiCoder.defaultAbiCoder().encode(
  ['address','address','address','address','address'],
  ['OWNER', 'BOT', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'PRIMARY_ASSET', 'KASH_YIELD']
).slice(2));
"
```

Replace placeholders with deployed values. License: **Business Source License 1.1 (BUSL-1.1)**.

---

## Environment

Copy `.env.example` to `.env` and fill in:

- `PRIVATE_KEY` — deployer wallet
- `BOT_ADDRESS` — address with `onlyBotOrKeeper` permissions
- `ARBITRUM_ONE_RPC_URL`
- `ETHERSCAN_API_KEY` — Hardhat verify (Etherscan API v2; one key for Arbiscan + other explorers). `ARBISCAN_API_KEY` accepted as legacy alias.
- Deployed addresses — fill in after each step (see checklist above)

## Post-deploy

- Verify `owner()` and `botAddress()` on vault and facade
- Confirm `exchangeFacade` is set on the vault and `kashYieldAddress` matches on the facade
- Verify contracts on Arbiscan
- Update frontend env and redeploy app

### Security hardening (audit 2026-08-16) — redeploy required

These fixes are in current `KashYieldETH` / `KashYieldBtc` bytecode. **Upgrade = new vault deploy** (not a proxy patch). After cutover, sync artifacts to **kash-ops** and the frontend.

| Fix | What changed | Operator note |
|-----|----------------|---------------|
| **Claim allocation binding** | `claimMint` / `claimRedeem` require proof amount = on-chain Phase-2 allocation (`batchMintKashAllocation` / `batchRedeemNetAsset`) | Evil Merkle roots cannot pay arbitrary amounts. Proofs must match settlement math the bot already uses. |
| **NAV deviation cap** | `updateNAV` limited to **±15%** per call after the first bot update (`NAV_MAX_DEVIATION_BPS = 1500`) | First `updateNAV` after deploy is uncapped (genesis calibration). Later jumps >15% **revert on-chain** even if the bot allows them. Legitimate large recovery may need **multiple stepped updates** (one per cycle). |
| **Oracle staleness** | `getEthPrice` / `getBtcPrice` revert if Chainlink `updatedAt` is older than **25 hours** (`ORACLE_MAX_STALENESS`) | Before deploy, confirm feed heartbeats on [data.chain.link](https://data.chain.link/) (Arbitrum ETH/USD + BTC/USD are ~24h). If you substitute a faster feed, tighten the constant to heartbeat + ~1h buffer. |
| **Emergency redeem phase** | `emergencyWithdrawRedeem` requires `batchPhase == 0` (same as mint) | Prevents clawing KASH back after ops started liquidating for that batch. |
| **Owner expired-claim sweep** | `sweepExpiredClaims` / `sweepExpiredMintClaims` callable by **owner** as well as bot/keeper | Cold owner can mark claims expired if the bot key is lost. `releaseExpired*` flow unchanged. |
| **ETH refund gas (ETH only)** | `cancelMintRequest` / `emergencyWithdrawMint` use `.call` instead of `.transfer` | Smart-contract wallets (Safe, etc.) can receive refunds. |

**After merge + deploy**

1. **`kash-ops`:** recompile and refresh bot ABI (`bot/dist/contracts/kashYieldABI.js` or your canonical sync path).
2. **Bot ops:** treat `ALLOW_NAV_DEVIATION` as advisory only — on-chain cap is 15%.
3. **Frontend:** no claim UX change; proofs must still match allocated amounts (already true for honest bot runs).

Tests: `test/claim-allocation-binding.unit.test.js` (FIX-1). Run full suite with `ARBITRUM_MAINNET_RPC_URL=` empty for local unit tests, or a valid fork RPC for e2e.
