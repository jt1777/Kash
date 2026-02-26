# Off-Chain Bot Specification for KashYield

## Overview

The bot (1) calls `processBatch()` in the processing window (or uses Chainlink Automation), and (2) reacts to `ProtocolInteraction` events to deploy/withdraw capital. The contract values mints via Chainlink and distributes in the same flow (no `setMintValuation()` or separate claim). This doc covers NAV formulas, deployment/withdrawal strategy, and operational procedures.

---

## 1. NAV Calculation

### Formula

```
NAV = Total Portfolio Value (USD) / Total Kash Token Supply

Total Portfolio Value (USD) = Assets - Liabilities
```

### Assets Calculation

```
Assets = 
  + ETH in Aave (aToken balance × ETH price)
  + wETH in Aave (aToken balance × ETH price)
  + wBTC in Aave (aToken balance × BTC price)
  + USDT in Aave (aToken balance × 1.00)
  + USDC in Aave (aToken balance × 1.00)
  + ETH in Hyperliquid spot wallet (balance × ETH price)
  + USDT in Hyperliquid spot wallet (balance × 1.00)
  + Value of open perp positions on Hyperliquid
  + Accrued funding fees (Hyperliquid)
  + Accrued interest (Aave supply)
  + ETH in contract (idle balance × ETH price)
  + ERC20 tokens in contract (idle balance × token price)
```

### Liabilities Calculation

```
Liabilities = 
  + Borrowed USDT from Aave (debt balance × 1.00)
  + Borrowed USDC from Aave (debt balance × 1.00)
  + Accrued borrow interest (Aave)
  + Unrealized losses on perp positions (if any)
```

### Perp Position Valuation

For each open perpetual position:

```
Position Value = 
  Collateral 
  + Unrealized PnL
  + Accrued Funding Fees

Unrealized PnL = Position Size × (Current Price - Entry Price) × Direction
  where Direction = +1 for long, -1 for short
```

### NAV Update Frequency

- **Daily Updates**: Once per day during batch processing (23:50 UTC)
- **Emergency**: Manual trigger by operator if needed

---

## 2. Batch Processing Workflow (Current)

### Contract flow (KashYieldETH)

- **Processing window:** 23:50–23:59 UTC (configurable).
- **`processBatch()`** runs in one call but two phases:
  1. **Phase 1:** Values mint requests via Chainlink (`getEthPrice()` etc.), computes batch totals and NAV, stores state. Then **stops** until owner marks ops done.
  2. **Owner/bot:** Performs Aave/Hyperliquid ops (deploy or withdraw capital), then calls **`updateNAV(newNAV)`**, then **`markBatchOpsDone()`**.
  3. **Phase 2:** Distributes KASH to minters and ETH (or other tokens) to redeemers, emits `BatchProcessed` and `TokensClaimed`, sets `batchProcessed[batchCycle] = true`.
- **ProtocolInteraction** events (e.g. `NET_MINT_ETH_DEPLOY`, asset, amount) are emitted when there is net mint or net redeem ETH to deploy/withdraw; the bot should react to these (from the tx receipt or event subscription) and call the contract’s owner functions (e.g. `depositToAave`, `depositToHyperliquid`, `openShort`) as needed.

### Daily timeline

| Time (UTC)     | Event            | Bot / contract action |
|----------------|------------------|------------------------|
| 00:00 – 23:49  | User window      | Users request mint/redeem |
| 23:50 – 23:59  | Processing       | Call `processBatch()` (or Chainlink Automation triggers it). Contract does Phase 1 (Chainlink valuation, batch math). |
| After Phase 1  | Owner ops        | Bot/owner: Aave + Hyperliquid deploy/withdraw, then `updateNAV(...)`, then `markBatchOpsDone()`. |
| Same tx / next | Phase 2          | Contract continues Phase 2: distributes tokens, emits events. |
| After tx       | Capital deploy  | Bot reads `ProtocolInteraction` from receipt (or listener) and calls `depositToAave`, `depositToHyperliquid`, `openShort`, etc. |

### Bot responsibilities

