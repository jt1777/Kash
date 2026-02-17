# Hyperliquid Integration Guide

## Overview
KASH integrates with Hyperliquid for delta-neutral yield through ETH short positions.

## Architecture

```
User Deposit ETH
    ↓
Supply to Aave → Borrow 70% USDC
    ↓
Deposit USDC to Hyperliquid as collateral
    ↓
Open 1.7x ETH short position
    ↓
Earn funding rate yield
```

## Contract Addresses Needed

### Arbitrum Sepolia (Testnet)

You mentioned you already have Hyperliquid access from the AI trading bot project. We need these addresses:

| Contract | Purpose | Where to Find |
|----------|---------|---------------|
| `Clearinghouse` | Main Hyperliquid L1 contract | Your trading bot config |
| `USDC` | USDC token on Sepolia | Usually `0xd9CBEC81df392A88AEff575E962d149d57F4d6bc` |
| `ETH-PERP` | ETH perpetual market ID | Hyperliquid API or your bot |

### Finding Your Addresses

From your AI trading bot project, look for:
1. The wallet address that deposited to Hyperliquid
2. Any contract addresses in your `.env` or config files
3. The `HYPERLIQUID_API_URL` or similar - probably `https://api.hyperliquid-testnet.xyz`

## Hyperliquid Interaction Flow

### Current (Mock)
Our `MockHyperliquid.sol` simulates:
```solidity
function depositCollateralAndOpenShort(usdcAmount, positionSize, user)
function closePosition(user) returns (collateralReturned, pnl)
function getPositionFunding(user) returns fundingAmount
```

### Real Hyperliquid
The actual integration would use:

1. **Deposit to L1** → Bridge USDC to Hyperliquid
2. **API Calls** → Open/close positions via REST API
3. **Or** → Direct contract calls to Clearinghouse

## Important: Hyperliquid Architecture

Hyperliquid is **NOT a typical DEX**:
- It's an L1 blockchain with its own consensus
- The "L1" contracts on Arbitrum are bridge contracts
- Actual trading happens on Hyperliquid chain
- We interact via:
  - **REST API** for orders/positions
  - **Arbitrum contracts** for deposits/withdrawals

## Implementation Options

### Option A: Mock Mode (Current)
Use `MockHyperliquid.sol` for testing logic without real positions.

### Option B: Real Hyperliquid via API
Integrate with Hyperliquid's Python/TS SDK:
```python
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

exchange = Exchange(wallet, constants.TESTNET_API_URL)
exchange.market_open("ETH", True, sz=1.7)  # Open 1.7x short
```

### Option C: Real Hyperliquid via Contracts
Direct contract calls (limited functionality):
```solidity
// Deposit to Hyperliquid L1
IClearinghouse(clearinghouse).deposit(usdcAmount);
// Note: Opening positions requires API, not direct contract calls
```

## Recommended Approach

For KASH, we recommend **hybrid approach**:

1. **Smart contract** handles deposits, batching, KashEth minting
2. **Off-chain bot** (owner-controlled initially) manages Hyperliquid positions via API
3. **Future**: On-chain integration as Hyperliquid adds more contract functionality

This is similar to how your AI trading bot works!

## Getting Testnet Funds

1. **Hyperliquid testnet USDC**: https://app.hyperliquid-testnet.xyz/drip
   - Requires same address that deposited on mainnet
   - You mentioned you have this ✓

2. **Arbitrum Sepolia ETH**: https://faucet.quicknode.com/arbitrum/sepolia
   - For gas fees

## Configuration

Add to your `.env`:
```bash
# Hyperliquid Testnet
HYPERLIQUID_TESTNET_API_URL=https://api.hyperliquid-testnet.xyz
HYPERLIQUID_CLEARINGHOUSE=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7
HYPERLIQUID_USDC=0xd9CBEC81df392A88AEff575E962d149d57F4d6bc

# Wallet (same as AI trading bot)
DEPLOYER_PRIVATE_KEY=0x...
```

## Testing Checklist

Before mainnet:
- [ ] Deploy to Arbitrum Sepolia
- [ ] Get testnet USDC from faucet
- [ ] Test ETH deposit flow
- [ ] Verify batch processing works
- [ ] Test Hyperliquid position opening (via API)
- [ ] Test redemption flow
- [ ] Monitor funding rate accrual

## Security Notes

1. **API Keys**: If using Hyperliquid API, store keys securely
2. **Position Monitoring**: Real positions can be liquidated
3. **Funding Rate Risk**: Can turn negative (shorts pay longs)
4. **Bridge Risk**: Funds locked during deposit/withdrawal

## Resources

- [Hyperliquid Docs](https://hyperliquid.gitbook.io/hyperliquid-docs/)
- [Python SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk)
- [Testnet Faucet](https://app.hyperliquid-testnet.xyz/drip)

---

**Next**: Can you share the wallet address or contract addresses from your AI trading bot project? Then I can update the deployment scripts with the exact addresses.
