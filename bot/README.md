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

## Owner Status Script

View protocol state at a glance (asset in contract, Aave, Hyperliquid):

```bash
# ETH product
PRODUCT=eth KASH_YIELD_ADDRESS=0x... npm run owner:status

# BTC product (with MockAave)
PRODUCT=btc KASH_YIELD_ADDRESS=0x... AAVE_POOL_ADDRESS=0x... npm run owner:status
```

Shows:
- **Asset in contract**: Total wBTC/ETH, user deposits (reserved), excess (owner-withdrawable)
- **Aave**: Supplied ETH/wBTC, borrowed USDC
- **Hyperliquid**: USDC in spot wallet, open perp positions

## Troubleshooting

### "Invalid KASH_YIELD_ADDRESS"
- Verify the contract is deployed at the address in `.env`
- Check you're on the correct network (Arbitrum Sepolia = chain ID 421614)

### "Hyperliquid address not set"
- Run `setHyperliquid.js` to set the Hyperliquid contract address on KashYield
- Or the bot will skip HL operations

### "Not in processing window"
- Batch processing only works between 23:50-23:59 UTC (unless the contract uses testing constants for full 24h)
- Set `WAIT_FOR_PROCESSING_WINDOW=true` to have the bot wait for the window, or set `SKIP_PROCESSING_WINDOW_CHECK=true` to run the batch logic anyway for testing (the contract may still revert if it enforces the window)

### Five-step batch flow
The batch is split into five steps so each can be run individually. If any step errors, fix the issue and re-run that step (or the next). Default remains a full run (all five in sequence).

| Step | Name        | Action |
|------|-------------|--------|
| 1    | `phase1`    | Call `performUpkeep()` (Phase 1 indicative; batch moves to phase 1) |
| 2    | `ops`       | Handle NET_MINT/NET_REDEEM (HL + Aave) |
| 3    | `nav`       | Compute and call `updateNAV(newNAV)` |
| 4    | `mark-done` | Call `markBatchOpsDone(batchCycle)` (batch moves to phase 2) |
| 5    | `phase2`    | Run Phase 2 distribution (mint KASH, pay redeemers) |

**How the bot picks the target batch (no batch number needed)**  
The bot does not detect "failure" directly; it detects **incomplete** batches from on-chain state. Each run it:

1. Gets the current batch cycle (today).
2. Looks back over the last **10** batch cycles.
3. Treats a batch as **incomplete** if:
   - **Phase 1 orphan:** batch phase is 1 and there is net mint/redeem (ops may not be done), or
   - **Phase 2 orphan:** batch phase is 2 but the batch is **not** marked processed (Phase 2 distribution did not run or did not finish).
4. Runs **one** batch per start: the **first** incomplete batch found (oldest first), or the **current** cycle if none are incomplete.

So if a step errors (e.g. "No active position" during ops), the batch stays in phase 1 or 2 and is not marked processed. The next run will pick that batch automatically. You can **override** the target batch with `--batch=N` or `BATCH_CYCLE=N` to run all 5 steps (or a single step) on that historical batch. If that batch is already processed (phase 3), the bot will exit unless you pass **`--allow-processed`** (or `ALLOW_PROCESSED_BATCH=true`): then you can run **only the ops step** (`--step=ops`, `--step=hl`, or `--step=aave`) to fix HL/Aave state that never completed (e.g. after a failed redeem). If Phase 2 ran and the contract marked the batch processed but you did not receive tokens, the bot will not retry that batch (contract state says done); use owner-status or events to investigate.

Run a single step: `npm start -- --step=phase1` or `BATCH_STEP=nav npm start`. Numeric shorthand: `--step=1` … `--step=5` (e.g. `npm start -- --step=3` for NAV only). To run on a specific batch: `npm start -- --batch=20520` or `BATCH_CYCLE=20520 npm start`. To run ops (or hl/aave) on an already-processed batch: `npm start -- --batch=20521 --step=hl --allow-processed` then `--step=aave --allow-processed`. The bot picks the target batch (current cycle or first incomplete orphan, or the override batch if set) and runs only that step, then exits. If the batch is in the wrong phase for the requested step, the bot errors with a clear message (e.g. "Run step phase1 first"). When running step 2 (ops), you can still use `--step=hl` or `--step=aave` to run only the Hyperliquid or Aave part of the ops (see below).

### Running only Hyperliquid or only Aave steps (Phase 1)
Phase 1 NET_MINT and NET_REDEEM are split into **Hyperliquid** steps (deposit/withdraw HL, spot buy/sell, open/close short) and **Aave** steps (deposit/withdraw, borrow/repay). You can run one set at a time for testing or recovery:

- **HL only:** `npm start -- --step=hl` or `BATCH_STEP=hl npm start`
  - NET_MINT: deposit USDC to HL, spot buy, open short.
  - NET_REDEEM: close short, spot sell, withdraw USDC from HL.
- **Aave only:** `npm start -- --step=aave` or `BATCH_STEP=aave npm start`
  - NET_MINT: deposit to Aave, borrow USDC.
  - NET_REDEEM: repay USDC to Aave, withdraw wBTC/ETH from Aave.

Order for a full run: for NET_MINT run Aave first then HL; for NET_REDEEM run HL first then Aave. If one step fails, fix state and re-run that step (or the other) without re-running the whole batch.

## License

MIT
