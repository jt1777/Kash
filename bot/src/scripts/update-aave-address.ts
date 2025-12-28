import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Script to update the deployed contract's Aave Pool address to the real Aave
 * This is needed because the contract was deployed before we updated the source code
 */
async function main() {
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not set in .env - needed to send transactions');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    wallet
  );

  console.log('🔄 Updating Aave Pool Address\n');
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`From: ${wallet.address}\n`);

  // Check current address
  const currentAddress = await kashYield.aavePoolAddress();
  const realAaveAddress = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951';
  const mockAaveAddress = '0x1Fbe5029cC02e7bF88AB8d0082272655399379E8';

  console.log(`Current Aave Pool Address: ${currentAddress}`);

  if (currentAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
    console.log('\n✅ Contract is already using the real Aave V3 Pool!');
    console.log('   No update needed.');
    return;
  }

  // Check if we're the owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`You are not the contract owner! Owner is: ${owner}`);
  }
  console.log('✅ You are the contract owner\n');

  if (currentAddress.toLowerCase() === mockAaveAddress.toLowerCase()) {
    console.log('⚠️  Contract is using MockAaveV3');
    console.log(`   Will update to real Aave: ${realAaveAddress}\n`);
  } else {
    console.log(`⚠️  Contract is using unknown address: ${currentAddress}`);
    console.log(`   Will update to real Aave: ${realAaveAddress}\n`);
  }

  // Update the address
  console.log('📝 Updating Aave Pool address...');
  try {
    const tx = await kashYield.setAavePool(realAaveAddress);
    console.log(`   Transaction sent: ${tx.hash}`);
    console.log(`   Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    console.log(`   ✅ Update confirmed in block ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);

    // Verify the update
    const newAddress = await kashYield.aavePoolAddress();
    if (newAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
      console.log('✅ Successfully updated to real Aave V3 Pool!');
      console.log(`   New address: ${newAddress}`);
    } else {
      console.log('⚠️  Warning: Address update may have failed');
      console.log(`   Expected: ${realAaveAddress}`);
      console.log(`   Got: ${newAddress}`);
    }
  } catch (error: any) {
    console.error(`   ❌ Failed to update: ${error.message}`);
    if (error.reason) {
      console.error(`   Revert reason: ${error.reason}`);
    }
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

