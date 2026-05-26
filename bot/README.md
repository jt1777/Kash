# KASH Yield Bot

Off-chain automation bot for the KASH Yield Token protocol on Arbitrum (Sepolia + One).

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
| `PRIVATE_KEY` | Bot wallet private key (must be contract owner for current contracts) | `0x...` |
| `KASH_YIELD_ETH_ADDRESS` | KashYieldETH contract (ETH product) | `0x...` |
| `KASH_TOKEN_ETH` | KashTokenEth contract (ETH product) | `0x...` |
| `KASH_YIELD_BTC_ADDRESS` | KashYieldBtc contract (BTC product) | `0x...` |
| `KASH_TOKEN_BTC` | KashTokenBtc contract (BTC product) | `0x...` |
| `AAVE_POOL_ADDRESS` | Aave V3 pool | Mainnet: `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| `RPC_URL` | RPC endpoint (preferred over ARBITRUM_SEPOLIA_RPC_URL) | Mainnet: `https://arb1.arbitrum.io/rpc` |
| `HYPERLIQUID_API_URL` | Hyperliquid API base URL (mainnet) | `https://api.hyperliquid.xyz` |
| `HYPERLIQUID_API_PRIVATE_KEY` | HL API signer key (bot key in direct mode) | `0x...` |
| `SHORT_LEVERAGE` | Short notional vs batch Aave deposit on mint (`openShort` reads `batchMint*DeployedToAave`) | `1` or `1.7` |
| `NET_MINT_SKIP_OPS_MIN_USDC` | Net batch ops skip threshold (USD) — see [Sub‑$10 net batch ops](#sub-10-net-batch-ops-net_mint_skip_ops_min_usdc-default-10) | `10` |
| `HL_DEPOSIT_WAIT_ENABLED` | After HL bridge deposit, poll until USDC credited before `openShort` | `true` |
| `HL_DEPOSIT_WAIT_MAX_MS` | Max wait for HL deposit credit (ms) | `180000` |
| `HL_DEPOSIT_WAIT_POLL_MS` | Poll interval for HL deposit wait (ms) | `10000` |
| `HL_WITHDRAW_WAIT_ENABLED` | After redeem HL withdraw, wait for USDC on KashYield | `true` |
| `HL_WITHDRAW_WAIT_MAX_MS` | Max wait for HL withdraw settlement (ms) | `360000` |
| `HL_WITHDRAW_WAIT_POLL_MS` | Poll interval for HL withdraw wait (ms) | `20000` |
| `HL_WITHDRAW_FEE_TOLERANCE_USDC` | Balanced/falling tail: max USDC gap covered via `coverUsdcShortfall` before Aave repay | `1` |
| `SMALL_SWAP_SKIP_MAX_USDC` | Rising tail — see [Redeem tail / spot dust thresholds](#redeem-tail--spot-dust-thresholds) | `2` |

### Redeem tail / spot dust thresholds

Used by [`opsExec.ts`](src/batch/opsExec.ts) / [`targetStateEngine.ts`](src/batch/targetStateEngine.ts) so the **rising** tail can skip tiny **11a** legs. Values are **human USDC amounts** (6 decimals), e.g. `2` means **$2.00`.

| Variable | When it applies | Behavior |
|----------|-----------------|----------|
| **`SMALL_SWAP_SKIP_MAX_USDC`** | **Rising** price tail (ops path: repay Aave USDC) | Let `sf = aaveDebt − contractUsdc` (adjusted USDC on KashYield). If `0 < sf <` this threshold, the bot **skips** partial Aave withdraw and **11a** (ETH→USDC). You must **send enough USDC** to KashYield (and optionally call `coverUsdcShortfall` if using owner reserve accounting), then complete repay / playbook. Default **`2`**. |

**Falling** tail **11b** (USDC→ETH/wBTC) swaps **only the USDC needed** for the redeem asset shortfall (`min(usdcNeeded, deployable USDC)`). If the vault already has enough ETH/wBTC for redeem sizing, **11b does not swap** and excess USDC stays on the vault (including **dust** amounts when a swap is needed). Legacy env **`FALLING_11B_USDC_RESERVE`** is ignored.

Swaps **above** the rising-tail threshold still use on-chain **`minOut`** from Chainlink + slippage settings in the vault; **`SMALL_SWAP_SKIP_MAX_USDC`** only gates **whether** the bot submits **11a** for small USDC shortfalls.

**Mint `openShort` (wBTC):** internal target short Δ is stored in 18-dec perp units; on-chain `openShort` uses 8-dec wBTC. If `(Δ * 10^8) / 10^18` rounds to **0**, the step is a deliberate no-op (sub-satoshi — no economic impact).

## Bot Components

### Batch Processor

Handles the daily two-phase batch on KashYield (`performUpkeep` → ops → settlement NAV → mark-done → Phase 2):

- Waits for the processing window (23:50–23:59 UTC) when configured
- Pre–Phase-1 and post-ops **`updateNAV`**
- **`runStepOps`** → **`runTargetStateEngine`** → **`opsExec`** delta pipelines (sole automated mint/redeem ops path)
- **`markBatchOpsDone`** preflight (vault asset vs gross redeem need)
- Phase 2 distribution via `performUpkeep` / `processBatchPhase2ForCycle`

Legacy **`handleNetMint` / `handleNetRedeem`** handlers were removed from `batchProcessor.ts`. Receipt parsing after Phase 2 is **informational only** (no deploy/withdraw triggered from events).

#### Mint ops (`net_mint_hl`, net ≥ skip threshold)

Order: **Aave deposit** → **`markMint*Deployed`** → **borrow to LTV** → **HL USDC deposit** → **wait for HL credit** → **open/extend short**.

- No on-chain **`spotBuyOnHyperliquid`** on the automated mint path (USDC collateral + perp short only).
- Short increment ≈ **batch Aave deposit USD × `SHORT_LEVERAGE`** (via `batchMintDeployedToAave`), not gross deployable USD × leverage.
- After `depositToHyperliquid`, the bot polls HL until USDC is credited before `openShort` (`HL_DEPOSIT_WAIT_*`).

#### Redeem ops (`redeem_hl`)

1. **Core:** proportional **close short** → **HL settlement** (`withdraw3` + on-chain adapter pull to KashYield; settlement is not complete until HL spot is at target **and** adapter ERC-20 USDC is drained **and** vault ops float covers strategy Aave repay).
2. **Tail** (after settlement wait): **balanced / falling / rising** — Aave repay, Aave withdraw, optional **11a** / **11b** spot swaps; **`coverUsdcShortfall`** for small HL withdraw fee gaps (`HL_WITHDRAW_FEE_TOLERANCE_USDC`).

See [`targetStateEngine.ts`](src/batch/targetStateEngine.ts) and [`opsExec.ts`](src/batch/opsExec.ts).

#### Sub‑$10 net batch ops (`NET_MINT_SKIP_OPS_MIN_USDC`, default **10**)

Gating lives in **`runStepOps`** only (not in `targetStateEngine`). Uses **net** = `totalMintUSD − totalRedeemUSD` (18‑dec USD). Phase 1 → settlement NAV → mark-done → Phase 2 **always run** when the batch has requests.

| Net batch | Ops behavior |
|-----------|----------------|
| **Net mint &lt; $10** | Skip Aave/HL; deposited wBTC/ETH **stays on the vault** (dust). KASH still minted in Phase 2. |
| **Net redeem ≥ $10** | Full redeem ops (HL + Aave tail). |
| **Net redeem &lt; $10**, vault **covers** payout | Skip ops; Phase 2 pays redeemers from **vault wBTC/ETH** (`vaultCoversRedeemPayout` — same check as mark-done). |
| **Net redeem &lt; $10**, vault **insufficient** | Full redeem ops. |

**Dust layer:** Skipped net mints accumulate idle vault asset (backs NAV, not deployed to Aave/HL). Small net redeems that skip ops draw down that vault slice without unwinding the levered book — intentional pairing for micro flows. The **frontend** blocks mint requests **&lt; $10** (oracle USD); **redemptions have no minimum**.

**Note:** Mint deploy sizing for a later ≥ $10 batch uses **that batch’s after-fee net mint** only (capped by vault balance); accumulated dust is not added into the deploy target, but may be consumed up to that batch’s target.

Manual **`scripts/ops/`** steps (e.g. `04-spot-buy-asset`, `07-sell-spot-asset`) follow the older HL spot playbook; **`npm start`** does not use those on mint/redeem.

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

## Ops scripts: `scripts/ops/_utils.js`

`getState(contract)` loads on-chain balances and returns both **raw** wallet balances (`contractAssetRaw`, `contractUsdcRaw`) and **owner-adjusted** values (`contractAsset`, `contractUsdc`): the adjusted numbers subtract `ownerUsdcReserve` and `ownerEthReserve` (ETH product) or `ownerWbtcReserve` (BTC product), clamped at zero. Use adjusted figures when reasoning about deployable float for Aave / Hyperliquid; use raw + reserve lines when reconciling the actual wallet. `displayState` prints reserves, raw, and adjusted columns. The TypeScript batch pipeline (`snapshotOpsContext`, `getContractUsdcBalance` in `batchProcessor`, and NAV estimation) applies the same reserve subtraction for consistency.

## Deployment Checklist

Before running the bot in production:

1. ✅ KashYield contract deployed on Arbitrum Sepolia
2. ✅ Aave pool address set via `setAavePool.js`
3. ✅ HyperliquidAdapter deployed via `deploy-hyperliquid-adapter.js`
4. ✅ Adapter registered and exchange switch proposed via `setHyperliquid.js`
5. ✅ Adapter activated via `setActivePerpExchange.js` (immediate; for 2nd+ adapters: `confirmPerpExchange.js` after 24h first)
6. ✅ Bot wallet has ETH for gas
7. ✅ Bot wallet is contract owner (for privileged functions)
8. ✅ Environment variables configured
9. ✅ Validation passes (`npm run validate`)

## Network Configuration (Sepolia + Mainnet)

### Arbitrum One (mainnet)
- Chain ID: `42161`
- RPC: `https://arb1.arbitrum.io/rpc` (or your provider URL in `RPC_URL`)
- Explorer: `https://arbiscan.io`
- Core addresses:
  - Aave Pool: `0x794a61358D6845594F94dc1DB02A252b5b4814aD`
  - WETH: `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`
  - USDC: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`

### Arbitrum Sepolia (testnet)
- Chain ID: `421614`
- RPC: `https://sepolia-rollup.arbitrum.io/rpc`
- Explorer: `https://sepolia.arbiscan.io`

---

## Mainnet Hyperliquid Setup (Important)

Real Hyperliquid trading is off-chain (API), not an Arbitrum contract call. The adapter must be configured correctly.

### 1) Use direct deposit mode on adapter

After deploying `HyperliquidAdapter`, set:
- `directDepositMode=true`
- `hlAccount=<bot EOA>`

From repo root:

```bash
npx hardhat console --network arbitrumOne
```

```javascript
const [signer] = await ethers.getSigners()
const adapter = await ethers.getContractAt("HyperliquidAdapter", "<HL_ADAPTER_ADDRESS_ETH>", signer)
await (await adapter.setDirectDepositMode(true, "<BOT_EOA_ADDRESS>")).wait()
console.log(await adapter.directDepositMode(), await adapter.hlAccount())
```

Why: contract-address HL users cannot directly sign API actions (`order`, `withdraw3`, `approveAgent`) unless pre-authorized agent plumbing already exists.

### 2) Bot `.env` for real HL

Add these in `bot/.env`:

```env
RPC_URL=https://arb1.arbitrum.io/rpc
PRODUCT=eth
KASH_YIELD_ETH_ADDRESS=<...>
KASH_TOKEN_ETH=<...>

# HL API
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz
HYPERLIQUID_API_PRIVATE_KEY=0x...   # bot signer key
HL_EVENT_RELAY_ENABLED=true          # default true; execute HL API orders inline during npm start
HL_EVENT_RELAY_STRICT=false          # if true, fail ops step when relay fails

# Strategy
SHORT_LEVERAGE=1
```

### 3) Inline HL relay during `npm start` (new)

The batch ops playbooks execute Hyperliquid API actions inline during `npm start` for:
- `EXCHANGE_OPEN_SHORT`
- `EXCHANGE_CLOSE_SHORT`

(`EXCHANGE_SPOT_BUY` / `EXCHANGE_SPOT_SELL` are **not** used on the automated mint path; rising/falling tails use on-chain **`swapForUsdc` / `swapFromUsdc`** via `spotDexAddress`. Relay scripts can still replay spot events for recovery.)

After each HL order, the bot syncs adapter state (`syncBalances` + `syncPosition`) on Arbitrum.

For direct-deposit mode, after `depositToHyperliquid` the bot also transfers USDC from `hlAccount` to `hlBridgeAddress` (same run), so collateral is pushed to HL L1.

If `HL_EVENT_RELAY_ENABLED=false`, on-chain intent txs still run but no real HL API trades are executed.

### 4) Relay scripts (optional recovery/backfill)

Scripts are still available for operational recovery:
- `bot/scripts/ops/13-hl-event-relay.js` — event backfill/watch relay
- `bot/scripts/ops/14-hl-sync-state.js` — one-shot state reconcile

Use them when you need to replay missed events, recover after downtime, or reconcile state manually.

### 5) Known operational caveat

`DRY_RUN_OPS=true npm start` skips only ops tx execution but still runs phase1/nav/mark-done/phase2 on-chain.  
Do not use that mode on live user batches unless you explicitly intend that behavior.

### Hyperliquid reference (mainnet)

| Item | Value |
|------|--------|
| Bridge2 (Arbitrum One) | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` |
| Native USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| API base URL | `https://api.hyperliquid.xyz` |

KashYield routes perp/spot calls through **`IPerpExchange`** adapters (production: **`HyperliquidAdapter`**). Trades and **`withdraw3`** are **off-chain via the HL API**; the bot syncs adapter state on Arbitrum after each action. Custody and `directDepositMode`: [DEPLOYMENT.md](../docs/DEPLOYMENT.md).

**External docs:** [Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/) · [Python SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk)

## Owner Status Script

View protocol state at a glance (asset in contract, Aave, Hyperliquid):

```bash
# ETH product
PRODUCT=eth KASH_YIELD_ETH_ADDRESS=0x... npm run owner:status

# BTC product
PRODUCT=btc KASH_YIELD_BTC_ADDRESS=0x... AAVE_POOL_ADDRESS=0x... npm run owner:status
```

Shows:
- **Asset in contract**: Total wBTC/ETH, user deposits (reserved), excess (owner-withdrawable)
- **KASH token**: Total supply, on-vault (pending redeems only), in user wallets — **do not** treat vault KASH = 0 as “no mints”
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
- For 2nd+ adapter registrations, run `confirmPerpExchange.js` after the 24-hour timelock, then `setActivePerpExchange.js`
- Until confirmed, the contract has no active exchange and the bot will skip HL operations

### "Not in processing window"
- Batch processing only works between 23:50-23:59 UTC (unless the contract uses testing constants for full 24h)
- Set `WAIT_FOR_PROCESSING_WINDOW=true` to have the bot wait for the window, or set `SKIP_PROCESSING_WINDOW_CHECK=true` to run the batch logic anyway for testing (the contract may still revert if it enforces the window)

### Five-step batch flow
The batch is split into five steps so each can be run individually. If any step errors, fix the issue and re-run that step (or the next). Default remains a full run (all five in sequence).

**Two `updateNAV` calls per full batch (starting from phase 0):** (1) **pre-Phase-1** MTM so on-chain Phase 1 sees fresh `currentNAV`; (2) **post-ops settlement** MTM so Phase 2 mint/redeem uses balances after fees and slippage.

| Step | Name        | Action |
|------|-------------|--------|
| —    | *(pre-Phase-1)* | `computeNewNAV` → **`updateNAV`** (Phase-1-era MTM on-chain) |
| 1    | `phase1`    | `performUpkeep()` after the above (Phase 1; batch moves to phase 1) |
| 2    | `ops`       | **`runStepOps`** (skip gates + target-state mint/redeem); sizing uses **Phase-1-era** NAV |
| 3    | `nav`       | `computeNewNAV` post-ops → **`updateNAV` (settlement)** for Phase 2 |
| 4    | `mark-done` | `markBatchOpsDone(batchCycle)` (batch moves to phase 2) |
| 5    | `phase2`    | Phase 2 distribution at **settlement** `currentNAV` |

#### Pre-Phase-1 vs settlement NAV

The bot computes NAV from live Aave/Hyperliquid state **before Phase 1** and calls **`updateNAV`** so `batchTotalRedeemValueUSD` / net signals use today’s MTM. **After ops**, it recomputes NAV and calls **`updateNAV` again** so Phase 2 aligns with post-trade balances. Phase 1 chain totals and Phase 2 payout can differ by the NAV and supply change over the ops window — not by a single “locked pre-ops” number that ignores realized costs.

**Manual `--step=phase1`:** runs pre-Phase-1 `updateNAV` + `performUpkeep()` (two txs for that step).

**`--locked-nav`:** overrides **Phase-1-era** sizing on `--step=ops` if needed; overrides **settlement** `updateNAV` on `--step=nav`; on **`--step=mark-done`** overrides the redeem-asset check (default: on-chain `currentNAV` after `nav`).

**Implication for full redemptions:** the playbook still targets enough asset on the vault for Phase 2 at **settlement** NAV; use `scripts/ops/16-phase2-redeem-shortfall.js` when borderline.

**How the bot picks the target batch (no batch number needed)**  
The bot does not detect "failure" directly; it detects **incomplete** batches from on-chain state. Each run it:

1. Gets the current batch cycle (today).
2. Looks back over the last **10** batch cycles.
3. Treats a batch as **incomplete** if:
   - **Phase 1 orphan:** batch phase is 1 and there is net mint/redeem (ops may not be done), or
   - **Phase 2 orphan:** batch phase is 2 but the batch is **not** marked processed (Phase 2 distribution did not run or did not finish).
4. Runs **one** batch per start: the **first** incomplete batch found (oldest first), or the **current** cycle if none are incomplete.

### Batch recovery runbook

Use this when a batch is stuck at **phase 1** (ops incomplete or mark-done blocked) or **phase 2** (payout not done). Prefer **diagnose → one corrective action → one completion run**. Avoid looping full `npm start` after mark-done has already failed.

#### Is `updateNAV` called every time a problem?

**On a normal, single full run — no.** Two `updateNAV` writes per batch (starting from phase 0) are intentional:

1. **Pre–Phase-1** — fresh MTM so Phase 1 on-chain signals use today’s portfolio.
2. **Post-ops settlement** — MTM after trades/fees so Phase 2 mint/redeem matches realized balances.

**On recovery — it can make things worse if you repeat full runs blindly.**

When you resume from **phase 1** with `npm start -- --batch=N` (no `--step`), the bot **always** runs ops → **settlement `updateNAV` again** → mark-done → phase2 — even when every ops step was `[Δ skip]`. Each settlement write:

- Updates on-chain **`currentNAV`** from live MTM (BTC price, portfolio, settlement buffer).
- Raises **mark-done**’s required vault wBTC/ETH (`totalRedeemAsset` ∝ NAV × pending KASH).

So if the vault is **already short** wBTC for payout, **re-running the full batch without fixing the asset gap first** can **raise the bar every time** while leaving the hole unchanged. That is what happened when mark-done failed, then runs 2–3 wrote higher settlement NAV (~$1.00 → ~$1.02 → ~$1.06) while ~0.00001224 wBTC was still missing.

**Rule:** after `Cannot markBatchOpsDone`, do **not** loop full `npm start`. Fix the wBTC/ETH gap once, then finish with targeted steps (below).

#### Default recovery command

One full resume (ops → settlement nav → mark-done → phase2):

```bash
cd bot
npm run build   # after code changes
PRODUCT=btc SKIP_PROCESSING_WINDOW_CHECK=true npm start -- --batch=<cycle>
```

Use when ops **actually failed mid-pipeline** (HL/Aave incomplete). Do **not** use when mark-done already failed and ops are all skips — fix capital first (next section).

#### Diagnose first

```bash
npm run owner:status
```

Check for batch `<cycle>`:

| Signal | Meaning |
|--------|---------|
| `phase=1 processed=false` | Mid-batch — ops and/or nav/mark-done/phase2 incomplete |
| `phase=2 processed=false` | mark-done passed; Phase 2 payout not done |
| KASH still on vault | Phase 2 not finished |
| Aave debt / HL short non-zero | Ops tail incomplete |
| Vault wBTC low + USDC ops float | May need **11b** (USDC→wBTC), not more manual wBTC dribbles |

#### Common failure modes

**1. Ops aborted mid-tail (e.g. tx error after repay, before 11b swap)**

- On-chain: Aave/HL may look “done”, but vault wBTC can still be below Phase 2 need; USDC may sit on vault unused.
- **Fix:** complete the missing tail action (often **swap ops USDC → wBTC** via falling-tail / 11b path, or owner script), **then** one completion run.
- **Do not** assume a small manual wBTC transfer fixes mark-done — if you also run settlement `updateNAV` again, required wBTC rises in parallel (same ~$ gap can persist).

**2. `Cannot markBatchOpsDone` (vault wBTC/ETH below gross redeem + owner reserve)**

- mark-done uses **settlement NAV** (or on-chain `currentNAV` after `--step=nav`).
- **Fix gap first** (11b / swap / withdraw remaining from Aave if any), **then** finish without re-bumping NAV repeatedly:

```bash
# After capital is sufficient — skip re-running ops if already idempotent:
PRODUCT=btc SKIP_PROCESSING_WINDOW_CHECK=true npm start -- --batch=<cycle> --step=mark-done
PRODUCT=btc SKIP_PROCESSING_WINDOW_CHECK=true npm start -- --batch=<cycle> --step=phase2
```

Only re-run `--step=nav` if settlement NAV was never written or you intentionally want a fresh MTM (understand it changes Phase 2 sizing).

**3. Partial step runs (`--step=hl`, `--step=ops` only)**

- `--step=ops` exits after ops — **does not** run nav, mark-done, or phase2.
- `--step=hl` on NET_REDEEM runs HL unwind only — **skips Aave tail** (repay, withdraw, 11b).
- After `--step=ops` or `--step=hl`, you must still run nav → mark-done → phase2 (or one full `npm start`).

**4. Stale phase 0 (past cycle, Phase 1 never ran)**

- Not recoverable with `--batch=N`. User must **cancel** and resubmit in the current cycle. Bot fails fast if you target it.

**5. Two processes, same `PRIVATE_KEY`**

- Can cause `nonce too low` mid-batch. Run **one** bot at a time on the bot wallet.

#### What not to do

- Loop `npm start -- --batch=N` after mark-done failure hoping it self-heals.
- Send tiny manual wBTC to the contract without checking mark-done math vs settlement NAV.
- Use `--step=hl` on a full redeem that still needs Aave tail.
- Confuse `phase=1` with `processed=true` — phase 1 means mid-pipeline, not paid out.

#### When auto-resume is enough

If a step errors but **capital is unchanged** (e.g. transient RPC, nonce retry succeeds on re-run), the next `npm start` orphan pick-up is fine — **one** retry, not many.

**Targeting a specific batch cycle**

By default the bot targets the current cycle (or the first incomplete orphan). You can target a specific batch cycle, but there is an important contract constraint:

- `performUpkeep()` always processes the **current timestamp cycle**.
- So a full forced run on an older phase-0 cycle can fail later with `WrongPhase()`.

```bash
npm start -- --batch=20523 --step=ops       # run only ops on batch 20523
npm start -- --batch=20523 --step=nav       # run only nav on batch 20523
npm start -- --batch=20523 --step=mark-done # run only mark-done on batch 20523
npm start -- --batch=20523 --step=phase2    # run only phase2 on batch 20523
```

The `BATCH_CYCLE=N` environment variable is equivalent to `--batch=N`.

**Stale past-cycle requests (phase 0):**

If a mint/redeem request is stuck in an older cycle with `phase=0`, it cannot be picked up by `performUpkeep()` anymore.  
User must cancel (`cancelMintRequest`/`cancelRedeemRequest`) and resubmit in the current cycle.

Targeting such a cycle with `--batch=N` (or any step on it) **fails immediately** with:

`Cycle N is stale phase 0 (current cycle is …). Users must cancel … and resubmit in the current cycle.`

Do not expect `--batch=N --step=phase1|ops|nav|mark-done|phase2` to recover stale phase-0 batches.

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
| `--locked-nav=<bigint>` | `LOCKED_NAV=<bigint>` | Optional override (18‑dec): ops sizing, settlement `nav`, or `mark-done` check — see batch flow section |

If the batch is in the wrong phase for the requested step, the bot exits with a clear message (e.g. `"Batch 20524 is in phase 0; run step phase1 first"`). Fix the prerequisite step, then re-run.

#### Using `--locked-nav` for manual step-through

When stepping through manually, `--locked-nav` is **optional** at each step:

- **`--step=ops`**: defaults to on-chain `currentNAV` after pre-Phase-1 `updateNAV`; pass `--locked-nav` only if that on-chain value is wrong for recovery.
- **`--step=nav`**: defaults to `computeNewNAV()` at run time (**settlement**); pass `--locked-nav` to force the `updateNAV` argument.
- **`--step=mark-done`**: defaults to on-chain `currentNAV` after settlement `nav`.

```bash
npm start -- --batch=20523 --step=phase1
npm start -- --batch=20523 --step=ops
npm start -- --batch=20523 --step=nav
npm start -- --batch=20523 --step=mark-done
npm start -- --batch=20523 --step=phase2
```

The value is NAV in 18-decimal fixed-point (e.g. `$1.0523` = `1052300000000000000`).

### Running only Hyperliquid or only Aave steps (Phase 1)

Ops sub-steps (`--step=hl` / `--step=aave`) filter steps inside **`opsExec`** delta pipelines. Order for a full run: **NET_MINT** — Aave then HL; **NET_REDEEM** — HL core then Aave/tail.

- **HL only:** `npm start -- --step=hl` or `BATCH_STEP=hl npm start`
  - **NET_MINT:** HL USDC deposit, wait for credit, open/extend short (no spot buy).
  - **NET_REDEEM:** close short, HL USDC settlement to KashYield.
- **Aave only:** `npm start -- --step=aave` or `BATCH_STEP=aave npm start`
  - **NET_MINT:** deposit to Aave, borrow USDC.
  - **NET_REDEEM:** tail — repay, withdraw, optional 11a/11b (after HL core when running full ops).

Sub‑$10 skip gates in **`runStepOps`** apply before any sub-step runs. If ops is skipped entirely, `--step=hl` / `--step=aave` on that batch have nothing to do.

Manual **`bot/scripts/ops/`** scripts are independent one-step Hardhat tools; see [`scripts/ops/README.md`](scripts/ops/README.md). They do not invoke `batchProcessor`.

## Known limitations / Work in progress

These items are stubs or partially implemented — tracked here after the development checklist was retired.

### Daily yield tracking (`dailyYield.ts`)

`getDailyYield(provider)` reads three components. On **MockAave / MockHyperliquid** (testnet) all three are live via custom view functions. On **real Aave** (no mock views) each falls back to zero until the following are implemented:

- **Aave supply interest** — read aToken balance growth or `liquidityIndex` from the Aave reserve data.
- **Aave borrow cost** — read variable debt growth or `variableBorrowIndex`.
- **Hyperliquid funding** — pull from the HL HTTP API or on-chain events.

The NAV path runs **`computeNewNAV` / `estimatePortfolioValueUSD`** for **pre-Phase-1** and **post-ops settlement** `updateNAV` calls (see Five-step batch flow above). When the yield readers above are implemented, NAV inputs will reflect them automatically.

### USD → token amounts in ops

Aave/HL steps in **`opsExec.ts`** use **token amounts** (wBTC 8 dec, ETH 18 dec, USDC 6 dec). Batch **net USD** (18 dec) is converted per step using Chainlink **`getBtcPrice()` / `getEthPrice()`**. Redeem **`totalRedeemAsset`** and mark-done use the same NAV era as ops sizing (`phase1EraNAV` at ops time; settlement NAV at mark-done).

## License

MIT
