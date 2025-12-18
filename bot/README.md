# KashYield Off-Chain Bot

Off-chain bot for processing daily batches, calculating NAV, and managing protocol interactions.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your configuration:
```bash
cp .env.example .env
```

3. **IMPORTANT**: Edit `.env` and set your contract addresses:
```bash
# Required: Set your deployed contract address
KASH_YIELD_ADDRESS=0xYourDeployedContractAddress

# Optional: Set if you have a deployed token address
KASH_TOKEN_ADDRESS=0xYourTokenAddress

# RPC URL - Use one of these:
# For Arbitrum Sepolia Testnet:
RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
# Or use: ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc

# For Arbitrum Mainnet:
# RPC_URL=https://arb1.arbitrum.io/rpc

# Chain ID (421614 for Sepolia, 42161 for Mainnet)
CHAIN_ID=421614
```

4. Build TypeScript:
```bash
npm run build
```

## Troubleshooting

### Error: "could not decode result data (value="0x")"

This error means the contract address is not set or incorrect. Make sure:

1. ✅ You have a `.env` file in the `bot/` directory
2. ✅ `KASH_YIELD_ADDRESS` is set to your deployed contract address
3. ✅ The contract is deployed on the network specified by `RPC_URL`
4. ✅ The address format is correct (starts with `0x` and is 42 characters)

### Error: "No contract found at address"

- Verify the contract is deployed at the address you specified
- Check that you're using the correct network (Arbitrum Mainnet vs Testnet)
- Ensure your RPC URL matches the network where the contract is deployed

## Usage

### Calculate Net Position

This is the first step in batch processing - it sums all mint and redeem requests to determine if we need to mint or redeem Kash tokens.

```bash
npm run dev
# or
npm start
```

This will:
1. Connect to the blockchain
2. Get yesterday's batch cycle
3. Query all mint and redeem requests
4. Calculate USD values for each request
5. Sum them to get net position

## Development

```bash
# Watch mode
npm run watch

# Run in development
npm run dev
```

## Project Structure

```
bot/
├── src/
│   ├── batch/
│   │   └── calculateNetPosition.ts  # Net position calculation
│   ├── contracts/
│   │   └── kashYieldABI.ts          # Contract ABI
│   ├── utils/
│   │   └── prices.ts                 # Price fetching utilities
│   ├── config.ts                     # Configuration
│   ├── types.ts                      # TypeScript types
│   └── index.ts                      # Main entry point
├── package.json
├── tsconfig.json
└── README.md
```
