# KashYield Deployment Guide

## Prerequisites

1. **Node.js & npm** - Already installed ✅
2. **Hardhat** - Already configured ✅
3. **dotenv package** - Install if not present:
   ```bash
   npm install dotenv
   ```

## Environment Setup

Create a `.env` file in the root directory with:

```env
# Private Key (DO NOT COMMIT - ADD .env TO .gitignore)
PRIVATE_KEY=your_private_key_here

# RPC URLs (optional - defaults provided)
ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_API_KEY
ARBITRUM_ONE_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Arbiscan API Key (for verification)
ARBISCAN_API_KEY=your_arbiscan_api_key

# Gas Reporter (optional)
REPORT_GAS=false
```

## Get Testnet Funds

### Arbitrum Sepolia ETH
1. Get Sepolia ETH from faucet: https://sepoliafaucet.com/
2. Bridge to Arbitrum Sepolia: https://bridge.arbitrum.io/?l2ChainId=421614

**OR** use direct Arbitrum Sepolia faucets:
- https://www.alchemy.com/faucets/arbitrum-sepolia
- https://faucet.quicknode.com/arbitrum/sepolia

## Deployment Commands

### 1. Test Locally First
```bash
# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Deploy to local Hardhat network
npx hardhat run scripts/deploy.js
```

### 2. Deploy to Arbitrum Sepolia Testnet
```bash
# Deploy
npx hardhat run scripts/deploy.js --network arbitrumSepolia

# Deployment info will be saved to: ./deployments/deployment-arbitrumSepolia-[timestamp].json
```

### 3. Verify Contracts on Arbiscan
```bash
# Verify KashYield (replace with your deployed address)
npx hardhat verify --network arbitrumSepolia KASHYIELD_ADDRESS

# Verify KashToken
npx hardhat verify --network arbitrumSepolia KASHTOKEN_ADDRESS

# Verify MockUSDT
npx hardhat verify --network arbitrumSepolia MOCK_USDT_ADDRESS 1000000

# Verify MockAaveV3
npx hardhat verify --network arbitrumSepolia MOCK_AAVE_ADDRESS USDT_ADDRESS

# Verify MockChainlinkPriceFeed
npx hardhat verify --network arbitrumSepolia ETH_FEED_ADDRESS 300000000000

# Verify MockHyperliquid
npx hardhat verify --network arbitrumSepolia MOCK_HYPER_ADDRESS USDC_ADDRESS USDT_ADDRESS WBTC_ADDRESS
```

## Post-Deployment Checklist

- [ ] Save deployment addresses from `./deployments/` folder
- [ ] Verify all contracts on Arbiscan
- [ ] Test mint/redeem functions via Etherscan or scripts
- [ ] Monitor time windows (user window vs processing window)
- [ ] Test batch processing after 24 hours
- [ ] Update frontend with contract addresses

## Deployment Structure

The deployment script will:
1. Deploy all mock tokens (USDT, USDC, wETH, wBTC)
2. Deploy Chainlink price feed mocks
3. Deploy MockAaveV3 (needs USDT address)
4. Deploy MockHyperliquid
5. Deploy KashYield contract
6. Configure KashYield with all addresses
7. Fund contracts with initial balances
8. Save deployment info to JSON file

## Troubleshooting

### "Insufficient funds" error
- Get more testnet ETH from faucets above
- Check your wallet balance: `npx hardhat run scripts/checkBalance.js --network arbitrumSepolia`

### "Invalid nonce" error
- Reset your account in MetaMask: Settings → Advanced → Reset Account

### Contract verification fails
- Make sure constructor arguments match exactly
- Wait a few minutes after deployment before verifying
- Check Arbiscan API key is correct

## Useful Commands

```bash
# Check account balance
npx hardhat run scripts/checkBalance.js --network arbitrumSepolia

# Interact with deployed contract
npx hardhat console --network arbitrumSepolia

# Clean artifacts and cache
npx hardhat clean

# Get current NAV
npx hardhat run scripts/getNAV.js --network arbitrumSepolia
```

## Network Details

### Arbitrum Sepolia
- **Chain ID**: 421614
- **RPC**: https://sepolia-rollup.arbitrum.io/rpc
- **Explorer**: https://sepolia.arbiscan.io
- **Faucet**: https://www.alchemy.com/faucets/arbitrum-sepolia

### Arbitrum One (Mainnet)
- **Chain ID**: 42161
- **RPC**: https://arb1.arbitrum.io/rpc
- **Explorer**: https://arbiscan.io

## Security Notes

⚠️ **IMPORTANT**:
- Never commit your `.env` file or private keys
- Use a separate test wallet for testnets
- Audit contracts before mainnet deployment
- Test thoroughly on testnet for at least 1 week
- Consider getting a professional security audit
