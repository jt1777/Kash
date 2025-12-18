import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Update the ETH/USD oracle address on the KashYield contract
 * Uses the Chainlink ETH/USD price feed on Arbitrum Sepolia testnet
 */
const NEW_ETH_ORACLE = '0x2d3bBa5e0A9Fd8EAa45Dcf71A2389b7C12005b1f'; // Arbitrum Sepolia ETH/USD

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

  console.log('🔧 Updating ETH/USD Oracle Address');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`From: ${wallet.address}`);
  console.log(`Network: ${config.rpcUrl}\n`);

  // Check current oracle
  console.log('📋 Current Oracle Addresses:');
  try {
    const ethOracle = await kashYield.tokenOracles(ethers.ZeroAddress);
    console.log(`   ETH Oracle: ${ethOracle}`);
    if (ethOracle.toLowerCase() === NEW_ETH_ORACLE.toLowerCase()) {
      console.log('   ✅ Oracle is already set to the correct address!');
      return;
    }
  } catch (error: any) {
    console.log(`   Could not read current oracle: ${error.message}`);
  }

  // Verify the new oracle exists and is a valid Chainlink feed
  console.log(`\n🔍 Verifying new oracle at ${NEW_ETH_ORACLE}...`);
  try {
    const oracleABI = [
      {
        inputs: [],
        name: 'latestRoundData',
        outputs: [
          { name: 'roundId', type: 'uint80' },
          { name: 'answer', type: 'int256' },
          { name: 'startedAt', type: 'uint256' },
          { name: 'updatedAt', type: 'uint256' },
          { name: 'answeredInRound', type: 'uint80' },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [],
        name: 'decimals',
        outputs: [{ name: '', type: 'uint8' }],
        stateMutability: 'view',
        type: 'function',
      },
    ];
    const oracle = new ethers.Contract(NEW_ETH_ORACLE, oracleABI, provider);
    const code = await provider.getCode(NEW_ETH_ORACLE);
    if (code === '0x') {
      throw new Error('Oracle contract does not exist at this address');
    }
    
    const priceData = await oracle.latestRoundData();
    const decimals = await oracle.decimals();
    const price = Number(priceData.answer) / 10 ** Number(decimals);
    console.log(`   ✅ Oracle is valid and responding`);
    console.log(`   📊 Current ETH Price: $${price.toFixed(2)}`);
    console.log(`   📅 Last Updated: ${new Date(Number(priceData.updatedAt) * 1000).toISOString()}`);
  } catch (error: any) {
    console.error(`   ⚠️  Warning: Could not verify oracle: ${error.message}`);
    console.error(`   Proceeding anyway, but please verify the address is correct`);
  }

  // Check owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`You are not the contract owner! Owner is: ${owner}`);
  }

  console.log('\n✅ You are the contract owner\n');

  // Update oracle address
  console.log('📝 Updating ETH oracle address...');
  console.log(`   Old: (checking...)`);
  console.log(`   New: ${NEW_ETH_ORACLE}`);
  
  try {
    const tx = await kashYield.setOracle(ethers.ZeroAddress, NEW_ETH_ORACLE);
    console.log(`\n   Transaction sent: ${tx.hash}`);
    console.log('   Waiting for confirmation...');
    
    const receipt = await tx.wait();
    console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
    
    // Verify the update
    const newOracle = await kashYield.tokenOracles(ethers.ZeroAddress);
    console.log(`\n   ✅ Verified: ETH oracle is now set to ${newOracle}`);
  } catch (error: any) {
    console.error('   ❌ Error updating oracle:', error.message);
    if (error.reason) {
      console.error('   Revert reason:', error.reason);
    }
    if (error.data) {
      console.error('   Error data:', error.data);
    }
    throw error;
  }

  console.log('\n✅ Oracle address updated successfully!');
  console.log('   You can verify by running: npm run net-position');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
