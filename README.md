# Kash - Enhanced Yield Strategy Protocol

Kash is a delta-neutral yield protocol on **Arbitrum One**. ETH and wrapped Bitcoin deposits are posted as collateral on **Aave** to fund a hedged short on **Aster**, an Arbitrum-native perpetuals DEX. An automated operator runs batch settlement, rebalancing, and NAV updates. Deposits are segregated by smart contract; portfolio components are auditable on-chain.

> **`aster` branch:** **ownerless Aster** vaults + **AsterAdapter**. The **`main`** branch retains a legacy **Hyperliquid (HL)** stack — see [docs/risks.md](docs/risks.md).

## Key Features

- **Two products**: `KashYieldETH` (ETH/wETH → KASH-ETH) and `KashYieldBtc` (wBTC → KASH-BTC)
- **Ownerless Aster**: Bot, `ExchangeFacade`, `AsterAdapter`, spot DEX, oracle, `feeReceiver`, fees, batch timing, and user caps are **immutable** at deploy — no `owner()`, no `pause()`, no post-deploy setters
- **Aster on-chain perps**: Positions managed via `AsterAdapter` through `ExchangeFacade` (no cross-chain HL master wallet)
- **NAV-based pricing**: KASH is minted and redeemed at NAV determined during daily batch processing
- **Batch overlap guard**: Phase 1 for cycle N+1 reverts while cycle N is still in Phase 1
- **Merkle pull claims**: `claimMint` / `claimRedeem` with 30-day expiry
- **Batch user caps**: Immutable `maxMintUsers` / `maxRedeemUsers` (default 10,000, cap 100,000)
- **Security**: `ReentrancyGuard`, custom errors, EIP-170 compliant bytecode

## Architecture

### Smart contracts

| Contract | Role |
|----------|------|
| `KashYieldETH.sol` / `KashYieldBtc.sol` | Vaults: mint/redeem, batch phases, Aave, spot swaps, NAV, Merkle claims |
| `ExchangeFacade.sol` | Immutable router: vault ↔ Aave ↔ Aster ↔ spot DEX |
| `AsterAdapter.sol` | `IPerpExchange` for Aster clearing house + vault |
| `KashTokenEth` / `KashTokenBtc` | ERC-20 KASH (vault-only mint/burn) |
| `libraries/MerkleVerify.sol` | Merkle verification for claims |
| `adapters/UniswapV3Adapter.sol` | `ISpotDex` spot swaps |

| Aspect | Aster stack behaviour |
|--------|----------------|
| Batch cycle | Fixed at deploy (`cycleDurationSeconds`, user/processing windows) |
| NAV | Updated during batch processing; submissions recorded on-chain |
| Claims | Merkle pull; unclaimed swept after 30 days |
| Perp | **Aster** via immutable facade + adapter |
| Fees | Immutable `feeBps` → immutable `feeReceiver` |

### Off-chain operator

Private **kash-ops** repo: batch bot (Aster path under `bot/src/batch/aster/`), deploy verification, runbooks.

## Deploy (Aster stack)

```bash
npm install && npx hardhat compile

# Spot DEX (shared)
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne

# Full stack per product (adapter + facade + vault)
npm run deploy:eth-aster
npm run deploy:btc-aster
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Legacy HL scripts remain for `main` branch only.

## Tests & frontend

```bash
npm run test:math
cd frontend && npm install && npm run dev
```

Configure `frontend/.env.local` with deployed `NEXT_PUBLIC_*` addresses.

## Security

See [docs/risks.md](docs/risks.md) for the public risk summary (Aster focus).

## License

[Business Source License 1.1](LICENSE). On-chain **`VERSION = "3.0.0"`** on Aster vaults.

## Disclaimer

DeFi carries smart contract, oracle, counterparty, and operator risk. Review [docs/risks.md](docs/risks.md) before depositing. Not financial advice.
