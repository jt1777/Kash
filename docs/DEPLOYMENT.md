# Deploying KashYield

This guide covers compiling and deploying the KashYield smart contracts on **Arbitrum One**.

**Post-deploy wiring, batch bot setup, and operator runbooks** live in the private **kash-ops** repository (`docs/DEPLOYMENT.md` there has the full sequence).

## Prerequisites

- Node.js (Hardhat-compatible version)
- `npm install` at repo root
- Copy `.env.example` to `.env` and fill in deployer key, RPC, `BOT_ADDRESS`, and token addresses

## Compile

```bash
npx hardhat compile
```

## Deployment order (per product)

Each product (KASH-ETH or KASH-BTC) is a **separate stack**. On this branch both `KashYieldETH` and `KashYieldBtc` are **V3**: ownerless, with bot, `exchangeFacade`, spot DEX, oracle, fees, and cycle timing all fixed in the constructor. There is no post-deploy `owner()`, `pause()`, or setter — changing any of these means redeploying the stack.

| | **KASH-ETH V3** | **KASH-BTC V3** |
|--|-------------------|-------------------|
| Governance | Ownerless; facade + spot DEX + oracle fixed in constructor | Ownerless; facade + spot DEX + oracle fixed in constructor |
| Typical flow | Uniswap → (HL adapter with predicted vault addr) → facade+vault **or** Aster atomic stack | Uniswap → (adapter with predicted vault addr) → facade+vault **or** Aster atomic stack |

Full operator sequencing (including Path A/HL vs Path B/Aster) lives in the private **kash-ops** repo.

```text
ETH:  spot DEX → perp adapter → deploy-kashyieldeth.js (facade+vault) OR deploy-kash-eth-aster-stack.js
BTC:  spot DEX → perp adapter → deploy-kashyieldbtc.js (facade+vault) OR deploy-kash-btc-aster-stack.js
```

### What each contract does

| Contract | Role |
|----------|------|
| **KashYieldBtc / KashYieldETH** | User mint/redeem, batch phases, Aave, spot swaps, NAV |
| **KashTokenBtc / KashTokenEth** | ERC-20 KASH; created in the vault constructor |
| **HyperliquidAdapter** | `IPerpExchange` wrapper around HL Bridge2; HL REST signing when adapter is master |
| **ExchangeFacade** | Immutable perp routing + write ops (deposit/withdraw USDC, open/close perp). Adapter and vault are bound at construction. Deployed separately for bytecode headroom. |
| **UniswapV3Adapter** | On-chain spot swaps (optional) |

**ExchangeFacade is not shared** between ETH and BTC. Each vault gets its own facade deployment, bound at construction to that vault’s address and primary asset (native ETH = `0x0`, BTC = wBTC).

---

## Deploy

All commands use `--network arbitrumOne`. Both vaults are V3: `exchangeFacade` and `spotDexAddress` are **immutable**, so the spot DEX and perp adapter must exist (or their addresses be predicted) **before** the vault deploys.

### Step 1 — Deploy UniswapV3Adapter (spot DEX)

```bash
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

Record `UNISWAP_ADAPTER_ADDRESS` — used as `SPOT_DEX_ADDRESS` below. One adapter is shared by both products.

### Step 2 — Deploy HyperliquidAdapter (one per vault)

The adapter constructor needs the vault address, which does not exist yet — pass the **predicted** vault address (see `scripts/lib/predictAddress.js`; account for deployer nonce order: adapter tx, then facade, then vault).

**BTC product:**

```bash
KASH_YIELD_ADDRESS=<predicted KashYieldBtc address> \
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
HL_BRIDGE_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
IS_ETH_ASSET=false \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Record `HL_ADAPTER_ADDRESS_BTC`. Saved under `deployments/hl-adapter-btc-arbitrumOne-*.json`.

**ETH product:** same script with `IS_ETH_ASSET=true`, `KASH_YIELD_ADDRESS=<predicted KashYieldETH address>`, and no `WBTC_ADDRESS`.