1. **Trigger batch:** Call `processBatch()` during the window, or use Chainlink Automation (`checkUpkeep` / `performUpkeep`).
2. **Between Phase 1 and Phase 2:** Run Aave/Hyperliquid ops, then `updateNAV(calculatedNAV)`, then `markBatchOpsDone()`.
3. **After batch tx:** Parse `ProtocolInteraction` from the tx receipt (or subscribe to events) and execute deploy/withdraw (see `bot/CHECKLIST.md` and `batchProcessor.ts`).

---

## 3. Deployment Strategy (Net Mints)

### Target Allocation

```
ETH Yield (Aave Supply):     40%
ETH Short Hedge:              35%
Stablecoin Reserve:           20%
Operational Buffer:            5%
```

### Deployment Logic

```javascript
function determineDeploymentStrategy(netMintUSD) {
  const currentAllocation = calculateCurrentAllocation();
  const targetAllocation = TARGET_ALLOCATION;
  
  const actions = [];
  
  // 1. Deposit ETH to Aave (40% of new capital)
  const ethToDeposit = convertUSDToETH(netMintUSD * 0.40);
  actions.push({
    type: 'DEPOSIT_AAVE',
    asset: ETH_ADDRESS,
    amount: ethToDeposit
  });
  
  // 2. Borrow USDT (70% LTV of deposited ETH)
  const usdtToBorrow = netMintUSD * 0.40 * 0.70;
  actions.push({
    type: 'BORROW_AAVE',
    asset: USDT_ADDRESS,
    amount: convertUSDToUSDT(usdtToBorrow)
  });
  
  // 3. Transfer USDT to Hyperliquid
  actions.push({
    type: 'DEPOSIT_HYPERLIQUID',
    amount: convertUSDToUSDT(usdtToBorrow)
  });
  
  // 4. Open ETH short position (35% of total capital)
  const shortNotional = netMintUSD * 0.35;
  actions.push({
    type: 'OPEN_PERP',
    symbol: 'ETH-PERP',
    size: convertUSDToETH(shortNotional),
    isLong: false
  });
  
  // 5. Keep 25% in stablecoins (already in contract from mints)
  // No action needed
  
  return actions;
}
```

---

## 4. Withdrawal Strategy (Net Redeems)

### Withdrawal Priority

1. **Idle Assets** (stablecoin reserves)
2. **Hyperliquid Spot** (close positions, withdraw)
3. **Aave** (withdraw, repay loans proportionally)

### Withdrawal Logic

```javascript
function determineWithdrawalStrategy(netRedeemUSD) {
  const actions = [];
  let remaining = netRedeemUSD;
  
  // Step 1: Use idle stablecoins first
  const idleStables = await getIdleStablecoinBalance();
  if (idleStables >= remaining) {
    return actions; // Sufficient idle funds
  }
  remaining -= idleStables;
  
  // Step 2: Close proportional perp positions
  const perpValue = await getPerpPositionValue();
  const perpToClose = Math.min(perpValue, remaining * 0.40);
  if (perpToClose > 0) {
    actions.push({
      type: 'CLOSE_PERP',
      symbol: 'ETH-PERP',
      portion: perpToClose / perpValue // Close proportionally
    });
    remaining -= perpToClose;
  }
  
  // Step 3: Withdraw from Hyperliquid and swap to needed assets
  const hlBalance = await getHyperliquidBalance();
  const hlToWithdraw = Math.min(hlBalance, remaining * 0.30);
  if (hlToWithdraw > 0) {
    actions.push({
      type: 'WITHDRAW_HYPERLIQUID',
      amount: hlToWithdraw
    });
    remaining -= hlToWithdraw;
  }
  
  // Step 4: Repay Aave loans and withdraw collateral
  if (remaining > 0) {
    const loanBalance = await getAaveLoanBalance();
    const collateralValue = await getAaveCollateralValue();
    
    // Repay proportional amount of loan
    const loanToRepay = Math.min(loanBalance, remaining * 0.50);
    actions.push({
      type: 'REPAY_AAVE',
      asset: USDT_ADDRESS,
      amount: loanToRepay
    });
    
    // Withdraw freed collateral
    const collateralToWithdraw = loanToRepay / 0.70; // Inverse of LTV
    actions.push({
      type: 'WITHDRAW_AAVE',
      asset: ETH_ADDRESS,
      amount: convertUSDToETH(collateralToWithdraw)
    });
    
    remaining -= (loanToRepay + collateralToWithdraw);
  }
  
  // Step 5: Emergency - withdraw more collateral if needed
  if (remaining > 0) {
    console.warn(`Still need ${remaining} USD - emergency withdrawal`);
    // Implement emergency procedures
  }
  
  return actions;
}
```

