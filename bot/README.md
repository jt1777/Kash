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
| `KASH_YIELD_ETH_ADDRESS` | KashYieldETH contract (ETH product) | `0x...` |
| `KASH_TOKEN_ETH` | KashTokenEth contract (ETH product) | `0x...` |
| `KASH_YIELD_BTC_ADDRESS` | KashYieldBtc contract (BTC product) | `0x...` |
| `KASH_TOKEN_BTC` | KashTokenBtc contract (BTC product) | `0x...` |
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
3. ✅ HyperliquidAdapter deployed via `deploy-hyperliquid-adapter.js`
4. ✅ Adapter registered and exchange switch proposed via `setHyperliquid.js`
5. ✅ Adapter activated via `setActivePerpExchange.js` (immediate; for 2nd+ adapters: `confirmPerpExchange.js` after 48h first)
6. ✅ Bot wallet has ETH for gas
7. ✅ Bot wallet is contract owner (for privileged functions)
8. ✅ Environment variables configured
9. ✅ Validation passes (`npm run validate`)

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
PRODUCT=eth KASH_YIELD_ETH_ADDRESS=0x... npm run owner:status

# BTC product (with MockAave)
PRODUCT=btc KASH_YIELD_BTC_ADDRESS=0x... AAVE_POOL_ADDRESS=0x... npm run owner:status
```

Shows:
- **Asset in contract**: Total wBTC/ETH, user deposits (reserved), excess (owner-withdrawable)
- **Aave**: Supplied ETH/wBTC, borrowed USDC
- **Hyperliquid**: USDC in spot wallet, open perp positions

## Troubleshooting

### "Invalid KASH_YIELD_ADDRESS" / empty kashYieldAddress
- Verify `KASH_YIELD_ETH_ADDRESS` or `KASH_YIELD_BTC_ADDRESS` (per product) is set in `.env`
- Verify the contract is deployed at that address
- Check you're on the correct network (Arbitrum Sepolia = chain ID 421614)

### "Hyperliquid address not set" / no active exchange
- Ensure a `HyperliquidAdapter` is deployed (`deploy-hyperliquid-adapter.js`)
- Run `setHyperliquid.js` to register the adapter and propose it as the active exchange
- The first adapter registration is immediate — just run `setActivePerpExchange.js` after `setHyperliquid.js`
- For 2nd+ adapter registrations, run `confirmPerpExchange.js` after the 48-hour timelock, then `setActivePerpExchange.js`
- Until confirmed, the contract has no active exchange and the bot will skip HL operations

### "Not in processing window"
- Batch processing only works between 23:50-23:59 UTC (unless the contract uses testing constants for full 24h)
- Set `WAIT_FOR_PROCESSING_WINDOW=true` to have the bot wait for the window, or set `SKIP_PROCESSING_WINDOW_CHECK=true` to run the batch logic anyway for testing (the contract may still revert if it enforces the window)

### Five-step batch flow
The batch is split into five steps so each can be run individually. If any step errors, fix the issue and re-run that step (or the next). Default remains a full run (all five in sequence).

| Step | Name        | Action |
|------|-------------|--------|
| —    | *(pre-step)*| Compute NAV snapshot before any ops (see below) |
| 1    | `phase1`    | Call `performUpkeep()` (Phase 1 indicative; batch moves to phase 1) |
| 2    | `ops`       | Handle NET_MINT/NET_REDEEM (HL + Aave) |
| 3    | `nav`       | Call `updateNAV(lockedNAV)` using the pre-ops snapshot |
| 4    | `mark-done` | Call `markBatchOpsDone(batchCycle)` (batch moves to phase 2) |
| 5    | `phase2`    | Run Phase 2 distribution (mint KASH, pay redeemers) |

#### Pre-ops NAV snapshot

Before Phase 1 runs, the bot computes today's NAV from live Aave/Hyperliquid state and logs it:

```
📊 Computing NAV (pre-ops snapshot)...
   NAV locked for this batch: $1.0523... per KASH
```

This value is used unchanged for `updateNAV()` in step 3 and therefore for Phase 2 settlement. It is **not** recomputed after the ops step, because the ops (Aave deposits/borrows, HL position changes) alter the live Aave yield figures and HL funding readings — recomputing after would produce a post-ops-tainted NAV that includes the cost and slippage of that day's capital deployment.

**Implication for full redemptions:** when 100% of KASH is redeemed, the Aave withdrawal step drains the entire remaining position (not a calculated amount) to sweep any accrued interest and cover any HL slippage gap, ensuring Phase 2 can pay redeemers in full at the locked NAV price.

**How the bot picks the target batch (no batch number needed)**  
The bot does not detect "failure" directly; it detects **incomplete** batches from on-chain state. Each run it:

1. Gets the current batch cycle (today).
2. Looks back over the last **10** batch cycles.
3. Treats a batch as **incomplete** if:
   - **Phase 1 orphan:** batch phase is 1 and there is net mint/redeem (ops may not be done), or
   - **Phase 2 orphan:** batch phase is 2 but the batch is **not** marked processed (Phase 2 distribution did not run or did not finish).
4. Runs **one** batch per start: the **first** incomplete batch found (oldest first), or the **current** cycle if none are incomplete.

**Recovery: when a step errors mid-batch**

If a step errors (e.g. "No active position" during ops), the batch stays in phase 1 or 2 and is not marked processed. The next bot run will detect it as an incomplete orphan and pick it up automatically — no manual intervention needed in most cases.

**Targeting a specific batch cycle**

By default the bot targets the current cycle (or the first incomplete orphan). To run on a specific historical batch:

```bash
npm start -- --batch=20523            # run all 5 steps on batch 20523
npm start -- --batch=20523 --step=ops # run only the ops step on batch 20523
```

The `BATCH_CYCLE=N` environment variable is equivalent to `--batch=N`.

**Re-running ops on an already-processed batch (`--allow-processed`)**

If a batch reached phase 3 (processed) but the capital operations (Aave/Hyperliquid) never completed — for example the mint batch finalized but wBTC was never deployed — you can re-run the ops step using `--allow-processed`:

```bash
# Example: batch 20523 is phase=3 processed=true, but Aave/HL ops never ran
npm start -- --batch=20523 --step=ops --allow-processed

