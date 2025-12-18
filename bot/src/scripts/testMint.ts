import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

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

  console.log('🧪 Testing ETH Mint');
  console.log('═'.repeat(60));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`From: ${wallet.address}`);
  console.log(`Network: ${config.rpcUrl}\n`);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`💰 Wallet Balance: ${ethers.formatEther(balance)} ETH\n`);

  if (balance < ethers.parseEther('0.001')) {
    throw new Error('Insufficient balance for testing (need at least 0.001 ETH)');
  }

  // Check contract state first
  const paused = await kashYield.paused();
  const isUserWindow = await kashYield.isUserWindow();
  const ethSupported = await kashYield.isSupportedToken(ethers.ZeroAddress);

  console.log('📋 Pre-flight Checks:');
  console.log(`   Contract Paused: ${paused ? '❌ YES' : '✅ NO'}`);
  console.log(`   User Window Open: ${isUserWindow ? '✅ YES' : '❌ NO'}`);
  console.log(`   ETH Supported: ${ethSupported ? '✅ YES' : '❌ NO'}\n`);

  if (paused) {
    throw new Error('Contract is paused - cannot mint');
  }

  if (!isUserWindow) {
    throw new Error('Not in user window - cannot mint (must be before 23:50 UTC)');
  }

  if (!ethSupported) {
    throw new Error('ETH is not supported - this should never happen!');
  }

  // Try to estimate gas first (this will show us if the call would fail)
  const mintAmount = ethers.parseEther('0.001'); // 0.001 ETH
  console.log(`💸 Attempting to mint with: ${ethers.formatEther(mintAmount)} ETH\n`);

  try {
    console.log('📊 Estimating gas...');
    const gasEstimate = await kashYield.requestMint.estimateGas(
      ethers.ZeroAddress, // ETH address
      0, // amount (ignored for ETH, uses msg.value)
      { value: mintAmount }
    );
    console.log(`   ✅ Gas estimate: ${gasEstimate.toString()}\n`);
  } catch (error: any) {
    console.error('   ❌ Gas estimation failed!');
    console.error(`   Error: ${error.message}`);
    if (error.reason) {
      console.error(`   Revert Reason: ${error.reason}`);
    }
    if (error.data) {
      console.error(`   Error Data: ${error.data}`);
    }
    throw error;
  }

  // If gas estimation passed, try the actual transaction
  console.log('🚀 Sending transaction...');
  try {
    const tx = await kashYield.requestMint(
      ethers.ZeroAddress, // ETH address
      0, // amount (ignored for ETH)
      { 
        value: mintAmount,
        gasLimit: 500000 // Set a reasonable gas limit
      }
    );
    console.log(`   ✅ Transaction sent: ${tx.hash}`);
    console.log('   Waiting for confirmation...\n');
    
    const receipt = await tx.wait();
    console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
    
    // Check for MintRequested event
    const mintEvent = receipt.logs.find((log: any) => {
      try {
        const parsed = kashYield.interface.parseLog(log);
        return parsed?.name === 'MintRequested';
      } catch {
        return false;
      }
    });

    if (mintEvent) {
      const parsed = kashYield.interface.parseLog(mintEvent);
      console.log(`\n   🎉 Mint Request Successful!`);
      console.log(`   User: ${parsed?.args.user}`);
      console.log(`   Token: ${parsed?.args.tokenIn}`);
      console.log(`   Amount: ${ethers.formatEther(parsed?.args.amountIn)} ETH`);
      console.log(`   Batch Cycle: ${parsed?.args.batchCycle}`);
    }

  } catch (error: any) {
    console.error('   ❌ Transaction failed!');
    console.error(`   Error: ${error.message}`);
    if (error.reason) {
      console.error(`   Revert Reason: ${error.reason}`);
    }
    if (error.data) {
      console.error(`   Error Data: ${error.data}`);
    }
    if (error.transaction) {
      console.error(`   Transaction: ${JSON.stringify(error.transaction, null, 2)}`);
    }
    throw error;
  }

  console.log('\n✅ Test complete!');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  });
