# KashYield - Enhanced Yield Strategy Protocol

A capital-efficient yield strategy protocol. Users deposit ETH or wBTC and receive KASH tokens representing their share of the portfolio. NAV-based pricing, configurable batch settlement cycles, multi-exchange perpetual hedging via an adapter pattern, and Aave lending integration.

## 🎯 Key Features

- **Two products**: `KashYieldETH` (ETH/wETH deposits → KASH-ETH) and `KashYieldBtc` (wBTC deposits → KASH-BTC). Both run on Arbitrum.
- **NAV-based pricing**: KASH priced at current Net Asset Value, updated by the owner/bot after each cycle's capital operations.
- **Configurable batch cycle**: Default 24-hour cycle (86400 s). Owner calls `setCycleDurationSeconds(uint256)` to shorten cycles for testing (e.g. 3600 s = 1-hour cycles) or extend them for production.
- **ExchangeFacade**: Perp exchange registry and Hyperliquid write ops live in a separate `ExchangeFacade` contract (bytecode headroom). The vault holds `exchangeFacade` and forwards HL view calls; the bot calls HL deposits/shorts through the facade.
- **Merkle pull claims (redeems)**: Phase 2 commits a Merkle root of net redeem amounts; users call `claimRedeem(batchCycle, amount, proof)` to receive ETH/wBTC (gas paid by user). Mint payouts remain push-based in Phase 2.
- **Multi-exchange adapter pattern**: Perpetual adapters (`HyperliquidAdapter`, GMX, Aster) implement `IPerpExchange` and are registered on **ExchangeFacade** (`perpExchanges` mapping, `activePerpExchange`).
- **Spot DEX integration**: An `ISpotDex` adapter (e.g. UniswapV3Adapter) enables on-chain asset ↔ USDC swaps. The bot passes **`minOut`** into `swapForUsdc(amount, minOut)` / `swapFromUsdc(amount, minOut)` using DEX quotes and `maxSwapSlippageBps`.
- **24-hour timelock on adapter registration**: On **ExchangeFacade**, the *first* adapter is immediate; subsequent registrations use `setPerpExchange` / `setHyperliquid` proposal + `confirmPerpExchange` after the facade timelock. Switching active exchange is immediate via `setActivePerpExchange`.
- **Batch user caps**: `MAX_MINT_USERS` / `MAX_REDEEM_USERS` (500) enforced via active per-cycle counters (cancel-safe).
- **Security**: `ReentrancyGuard` on all user-facing functions, two-step ownership transfer (`transferOwnership` / `acceptOwnership`), and custom Solidity errors (smaller bytecode, cheaper reverts).
- **Aave**: Lending/borrowing for capital deployment (owner/bot).
- **Owner reserves**: On-chain USDC and native ETH / WBTC buffers the treasury can mark as **not** user NAV (`ownerUsdcReserve`, `ownerEthReserve` on ETH, `ownerWbtcReserve` on BTC), plus `coverUsdcShortfall` for the bot to draw reserved USDC into the working float. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## 📋 Architecture

### Smart contracts

| Contract | Role |
|----------|------|
| `KashYieldETH.sol` / `KashYieldBtc.sol` | Main vaults: mint/redeem requests, batch phases, Aave, spot swaps, `claimRedeem`, claim-reserve accounting |
| `ExchangeFacade.sol` | Perp registry + HL write ops (`depositToHyperliquid`, `openShort`, etc.); pulls USDC from vault |
| `KashTokenEth` / `KashTokenBtc` | ERC-20 KASH tokens, minted/burned by the respective KashYield contract only |
| `libraries/MerkleVerify.sol` | Sorted-pair Merkle verification for redeem claim proofs |
| `interfaces/IPerpExchange.sol` | Common interface for all perp exchange adapters |
| `interfaces/ISpotDex.sol` | Common interface for spot DEX adapters |
| `adapters/HyperliquidAdapter.sol` | `IPerpExchange` + ERC-1271 `isValidSignature` (owner-authorized HL REST when adapter is HL master) |
| `adapters/GMXAdapter.sol` | `IPerpExchange` implementation for GMX V2 (Arbitrum) |
| `adapters/AsterAdapter.sol` | `IPerpExchange` implementation for Aster DEX |
| `adapters/UniswapV3Adapter.sol` | `ISpotDex` implementation for Uniswap V3 spot swaps |

**Key contract behaviours:**

