# KASH Deployment Guide

## Prerequisites

1. **ETH for Gas**
   - Arbitrum Sepolia: Get from [faucet](https://faucet.quicknode.com/arbitrum/sepolia)
   - Arbitrum One: Need real ETH (bridged from Ethereum)

2. **Environment Setup**
   ```bash
   cp .env.example .env
   # Edit .env with your private key and RPC URLs
   ```

## Deployment Steps

### 1. Testnet Deployment (Arbitrum Sepolia)

```bash
# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Deploy to Sepolia
npx hardhat run scripts/deploy.js --network arbitrumSepolia
```

This will:
- Deploy all mock contracts (USDC, WETH, Aave, PriceFeed, Hyperliquid)
- Deploy KashYield main contract
- Configure settings (70% borrow, 1.7x leverage)
- Save deployment info to `deployment-arbitrumSepolia-{timestamp}.json`

### 2. Verify Contracts (Optional)

```bash
# Verify on Arbiscan
npx hardhat verify --network arbitrumSepolia DEPLOYED_KASHYIELD_ADDRESS \
  MOCK_AAVE_ADDRESS MOCK_USDC_ADDRESS MOCK_PRICEFEED_ADDRESS MOCK_HYPERLIQUID_ADDRESS MOCK_WETH_ADDRESS
```

### 3. Mainnet Deployment (Arbitrum One)

⚠️ **Warning**: Mainnet deployment costs real money. Test thoroughly on Sepolia first.

```bash
# Make sure you have real ETH on Arbitrum
npx hardhat run scripts/deploy.js --network arbitrumOne
```

## Post-Deployment

### Update Frontend

Edit `frontend/index.html` with deployed addresses:

```javascript
const kashYieldAddress = "0xYOUR_DEPLOYED_ADDRESS";
```

### Test the Deployment

```bash
# Run interaction scripts
npx hardhat run scripts/interact.js --network arbitrumSepolia
```

## Security Checklist

Before mainnet:
- [ ] Contracts audited by reputable firm
- [ ] Bug bounty program active
- [ ] Multisig owner configured
- [ ] Emergency pause tested
- [ ] All test cases passing
- [ ] Frontend tested end-to-end

## Troubleshooting

### "Insufficient funds"
- Check wallet balance: `npx hardhat balance --network arbitrumSepolia ADDRESS`
- Get more Sepolia ETH from faucet

### "Nonce too low"
- Reset nonce: `npx hardhat clean` and try again

### "Contract too large"
- Enable optimizer in hardhat.config.js (already done)
- Consider splitting into libraries

## Cost Estimates

| Network | Approximate Cost |
|---------|-----------------|
| Arbitrum Sepolia | Free (testnet) |
| Arbitrum One | ~0.01-0.02 ETH |

---

**Note**: I can execute these commands for you once you provide the environment variables in your OpenClaw workspace!
