import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { arbitrumSepolia, arbitrum } from 'wagmi/chains';
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
      appName: 'KashYield',
      projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID',
      chains: [arbitrumSepolia, arbitrum],
      ssr: false,
    });
  }
  return config;
}
