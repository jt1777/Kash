import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { arbitrum } from 'wagmi/chains';
import { http } from 'wagmi';
import type { Config } from 'wagmi';
import { defineChain } from 'viem';

const hardhat = defineChain({
  id: 31337,
  name: 'Hardhat',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  blockExplorers: {
    default: { name: 'Hardhat', url: 'http://localhost:8545' },
  },
});

const arbitrumOneRpc =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_RPC_URL?.trim()) ||
  'https://arb1.arbitrum.io/rpc';

// localStorage shim for SSR
if (typeof window === 'undefined' && typeof global !== 'undefined') {
  const storage: Record<string, string> = {};
  (global as any).localStorage = {
    getItem: (key: string) => storage[key] || null,
    setItem: (key: string, value: string) => { storage[key] = String(value); },
    removeItem: (key: string) => { delete storage[key]; },
    clear: () => { Object.keys(storage).forEach(key => delete storage[key]); },
    key: (index: number) => Object.keys(storage)[index] || null,
    get length() { return Object.keys(storage).length; },
  };
}

let config: Config | null = null;

export function getConfig(): Config {
  if (!config) {
    config = getDefaultConfig({
      appName: 'KashYield',
      projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID',
      chains: [arbitrum, hardhat],
      transports: {
        [arbitrum.id]: http(arbitrumOneRpc),
        [hardhat.id]: http('http://127.0.0.1:8545'),
      },
      ssr: false,
    });
  }
  return config;
}
