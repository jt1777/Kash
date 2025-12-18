import { ethers } from 'ethers';
import { config } from '../config';

/**
 * Validate bot configuration
 * @throws Error if configuration is invalid
 */
export function validateConfig(): void {
  const errors: string[] = [];

  // Check contract address
  if (!config.kashYieldAddress) {
    errors.push('KASH_YIELD_ADDRESS is not set in environment variables');
  } else if (!ethers.isAddress(config.kashYieldAddress)) {
    errors.push(`Invalid KASH_YIELD_ADDRESS format: ${config.kashYieldAddress}`);
  }

  // Check RPC URL
  if (!config.rpcUrl) {
    errors.push('RPC_URL is not set in environment variables');
  }

  if (errors.length > 0) {
    throw new Error(
      'Configuration errors:\n' +
      errors.map((e) => `  - ${e}`).join('\n') +
      '\n\nPlease check your .env file and ensure all required variables are set.'
    );
  }
}

/**
 * Verify contract exists at address
 * @param provider Ethers provider
 * @throws Error if contract doesn't exist
 */
export async function verifyContract(provider: ethers.Provider): Promise<void> {
  const code = await provider.getCode(config.kashYieldAddress);
  if (code === '0x') {
    throw new Error(
      `No contract found at address ${config.kashYieldAddress}.\n` +
      `This usually means:\n` +
      `  1. The contract is not deployed at this address\n` +
      `  2. The address is incorrect\n` +
      `  3. You're connected to the wrong network\n\n` +
      `Please verify:\n` +
      `  - KASH_YIELD_ADDRESS in .env matches your deployed contract\n` +
      `  - RPC_URL points to the correct network (Arbitrum Mainnet/Testnet)`
    );
  }
}
