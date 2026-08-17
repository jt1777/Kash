# Deploying KashYield (Aster)

This guide covers compiling and deploying **ownerless Aster** KashYield contracts on **Arbitrum One** with **Aster** as the perp DEX.

**Post-deploy bot setup and operator runbooks** live in the private **kash-ops** repository (`docs/DEPLOYMENT.md` there, Aster batch path under `bot/src/batch/aster/`).

> **Legacy:** The `main` branch still documents a **Hyperliquid (HL)** owner-gated deployment path. That stack is **not** the same as Aster — do not reuse HL adapter scripts or addresses for Aster.

---

## Prerequisites

- Node.js (Hardhat-compatible version)
- `npm install` at repo root
- Copy `.env.example` to `.env` — deployer key, RPC, `BOT_ADDRESS`, `FEE_RECEIVER_ADDRESS`, Aster protocol addresses, spot DEX

---

## Ownerless deploy properties (both products)

| Property | Aster stack behavior |
|----------|-------------|
| Governance | **Ownerless** — no `owner()`, no `pause()`, no post-deploy setters |
| Bot | **`botAddress`** immutable at deploy |
| Perp DEX | **`ExchangeFacade`** + **`AsterAdapter`** immutable |
| Spot DEX | **`spotDexAddress`** immutable (e.g. UniswapV3Adapter) |
| Fees | **`feeBps`** + **`feeReceiver`** immutable |
| Batch timing | **`cycleDurationSeconds`**, **`userWindowEnd`**, **`processingWindowStart`** immutable |
| User caps | **`maxMintUsers`**, **`maxRedeemUsers`** immutable |

Changing any of the above requires **redeploying the full stack** and migrating users.

---

## Compile

```bash
npx hardhat compile
```

---

## Recommended deploy path — Aster atomic stack

Each product deploys **AsterAdapter → ExchangeFacade → KashYield + KASH token** in **one script** using nonce-predicted addresses:

```bash
# ETH product
npm run deploy:eth-aster
# or: npx hardhat run scripts/deploy-kash-eth-aster-stack.js --network arbitrumOne

# BTC product
npm run deploy:btc-aster
# or: npx hardhat run scripts/deploy-kash-btc-aster-stack.js --network arbitrumOne
```

### Required env (see `.env.example`)

| Variable | Purpose |
|----------|---------|
| `PRIVATE_KEY` | Deployer |
| `BOT_ADDRESS` | Batch operator (`onlyBotOrKeeper`) |
| `FEE_RECEIVER_ADDRESS` | Protocol fee recipient (immutable) |
| `KEEPER_REGISTRY_ADDRESS` | Chainlink Automation registry (or zero) |
| `SPOT_DEX_ADDRESS` | UniswapV3Adapter (deploy Step 1 below) |
| `ASTER_CLEARING_HOUSE` | Aster clearing house on Arbitrum |
| `ASTER_VAULT` | Aster vault contract |
| `ASTER_ACCOUNT_BALANCE` | Aster account balance reader |
| `ASTER_BASE_TOKEN` | ETH = WETH address; BTC = wBTC address |
| `AAVE_POOL_ADDRESS` | Aave V3 pool |
| `*_ORACLE_ADDRESS` | Chainlink feed for batch pricing |
| `CYCLE_DURATION_SECONDS`, `USER_WINDOW_END`, `PROCESSING_WINDOW_START` | Batch schedule (immutable) |
| `FEE_BPS`, `MAX_SWAP_SLIPPAGE_BPS`, `MAX_MINT_USERS`, `MAX_REDEEM_USERS` | Economic params (immutable). **`MAX_SWAP_SLIPPAGE_BPS` default: 50** (0.5%) in deploy scripts. |

Script output includes `KASH_YIELD_*`, `KASH_TOKEN_*`, `EXCHANGE_FACADE_*`, `ASTER_ADAPTER_*` — save to `.env` and `frontend/.env.local`.

---

## Step 1 — Deploy UniswapV3Adapter (spot DEX)

```bash
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

Record `UNISWAP_ADAPTER_ADDRESS` → `SPOT_DEX_ADDRESS`. One adapter can serve both products.

---

## What each contract does

| Contract | Role |
|----------|------|
| **KashYieldEth / KashYieldBtc** | User mint/redeem, batch phases, Aave, spot swaps, NAV updates, Merkle claims |
| **KashTokenEth / KashTokenBtc** | ERC-20 KASH (minted/burned by vault) |
| **AsterAdapter** | `IPerpExchange` — Aster clearing house + vault; **onlyFacade** |
| **ExchangeFacade** | Immutable router: vault ↔ Aave ↔ Aster ↔ spot DEX |
| **UniswapV3Adapter** | On-chain spot swaps |

**ExchangeFacade is not shared** between ETH and BTC — one facade per vault, bound at construction.

---

## Post-deploy verification

On Arbiscan / via cast:

- `kashYield.botAddress()` → intended bot
- `kashYield.exchangeFacade()` → facade
- `kashYield.feeReceiver()` → fee wallet
- `kashYield.feeBps()`, `cycleDurationSeconds()`, `userWindowEnd()`, `processingWindowStart()`
- `facade.kashYieldAddress()` → vault
- `facade.perpExchangeAddress()` → AsterAdapter
- `AsterAdapter.exchangeFacade()` → facade (round-trip)
- No `owner()` on vault or adapter

Update **`frontend/.env.local`** (`NEXT_PUBLIC_*`) and **`frontend/lib/contracts/addresses.ts`** verified sets after Arbiscan verification.

Complete **kash-ops** bot `.env`, Aster batch config (`ACTIVE_PERP_EXCHANGE=ASTER`), and smoke batch on test cycle before public launch.

---

## Verify on Arbiscan

Set **`ETHERSCAN_API_KEY`** in `.env`. Example:

```bash
npx hardhat verify --network arbitrumOne <KashYieldETH> <constructor args...>
```

For manual Standard-Json-Input verification, see compiled artifacts under `artifacts/build-info/`. License: **BUSL-1.1**.

---

## Legacy Hyperliquid path (not Aster)

The `main` branch and scripts `deploy-hyperliquid-adapter.js` + `deploy-kashyieldeth.js` (with `EXCHANGE_NAME=HL`) target the **older owner-gated HL stack**. They are **not** used for Aster bug-bounty deployments on this branch.

---

## Environment checklist

After deploy, `.env` should include at minimum:

| Variable | Contract |
|----------|----------|
| `KASH_YIELD_ETH_ADDRESS` / `KASH_YIELD_BTC_ADDRESS` | Vault |
| `KASH_TOKEN_ETH` / `KASH_TOKEN_BTC` | KASH ERC-20 |
| `EXCHANGE_FACADE_*` | ExchangeFacade |
| `ASTER_ADAPTER_ADDRESS_*` | AsterAdapter |
| `UNISWAP_ADAPTER_ADDRESS` | Spot DEX (if used) |
