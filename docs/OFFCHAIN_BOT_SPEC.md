# Off-Chain Bot Specification for KashYield

> **⚠️ Partially outdated.** The **current** contract does **not** use `setMintValuation()` or a separate claim step. Batch flow is: during 23:50–23:59 UTC call `processBatch()` (which values mints via Chainlink, settles redeems, and distributes in one tx). The bot should (1) call `processBatch()` in the processing window (or use Chainlink Automation) and (2) react to `ProtocolInteraction("NET_MINT" | "NET_REDEEM")` events for capital deployment. NAV formulas and protocol interaction *ideas* (Aave, Hyperliquid) still apply; the **timeline and step-by-step below** (e.g. “Call setMintValuation”) reflect the old flow. See `frontend/README.md` for current status.

## Overview

The off-chain bot is responsible for calculating the Net Asset Value (NAV), processing batch settlements, rebalancing the portfolio, and storing historical data. This document outlines the bot's responsibilities, calculation formulas, and operational procedures.

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

## 2. Batch Processing Workflow

### Daily Timeline

| Time (UTC) | Event | Bot Action |
|------------|-------|------------|
| 00:00 - 23:49 | User Window | Monitor mint/redeem requests |
| 23:50 | Processing Start | Calculate NAV and value all deposits |
| 23:50 - 23:52 | Valuation | Call `setMintValuation()` for each mint request |
| 23:52 - 23:55 | NAV Update | Call `updateNAV()` with calculated portfolio value |
| 23:55 - 23:57 | Execution | Execute protocol interactions |
| 23:57 - 23:59 | Settlement | Call `processBatch()` on-chain |
| 00:00 | Distribution | Tokens available for claiming |

### Processing Steps

#### Step 1: Value All Mint Requests (23:50 - 23:52)

```javascript
// Get all users who requested mints for yesterday
const batchCycle = currentDay - 1;
const mintUsers = await contract.batchMintUsers(batchCycle);

// For each user, calculate USD value of their deposit
for (const user of mintUsers) {
  const request = await contract.getPendingMintRequest(user, batchCycle);
  
  // Get real-time price for the deposited token
  const price = await getPriceForToken(request.tokenIn);
  const amountInUSD = calculateUSDValue(request.amountIn, request.tokenIn, price);
  
  // Set the valuation on-chain
  await contract.setMintValuation(user, batchCycle, amountInUSD);
}
```

#### Step 2: Calculate Portfolio NAV (23:50 - 23:52)

```javascript
// Calculate total portfolio value
const portfolioValue = await calculatePortfolioValue();
const kashSupply = await kashToken.totalSupply();
const newNAV = portfolioValue / kashSupply;

// Get mint/redeem totals
const batchInfo = await contract.getBatchInfo(batchCycle);
const netPositionUSD = batchInfo.totalMintUSD - batchInfo.totalRedeemUSD;
```

#### Step 3: Update NAV (23:52 - 23:55)

```javascript
// Update on-chain NAV
const navTx = await contract.updateNAV(ethers.parseEther(newNAV.toString()));
await navTx.wait();
console.log(`NAV updated to ${newNAV}`);
```

#### Step 4: Determine Actions (23:52 - 23:55)

```javascript
if (netPositionUSD > 0) {
  // Net mints: Deploy new capital
  actions = determineDeploymentStrategy(netPositionUSD);
} else if (netPositionUSD < 0) {
  // Net redeems: Free up capital
  actions = determineWithdrawalStrategy(Math.abs(netPositionUSD));
} else {
  // No net change: Only rebalancing if needed
  actions = checkRebalancingNeeds();
}
```

#### Step 5: Execute Protocol Interactions (23:55 - 23:57)

Execute actions determined in step 2:

```javascript
for (const action of actions) {
  switch (action.type) {
    case 'DEPOSIT_AAVE':
      await contract.depositToAave(action.asset, action.amount);
      break;
    case 'WITHDRAW_AAVE':
      await contract.withdrawFromAave(action.asset, action.amount);
      break;
    case 'BORROW_AAVE':
      await contract.borrowFromAave(action.asset, action.amount);
      break;
    case 'REPAY_AAVE':
      await contract.repayToAave(action.asset, action.amount);
      break;
    case 'DEPOSIT_HYPERLIQUID':
      await contract.depositToHyperliquid(action.amount);
      break;
    case 'OPEN_PERP':
      await contract.openPerpPosition(action.symbol, action.size, action.isLong);
      break;
    case 'CLOSE_PERP':
      await contract.closePerpPosition(action.symbol);
      break;
  }
  
  await delay(1000); // Wait between transactions
}
```

#### Step 6: Call processBatch() (23:57 - 23:59)

```javascript
const tx = await contract.processBatch();
await tx.wait();
console.log(`Batch ${batchCycle} processed successfully`);
```

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
