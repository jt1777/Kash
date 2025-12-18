import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Arbitrum Sepolia Testnet Token Addresses
 * These need to be set in the contract for tokens to work on Sepolia
 * Addresses from frontend/lib/contracts/addresses.ts
 */
const SEPOLIA_TOKEN_ADDRESSES = {
  WETH: '0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9', // Arbitrum Sepolia WETH
  WBTC: '0x4D8b720b94D341F54df948696747B05998c5FbD5', // Arbitrum Sepolia WBTC
  USDT: '0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1', // Arbitrum Sepolia USDT
  USDC: '0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5', // Arbitrum Sepolia USDC
};

async function main() {
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not set in .env - needed to send transaction');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    wallet
  );

  console.log('🔧 Updating Token Addresses for Arbitrum Sepolia');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`From: ${wallet.address}`);
  console.log(`Network: ${config.rpcUrl}\n`);

  // Check current addresses
  console.log('📋 Current Token Addresses:');
  try {
    // Note: These are public variables, we'd need to add getters to the ABI
    console.log('   (Need to add getters to check current addresses)');
  } catch (error) {
    console.log('   Could not read current addresses');
  }

  console.log('\n⚠️  IMPORTANT:');
  console.log('   1. You need to find the actual Arbitrum Sepolia addresses for:');
  console.log('      - WETH');
  console.log('      - WBTC');
  console.log('      - USDT');
  console.log('      - USDC');
  console.log('   2. Update SEPOLIA_TOKEN_ADDRESSES in this script');
  console.log('   3. Then run this script to update the contract\n');

  // Check if we have valid addresses
  const hasValidAddresses = Object.values(SEPOLIA_TOKEN_ADDRESSES).every(
    addr => addr !== '0x0000000000000000000000000000000000000000'
  );

  if (!hasValidAddresses) {
    console.log('❌ Please update SEPOLIA_TOKEN_ADDRESSES with actual Sepolia addresses first!');
    console.log('\n💡 You can find Sepolia token addresses at:');
    console.log('   - https://bridge.arbitrum.io/');
    console.log('   - https://docs.chain.link/data-feeds/l2-sequencer-feeds');
    console.log('   - Arbitrum Sepolia block explorer');
    process.exit(1);
  }

  // Check owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`You are not the contract owner! Owner is: ${owner}`);
  }

  console.log('✅ You are the contract owner\n');

  // Update token addresses
  console.log('📝 Updating token addresses...');
  try {
    const tx = await kashYield.setTokenAddresses(
      SEPOLIA_TOKEN_ADDRESSES.WETH,
      SEPOLIA_TOKEN_ADDRESSES.WBTC,
      SEPOLIA_TOKEN_ADDRESSES.USDT,
      SEPOLIA_TOKEN_ADDRESSES.USDC
    );
    console.log(`   Transaction sent: ${tx.hash}`);
    console.log('   Waiting for confirmation...');
    
    const receipt = await tx.wait();
    console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
  } catch (error: any) {
    console.error('   ❌ Error updating addresses:', error.message);
    if (error.reason) {
      console.error('   Revert reason:', error.reason);
    }
    throw error;
  }

  console.log('\n✅ Token addresses updated successfully!');
  console.log('   You can now verify by running: npm run debug');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
