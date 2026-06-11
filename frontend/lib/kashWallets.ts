import {
  type RainbowKitWalletConnectParameters,
  type Wallet,
} from '@rainbow-me/rainbowkit';
import { rabbyWallet, rainbowWallet } from '@rainbow-me/rainbowkit/wallets';

type KashWalletOptions = {
  projectId: string;
  walletConnectParameters?: RainbowKitWalletConnectParameters;
};

const RABBY_IOS =
  'https://apps.apple.com/app/rabby-wallet/id6450663781';
const RABBY_ANDROID =
  'https://play.google.com/store/apps/details?id=com.debank.rabbymobile';

function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function hasRabbyInjected(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as Window & { ethereum?: { isRabby?: boolean } }).ethereum?.isRabby,
  );
}

function hasRainbowInjected(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as Window & { ethereum?: { isRainbow?: boolean } }).ethereum
      ?.isRainbow,
  );
}

/** Rainbow mobile universal link — avoids iOS blocking `rainbow://` custom schemes. */
function rainbowMobileUri(uri: string): string {
  return `https://rnbwapp.com/wc?uri=${encodeURIComponent(uri)}&connector=rainbowkit`;
}

/**
 * Desktop: injected Rabby extension.
 * Rabby Mobile: only show direct Rabby inside Rabby's in-app browser, where it injects a provider.
 * External mobile browsers do not reliably hand WalletConnect URIs to Rabby Mobile.
 */
export function kashRabbyWallet(_options: KashWalletOptions): Wallet {
  const extensionWallet = rabbyWallet();
  const isInjected = hasRabbyInjected();
  const isMobile = isMobileBrowser();

  const downloadUrls = {
    ...extensionWallet.downloadUrls,
    ios: RABBY_IOS,
    android: RABBY_ANDROID,
    mobile: 'https://rabby.io/',
  };

  return {
    ...extensionWallet,
    downloadUrls,
    installed: isInjected || (isMobile ? undefined : extensionWallet.installed),
    hidden: () => isMobileBrowser() && !hasRabbyInjected(),
  };
}

/** Prefer Rainbow universal links on mobile instead of blocked custom URL schemes. */
export function kashRainbowWallet(options: KashWalletOptions): Wallet {
  const wallet = rainbowWallet(options);
  if (!isMobileBrowser() || hasRainbowInjected()) return wallet;

  return {
    ...wallet,
    mobile: { getUri: rainbowMobileUri },
    qrCode: wallet.qrCode
      ? { ...wallet.qrCode, getUri: rainbowMobileUri }
      : undefined,
  };
}