| Aspect | Behaviour |
|--------|-----------|
| Batch cycle | Configurable via `setCycleDurationSeconds(uint256)` (default 86400 s = 24 h) |
| Mint valuation | Phase 1 via Chainlink price feed |
| NAV | Bot calls `updateNAV()` before Phase 1 and after ops; `markBatchOpsDone(batchCycle, G)` locks gross redeem **G**; Phase 2 **mint** uses settlement `currentNAV` |
| Redeem distribution | Phase 2 commits Merkle root + `lockedClaim*` reserve; users **`claimRedeem`** for net wBTC/ETH (pull model) |
| Exchange registry | On **ExchangeFacade**: `perpExchanges`, `activePerpExchange`; vault `exchangeFacade` address |
| Adapter registration | On facade: first HL adapter immediate via `setHyperliquid`; later changes timelocked on facade |
| Spot swaps | `swapForUsdc(amount, minOut)` / `swapFromUsdc(amount, minOut)` via `spotDexAddress` |
| Ownership | Two-step: `transferOwnership()` + `acceptOwnership()` |

**Owner config (no redeploy):** `setExchangeFacade`, `setAavePool`, `setCycleDurationSeconds`, `setFeeBps`, `setSpotDex`, `setMaxSwapSlippageBps`, `pause`/`unpause`; perp registry on **ExchangeFacade** (`setHyperliquid`, `setActivePerpExchange`, etc.).

### Off-chain bot

1. **Processing window** (last 15 minutes of each cycle by default): The operator bot runs a five-step batch flow (`phase1` → `ops` → `nav` → `mark-done` → `phase2`) via `performUpkeep` and related calls.
2. **Ops between Phase 1 and Phase 2:** Target-state engine deploys or unwinds capital (Aave + Hyperliquid) before settlement NAV, **`markBatchOpsDone(batchCycle, G)`**, and Phase 2 distribution — not event-driven post-batch reactions.

Batch operator tooling (bot source, ops scripts, runbooks) lives in a **private repository** (`kash-ops`), separate from this public contracts repo.

## 🕐 Batch Cycle and Time Windows

The cycle length is set by `cycleDurationSeconds` (default 86400 s = 24 hours). Within each cycle:

| Phase of cycle | Window | Actions Allowed |
|----------------|--------|-----------------|
| 0 s → `USER_WINDOW_END` | User Window | Users can `requestMint()` and `requestRedeem()` |
| `PROCESSING_WINDOW_START` → end | Processing Window | Bot calls `processBatch()`; no user actions |
| After Phase 2 | Distribution | Minters receive KASH (push); redeemers **claim** wBTC/ETH via `claimRedeem` |

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

# Deploy HyperliquidAdapter + ExchangeFacade (per product; see docs/DEPLOYMENT.md)
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumSepolia
KASH_YIELD_ADDRESS=<vault> BOT_ADDRESS=<bot> npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumSepolia

# Wire facade (owner): kashYield.setExchangeFacade(facade); facade.setHyperliquid(adapter); facade.setActivePerpExchange("HL")
# Full commands in docs/DEPLOYMENT.md
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full step-by-step checklist.

### Run Tests

