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

function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * RainbowKit mobile only lists wallets with ready=true (installed ?? true).
 * Stock rabbyWallet sets installed=false without the extension, so Rabby is
 * omitted from the mobile row. On mobile, leave installed unset so Rabby appears
 * first under Popular with app-store download links.
 */
function kashRabbyWallet(): ReturnType<typeof rabbyWallet> {
  const wallet = rabbyWallet();
  if (!isMobileBrowser()) return wallet;

  return {
    ...wallet,
    installed: undefined,
    downloadUrls: {
      ...wallet.downloadUrls,
      ios: 'https://apps.apple.com/app/rabby-wallet/id6450663781',
      android:
        'https://play.google.com/store/apps/details?id=com.debank.rabbymobile',
    },
  };
}

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
    groupName: 'Popular',
    wallets: [
      kashRabbyWallet,
      safeWallet,
      rainbowWallet,
      baseAccount,
      walletConnectWallet,
    ],
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
