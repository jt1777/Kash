import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { arbitrumSepolia } from 'wagmi/chains';
import { http } from 'wagmi';
import type { Config } from 'wagmi';

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
      appName: 'KashYieldETH',
      projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID',
      chains: [arbitrumSepolia],
      transports: {
        [arbitrumSepolia.id]: http('https://sepolia-rollup.arbitrum.io/rpc'),
      },
      ssr: false,
    });
  }
  return config;
}
