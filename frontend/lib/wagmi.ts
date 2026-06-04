import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  baseAccount,
  rabbyWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { arbitrum } from 'wagmi/chains';
import { http } from 'wagmi';
import type { Config } from 'wagmi';

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

const wallets = [
  {
    groupName: 'Recommended',
    wallets: [rabbyWallet],
  },
  {
    groupName: 'Popular',
    wallets: [safeWallet, rainbowWallet, baseAccount, walletConnectWallet],
  },
];

export const config: Config = getDefaultConfig({
  appName: 'KashYield',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID',
  chains: [arbitrum],
  transports: {
    [arbitrum.id]: http(arbitrumOneRpc),
  },
  wallets,
  ssr: false,
});
