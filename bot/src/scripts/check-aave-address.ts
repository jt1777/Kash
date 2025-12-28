import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Quick script to check what Aave address the deployed contract is using
 */
async function main() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  console.log('🔍 Checking Deployed Contract Aave Address\n');
  console.log(`Contract: ${config.kashYieldAddress}\n`);

  const aavePoolAddress = await kashYield.aavePoolAddress();
  const realAaveAddress = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951';
  const mockAaveAddress = '0x1Fbe5029cC02e7bF88AB8d0082272655399379E8';

  console.log(`Current Aave Pool Address: ${aavePoolAddress}\n`);

  if (aavePoolAddress.toLowerCase() === realAaveAddress.toLowerCase()) {
    console.log('✅ Contract is using REAL Aave V3 Pool');
    console.log('   No update needed!');
  } else if (aavePoolAddress.toLowerCase() === mockAaveAddress.toLowerCase()) {
    console.log('⚠️  Contract is using MockAaveV3');
    console.log(`   Need to update to: ${realAaveAddress}`);
    console.log('\n   To update, run:');
    console.log(`   await kashYield.setAavePool("${realAaveAddress}")`);
  } else {
    console.log('⚠️  Contract is using an unknown Aave address');
    console.log(`   Expected real Aave: ${realAaveAddress}`);
    console.log(`   Expected mock Aave: ${mockAaveAddress}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

