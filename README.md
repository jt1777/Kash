# Kash - Enhanced Yield Strategy Protocol

Kash is an AI-managed, leveraged yield protocol. ETH and Bitcoin deposits are posted as collateral on Aave to fund a perpetual futures position on Hyperliquid. The strategy is market-neutral — it earns funding rate premiums without taking directional risk. An AI agent runs the entire operational stack: batch settlement, rebalancing, and NAV pricing, autonomously and continuously. Deposits are segregated by smart contract, and all positions are independently auditable on-chain in real time.

## Key Features

- **Two products**: `KashYieldETH` (ETH/wETH deposits → KASH-ETH) and `KashYieldBtc` (wBTC deposits → KASH-BTC). Both run on Arbitrum.
- **NAV-based pricing**: KASH priced at current Net Asset Value, updated after each settlement cycle.
- **Configurable batch cycle**: Default 24-hour cycle. Owner can adjust duration for testing or production.
- **ExchangeFacade**: Perp exchange registry and Hyperliquid write ops live in a separate `ExchangeFacade` contract (bytecode headroom). The vault holds `exchangeFacade` and forwards HL view calls.
- **Merkle pull claims (redeems)**: Users call `claimRedeem(batchCycle, amount, proof)` to receive ETH/wBTC after settlement. Mint payouts remain push-based.
- **Perp adapter pattern**: `HyperliquidAdapter` implements `IPerpExchange` and is registered on **ExchangeFacade** (additional adapters can be added via the facade registry).
- **Spot DEX integration**: An `ISpotDex` adapter (e.g. UniswapV3Adapter) enables on-chain asset ↔ USDC swaps with configurable slippage caps.
- **24-hour timelock on adapter registration**: On **ExchangeFacade**, the first adapter is immediate; subsequent registrations use proposal + confirmation after the facade timelock.
- **Batch user caps**: Up to **400** unique wallets per batch cycle for mints and redeems (separate counters), enforced in the app. On-chain `MAX_MINT_USERS` / `MAX_REDEEM_USERS` remain 500.
- **Security**: `ReentrancyGuard` on user-facing functions, two-step ownership transfer, and custom Solidity errors.
- **Aave**: Lending/borrowing for capital deployment.

## Architecture

### Smart contracts

| Contract | Role |
|----------|------|
| `KashYieldETH.sol` / `KashYieldBtc.sol` | Main vaults: mint/redeem requests, batch phases, Aave, spot swaps, `claimRedeem` |
| `ExchangeFacade.sol` | Perp registry + HL write ops; pulls USDC from vault |
| `KashTokenEth` / `KashTokenBtc` | ERC-20 KASH tokens, minted/burned by the respective KashYield contract only |
| `libraries/MerkleVerify.sol` | Sorted-pair Merkle verification for redeem claim proofs |
| `interfaces/IPerpExchange.sol` | Common interface for all perp exchange adapters |
| `interfaces/ISpotDex.sol` | Common interface for spot DEX adapters |
| `adapters/HyperliquidAdapter.sol` | `IPerpExchange` + ERC-1271 for HL REST when adapter is HL master |
| `adapters/UniswapV3Adapter.sol` | `ISpotDex` implementation for Uniswap V3 spot swaps |

| Aspect | Behaviour |
|--------|-----------|
| Batch cycle | Configurable via `setCycleDurationSeconds` (default 86400 s) |
| Mint valuation | Phase 1 via Chainlink price feed |
| NAV | Updated before settlement; Phase 2 mint uses settlement NAV |
| Redeem distribution | Phase 2 commits Merkle root; users **`claimRedeem`** (pull model) |
| Exchange registry | On **ExchangeFacade**: `perpExchanges`, `activePerpExchange` |
| Adapter registration | On facade: first HL adapter immediate; later changes timelocked |
| Spot swaps | `swapForUsdc` / `swapFromUsdc` via `spotDexAddress` with `minOut` |
| Ownership | Two-step: `transferOwnership()` + `acceptOwnership()` |

**Owner config (no redeploy):** `setExchangeFacade`, `setAavePool`, `setCycleDurationSeconds`, `setFeeBps`, `setSpotDex`, `setMaxSwapSlippageBps`, `pause`/`unpause`; perp registry on **ExchangeFacade**.

### Off-chain operator

A private **kash-ops** repository holds the batch bot, post-deploy wiring scripts, and operator runbooks. This public repo contains contracts, deploy scripts, tests, and the frontend.

## User Flows

### Mint

1. User sends ETH/wETH (ETH product) or approves wBTC (BTC product) and calls `requestMint()`.
2. Request queues until the next batch cycle processes it.
3. After settlement, user receives KASH tokens (push transfer).

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

# Adapters + facade (see docs/DEPLOYMENT.md)
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
KASH_YIELD_ADDRESS=<vault> BOT_ADDRESS=<bot> \
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
- **Two-step ownership** — new owner must explicitly accept
- **24-hour timelock** on new perp/spot adapter registration (first adapter immediate)
- **Claim-reserve accounting** — redeem assets reserved for Merkle claims cannot be swept by owner withdrawals
- **Bot/keeper protocol interactions** — Aave, spot swaps, and HL writes are `onlyBotOrKeeper`
- **Configurable slippage** — `maxSwapSlippageBps` caps Uniswap swap price impact
- **Emergency pause** — `pause()`/`unpause()` halts user activity
- **Custom errors** — smaller bytecode and cheaper reverts
- **EIP-170 compliant** — contracts compile under the 24,576-byte limit

See [docs/risks.md](docs/risks.md) for the public risk summary.

## Project Structure

```
Kash/
├── contracts/
│   ├── KashYieldETH.sol            # Main ETH product
│   ├── KashYieldBtc.sol            # Main BTC product
│   ├── ExchangeFacade.sol          # Perp registry + HL write ops
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

KASH is live on **Arbitrum One**. Smart contract source is verified on Arbiscan and published in this repository ([v1.0.0](https://github.com/jt1777/Kash/releases/tag/v1.0.0)).

DeFi protocols carry inherent risk — smart contract bugs, oracle failures, counterparty risk, and operator dependency can lead to partial or total loss of funds. Review [docs/risks.md](docs/risks.md) and verify contract addresses and NAV on-chain before depositing. Nothing here is financial advice. Only use funds you can afford to lose.
