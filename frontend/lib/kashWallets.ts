import {
  getWalletConnectConnector,
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

/** Rabby mobile universal link (WalletConnect). */
function rabbyMobileUri(uri: string): string {
  return `https://rabby.io/wc?uri=${encodeURIComponent(uri)}`;
}

/** Rainbow mobile universal link — avoids iOS blocking `rainbow://` custom schemes. */
function rainbowMobileUri(uri: string): string {
  return `https://rnbwapp.com/wc?uri=${encodeURIComponent(uri)}&connector=rainbowkit`;
}

/**
 * Desktop: injected Rabby extension.
 * Mobile browser: WalletConnect + Rabby app deep link (stock rabbyWallet is extension-only).
 */
export function kashRabbyWallet({
  projectId,
  walletConnectParameters,
}: KashWalletOptions): Wallet {
  const extensionWallet = rabbyWallet();
  const isInjected = hasRabbyInjected();
  const useWalletConnect = isMobileBrowser() && !isInjected;

  const downloadUrls = {
    ...extensionWallet.downloadUrls,
    ios: RABBY_IOS,
    android: RABBY_ANDROID,
    mobile: 'https://rabby.io/',
  };

  if (!useWalletConnect) {
    return {
      ...extensionWallet,
      downloadUrls,
      installed: isInjected || (isMobileBrowser() ? undefined : extensionWallet.installed),
    };
  }

  return {
    ...extensionWallet,
    installed: undefined,
    downloadUrls,
    mobile: { getUri: rabbyMobileUri },
    qrCode: {
      getUri: rabbyMobileUri,
      instructions: {
        learnMoreUrl: 'https://rabby.io/',
        steps: [
          {
            step: 'install',
            title: 'Install Rabby Mobile',
            description: 'Get Rabby from the App Store or Google Play.',
          },
          {
            step: 'create',
            title: 'Open Rabby',
            description: 'Return here and tap Rabby again to approve the connection.',
          },
          {
            step: 'refresh',
            title: 'Stay in the browser',
            description:
              'If Rabby does not open automatically, open the app manually and approve the pending WalletConnect request.',
          },
        ],
      },
    },
    createConnector: getWalletConnectConnector({
      projectId,
      walletConnectParameters,
    }),
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
