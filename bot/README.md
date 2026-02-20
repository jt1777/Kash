# KASH Yield Bot

Off-chain automation bot for the KASH Yield Token protocol on Arbitrum Sepolia.

## Overview

This bot handles:
- **Batch Processing** - Daily processing of mint/redeem requests
- **Capital Deployment** - Deploys capital to Aave and Hyperliquid
- **Rebalancing** - Monitors and rebalances portfolio allocation
- **Liquidation Protection** - Monitors health factor and takes protective action

## Architecture

### Option 1: Chainlink Automation (On-chain)

The KashYield contract has built-in `checkUpkeep`/`performUpkeep` functions that can be registered with Chainlink Automation:

1. Deploy the KashYield contract
2. Register an upkeep on [Chainlink Automation](https://automation.chain.link/)
3. Set the upkeep to call `performUpkeep()` on the contract
4. Chainlink nodes will automatically call `processBatch()` when in the processing window

**Pros:**
- Fully decentralized
- No bot infrastructure needed
- Guaranteed execution

**Cons:**
- LINK token fees for upkeep
- Less control over execution timing

### Option 2: Off-chain Bot (This Implementation)

Run this bot on a schedule (cron) to call `processBatch()` and handle protocol interactions:

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your values

# Build
npm run build

# Run batch processor
npm start
```

**Pros:**
- Full control over execution
- Can implement complex strategies
- No LINK token fees
- Easier to debug and monitor

**Cons:**
- Requires running infrastructure
- Single point of failure (unless redundant)

## Quick Start

1. **Set up environment:**
   ```bash
   cd bot
   cp .env.example .env
   # Edit .env with your deployed contract addresses
   ```

2. **Install and build:**
   ```bash
   npm install
   npm run build
   ```

3. **Run validation:**
   ```bash
   npm run validate
   ```

4. **Run the bot:**
   ```bash
   npm start
   ```

## Environment Variables

See `.env.example` for all required variables. Key ones:

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Bot wallet private key (must be contract owner) | `0x...` |
| `KASH_YIELD_ADDRESS` | Deployed KashYield contract | `0x...` |
| `KASH_TOKEN_ADDRESS` | Deployed KashToken contract | `0x...` |
| `AAVE_POOL_ADDRESS` | Aave V3 Pool on Arbitrum Sepolia | `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff` |
| `RPC_URL` | Arbitrum Sepolia RPC endpoint | `https://sepolia-rollup.arbitrum.io/rpc` |

## Bot Components

### Batch Processor

Handles daily batch processing:
- Waits for processing window (23:50-23:59 UTC)
- Calls `processBatch()` on contract
- Handles `NET_MINT` / `NET_REDEEM` events
- Deploys capital to Aave and Hyperliquid

### Rebalancer Bot

Monitors portfolio allocation:
- Checks allocation drift hourly
- Rebalances when drift exceeds threshold (default 10%)
- Moves collateral between protocols

### Liquidation Guard

Monitors Aave health factor:
- Continuously monitors health factor
- Alerts at HF < 1.5 (warning)
- Adds collateral at HF < 1.3 (critical)
- Emergency actions at HF < 1.1 (emergency)
- Panic mode below HF < 1.0 (liquidation imminent)

## Deployment Checklist

Before running the bot in production:

1. ✅ KashYield contract deployed on Arbitrum Sepolia
2. ✅ Aave pool address set via `setAavePool.js`
3. ✅ Hyperliquid address set via `setHyperliquid.js` (if using HL)
4. ✅ Bot wallet has ETH for gas
5. ✅ Bot wallet is contract owner (for privileged functions)
6. ✅ Environment variables configured
7. ✅ Validation passes (`npm run validate`)

## Network: Arbitrum Sepolia

This bot is configured for **Arbitrum Sepolia testnet** by default:
- Chain ID: 421614
- RPC: https://sepolia-rollup.arbitrum.io/rpc
- Block Explorer: https://sepolia.arbiscan.io

For mainnet deployment, update:
- `RPC_URL` to Arbitrum mainnet endpoint
- Token addresses to Arbitrum mainnet
- Aave pool address to Arbitrum mainnet
- Oracle addresses to Arbitrum mainnet

## Troubleshooting

### "Invalid KASH_YIELD_ADDRESS"
- Verify the contract is deployed at the address in `.env`
- Check you're on the correct network (Arbitrum Sepolia = chain ID 421614)

### "Hyperliquid address not set"
- Run `setHyperliquid.js` to set the Hyperliquid contract address on KashYield
- Or the bot will skip HL operations

### "Not in processing window"
- Batch processing only works between 23:50-23:59 UTC
- The bot will wait for the window automatically

## License

MIT
