import { CONTRACTS } from '@/lib/contracts/addresses';
import { kashVaultBtcABI } from '@/lib/contracts/kashVaultBtcABI';
import { kashVaultEthABI } from '@/lib/contracts/kashVaultEthABI';

export type VaultProduct = 'eth' | 'btc';

/** One ABI per vault — do not merge ETH+BTC selectors. */
export function vaultAbi(product: VaultProduct) {
  return product === 'btc' ? kashVaultBtcABI : kashVaultEthABI;
}

export function vaultAbiForAddress(address: `0x${string}` | undefined) {
  if (address && address.toLowerCase() === CONTRACTS.kashYieldBtc.toLowerCase()) {
    return kashVaultBtcABI;
  }
  return kashVaultEthABI;
}
