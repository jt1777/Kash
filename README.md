# KashYield - Simplified Yield Strategy Protocol

A capital-efficient yield strategy protocol that allows users to deposit multiple assets (ETH, wETH, wBTC) and receive Kash tokens representing their share of the portfolio.

## 🎯 Key Features

- **Multi-Asset Support**: Deposit and redeem in ETH, wETH, or wBTC.
- **NAV-Based Pricing**: Kash tokens are priced at current Net Asset Value (NAV)
- **Daily Batch Settlement**: Capital-efficient processing at 23:50 UTC daily
- **Daily NAV Updates**: NAV updated once daily during batch processing
- **Hyperliquid Integration**: Perpetual futures
- **Aave Integration**: Lending and borrowing for yield generation and leverage

## 📋 Architecture

### Smart Contracts

1. **KashYield.sol** - Main protocol contract
   - User functions: `requestMint()`, `requestRedeem()` (no claim step; distribution happens inside `processBatch()`)
   - Batch processing: `processBatch()` (values mints via Chainlink, settles redemptions, mints/burns KASH, distributes in one tx)
   - Protocol interactions: Aave and Hyperliquid functions (owner/bot)
   - NAV management: `updateNAV()` (owner); batch uses `currentNAV`

2. **KashToken.sol** - ERC20 token (Kash)
   - Name: "Kash"
   - Symbol: "KASH"
   - Mintable/Burnable by KashYield contract only

### Off-Chain Bot

- Calculates NAV during daily batch processing
- Processes daily batches at 23:50 UTC
- Updates on-chain NAV after batch settlement
- Executes rebalancing operations at batch processing time or throughout the day as necessary
- Stores historical data
- Provides API for frontend

## 🕐 Time Windows

| Time (UTC) | Window | Actions Allowed |
|------------|--------|-----------------|
| 00:00 - 23:49 | User Window | Users can `requestMint()` and `requestRedeem()` |
| 23:50 - 23:59 | Processing Window | Keeper or bot calls `processBatch()`; no user actions |
| 00:00+ | — | Minters receive KASH and redeemers are returned their assets plus any net yield (distributed in `processBatch()`) |

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Deploy Contracts

```bash
# Compile contracts
npx hardhat compile

# Deploy to local network
npx hardhat run scripts/deploy.js --network localhost

# Deploy to testnet (e.g., Sepolia)
npx hardhat run scripts/deploy.js --network sepolia
```

### Run Tests

```bash
# Run all tests
npx hardhat test

# Run specific test file
npx hardhat test test/KashYieldTest.v2.js
```

### Start Off-Chain Bot

See [docs/OFFCHAIN_BOT_SPEC.md](docs/OFFCHAIN_BOT_SPEC.md) for detailed bot setup.

```bash
cd bot
npm install
npm run start
```

## 💡 How It Works

### For Users

1. **Deposit (Mint)**
   ```solidity
   // Deposit ETH
   kashYield.requestMint(address(0), 0, { value: 1 ether });
   
   // Deposit USDT
   usdt.approve(kashYield, 1000e6);
   kashYield.requestMint(usdtAddress, 1000e6);
   ```

2. **Wait for Batch Processing**
   - Requests are queued during the day
   - During 23:50–23:59 UTC a keeper or bot calls `processBatch()`
   - Contract values deposits via Chainlink oracles, settles redeems, mints KASH to minters, sends tokens to redeemers (no separate claim)

4. **Redeem**
   ```solidity
   kash.approve(kashYield, 1000 ether);
   kashYield.requestRedeem(1000 ether, address(0)); // Redeem for ETH
   ```

### NAV Calculation (Performed by Off-Chain Bot)

```
NAV = (Total Assets - Total Liabilities) / Total Kash Supply

Assets (calculated by bot using real-time prices):
+ Aave deposits (ETH, wBTC, USDT, USDC)
+ Hyperliquid spot wallet
+ Perp position value
+ Accrued yields and funding

Liabilities (calculated by bot):
- Aave borrows (USDT, USDC)
- Accrued interest
- Unrealized losses

The bot calculates NAV daily at 23:50 UTC using real on-chain data and price feeds,
then updates the smart contract with the new NAV value.
```

