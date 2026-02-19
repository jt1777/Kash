# KashYield - Simplified Yield Strategy Protocol

A capital-efficient yield strategy protocol that allows users to deposit multiple assets (ETH, wETH, wBTC) and receive Kash tokens representing their share of the portfolio.

## 🎯 Key Features

- **Multi-Asset Support**: Deposit and redeem in ETH, wETH, or wBTC.
- **NAV-Based Pricing**: Kash tokens are priced at current Net Asset Value (NAV)
- **Daily Batch Settlement**: Capital-efficient processing at 23:50 UTC daily
- **Hyperliquid Integration**: Perpetual futures for delta-neutral yield
- **Aave Integration**: Lending and borrowing for yield generation

## 📋 Architecture

### Smart Contracts

1. **KashYield.sol** - Main protocol contract
   - User functions: `requestMint()`, `requestRedeem()`
   - Batch processing: `processBatch()` (values mints via Chainlink, settles redemptions, mints/burns KASH, distributes in one tx)
   - Protocol interactions: Aave and Hyperliquid functions (owner/bot only)

2. **KashToken.sol** - ERC20 token (Kash)
   - Mintable/Burnable by KashYield contract only

### Off-Chain Bot

The bot handles the critical capital deployment operations:

1. **During batch processing (23:50-23:59 UTC)**:
   - Calculate net position (mint vs redeem USD)
   - Call `processBatch()` during the processing window
   - React to `ProtocolInteraction("NET_MINT" | "NET_REDEEM")` events

2. **Capital Deployment** (on NET_MINT):
   - Take net ETH amount X to be minted
   - Send wETH to Aave
   - Borrow 70% of X total worth of minted ETH as USDC
   - Send USDC to Hyperliquid as collateral
   - Open 1.7X short of wETH to earn funding

3. **Capital Withdrawal** (on NET_REDEEM):
   - Reverse the trade starting with Hyperliquid unwind
   - Return Aave borrow
   - Withdraw wETH
   - Payout original amount of ETH plus yield if any

4. **Same flow applies for wBTC deposits**

## 🕐 Time Windows

| Time (UTC) | Window | Actions Allowed |
|------------|--------|-----------------|
| 00:00 - 23:49 | User Window | Users can `requestMint()` and `requestRedeem()` |
| 23:50 - 23:59 | Processing Window | Bot calls `processBatch()`; no user actions |
| 00:00+ | Distribution | Minters receive KASH and redeemers get assets |

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

# Deploy to testnet (e.g., Arbitrum Sepolia)
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

See [docs/OFFCHAIN_BOT_SPEC.md](docs/OFFCHAIN_BOT_SPEC.md) for detailed bot specification.

```bash
cd bot
npm install
cp .env.example .env
# Edit .env with your contract addresses
npm run build
npm start
```

### Start Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local
# Add your WalletConnect Project ID
npm run dev
```

## 💡 How It Works

### For Users

1. **Deposit (Mint)**
   ```solidity
   // Deposit ETH
   kashYield.requestMint(address(0), 0, { value: 1 ether });
   
   // Deposit wETH
   weth.approve(kashYield, 1 ether);
   kashYield.requestMint(wethAddress, 1 ether);
   ```

2. **Wait for Batch Processing**
   - Requests are queued during the day
   - During 23:50–23:59 UTC, the bot calls `processBatch()`
   - Contract values deposits via Chainlink oracles, settles redeems, mints KASH to minters, sends tokens to redeemers

3. **Redeem**
   ```solidity
   kash.approve(kashYield, 1000 ether);
   kashYield.requestRedeem(1000 ether, address(0)); // Redeem for ETH
   ```

### NAV Calculation

```
NAV = (Total Assets - Total Liabilities) / Total Kash Supply

Assets:
+ Aave deposits (ETH, wBTC)
+ Hyperliquid spot wallet
+ Perp position value
+ Accrued yields and funding

