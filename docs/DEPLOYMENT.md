# Deploying KashYield

This guide covers compiling and deploying the KashYield smart contracts on **Arbitrum One**.

For post-deploy wiring and operational setup, see the private **kash-ops** repository.

## Prerequisites

- Node.js (Hardhat-compatible version)
- `npm install` at repo root

## Compile

```bash
npx hardhat compile
```

## Deploy

All commands use `--network arbitrumOne`.

### Deploy vault

**KashYieldETH:**

```bash
BOT_ADDRESS=0x... npx hardhat run scripts/deploy-kashyieldeth.js --network arbitrumOne
```

**KashYieldBtc:**

```bash
BOT_ADDRESS=0x... npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumOne
```

Each deploy creates a new vault + KASH token contract.

### Deploy adapters

**HyperliquidAdapter** (one per vault):

```bash
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

**ExchangeFacade** (one per vault):

```bash
KASH_YIELD_ADDRESS=0x... BOT_ADDRESS=0x... npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
```

**UniswapV3Adapter** (shared or per vault):

```bash
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

### Wire contracts

Owner calls `setExchangeFacade(facade)` on the vault, then wires the facade (kash-ops repo):

```bash
npx hardhat run scripts/wire-exchange-facade.js --network arbitrumOne
```

## Verify on Arbiscan

```bash
npx hardhat verify --network arbitrumOne CONTRACT_ADDRESS CONSTRUCTOR_ARG1 ...
```

## Environment

Copy `.env.example` to `.env` and fill in:

- `PRIVATE_KEY` — deployer wallet
- `BOT_ADDRESS` — address with `onlyBotOrKeeper` permissions
- `ARBITRUM_ONE_RPC_URL`
- `ARBISCAN_API_KEY` — for verification

## Addresses

Update `frontend/lib/contracts/addresses.ts` with deployed addresses.

## Post-deploy

- Verify `owner()` and `botAddress()` are set correctly
- Verify contracts on Arbiscan
- Update frontend addresses and ABI
