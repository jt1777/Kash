# KashYield Ops Scripts

Standalone Hardhat scripts for each individual operation in the KashYield batch cycle.
Each script performs exactly one on-chain action, shows before/after state, and is fully
retryable if a step fails.

Run all scripts from the **repo root**:
```bash
PRODUCT=eth npx hardhat run bot/scripts/ops/00-status.js --network arbitrumSepolia
```

Set `PRODUCT=eth` or `PRODUCT=btc` to select the contract (reads from `bot/.env`).

---

## Scripts

| Script | Description |
|--------|-------------|
| `00-status.js` | Show all positions and balances (read-only) |
| **— MINT OPS —** | |
| `01-deposit-to-aave.js` | Deposit ETH/wBTC from contract → Aave collateral |
| `02-borrow-usdc-from-aave.js` | Borrow USDC from Aave against deposited collateral |
| `02a-aave-loop.js` | **Round 2 leverage loop:** swap all contract USDC → asset, deposit to Aave, borrow incremental USDC to LTV. Prerequisite: `01` + `02` |
| `03-deposit-usdc-to-perp.js` | Deposit USDC to perp DEX spot wallet *(HL path)* |
| `03b-deposit-asset-to-perp.js` | Deposit ETH/wBTC to perp DEX as collateral *(Aster path)* |
| `04-spot-buy-asset.js` | Buy spot ETH/wBTC on perp DEX with USDC *(HL path)* |
| `05-open-short.js` | Open leveraged short on perp DEX |
| **— REDEEM OPS —** | |
| `06-close-short.js` | Close proportional short (set `FRACTION=50` for 50%) |
| `07-sell-spot-asset.js` | Sell spot ETH/wBTC on perp DEX → USDC *(HL path)* |
| `08-withdraw-usdc-from-perp.js` | Withdraw USDC from perp DEX to contract *(HL path)* |
| `09-repay-aave-borrow.js` | Repay USDC borrow to Aave |
| `10-withdraw-from-aave.js` | Withdraw ETH/wBTC collateral from Aave (set `FRACTION`) |
| `11a-swap-asset-for-usdc.js` | Swap ETH/wBTC → USDC via spot DEX *(rising price)* |
| `11b-swap-usdc-for-asset.js` | Swap USDC → ETH/wBTC via spot DEX *(falling price)* |
| `12-withdraw-asset-from-perp.js` | Withdraw ETH/wBTC from perp DEX to contract *(Aster path)* |
| `14-hl-sync-state.js` | Reconcile HL adapter mirror from HL API |
| `16-phase2-redeem-shortfall.js` | Read-only: vault wBTC/ETH vs Phase 2 need (locked **G** when `batchPhase >= 2`) |

---

## Perp DEX types

### USDC-collateral DEX (Hyperliquid)
On Hyperliquid, collateral is always USDC and **only USDC can be withdrawn**.
Spot ETH/wBTC exists only as an internal ledger balance and must be sold back to USDC
before withdrawing.

**Mint sequence:** `01 → 02 → 02a → 03 → 05` (skip `04` spot buy — USDC collateral + perp short only)

**Aave leverage loop test (manual):** run `01`, then `02`, then `02a`. Example at 70% LTV on a $100 deposit: after `02a`, Aave holds ~$170 collateral and ~$119 USDC debt; vault holds ~$119 USDC ready for script `03`.

**Redeem sequence:** `06 → 07 → 08 → 09 → 10`
**Falling price top-up (if ETH shortfall):** `11b`
**Rising price top-up (if USDC shortfall):** `11a → 09`

### Asset-collateral DEX (Aster, dYdX, etc.)
On asset-collateral DEXs, ETH/wBTC is deposited directly as short collateral.
When the short closes, ETH/wBTC is returned and can be withdrawn natively.
No spot buy step is needed.

**Mint sequence:** `01 → 02 → 03b → 05`
**Redeem sequence:** `06 → 12 → sell some via 11a if needed → 09 → 10`

---

## Price scenarios

### Flat / rising price (USDC from short P&L may not cover full Aave debt)
```
06-close-short        (FRACTION=100)
07-sell-spot-asset    # HL path: sell returned ETH collateral for USDC
08-withdraw-usdc-from-perp
09-repay-aave-borrow  # if USDC still not enough, run 11a first
11a-swap-asset-for-usdc AUTO=true   # sells some Aave-withdrawn ETH to cover gap
10-withdraw-from-aave FRACTION=100
```

### Falling price (HL short profit > Aave debt — have excess USDC, need more ETH)
```
06-close-short        (FRACTION=100)
07-sell-spot-asset    # sell all returned ETH collateral for USDC
08-withdraw-usdc-from-perp
09-repay-aave-borrow  # USDC covers full borrow
10-withdraw-from-aave FRACTION=100  # only 1 ETH from Aave, but redeemer needs 1.5 ETH
11b-swap-usdc-for-asset AUTO=true BATCH_CYCLE=N  # swap excess USDC for the shortfall ETH
```

---

## Environment variables

All scripts read from `bot/.env`. Common overrides:

| Variable | Description | Default |
|----------|-------------|---------|
| `PRODUCT` | `eth` or `btc` | `eth` |
| `AMOUNT` | Override auto-computed amount | auto |
| `FRACTION` | Percentage for close/withdraw scripts (1–100) | required |
| `BORROW_LTV_PCT` | LTV for scripts 02 and 02a | `70` |
| `SHORT_LEVERAGE` | Leverage multiplier for script 05 suggestion | `1.7` |
| `AUTO` | `true` to auto-compute in scripts 11a/11b | `false` |
| `BATCH_CYCLE` | Override batch cycle for script 11b AUTO mode | current |

---

## Mainnet vs testnet

On **Arbitrum Sepolia**, all scripts send on-chain transactions including trading steps (04, 05, 06, 07) because `MockHyperliquid` is an Arbitrum contract.

On **Arbitrum mainnet**, real Hyperliquid is its own L1. Trading operations are off-chain API calls:

| Script | Testnet | Mainnet |
|--------|---------|---------|
| `03` deposit USDC | on-chain tx | on-chain tx (HL bridge) |
| `04` spot buy | on-chain tx | **HL API call** |
| `05` open short | on-chain tx | **HL API call** |
| `06` close short | on-chain tx | **HL API call** |
| `07` sell spot | on-chain tx | **HL API call** |
| `08` withdraw USDC | on-chain tx | on-chain tx (HL bridge) |
| `09`–`11` Aave/Uniswap | on-chain tx | on-chain tx |

Pass `--network arbitrumOne` instead of `--network arbitrumSepolia` for all mainnet runs.