Liabilities:
- Aave borrows (USDC)
- Accrued interest
- Unrealized losses
```

## 📊 Target Portfolio Allocation

- **40%** - ETH deposited in Aave (earning yield)
- **35%** - ETH short hedge on Hyperliquid (earning funding)
- **20%** - Stablecoin reserves (USDC)
- **5%** - Operational buffer

## 🔐 Security Features

### Access Control

- Owner-only functions for protocol interactions (Aave, Hyperliquid)
- Permissionless batch processing (anyone can call during window)
- Emergency pause functions

### Configurable Parameters (Owner-Only)

| Parameter | Function | Notes |
|-----------|----------|-------|
| Aave pool | `setAavePool(address)` | Switch to mock or different Aave pool |
| Hyperliquid adapter | `setHyperliquid(address)` | Set HL bridge/adapter |
| Token addresses | `setTokenAddresses(weth, wbtc, usdt, usdc)` | Update supported tokens |
| Oracle per token | `setOracle(token, oracle)` | Chainlink feed for a token |
| Protocol fee | `setFeeBps(uint256)` | 0–100 (0–1%); default 3 (0.03%) |
| Pause | `pause()` / `unpause()` | Emergency pause |

## 📁 Project Structure

```
yieldproduct/
├── contracts/
│   ├── KashYield.sol          # Main protocol contract
│   ├── KashToken.sol           # Kash ERC20 token
│   ├── MockAaveV3.sol          # Mock Aave for testing
│   └── MockHyperliquid.sol     # Mock Hyperliquid for testing
├── scripts/
│   └── deploy.js               # Deployment script
├── test/
│   ├── KashYieldTest.v2.js     # Comprehensive test suite
│   └── KashYield.Hyperliquid.test.js
├── docs/
│   ├── ARCHITECTURE_CHANGES.md # Historical architecture notes
│   └── OFFCHAIN_BOT_SPEC.md    # Detailed bot specification
├── bot/                        # Off-chain bot
│   ├── src/
│   │   ├── batch/              # Batch processing logic
│   │   ├── contracts/          # Contract ABIs
│   │   ├── scripts/            # Utility scripts
│   │   └── utils/              # Utilities
│   ├── package.json
│   └── README.md
├── frontend/                   # Next.js frontend
│   ├── app/
│   ├── components/
│   └── lib/
├── hardhat.config.js
└── package.json
```

## 🧪 Testing

The test suite covers:

- ✅ Multi-asset deposits (ETH, wETH, wBTC)
- ✅ Redemptions in different assets
- ✅ Batch processing and settlement
- ✅ Daily NAV updates
- ✅ Time window enforcement
- ✅ Protocol interactions (Aave, Hyperliquid)

Run tests:
```bash
npx hardhat test test/KashYieldTest.v2.js
```

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

## 📝 Current Status

### Deployed Contracts (Arbitrum Sepolia)

- **KashYield**: `0x4C3910E93aB0c5983c6DEE003749485E525E5Db7`
- **KashToken**: `0x3461e725Fb77ead9a4FD22A10e0f0c9373156297`

### Missing Configurations

⚠️ **The deployed contract has NOT been updated with:**
- Aave pool address (mainnet: `0x794a61358D6845594F94dc1DB02A252b5b4814aD`)
- Hyperliquid adapter address

The owner must call:
- `setAavePool(address)` 
- `setHyperliquid(address)`

### Still Needed

1. **Hyperliquid integration**: Contract has `hyperliquidAddress` (currently unset). Owner must call `setHyperliquid(adapter)` so the bot can use `depositToHyperliquid`, `withdrawFromHyperliquid`, `openShort`, `closeShort`, etc.

2. **Bot batch actions**: Bot needs to:
   - Call `processBatch()` during the processing window (23:50–23:59 UTC)
   - React to `ProtocolInteraction("NET_MINT", ...)` / `("NET_REDEEM", ...)` by moving capital

3. **Chainlink Automation (optional)**: Contract exposes `checkUpkeep` / `performUpkeep` so a keeper can call `processBatch()` at 23:50 UTC without running the bot manually.

## 📄 License

UNLICENSED

## 🤝 Contributing

This is a private project. Contact the owner for contribution guidelines.

## 📞 Contact

For questions or support, please contact the project maintainer.

---

**⚠️ Disclaimer**: This protocol is in development and has not been audited. Do not use with real funds until proper audits are completed.
