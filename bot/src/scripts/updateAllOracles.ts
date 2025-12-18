import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

/**
 * Update all oracle addresses on the KashYield contract to use Arbitrum Sepolia testnet addresses
 * 
 * NOTE: Chainlink does NOT provide a BTC/USD feed on Arbitrum Sepolia.
 * The BTC address below is a MOCK oracle with a hardcoded $60,000 price.
 * For production, you would need to use Arbitrum Mainnet or find an alternative solution.
 */
const SEPOLIA_ORACLES = {
  ETH: '0x2d3bBa5e0A9Fd8EAa45Dcf71A2389b7C12005b1f', // Arbitrum Sepolia ETH/USD (real Chainlink feed)
  BTC: '0xBfFE5FE928F9597E2A21Ba8f2cDE7D2D10C09d27', // MOCK BTC/USD (hardcoded $60k, no real feed available)
  USDT: '0x78a59DD416d0CE4AbfD2e27BFd2f6bFdceC446e3', // Arbitrum Sepolia USDT/USD (real Chainlink feed)
  USDC: '0xed45CBB45d34F53bf14C70e6FC2711bDd6454E76', // Arbitrum Sepolia USDC/USD (real Chainlink feed)
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

  console.log('🔧 Updating All Oracle Addresses to Sepolia Testnet');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`From: ${wallet.address}`);
  console.log(`Network: ${config.rpcUrl}\n`);

  // Check current oracles
  console.log('📋 Current Oracle Addresses:');
  const currentOracles: Record<string, string> = {};
  try {
    currentOracles.ETH = await kashYield.tokenOracles(ethers.ZeroAddress);
    // Get WETH address to check its oracle
    const wethAddress = await kashYield.wethAddress();
    currentOracles.WETH = await kashYield.tokenOracles(wethAddress);
    const wbtcAddress = await kashYield.wbtcAddress();
    currentOracles.BTC = await kashYield.tokenOracles(wbtcAddress);
    const usdtAddress = await kashYield.usdtAddress();
    currentOracles.USDT = await kashYield.tokenOracles(usdtAddress);
    const usdcAddress = await kashYield.usdcAddress();
    currentOracles.USDC = await kashYield.tokenOracles(usdcAddress);

    console.log(`   ETH:  ${currentOracles.ETH}`);
    console.log(`   WETH: ${currentOracles.WETH}`);
    console.log(`   BTC:  ${currentOracles.BTC}`);
    console.log(`   USDT: ${currentOracles.USDT}`);
    console.log(`   USDC: ${currentOracles.USDC}`);
  } catch (error: any) {
    console.log(`   Could not read all current oracles: ${error.message}`);
  }

  // Verify new oracles exist
  console.log('\n🔍 Verifying new oracle addresses...');
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

  for (const [token, oracleAddress] of Object.entries(SEPOLIA_ORACLES)) {
    try {
      const code = await provider.getCode(oracleAddress);
      if (code === '0x') {
        console.log(`   ⚠️  ${token}: Oracle does not exist at ${oracleAddress}`);
        continue;
      }
      const oracle = new ethers.Contract(oracleAddress, oracleABI, provider);
      const priceData = await oracle.latestRoundData();
      const decimals = await oracle.decimals();
      const price = Number(priceData.answer) / 10 ** Number(decimals);
      const isMock = token === 'BTC' ? ' (MOCK - hardcoded)' : '';
      console.log(`   ✅ ${token}: Valid (Price: $${price.toFixed(2)}${isMock})`);
    } catch (error: any) {
      console.log(`   ⚠️  ${token}: Could not verify - ${error.message}`);
    }
  }
  
  if (SEPOLIA_ORACLES.BTC) {
    console.log(`\n   ⚠️  NOTE: BTC oracle is a MOCK with hardcoded $60k price.`);
    console.log(`   Chainlink does not provide BTC/USD feed on Arbitrum Sepolia.\n`);
  }

  // Check owner
  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`You are not the contract owner! Owner is: ${owner}`);
  }

  console.log('\n✅ You are the contract owner\n');

  // Update oracles
  console.log('📝 Updating oracle addresses...\n');
  
  const updates: Array<{ token: string; address: string; oldAddress: string }> = [];
  
  // Update ETH oracle (address(0))
  if (currentOracles.ETH?.toLowerCase() !== SEPOLIA_ORACLES.ETH.toLowerCase()) {
    updates.push({ token: 'ETH', address: SEPOLIA_ORACLES.ETH, oldAddress: currentOracles.ETH || 'unknown' });
  }

  // Get token addresses for other tokens
  const wethAddress = await kashYield.wethAddress();
  const wbtcAddress = await kashYield.wbtcAddress();
  const usdtAddress = await kashYield.usdtAddress();
  const usdcAddress = await kashYield.usdcAddress();

  // Update WETH oracle (same as ETH)
  if (currentOracles.WETH?.toLowerCase() !== SEPOLIA_ORACLES.ETH.toLowerCase()) {
    updates.push({ token: 'WETH', address: SEPOLIA_ORACLES.ETH, oldAddress: currentOracles.WETH || 'unknown' });
  }

  // Update BTC oracle
  if (currentOracles.BTC?.toLowerCase() !== SEPOLIA_ORACLES.BTC.toLowerCase()) {
    updates.push({ token: 'BTC', address: SEPOLIA_ORACLES.BTC, oldAddress: currentOracles.BTC || 'unknown' });
  }

  // Update USDT oracle
  if (currentOracles.USDT?.toLowerCase() !== SEPOLIA_ORACLES.USDT.toLowerCase()) {
    updates.push({ token: 'USDT', address: SEPOLIA_ORACLES.USDT, oldAddress: currentOracles.USDT || 'unknown' });
  }

  // Update USDC oracle
  if (currentOracles.USDC?.toLowerCase() !== SEPOLIA_ORACLES.USDC.toLowerCase()) {
    updates.push({ token: 'USDC', address: SEPOLIA_ORACLES.USDC, oldAddress: currentOracles.USDC || 'unknown' });
  }

  if (updates.length === 0) {
    console.log('✅ All oracles are already set to the correct addresses!');
    return;
  }

  console.log(`Found ${updates.length} oracle(s) to update:\n`);
  for (const update of updates) {
    console.log(`   ${update.token}:`);
    console.log(`     Old: ${update.oldAddress}`);
    console.log(`     New: ${update.address}\n`);
  }

  // Execute updates
  for (const update of updates) {
    try {
      let tokenAddress: string;
      if (update.token === 'ETH') {
        tokenAddress = ethers.ZeroAddress;
      } else if (update.token === 'WETH') {
        tokenAddress = wethAddress;
      } else if (update.token === 'BTC') {
        tokenAddress = wbtcAddress;
      } else if (update.token === 'USDT') {
        tokenAddress = usdtAddress;
      } else if (update.token === 'USDC') {
        tokenAddress = usdcAddress;
      } else {
        throw new Error(`Unknown token: ${update.token}`);
      }

      console.log(`📤 Updating ${update.token} oracle...`);
      const tx = await kashYield.setOracle(tokenAddress, update.address);
      console.log(`   Transaction sent: ${tx.hash}`);
      console.log('   Waiting for confirmation...');
      
      const receipt = await tx.wait();
      console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
      console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
    } catch (error: any) {
      console.error(`   ❌ Error updating ${update.token}:`, error.message);
      if (error.reason) {
        console.error('   Revert reason:', error.reason);
      }
      throw error;
    }
  }

  // Verify all updates
  console.log('🔍 Verifying updates...\n');
  const verifyOracles: Record<string, string> = {};
  verifyOracles.ETH = await kashYield.tokenOracles(ethers.ZeroAddress);
  verifyOracles.WETH = await kashYield.tokenOracles(wethAddress);
  verifyOracles.BTC = await kashYield.tokenOracles(wbtcAddress);
  verifyOracles.USDT = await kashYield.tokenOracles(usdtAddress);
  verifyOracles.USDC = await kashYield.tokenOracles(usdcAddress);

  console.log('✅ Final Oracle Addresses:');
  console.log(`   ETH:  ${verifyOracles.ETH}`);
  console.log(`   WETH: ${verifyOracles.WETH}`);
  console.log(`   BTC:  ${verifyOracles.BTC}`);
  console.log(`   USDT: ${verifyOracles.USDT}`);
  console.log(`   USDC: ${verifyOracles.USDC}`);

  console.log('\n✅ All oracle addresses updated successfully!');
  console.log('   You can verify by running: npm run net-position');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
