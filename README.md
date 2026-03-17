# KashYield - Enhanced Yield Strategy Protocol

A capital-efficient yield strategy protocol. Users deposit ETH or wBTC and receive KASH tokens representing their share of the portfolio. NAV-based pricing, configurable batch settlement cycles, multi-exchange perpetual hedging via an adapter pattern, and Aave lending integration.

## 🎯 Key Features

- **Two products**: `KashYieldETH` (ETH/wETH deposits → KASH-ETH) and `KashYieldBtc` (wBTC deposits → KASH-BTC). Both run on Arbitrum.
- **NAV-based pricing**: KASH priced at current Net Asset Value, updated by the owner/bot after each cycle's capital operations.
- **Configurable batch cycle**: Default 24-hour cycle (86400 s). Owner calls `setCycleDurationSeconds(uint256)` to shorten cycles for testing (e.g. 3600 s = 1-hour cycles) or extend them for production.
- **Multi-exchange adapter pattern**: Perpetual exchange integrations (Hyperliquid, GMX, Aster DEX) are deployed as independent adapter contracts implementing `IPerpExchange`. The main contract holds a registry (`perpExchanges` mapping) and routes calls to the active adapter. New exchanges can be added without redeploying the main contract.
- **Spot DEX integration**: An `ISpotDex` adapter (e.g. UniswapV3Adapter) enables on-chain asset ↔ USDC swaps for redemption rebalancing, with configurable slippage (`maxSwapSlippageBps`).
- **48-hour timelock on exchange switching**: Changing the active perp exchange requires `proposeActivePerpExchange()` followed by `confirmActivePerpExchange()` after a 48-hour delay, preventing rushed governance changes.
- **Security**: `ReentrancyGuard` on all user-facing functions, two-step ownership transfer (`transferOwnership` / `acceptOwnership`), and custom Solidity errors (smaller bytecode, cheaper reverts).
- **Aave**: Lending/borrowing for capital deployment (owner/bot).

## 📋 Architecture

### Smart contracts

| Contract | Role |
|----------|------|
| `KashYieldETH.sol` | Main ETH product: `requestMint()`, `requestRedeem()`, `processBatch()`, Aave/exchange owner functions |
| `KashYieldBtc.sol` | Main BTC product: identical flow, wBTC as the underlying asset |
| `KashTokenEth` / `KashTokenBtc` | ERC-20 KASH tokens, minted/burned by the respective KashYield contract only |
| `interfaces/IPerpExchange.sol` | Common interface for all perp exchange adapters |
| `interfaces/ISpotDex.sol` | Common interface for spot DEX adapters |
| `adapters/HyperliquidAdapter.sol` | `IPerpExchange` implementation for Hyperliquid |
| `adapters/GMXAdapter.sol` | `IPerpExchange` implementation for GMX V2 (Arbitrum) |
| `adapters/AsterAdapter.sol` | `IPerpExchange` implementation for Aster DEX |
| `adapters/UniswapV3Adapter.sol` | `ISpotDex` implementation for Uniswap V3 spot swaps |

**Key contract behaviours:**

| Aspect | Behaviour |
|--------|-----------|
| Batch cycle | Configurable via `setCycleDurationSeconds(uint256)` (default 86400 s = 24 h) |
| Mint valuation | Phase 1 via Chainlink price feed |
| NAV | Owner/bot calls `updateNAV()` after capital ops, before `markBatchOpsDone()`; Phase 2 uses `currentNAV` |
| Distribution | Phase 2 mints KASH to minters, sends assets to redeemers; no user claim step |
| Exchange registry | `perpExchanges[string] → address`; `activePerpExchange` routes all exchange calls |
| Exchange switching | `proposeActivePerpExchange(key)` starts 48-hour timelock; `confirmActivePerpExchange()` activates it |
| Spot swaps | `swapForUsdc()` / `swapFromUsdc()` call the registered `spotDexAddress` (UniswapV3Adapter) |
| Ownership | Two-step: `transferOwnership()` + `acceptOwnership()` |