---

## 5. Rebalancing Logic

### Triggers for Rebalancing

- **Allocation Drift**: When any category deviates >10% from target
- **Risk Metrics**: When health factor < 1.5 or LTV > 65%
- **Funding Rates**: When funding rates change significantly
- **Scheduled**: Weekly rebalancing check

### Rebalancing Actions

```javascript
function checkRebalancingNeeds() {
  const current = calculateCurrentAllocation();
  const target = TARGET_ALLOCATION;
  const actions = [];
  
  // Check each allocation category
  for (const [category, targetPercent] of Object.entries(target)) {
    const currentPercent = current[category];
    const drift = Math.abs(currentPercent - targetPercent);
    
    if (drift > 0.10) { // 10% drift threshold
      console.log(`Rebalancing ${category}: ${currentPercent} → ${targetPercent}`);
      
      if (currentPercent > targetPercent) {
        // Reduce exposure
        actions.push(createReduceAction(category, drift));
      } else {
        // Increase exposure
        actions.push(createIncreaseAction(category, drift));
      }
    }
  }
  
  return actions;
}
```

---

## 6. Historical Data Storage

### Database Schema

#### `nav_history` Table

```sql
CREATE TABLE nav_history (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL,
  nav DECIMAL(20, 18) NOT NULL,
  total_assets_usd DECIMAL(20, 2) NOT NULL,
  total_liabilities_usd DECIMAL(20, 2) NOT NULL,
  total_kash_supply DECIMAL(20, 18) NOT NULL,
  eth_price DECIMAL(10, 2) NOT NULL,
  btc_price DECIMAL(10, 2) NOT NULL
);
```

#### `batch_history` Table

```sql
CREATE TABLE batch_history (
  id SERIAL PRIMARY KEY,
  batch_cycle BIGINT NOT NULL UNIQUE,
  processed_at TIMESTAMP NOT NULL,
  total_mint_usd DECIMAL(20, 2) NOT NULL,
  total_redeem_usd DECIMAL(20, 2) NOT NULL,
  net_position_usd DECIMAL(20, 2) NOT NULL,
  final_nav DECIMAL(20, 18) NOT NULL
);
```

#### `user_transactions` Table

```sql
CREATE TABLE user_transactions (
  id SERIAL PRIMARY KEY,
  user_address VARCHAR(42) NOT NULL,
  batch_cycle BIGINT NOT NULL,
  tx_type VARCHAR(10) NOT NULL, -- 'MINT' or 'REDEEM'
  token_in VARCHAR(42),
  amount_in DECIMAL(30, 18),
  token_out VARCHAR(42),
  amount_out DECIMAL(30, 18),
  nav_at_request DECIMAL(20, 18) NOT NULL,
  claimed BOOLEAN DEFAULT FALSE,
  claimed_at TIMESTAMP,
  tx_hash VARCHAR(66)
);
```

#### `portfolio_snapshots` Table

```sql
CREATE TABLE portfolio_snapshots (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL,
  aave_eth_balance DECIMAL(30, 18),
  aave_wbtc_balance DECIMAL(30, 8),
  aave_usdt_debt DECIMAL(30, 6),
  hyperliquid_eth_balance DECIMAL(30, 18),
  hyperliquid_usdt_balance DECIMAL(30, 6),
  eth_short_position_size DECIMAL(30, 18),
  eth_short_entry_price DECIMAL(10, 2),
  accrued_funding_fees DECIMAL(20, 8),
  health_factor DECIMAL(10, 4)
);
```

---

## 7. Monitoring & Alerts

### Key Metrics to Monitor

1. **NAV Stability**
   - Alert if NAV drops > 5% from previous day
   - Alert if calculated NAV seems anomalous

2. **Health Factor**
   - Alert if health factor < 1.5
   - Critical alert if health factor < 1.2

3. **Batch Processing**
   - Alert if batch not processed by 23:59
   - Alert if processBatch() transaction fails

4. **Funding Rates**
   - Alert if funding rate changes by > 0.05% per day

5. **Protocol Balances**
   - Alert if insufficient liquidity for pending redeems
   - Alert if idle cash > 30% of portfolio