# Or run HL and Aave separately:
npm start -- --batch=20523 --step=hl   --allow-processed
npm start -- --batch=20523 --step=aave --allow-processed
```

`--allow-processed` only unlocks `--step=ops`, `--step=hl`, and `--step=aave`. It cannot re-run phase1, nav, mark-done, or phase2 on a finalized batch.

> **Note:** If Phase 2 ran and the contract marked the batch processed, but tokens were not received, the bot cannot retry the distribution (contract state says done). Use `npm run owner:status` or check on-chain events to investigate.

**Quick reference: common flags**

| Flag | Env var equivalent | Description |
|------|--------------------|-------------|
| `--step=<name>` | `BATCH_STEP=<name>` | Run a single step (`phase1`, `ops`, `nav`, `mark-done`, `phase2`, `hl`, `aave`) |
| `--step=1` … `--step=5` | — | Numeric shorthand for steps 1–5 |
| `--batch=N` | `BATCH_CYCLE=N` | Target a specific batch cycle number |
| `--allow-processed` | `ALLOW_PROCESSED_BATCH=true` | Allow ops steps on an already-finalized batch |
| `--locked-nav=<bigint>` | `LOCKED_NAV=<bigint>` | Supply the pre-ops NAV (18 decimals) when stepping through manually |

If the batch is in the wrong phase for the requested step, the bot exits with a clear message (e.g. `"Batch 20524 is in phase 0; run step phase1 first"`). Fix the prerequisite step, then re-run.

#### Using `--locked-nav` for manual step-through

When the full batch runs automatically, the pre-ops NAV is computed and threaded through all steps internally. When stepping through manually (e.g. for recovery or debugging), pass the same value via `--locked-nav` so `--step=ops` and `--step=nav` use the correct pre-ops price:

```bash
# Run a full batch first (or use --step=nav without --locked-nav) to see the current NAV:
#   📊 Computing NAV (pre-ops snapshot)...
#      NAV locked for this batch: $1.0523... per KASH

# Then step through manually, passing that value to ops and nav:
npm start -- --batch=20523 --step=phase1
npm start -- --batch=20523 --step=ops       --locked-nav=1052300000000000000
npm start -- --batch=20523 --step=nav       --locked-nav=1052300000000000000
npm start -- --batch=20523 --step=mark-done
npm start -- --batch=20523 --step=phase2
```

The value is the NAV in 18-decimal fixed-point (e.g. `$1.0523` = `1052300000000000000`). If `--locked-nav` is omitted, `--step=ops` falls back to the Phase 1 indicative amounts and `--step=nav` recomputes on demand (post-ops), which is fine for testing but introduces the small yield gap described above for production partial redemptions.

### Running only Hyperliquid or only Aave steps (Phase 1)
Phase 1 NET_MINT and NET_REDEEM are split into **Hyperliquid** steps (deposit/withdraw HL, spot buy/sell, open/close short) and **Aave** steps (deposit/withdraw, borrow/repay). You can run one set at a time for testing or recovery:

- **HL only:** `npm start -- --step=hl` or `BATCH_STEP=hl npm start`
  - NET_MINT: deposit USDC to HL, spot buy, open short.
  - NET_REDEEM: close short, spot sell, withdraw USDC from HL.
- **Aave only:** `npm start -- --step=aave` or `BATCH_STEP=aave npm start`
  - NET_MINT: deposit to Aave, borrow USDC.
  - NET_REDEEM: repay USDC to Aave, withdraw wBTC/ETH from Aave.

Order for a full run: for NET_MINT run Aave first then HL; for NET_REDEEM run HL first then Aave. If one step fails, fix state and re-run that step (or the other) without re-running the whole batch.

## Known limitations / Work in progress

These items are stubs or partially implemented — tracked here after the development checklist was retired.

### Daily yield tracking (`dailyYield.ts`)

`getDailyYield(provider)` reads three components. On **MockAave / MockHyperliquid** (testnet) all three are live via custom view functions. On **real Aave** (no mock views) each falls back to zero until the following are implemented:

- **Aave supply interest** — read aToken balance growth or `liquidityIndex` from the Aave reserve data.
- **Aave borrow cost** — read variable debt growth or `variableBorrowIndex`.
- **Hyperliquid funding** — pull from the HL HTTP API or on-chain events.

The NAV computation (`computeNAVFromPortfolioAndYield`) and `updateNAV()` call are fully wired in and run as a pre-ops snapshot before Phase 1 (see above). When the yield readers above are implemented, the NAV will automatically reflect them with no further plumbing required.

### USD → token conversion in Aave calls

Aave deposit/withdraw/borrow/repay functions in `batchProcessor.ts` expect **token amounts** (e.g. WETH in 18 decimals, wBTC in 8 decimals), but the net position computed by the bot is in **USD with 18 decimals**. The conversion is done per-call using `price = getEthPrice() / getBtcPrice()`. Verify this is consistent for all code paths, especially in `handleNetRedeem` where multiple partial withdrawals may occur.

## License

MIT
