# Kash - Enhanced Yield Strategy Protocol

Kash is an AI-managed, leveraged yield protocol built on Arbitrum, an Ethereum L2. ETH and wrapped Bitcoin deposits are posted as collateral on Aave to fund a perpetual futures position on Hyperliquid. The strategy is market-neutral — it earns funding rate premiums without taking directional risk. An AI agent runs the entire operational stack: batch settlement, rebalancing, and NAV pricing, autonomously and continuously. Deposits are segregated by smart contract, and all positions are independently auditable on-chain in real time.

## Key Features

- **Two products**: `KashYieldETH` (ETH/wETH deposits → KASH-ETH) and `KashYieldBtc` (wBTC deposits → KASH-BTC). Both run on Arbitrum.
- **Ownerless V3 (this branch)**: Bot address, `ExchangeFacade`/adapter, oracle, spot DEX, fees, and cycle timing are all **immutable**, fixed at deploy via the constructor — no `owner()`, no pause, no post-deploy setters. Changing any of these requires redeploying the vault.
- **NAV-based pricing**: KASH priced at current Net Asset Value, updated after each settlement cycle.
- **Configurable batch cycle**: Default 24-hour cycle, fixed at deploy on V3.
- **ExchangeFacade**: Perp exchange routing and write ops live in a separate immutable `ExchangeFacade` contract (bytecode headroom). The vault holds `exchangeFacade` and forwards perp balance/position views.
- **Merkle pull claims (mints and redeems)**: After settlement, users call `claimMint(batchCycle, amount, proof)` to receive KASH or `claimRedeem(batchCycle, amount, proof)` to receive ETH/wBTC. Proofs are published in hosted manifests.
- **Perp adapter pattern**: `HyperliquidAdapter` (and future adapters) implement `IPerpExchange`. The adapter address is set when the facade is deployed.
- **Spot DEX integration**: An `ISpotDex` adapter (e.g. UniswapV3Adapter) enables on-chain asset ↔ USDC swaps with configurable slippage caps.
- **Batch user caps**: Up to **10,000** unique wallets per batch cycle for mints and redeems (separate counters), enforced in the app. On-chain defaults are **10,000** per side (`maxMintUsers` / `maxRedeemUsers`), with a ceiling of 100,000.
- **Security**: `ReentrancyGuard` on user-facing functions, two-step ownership transfer, and custom Solidity errors.
- **Aave**: Lending/borrowing for capital deployment.

## Architecture

### Smart contracts

| Contract | Role |
|----------|------|
| `KashYieldETH.sol` / `KashYieldBtc.sol` | Main vaults: mint/redeem requests, batch phases, Aave, spot swaps, `claimMint`, `claimRedeem` |
| `ExchangeFacade.sol` | Immutable perp routing + write ops; bound to one vault and adapter at deploy |
| `KashTokenEth` / `KashTokenBtc` | ERC-20 KASH tokens, minted/burned by the respective KashYield contract only |
| `libraries/MerkleVerify.sol` | Sorted-pair Merkle verification for mint and redeem claim proofs |
| `interfaces/IPerpExchange.sol` | Common interface for all perp exchange adapters |
| `interfaces/ISpotDex.sol` | Common interface for spot DEX adapters |
| `adapters/HyperliquidAdapter.sol` | `IPerpExchange` + ERC-1271 for HL REST when adapter is HL master |
| `adapters/UniswapV3Adapter.sol` | `ISpotDex` implementation for Uniswap V3 spot swaps |

| Aspect | Behaviour |
|--------|-----------|
| Batch cycle | Configurable via `setCycleDurationSeconds` (default 86400 s) |
| Mint valuation | Phase 1 via Chainlink price feed |
| NAV | Updated before settlement; Phase 2 mint uses settlement NAV |
| Mint distribution | Phase 2 commits Merkle root; users **`claimMint`** (pull model) |
| Redeem distribution | Phase 2 commits Merkle root; users **`claimRedeem`** (pull model) |
| Perp exchange | **ExchangeFacade** routes bot/keeper calls to the configured `IPerpExchange` adapter |
| Spot swaps | `swapForUsdc` / `swapFromUsdc` via `spotDexAddress` with `minOut` |
| Ownership | Two-step: `transferOwnership()` + `acceptOwnership()` |

**Owner config (no redeploy):** `setExchangeFacade` (where supported), `setAavePool`, `setCycleDurationSeconds`, `setFeeBps`, `setSpotDex`, `setMaxSwapSlippageBps`, `pause`/`unpause`.

### Off-chain operator

A private **kash-ops** repository holds the batch bot, post-deploy wiring scripts, and operator runbooks. This public repo contains contracts, deploy scripts, tests, and the frontend.

## User Flows

### Mint