### Alert Channels

- **Telegram**: Real-time alerts to operations team
- **Email**: Daily summary reports
- **PagerDuty**: Critical alerts (health factor, failed batches)

---

## 8. API Endpoints

The bot should expose the following API endpoints for frontend/analytics:

### GET `/api/nav/current`

Returns current NAV and portfolio breakdown.

```json
{
  "nav": 1.042,
  "timestamp": "2024-01-15T12:00:00Z",
  "totalAssets": 5420000.00,
  "totalLiabilities": 2100000.00,
  "totalKashSupply": 3200000.00,
  "breakdown": {
    "aaveETH": 2100000,
    "hyperliquidShort": 1400000,
    "stablecoins": 920000
  }
}
```

### GET `/api/nav/history?from=<timestamp>&to=<timestamp>`

Returns historical NAV data.

### GET `/api/batch/current`

Returns current batch cycle information.

```json
{
  "batchCycle": 19742,
  "totalMintUSD": 50000,
  "totalRedeemUSD": 30000,
  "netPositionUSD": 20000,
  "processed": false,
  "processesAt": "2024-01-15T23:50:00Z"
}
```

### GET `/api/user/:address/pending`

Returns user's pending mint/redeem requests.

### GET `/api/portfolio/allocation`

Returns current vs target allocation.

### GET `/api/metrics/apy`

Returns historical APY calculations.

---

## 9. Error Handling

### Common Errors and Recovery

#### Failed Transaction

```javascript
async function executeWithRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      if (i === maxRetries - 1) {
        await sendAlert('CRITICAL', `Transaction failed after ${maxRetries} retries`);
        throw error;
      }
      await delay(5000 * (i + 1)); // Exponential backoff
    }
  }
}
```

#### RPC Node Failure

```javascript
const providers = [
  new ethers.JsonRpcProvider(RPC_URL_1),
  new ethers.JsonRpcProvider(RPC_URL_2),
  new ethers.JsonRpcProvider(RPC_URL_3)
];

let currentProviderIndex = 0;

function getProvider() {
  return providers[currentProviderIndex];
}

async function switchProvider() {
  currentProviderIndex = (currentProviderIndex + 1) % providers.length;
  console.log(`Switched to RPC provider ${currentProviderIndex + 1}`);
}
```

#### Insufficient Gas

```javascript
async function estimateGasWithBuffer(tx) {
  const estimated = await tx.estimateGas();
  return estimated * 120n / 100n; // 20% buffer
}
```

---

## 10. Deployment & Operations

### Environment Variables

```bash
# Blockchain
RPC_URL=https://mainnet.infura.io/v3/...
CHAIN_ID=1
PRIVATE_KEY=0x...

# Contracts
KASH_YIELD_ADDRESS=0x...
AAVE_POOL_ADDRESS=0x...
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=kashyield
DB_USER=bot
DB_PASSWORD=...

# Monitoring
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
SENTRY_DSN=...

# Configuration
BATCH_PROCESSING_TIME=23:50
```

### Running the Bot

```bash
# Install dependencies
npm install

# Run database migrations
npm run migrate

# Start bot
npm run start

# Run in development mode with auto-reload
npm run dev
```

### Docker Deployment

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["node", "src/index.js"]
```

---

## 11. Security Considerations

### Private Key Management

- Store private keys in AWS Secrets Manager or HashiCorp Vault
- Use hardware wallet for owner operations
- Implement multi-sig for critical functions

### Rate Limiting

- Implement rate limits for API endpoints
- Monitor for unusual activity patterns

### Audit Trail

- Log all actions to immutable storage
- Store transaction hashes for all on-chain operations
- Regular security audits of bot code

---

## Summary

The off-chain bot is the operational backbone of the KashYield protocol, responsible for:

1. ✅ Calculating and updating NAV once daily during batch processing
2. ✅ Processing daily batches at 23:50 UTC
3. ✅ Executing protocol interactions (Aave, Hyperliquid)
4. ✅ Rebalancing portfolio to maintain target allocation
5. ✅ Storing historical data for analytics
6. ✅ Providing API for frontend integration
7. ✅ Monitoring health metrics and sending alerts

The bot ensures capital efficiency through batch settlement while maintaining accurate NAV tracking for users.
