import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  baseAccount,
  safeWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { kashRabbyWallet, kashRainbowWallet } from '@/lib/kashWallets';
import { arbitrum } from 'wagmi/chains';
import { http } from 'wagmi';
import type { Config } from 'wagmi';

const arbitrumOneRpc =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_RPC_URL?.trim()) ||
  'https://arb1.arbitrum.io/rpc';

const appUrl =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_APP_URL?.trim()) ||
  'https://kashyield.com';

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

const wallets = [
  {
    groupName: 'Popular',
    wallets: [
      kashRabbyWallet,
      safeWallet,
      kashRainbowWallet,
      baseAccount,
      walletConnectWallet,
    ],
  },
];

export const config: Config = getDefaultConfig({
  appName: 'KashYield',
  appUrl,
  appDescription: 'KASH yield protocol on Arbitrum One',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID',
  chains: [arbitrum],
  transports: {
    [arbitrum.id]: http(arbitrumOneRpc),
  },
  wallets,
  ssr: false,
});