1. User sends ETH/wETH (ETH product) or approves wBTC (BTC product) and calls `requestMint()`.
2. Request queues until the next batch cycle processes it.
3. After settlement, user calls **`claimMint`** with a Merkle proof (from hosted manifest or on-chain rebuild) to receive KASH tokens.

### Redeem

1. User approves KASH and calls `requestRedeem(kashAmount)`.
2. After settlement, user calls **`claimRedeem`** with a Merkle proof (from hosted manifest) to receive ETH or wBTC.

### Cycle windows

Within each cycle, users can mint/redeem during the user window. A processing window at the end of the cycle is reserved for batch settlement. Default cycle length is 24 hours.

## Quick Start

### Installation

```bash
npm install
```

### Deploy contracts

```bash
npx hardhat compile

# Arbitrum One
BOT_ADDRESS=<bot_wallet> \
npx hardhat run scripts/deploy-kashyieldeth.js --network arbitrumOne

BOT_ADDRESS=<bot_wallet> \
npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumOne

# Adapters + facade (see docs/DEPLOYMENT.md; post-deploy wiring in kash-ops)
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
KASH_YIELD_ADDRESS=<vault> BOT_ADDRESS=<bot> \
EXCHANGE_ADAPTER_ADDRESS=<adapter> EXCHANGE_NAME=HL \
npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for addresses, verification, and frontend setup. Post-deploy wiring lives in the private **kash-ops** repo.

### Run tests

```bash
npm run test:math
npx hardhat test test/redeem-merkle.unit.test.js

# Mainnet fork e2e (requires ARBITRUM_MAINNET_RPC_URL)
npm run test:fork
```

### Frontend

```bash
cd frontend && npm install
```

Create `frontend/.env.local` with `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. Then:

```bash
npm run dev
```

Open http://localhost:3000. Root `/` is the landing page; `/app` is the mint/redeem app. Update `frontend/lib/contracts/addresses.ts` after deploy.

## Security Features

- **ReentrancyGuard** on user-facing state-changing functions
- **Ownerless (V3)** — no `owner()`, no two-step ownership transfer, no pause; all config is immutable at deploy
- **Claim-reserve accounting** — redeem assets reserved for Merkle claims cannot be swept
- **Bot/keeper protocol interactions** — Aave, spot swaps, and HL writes are `onlyBotOrKeeper`
- **Configurable slippage** — `maxSwapSlippageBps` (fixed at deploy) caps Uniswap swap price impact
- **Custom errors** — smaller bytecode and cheaper reverts
- **EIP-170 compliant** — contracts compile under the 24,576-byte limit

See [docs/risks.md](docs/risks.md) for the public risk summary.

## Project Structure

```
Kash/
├── contracts/
│   ├── KashYieldETH.sol            # Main ETH product
│   ├── KashYieldBtc.sol            # Main BTC product
│   ├── ExchangeFacade.sol          # Immutable perp routing + write ops
│   ├── libraries/MerkleVerify.sol
│   ├── interfaces/
│   ├── adapters/
│   └── ...
├── scripts/                        # Deploy scripts (post-deploy ops in kash-ops)
│   ├── deploy-kashyieldeth.js
│   ├── deploy-kashyieldbtc.js
│   ├── deploy-hyperliquid-adapter.js
│   ├── deploy-exchange-facade.js
│   ├── deploy-uniswap-adapter.js
│   └── ...
├── test/
├── docs/
│   ├── DEPLOYMENT.md               # Public deploy overview
│   └── ...
├── frontend/                       # Next.js 15 + wagmi + RainbowKit
├── hardhat.config.js
└── package.json
```

## Development

```bash
npx hardhat compile
npx hardhat node   # local chain
```

## License

This repository is licensed under the [Business Source License 1.1](LICENSE) (BSL 1.1), similar to the delayed open-source model used by Uniswap v3.

- **Before the Change Date (2030-06-14):** the code may be copied, modified, and redistributed for **non-production** use (e.g. review, testing, local development). Production use requires compliance with the Additional Use Grant in [LICENSE](LICENSE) or a commercial license from the Licensor.
- **On or after the Change Date:** the licensed work converts to [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html).

Each release version may specify its own Change Date and Additional Use Grant. See [LICENSE](LICENSE) for the current parameters and full terms.

**Current release:** [v1.0.0](https://github.com/jt1777/Kash/releases/tag/v1.0.0) — on-chain protocol version `1.0.0` (`KashYieldETH.VERSION` / `KashYieldBtc.VERSION`).

## Disclaimer

KASH is live on **Arbitrum One**. Smart contract source is verified on Arbiscan and published in this repository. Live vault addresses are in [docs/agent-quickstart.md](docs/agent-quickstart.md).

DeFi protocols carry inherent risk — smart contract bugs, oracle failures, counterparty risk, and operator dependency can lead to partial or total loss of funds. Review [docs/risks.md](docs/risks.md) and verify contract addresses and NAV on-chain before depositing. Nothing here is financial advice. Only use funds you can afford to lose.