> **Deploying on Aster instead of HL?** Skip this step — `deploy-kash-eth-aster-stack.js` / `deploy-kash-btc-aster-stack.js` (Step 3) deploy the `AsterAdapter` themselves using nonce-predicted addresses.

### Step 3 — Deploy ExchangeFacade + vault

`deploy-kashyieldbtc.js` / `deploy-kashyieldeth.js` deploy **ExchangeFacade and the vault together** in one script, resolving the circular dependency (facade needs the vault address; vault needs the facade address) via the same nonce-prediction as Step 2:

```bash
# BTC (HL adapter already deployed in Step 2)
BOT_ADDRESS=0x... \
SPOT_DEX_ADDRESS=<UNISWAP_ADAPTER_ADDRESS> \
EXCHANGE_ADAPTER_ADDRESS=<HL_ADAPTER_ADDRESS_BTC> \
EXCHANGE_NAME=HL \
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
BTC_ORACLE_ADDRESS=0x6ce185860a4963106506C203335A2910413708e9 \
npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumOne

# ETH (HL adapter already deployed in Step 2)
BOT_ADDRESS=0x... \
SPOT_DEX_ADDRESS=<UNISWAP_ADAPTER_ADDRESS> \
EXCHANGE_ADAPTER_ADDRESS=<HL_ADAPTER_ADDRESS_ETH> \
EXCHANGE_NAME=HL \
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612 \
npx hardhat run scripts/deploy-kashyieldeth.js --network arbitrumOne
```

Record **`KASH_YIELD_BTC_ADDRESS`** / **`KASH_YIELD_ETH_ADDRESS`**, **`KASH_TOKEN_BTC`** / **`KASH_TOKEN_ETH`**, and **`EXCHANGE_FACADE_BTC_ADDRESS`** / **`EXCHANGE_FACADE_ETH_ADDRESS`** from script output. Also saved under `deployments/`.

**Deploying on Aster instead of HL?** Use the atomic stack script per product — it deploys the adapter, facade, and vault together in one run via three consecutive nonce-predicted addresses:

```bash
npx hardhat run scripts/deploy-kash-eth-aster-stack.js --network arbitrumOne   # or npm run deploy:eth-aster
npx hardhat run scripts/deploy-kash-btc-aster-stack.js --network arbitrumOne   # or npm run deploy:btc-aster
```

Add to `.env`:

```bash
EXCHANGE_FACADE_BTC_ADDRESS=0x...
HL_ADAPTER_ADDRESS_BTC=0x...
KASH_YIELD_BTC_ADDRESS=0x...
```

### Step 4 — Wire facade (kash-ops)

Owner wiring connects vault ↔ facade ↔ adapter. Run from **kash-ops** (see `docs/DEPLOYMENT.md` in that repo for env vars and verification):

```bash
npx hardhat run scripts/wire-exchange-facade.js --network arbitrumOne
```

At a high level, wiring confirms the facade points at your adapter, sets `exchangeFacade` on the vault where applicable, and authorizes the facade on the adapter.

Confirm on Arbiscan:

- `KashYield*.exchangeFacade()` → your facade address
- `ExchangeFacade.kashYieldAddress()` → your vault address
- `ExchangeFacade.perpExchangeAddress()` → your adapter address

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

Seven values: `_bot`, `_keeper`, `_usdc`, `_primaryAsset`, `_kashYield`, `_exchangeName`, `_adapterAddress`.

```bash
node -e "
const { AbiCoder } = require('ethers');
console.log(AbiCoder.defaultAbiCoder().encode(
  ['address','address','address','address','address','string','address'],
  ['BOT', 'KEEPER_OR_ZERO', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'PRIMARY_ASSET', 'KASH_YIELD', 'HL', 'ADAPTER']
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

- Verify `botAddress()` on the vault matches your intended bot wallet (immutable — redeploy to change)
- Confirm `exchangeFacade` is set on the vault and matches the facade’s `kashYieldAddress`
- Confirm `facade.perpExchangeAddress()` matches your adapter
- Verify contracts on Arbiscan
- Update frontend env and redeploy app
- Complete batch bot and operator setup in **kash-ops**