```bash
# Unit tests (no fork RPC required)
npm run test:math
npx hardhat test test/redeem-merkle.unit.test.js

# Mainnet fork e2e (requires ARBITRUM_MAINNET_RPC_URL)
npm run test:fork
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
2. **Batch** – At the end of each cycle (configurable, default 24 h), the bot runs Phase 1, ops, settlement `updateNAV()`, `markBatchOpsDone(batchCycle, G)`, and Phase 2 (mint at settlement NAV; redeem from locked **G**).
3. **Redeem** – Approve KASH and call `requestRedeem(kashAmount)`. After Phase 2 settles, call **`claimRedeem`** in the app (Merkle proof from hosted manifest) to receive ETH or wBTC.

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
- **24-hour timelock on adapter registration**: On **ExchangeFacade**, first adapter is immediate; later registrations are timelocked. Switching active exchange is immediate.
- **Claim-reserve accounting**: `lockedClaimWbtc` / `lockedClaimEth` protect redeem assets reserved for Merkle claims; owner withdrawals cannot consume claim reserves.
- **Bot/keeper protocol interactions**: Aave, spot swaps, and HL writes (via facade) are `onlyBotOrKeeper` on the vault/facade.
- **Configurable slippage**: `maxSwapSlippageBps` caps the price impact on any Uniswap swap performed by the contract.
- **Emergency pause**: `pause()`/`unpause()` halts all user activity.
- **Custom errors**: All `require` strings replaced with typed Solidity errors — smaller bytecode and cheaper reverts.
- **EIP-170 compliant**: Both main contracts compile well under the 24,576-byte limit with `optimizer: { runs: 1 }` and `viaIR: true`.

## 📁 Project Structure

```
Kash/
├── contracts/
│   ├── KashYieldETH.sol            # Main ETH product (Merkle redeem claims)
│   ├── KashYieldBtc.sol            # Main BTC product
│   ├── ExchangeFacade.sol          # Perp registry + HL write ops (separate deploy)
│   ├── libraries/MerkleVerify.sol  # Merkle proof verification
│   ├── interfaces/
│   │   ├── IPerpExchange.sol       # Common interface for perp exchange adapters
│   │   └── ISpotDex.sol            # Common interface for spot DEX adapters
│   ├── adapters/
│   │   ├── HyperliquidAdapter.sol  # IPerpExchange → Hyperliquid
│   │   ├── GMXAdapter.sol          # IPerpExchange → GMX V2
│   │   ├── AsterAdapter.sol        # IPerpExchange → Aster DEX
│   │   └── UniswapV3Adapter.sol    # ISpotDex → Uniswap V3
│   └── ...
├── scripts/
│   ├── deploy-kashyieldbtc.js          # Deploy BTC product
│   ├── deploy-arbitrum-sepolia.js      # Deploy ETH product
│   ├── deploy-hyperliquid-adapter.js   # Deploy HyperliquidAdapter
│   ├── deploy-exchange-facade.js       # Deploy ExchangeFacade per vault
│   └── ...
├── test/
├── docs/
│   ├── DEPLOYMENT.md               # Deploy + verify guide (public)
│   └── ...
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
npm run test:math
npx hardhat test test/redeem-merkle.unit.test.js
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
- **Exchange adapters**: Deploy `HyperliquidAdapter` + **`ExchangeFacade`** per vault; wire with `setExchangeFacade` and `facade.setHyperliquid` / `setActivePerpExchange`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **Redeem claims**: The operator bot publishes Merkle proofs to static hosting; the frontend fetches via `NEXT_PUBLIC_REDEEM_PROOF_BASE_URL`.
- **Spot DEX**: On Arbitrum One, deploy/register `UniswapV3Adapter`.
- **Batch ops**: Five-step batch flow; redeem Phase 2 uses `processBatchPhase2ForCycle(cycle, merkleRoot)`. Operator tooling is in the private `kash-ops` repository.

## 🌐 Frontend

- **Stack**: Next.js 15 (App Router), Tailwind, wagmi + viem + RainbowKit. Network: Arbitrum Sepolia.
- **Features**: Mobile-first UI, wallet connect, mint KASH (ETH), redeem (ETH/wBTC), **claim redeem** after settlement, real-time NAV and deposits (from chain events), KASH balance, time-window status.
- **Contract addresses**: Set in `frontend/lib/contracts/addresses.ts` (`CONTRACTS.kashYieldEth`, `CONTRACTS.kashTokenEth`, tokens, oracles). Update when you deploy (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- **Mint flow**: Select ETH → enter amount → approve if needed → submit mint → wait for batch (KASH in Phase 2). **Redeem**: Enter KASH → approve → submit → after Phase 2, **Claim** (pull payout; user pays gas). Set `NEXT_PUBLIC_REDEEM_PROOF_BASE_URL` to hosted redeem proof manifests.
- **Time windows**: User window spans most of each cycle (requests); processing window is the last segment (`processBatch()`). Default cycle = 24 h; adjustable via `setCycleDurationSeconds`.
- **Build**: `cd frontend && npm run build && npm start`. **Deploy**: e.g. `vercel` or Docker (see [DEPLOYMENT.md](DEPLOYMENT.md) for full checklist).
- **Troubleshooting**: Use Arbitrum Sepolia; set WalletConnect project ID in `.env.local`; ensure user window for mint/redeem; check addresses in `lib/contracts/addresses.ts`. Testnet ETH: [Alchemy Arbitrum Sepolia faucet](https://www.alchemy.com/faucets/arbitrum-sepolia).

## Post-release ABI sync checklist

After every verified contract upgrade, update **all** of the following:

1. **`frontend/lib/contracts/kashYieldABI.ts`** — match compiled vault ABI from this repo.
2. **`frontend/lib/contracts/addresses.ts`** — new vault/token/facade addresses after cutover.
3. **Private `kash-ops` repo** — sync `bot/src/contracts/kashYieldABI.ts`, `protocolActionCodes.ts`, `.env` addresses, and `contracts/` copy (see kash-ops README).

Mismatch between this repo and `kash-ops` ABIs is the primary operational risk after a split.

## 📄 License

UNLICENSED

## 🤝 Contributing

This is a private project. Contact the owner for contribution guidelines.

## 📞 Contact

For questions or support, please contact the project maintainer.

---

**⚠️ Disclaimer**: This protocol is in development and has not been audited. Do not use with real funds until proper audits are completed.