## 📊 Target Portfolio Allocation

- **40%** - ETH deposited in Aave (earning yield)
- **35%** - ETH short hedge on Hyperliquid (earning funding)
- **20%** - Stablecoin reserves (USDT/USDC)
- **5%** - Operational buffer

## 🔐 Security Features

### Daily NAV Updates

```solidity
// Bot updates NAV once daily during batch processing
kashYield.updateNAV(1.05 ether); // $1.05
```

NAV is calculated based on real portfolio value (assets - liabilities) and updated once per day during the processing window (23:50-23:59 UTC).

### Access Control

- Owner-only functions for protocol interactions
- Permissionless batch processing (anyone can call during window)
- Emergency functions for critical situations

### Auditing

- [ ] Smart contract audit pending
- [ ] Bot security review pending
- [ ] Penetration testing pending

## 📁 Project Structure

```
yieldproduct/
├── contracts/
│   ├── KashYield.sol          # Main protocol contract
│   ├── KashToken.sol           # Kash ERC20 token
│   ├── MockAaveV3.sol          # Mock Aave for testing
│   └── MockChainlinkPriceFeed.sol
├── scripts/
│   └── deploy.js               # Deployment script
├── test/
│   ├── KashYieldTest.v2.js     # Comprehensive test suite
│   ├── KashYieldTest.js        # Original tests (deprecated)
│   └── data/
├── docs/
│   └── OFFCHAIN_BOT_SPEC.md    # Bot documentation
├── bot/                         # Off-chain bot (to be implemented)
├── deployments/                 # Deployment records (gitignored)
├── hardhat.config.js
└── package.json
```

## 🧪 Testing

The test suite covers:

- ✅ Multi-asset deposits (ETH, USDT, USDC, wETH, wBTC)
- ✅ Redemptions in different assets
- ✅ Batch processing and settlement
- ✅ Token claiming after batch
- ✅ Daily NAV updates
- ✅ Time window enforcement
- ✅ Protocol interactions (Aave, Hyperliquid)
- ✅ Edge cases and error handling

Run tests:
```bash
npx hardhat test test/KashYieldTest.v2.js
```

## 🔄 Comparison: Old vs New

| Feature | Old Contract | New Contract |
|---------|-------------|--------------|
| Lines of Code | 798 | ~450 |
| Time Windows | 3 (complex) | 2 (simple) |
| Fee Distribution | On-chain | Off-chain (via NAV) |
| Historical Data | On-chain storage | Off-chain database |
| Supported Assets | ETH only | ETH, wETH, wBTC, USDT, USDC |
| Batch Cycles | Complex | Simple daily |
| GMX Integration | Yes | Replaced with Hyperliquid |

### Removed Complexity

- ❌ On-chain fee distribution across users
- ❌ Historical metrics storage (daily snapshots)
- ❌ Complex batch contributor tracking
- ❌ Multiple processing steps (3→1)
- ❌ Eligible cycle day logic
- ❌ User share calculations on-chain

### Added Features

- ✅ Multi-asset support
- ✅ Daily NAV calculation and updates
- ✅ Simplified batch settlement
- ✅ Hyperliquid integration ready
- ✅ Better capital efficiency
- ✅ Cleaner architecture

## 🛠️ Development

### Compile Contracts

```bash
npx hardhat compile
```

### Run Local Node

```bash
npx hardhat node
```

### Deploy to Testnet

```bash
npx hardhat run scripts/deploy.js --network sepolia
```

## 📝 TODO

- [ ] Update smart contract and implement Aave and Hyperliquid integration (currently placeholder)
- [ ] Build off-chain bot
- [ ] Polish up frontend interface
- [ ] Smart contract audit
- [ ] Testnet launch and testing (in progress)
- [ ] Mainnet deployment

## 📄 License

UNLICENSED

## 🤝 Contributing

This is a private project. Contact the owner for contribution guidelines.

## 📞 Contact

For questions or support, please contact the project maintainer.

---

**⚠️ Disclaimer**: This protocol is in development and has not been audited. Do not use with real funds until proper audits are completed.
