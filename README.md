# KashYield - Enhanced Yield Strategy Protocol

A capital-efficient yield strategy protocol. Users deposit ETH (and later wBTC via a separate product) and receive KASH tokens representing their share of the portfolio. NAV-based pricing, daily batch settlement, Hyperliquid (delta-neutral) and Aave integration.

## 🎯 Key Features

- **ETH product (live)**: Mint KASH with ETH; redeem KASH for ETH, wETH, or wBTC. wBTC mint coming with KashYieldBTC.
- **NAV-based pricing**: KASH priced at current Net Asset Value.
- **Daily batch settlement**: Two-phase `processBatch()` (23:50–23:59 UTC): Phase 1 (Chainlink valuation, batch math), owner/bot Aave/HL + `updateNAV()` + `markBatchOpsDone()`, Phase 2 (distribute KASH and payouts). No user claim step.
- **Hyperliquid**: Delta-neutral yield via short positions (owner/bot).
- **Aave**: Lending/borrowing (owner/bot).

## 📋 Architecture

### Smart contracts (KashYieldETH)

- **KashYieldETH.sol** – Main protocol: `requestMint()`, `requestRedeem()`, `processBatch()` (two-phase), Aave/Hyperliquid owner functions. Chainlink used in Phase 1 for mint valuation.
- **KashTokenEth** – ERC20 (KASH), mint/burn by KashYieldETH only.

| Aspect | Behavior |
|--------|----------|
| Mint valuation | Phase 1 via Chainlink (`getEthPrice()`); no `setMintValuation()` |
| NAV | Owner/bot calls `updateNAV()` after Aave/HL, before `markBatchOpsDone()`; Phase 2 uses `currentNAV` |
| Distribution | Phase 2 mints KASH to minters, sends tokens to redeemers; no user claim |
| Time window | `processBatch()` is `onlyProcessingWindow` (23:50–23:59 UTC) |
| Hyperliquid | `setHyperliquid(address)`; HL calls owner-only |

**Owner config (no redeploy):** `setAavePool`, `setHyperliquid`, `setFeeBps`, `pause`/`unpause`.

### Off-chain bot

1. **Processing window (23:50–23:59 UTC)**: Call `processBatch()` (or use Chainlink Automation).
2. **Between Phase 1 and Phase 2**: Run Aave/Hyperliquid ops, then `updateNAV(newNAV)`, then `markBatchOpsDone()`.
3. **After batch**: React to `ProtocolInteraction("NET_MINT_ETH_DEPLOY", ...)` (and net redeem) to deploy/withdraw capital. See [docs/OFFCHAIN_BOT_SPEC.md](docs/OFFCHAIN_BOT_SPEC.md) and [bot/CHECKLIST.md](bot/CHECKLIST.md).

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
```

Create `frontend/.env.local` with `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (get from https://cloud.walletconnect.com/). Then:

```bash
npm run dev
```

Open http://localhost:3000. Root `/` is the landing page; `/app` is the mint/redeem app. Contract addresses live in `frontend/lib/contracts/addresses.ts` (update after deploy; see [DEPLOYMENT.md](DEPLOYMENT.md)).

## 💡 How It Works

### For Users

1. **Deposit (Mint)** – Send ETH or approve wETH and call `requestMint()`. Requests are queued until the next batch.
2. **Batch** – During 23:50–23:59 UTC, bot calls `processBatch()`; Phase 1 (Chainlink valuation), owner runs Aave/HL and `updateNAV()` + `markBatchOpsDone()`, Phase 2 distributes KASH to minters.
3. **Redeem** – Approve KASH and call `requestRedeem(kashAmount)`. After the next batch, redeemers receive ETH (or chosen token).

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

(Owner configuration is listed in the Architecture section above.)

## 📁 Project Structure

```
yieldproduct/
├── contracts/
│   ├── KashYieldETH.sol        # Main protocol (ETH product)
│   ├── MockHyperliquid.sol     # Mock HL for testing
│   └── ...
├── scripts/                    # Deploy and config scripts
├── test/
├── docs/
│   ├── OFFCHAIN_BOT_SPEC.md    # Bot specification
│   ├── HYPERLIQUID-INTEGRATION.md
│   └── ...
├── bot/                        # Off-chain bot (batch, Aave/HL)
│   ├── src/batch/, ...
│   └── CHECKLIST.md
├── frontend/                   # Next.js 15 + wagmi + RainbowKit
│   ├── app/                    # App Router: page.tsx (landing), app/page.tsx (mint/redeem)
│   ├── components/            # MintForm, RedeemForm, StatsCard, StatusIndicator, ...
│   └── lib/contracts/          # addresses.ts, kashYieldABI, kashTokenABI
├── DEPLOYMENT.md               # Deployment checklist
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

- **Frontend**: Live on Arbitrum Sepolia. Landing at `/`, app at `/app`. Mint (ETH), redeem (ETH/wETH/wBTC), stats (NAV, deposits from chain events, KASH balance), time-window status. See **Frontend** section below for setup and details.
- **Contracts**: KashYieldETH and KashTokenEth. Addresses are in `frontend/lib/contracts/addresses.ts`; update after deploy (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- **Still needed**: Owner must call `setHyperliquid(adapter)` for HL (e.g. MockHyperliquid on testnet; see [docs/HYPERLIQUID-INTEGRATION.md](docs/HYPERLIQUID-INTEGRATION.md)). Bot must run batch flow and react to `ProtocolInteraction("NET_MINT_ETH_DEPLOY", ...)` (see [bot/CHECKLIST.md](bot/CHECKLIST.md)).

## 🌐 Frontend

- **Stack**: Next.js 15 (App Router), Tailwind, wagmi + viem + RainbowKit. Network: Arbitrum Sepolia.
- **Features**: Mobile-first UI, wallet connect, mint KASH (ETH), redeem (ETH/wETH/wBTC), real-time NAV and deposits (from chain events), KASH balance, time-window status.
- **Contract addresses**: Set in `frontend/lib/contracts/addresses.ts` (`CONTRACTS.kashYieldEth`, `CONTRACTS.kashTokenEth`, tokens, oracles). Update when you deploy (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- **Mint flow**: Select ETH → enter amount → approve if needed → submit mint → wait for batch (KASH in Phase 2). **Redeem**: Select output token → enter KASH → approve → submit → wait for batch.
- **Time windows**: User window 00:00–23:50 UTC (requests); processing 23:50–23:59 UTC (`processBatch()`).
- **Build**: `cd frontend && npm run build && npm start`. **Deploy**: e.g. `vercel` or Docker (see [DEPLOYMENT.md](DEPLOYMENT.md) for full checklist).
- **Troubleshooting**: Use Arbitrum Sepolia; set WalletConnect project ID in `.env.local`; ensure user window for mint/redeem; check addresses in `lib/contracts/addresses.ts`. Testnet ETH: [Alchemy Arbitrum Sepolia faucet](https://www.alchemy.com/faucets/arbitrum-sepolia).

## 📄 License

UNLICENSED

## 🤝 Contributing

This is a private project. Contact the owner for contribution guidelines.

## 📞 Contact

For questions or support, please contact the project maintainer.

---

**⚠️ Disclaimer**: This protocol is in development and has not been audited. Do not use with real funds until proper audits are completed.
