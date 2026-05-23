import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';

/**
 * Token balance information
 */
export interface TokenBalance {
  token: string;
  symbol: string;
  amount: bigint;
  amountFormatted: string;
  usdValue: bigint; // 18 decimals
  usdValueFormatted: string;
}

/**
 * Get all token balances in the contract for a given batch cycle
 * This checks what tokens were actually deposited by users
 * This is legacy code but may be useful in the future, do not delete yet.
 * 
 * @param provider Ethers provider
 * @param batchCycle Batch cycle to check
 * @returns Array of token balances with USD values
 */
export async function getContractBalances(
  provider: ethers.Provider,
  batchCycle: bigint
): Promise<TokenBalance[]> {
  if (!config.kashYieldAddress || !ethers.isAddress(config.kashYieldAddress)) {
    throw new Error('Invalid KASH_YIELD_ADDRESS in configuration');
  }

  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  const balances: TokenBalance[] = [];

  // Get token addresses from contract
  const ethAddress = ethers.ZeroAddress;
  const wethAddress = await kashYield.wethAddress();
  const wbtcAddress = await kashYield.wbtcAddress();
  const usdtAddress = await kashYield.usdtAddress();
  const usdcAddress = await kashYield.usdcAddress();

  // Get batch mints by token (if available in ABI)
  // For now, we'll check actual contract balances and query events
  const supportedTokens = [
    { address: ethAddress, symbol: 'ETH', decimals: 18 },
    { address: wethAddress, symbol: 'WETH', decimals: 18 },
    { address: wbtcAddress, symbol: 'WBTC', decimals: 8 },
    { address: usdtAddress, symbol: 'USDT', decimals: 6 },
    { address: usdcAddress, symbol: 'USDC', decimals: 6 },
  ];

  console.log('📊 Checking contract balances for batch cycle:', batchCycle.toString());

  for (const token of supportedTokens) {
    let balance: bigint;
    let amountFormatted: string;

    if (token.address === ethAddress) {
      // Check ETH balance
      balance = await provider.getBalance(config.kashYieldAddress);
      amountFormatted = ethers.formatEther(balance);
    } else {
      // Check ERC20 balance
      const erc20ABI = [
        {
          inputs: [{ name: 'account', type: 'address' }],
          name: 'balanceOf',
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        },
      ];
      const tokenContract = new ethers.Contract(token.address, erc20ABI, provider);
      balance = await tokenContract.balanceOf(config.kashYieldAddress);
      amountFormatted = ethers.formatUnits(balance, token.decimals);
    }

    if (balance > 0n) {
      // Calculate USD value using contract's getTokenUSD
      try {
        const usdValue = await kashYield.getTokenUSD(token.address, balance);
        const usdValueBigInt = BigInt(usdValue.toString());
        const usdValueFormatted = ethers.formatEther(usdValueBigInt);

        balances.push({
          token: token.address,
          symbol: token.symbol,
          amount: balance,
          amountFormatted,
          usdValue: usdValueBigInt,
          usdValueFormatted,
        });

        console.log(`   ${token.symbol}: ${amountFormatted} ($${usdValueFormatted})`);
      } catch (error: any) {
        console.warn(`   ⚠️  Could not get USD value for ${token.symbol}: ${error.message}`);
      }
    }
  }

  return balances;
}

/**
 * Get token balances from batch events (more accurate for pending batch)
 * This queries MintRequested events to see what was actually deposited
 */
export async function getBalancesFromEvents(
  provider: ethers.Provider,
  batchCycle: bigint
): Promise<TokenBalance[]> {
  if (!config.kashYieldAddress || !ethers.isAddress(config.kashYieldAddress)) {
    throw new Error('Invalid KASH_YIELD_ADDRESS in configuration');
  }

  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    provider
  );

  // Query all MintRequested events for this batch
  const currentBlock = await provider.getBlockNumber();
  const allMintEvents = await kashYield.queryFilter(
    kashYield.filters.MintRequested(),
    undefined,
    currentBlock
  );

  // Filter by batch cycle and aggregate by token
  const tokenAmounts = new Map<string, bigint>();
  const tokenSymbols = new Map<string, string>();

  for (const event of allMintEvents) {
    if ('args' in event && event.args) {
      const args = event.args as any;
      const eventBatchCycle = BigInt(args.batchCycle?.toString() || '0');
      
      if (eventBatchCycle === batchCycle) {
        const tokenIn = args.tokenIn as string;
        const amountIn = BigInt(args.amountIn?.toString() || '0');
        
        // Determine symbol
        let symbol = 'UNKNOWN';
        if (tokenIn === ethers.ZeroAddress) {
          symbol = 'ETH';
        } else {
          // Try to get symbol from contract or use address
          try {
            const wethAddress = await kashYield.wethAddress();
            const wbtcAddress = await kashYield.wbtcAddress();
            const usdtAddress = await kashYield.usdtAddress();
            const usdcAddress = await kashYield.usdcAddress();
            
            if (tokenIn.toLowerCase() === wethAddress.toLowerCase()) symbol = 'WETH';
            else if (tokenIn.toLowerCase() === wbtcAddress.toLowerCase()) symbol = 'WBTC';
            else if (tokenIn.toLowerCase() === usdtAddress.toLowerCase()) symbol = 'USDT';
            else if (tokenIn.toLowerCase() === usdcAddress.toLowerCase()) symbol = 'USDC';
          } catch (error) {
            // Keep as UNKNOWN
          }
        }
        
        const current = tokenAmounts.get(tokenIn) || 0n;
        tokenAmounts.set(tokenIn, current + amountIn);
        tokenSymbols.set(tokenIn, symbol);
      }
    }
  }

  // Convert to TokenBalance array
  const balances: TokenBalance[] = [];
  
  for (const [tokenAddress, amount] of tokenAmounts.entries()) {
    const symbol = tokenSymbols.get(tokenAddress) || 'UNKNOWN';
    
    // Determine decimals
    let decimals = 18;
    if (symbol === 'WBTC') decimals = 8;
    else if (symbol === 'USDT' || symbol === 'USDC') decimals = 6;
    
    const amountFormatted = tokenAddress === ethers.ZeroAddress
      ? ethers.formatEther(amount)
      : ethers.formatUnits(amount, decimals);
    
    // Get USD value
    try {
      const usdValue = await kashYield.getTokenUSD(tokenAddress, amount);
      const usdValueBigInt = BigInt(usdValue.toString());
      const usdValueFormatted = ethers.formatEther(usdValueBigInt);
      
      balances.push({
        token: tokenAddress,
        symbol,
        amount,
        amountFormatted,
        usdValue: usdValueBigInt,
        usdValueFormatted,
      });
    } catch (error: any) {
      console.warn(`Could not get USD value for ${symbol}: ${error.message}`);
    }
  }

  return balances;
}