**Owner config (no redeploy):** `setAavePool`, `setHyperliquid`, `setCycleDurationSeconds`, `setFeeBps`, `setSpotDex`, `setMaxSwapSlippageBps`, `pause`/`unpause`, `proposeActivePerpExchange`/`confirmActivePerpExchange`.

### Off-chain bot

1. **Processing window** (last 10 minutes of each cycle by default): Call `processBatch()` (or use Chainlink Automation).
2. **Between Phase 1 and Phase 2**: Run Aave/exchange ops, then `updateNAV(newNAV)`, then `markBatchOpsDone()`.
3. **After batch**: React to `ProtocolInteraction("NET_MINT_ETH_DEPLOY", ...)` / `("NET_REDEEM", ...)` to deploy/withdraw capital. See [docs/OFFCHAIN_BOT_SPEC.md](docs/OFFCHAIN_BOT_SPEC.md) and [bot/CHECKLIST.md](bot/CHECKLIST.md).

## 🕐 Batch Cycle and Time Windows

The cycle length is set by `cycleDurationSeconds` (default 86400 s = 24 hours). Within each cycle:

| Phase of cycle | Window | Actions Allowed |
|----------------|--------|-----------------|
| 0 s → `USER_WINDOW_END` | User Window | Users can `requestMint()` and `requestRedeem()` |
| `PROCESSING_WINDOW_START` → end | Processing Window | Bot calls `processBatch()`; no user actions |
| After Phase 2 | Distribution | Minters receive KASH, redeemers receive assets |

**Shortening cycles for testing:** Call `setCycleDurationSeconds(3600)` to switch to 1-hour cycles. Restore to `86400` for production. The cycle key (`currentBatchCycle`) is `block.timestamp / cycleDurationSeconds`, so all batch state is automatically scoped to the new cycle length.

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Deploy Contracts

```bash
# Compile contracts
npx hardhat compile

# Deploy ETH product to Arbitrum Sepolia
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia

# Deploy BTC product to Arbitrum Sepolia
npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumSepolia

# Deploy HyperliquidAdapter (run once per product; see docs/DEPLOYMENT.md for env vars)
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia

# Register adapter + start 48h timelock
npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia

# Confirm active exchange after 48 hours
npx hardhat run scripts/confirmActivePerpExchange.js --network arbitrumSepolia
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full step-by-step checklist.

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

1. **Deposit (Mint)** – Send ETH/wETH (ETH product) or approve wBTC (BTC product) and call `requestMint()`. Requests are queued until the next batch cycle.
2. **Batch** – At the end of each cycle (configurable, default 24 h), the bot calls `processBatch()`; Phase 1 (Chainlink valuation), owner/bot runs Aave/exchange ops and `updateNAV()` + `markBatchOpsDone()`, Phase 2 distributes KASH to minters.
3. **Redeem** – Approve KASH and call `requestRedeem(kashAmount)`. After the next batch, redeemers receive ETH or wBTC.

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

## 🔐 Security Features

- **ReentrancyGuard**: All user-facing state-changing functions (`requestMint`, `requestRedeem`, `processBatch`) are protected against reentrancy.
- **Two-step ownership** (`Ownable2Step`-equivalent): Ownership transfers require the new owner to explicitly accept, preventing accidental transfers to wrong addresses.
- **48-hour timelock on exchange switching**: `proposeActivePerpExchange` starts a 48-hour countdown; `confirmActivePerpExchange` must be called after it expires. This prevents a compromised owner key from instantly redirecting funds to a malicious adapter.
- **Owner-only protocol interactions**: Aave deposits/borrows, exchange calls, and spot swaps are all `onlyOwner`.
- **Configurable slippage**: `maxSwapSlippageBps` caps the price impact on any Uniswap swap performed by the contract.
- **Emergency pause**: `pause()`/`unpause()` halts all user activity.
- **Custom errors**: All `require` strings replaced with typed Solidity errors — smaller bytecode and cheaper reverts.
- **EIP-170 compliant**: Both main contracts compile well under the 24,576-byte limit with `optimizer: { runs: 1 }` and `viaIR: true`.

## 📁 Project Structure

```
yieldproduct/
├── contracts/
│   ├── KashYieldETH.sol            # Main ETH product
│   ├── KashYieldBtc.sol            # Main BTC product
│   ├── interfaces/
│   │   ├── IPerpExchange.sol       # Common interface for perp exchange adapters
│   │   └── ISpotDex.sol            # Common interface for spot DEX adapters
│   ├── adapters/
│   │   ├── HyperliquidAdapter.sol  # IPerpExchange → Hyperliquid
│   │   ├── GMXAdapter.sol          # IPerpExchange → GMX V2
│   │   ├── AsterAdapter.sol        # IPerpExchange → Aster DEX
│   │   └── UniswapV3Adapter.sol    # ISpotDex → Uniswap V3
│   ├── MockHyperliquid.sol         # Mock HL for testing
│   ├── MockPerpExchange.sol        # Universal mock IPerpExchange for tests
│   └── ...
├── scripts/
│   ├── deploy-kashyieldbtc.js          # Deploy BTC product
│   ├── deploy-arbitrum-sepolia.js      # Deploy ETH product
│   ├── deploy-hyperliquid-adapter.js   # Deploy HyperliquidAdapter
│   ├── setHyperliquid.js               # Register adapter + propose activation
│   ├── confirmActivePerpExchange.js    # Confirm active exchange after 48h timelock
│   └── ...
├── test/
├── docs/
│   ├── DEPLOYMENT.md               # Full deployment guide
│   ├── OFFCHAIN_BOT_SPEC.md        # Bot specification
│   └── ...
├── bot/                            # Off-chain bot (batch, Aave/exchange)
│   ├── src/batch/batchProcessor.ts
│   └── README.md
├── frontend/                       # Next.js 15 + wagmi + RainbowKit
│   ├── app/
│   ├── components/
│   └── lib/contracts/addresses.ts
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
# ETH product
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia

# BTC product
npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumSepolia
```

## 📝 Current Status

- **Frontend**: Live on Arbitrum Sepolia. Landing at `/`, app at `/app`. Mint (ETH), redeem (ETH/wETH/wBTC), stats (NAV, deposits from chain events, KASH balance), time-window status.
- **Contracts**: `KashYieldETH`, `KashYieldBtc`, and their KASH tokens are deployed. Addresses are in `frontend/lib/contracts/addresses.ts`; update after each deploy (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- **Exchange adapters**: Deploy `HyperliquidAdapter` and register it via `setHyperliquid.js`, then confirm activation after the 48-hour timelock with `confirmActivePerpExchange.js`. GMX and Aster adapters are available but require mainnet addresses.
- **Spot DEX**: Deploy `UniswapV3Adapter` and set it on the contract via `setSpotDex(address)` to enable on-chain USDC ↔ asset swaps during redemptions.
- **Bot**: Runs the 5-step batch flow (`phase1` → `ops` → `nav` → `mark-done` → `phase2`). See [bot/README.md](bot/README.md) and [bot/CHECKLIST.md](bot/CHECKLIST.md).

## 🌐 Frontend

- **Stack**: Next.js 15 (App Router), Tailwind, wagmi + viem + RainbowKit. Network: Arbitrum Sepolia.
- **Features**: Mobile-first UI, wallet connect, mint KASH (ETH), redeem (ETH/wETH/wBTC), real-time NAV and deposits (from chain events), KASH balance, time-window status.
- **Contract addresses**: Set in `frontend/lib/contracts/addresses.ts` (`CONTRACTS.kashYieldEth`, `CONTRACTS.kashTokenEth`, tokens, oracles). Update when you deploy (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- **Mint flow**: Select ETH → enter amount → approve if needed → submit mint → wait for batch (KASH in Phase 2). **Redeem**: Select output token → enter KASH → approve → submit → wait for batch.
- **Time windows**: User window spans most of each cycle (requests); processing window is the last segment (`processBatch()`). Default cycle = 24 h; adjustable via `setCycleDurationSeconds`.
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
