'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEnsAvatar, useEnsName } from 'wagmi';
import { normalize } from 'viem/ens';
import { mainnet } from 'wagmi/chains';
import { MintForm } from '@/components/MintForm';
import { RedeemForm } from '@/components/RedeemForm';
import { RecentActivity } from '@/components/RecentActivity';
import { StatsCard } from '@/components/StatsCard';
import { StatusIndicator } from '@/components/StatusIndicator';
import { ClientOnly } from '@/components/ClientOnly';
import { SiteFooter } from '@/components/SiteFooter';
import { CONTRACTS, isConfiguredAddress } from '@/lib/contracts/addresses';
import { useState } from 'react';
import { useAccount } from 'wagmi';
import Link from 'next/link';

function WalletAvatar({ address, fallbackUrl, size = 24 }: { address: `0x${string}`; fallbackUrl?: string; size?: number }) {
  const { data: ensName } = useEnsName({ address, chainId: mainnet.id });
  const { data: ensAvatar } = useEnsAvatar({
    name: ensName ? normalize(ensName) : undefined,
    chainId: mainnet.id,
    query: { enabled: !!ensName },
  });
  const avatarUrl = ensAvatar ?? fallbackUrl;
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className="rounded-full shrink-0"
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    );
  }
  const hue = parseInt(address.slice(2, 8), 16) % 360;
  return (
    <div
      className="rounded-full shrink-0 flex items-center justify-center"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue}, 65%, 55%), hsl(${hue}, 55%, 40%))`,
        color: 'white',
      }}
      title={address}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
        <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
        <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z" />
      </svg>
    </div>
  );
}

function CustomWalletButton() {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        authenticationStatus,
        mounted,
      }) => {
        const ready = mounted && authenticationStatus !== 'loading';
        const connected =
          ready &&
          account &&
          chain &&
          (!authenticationStatus || authenticationStatus === 'authenticated');

        if (!ready) {
          return (
            <div aria-hidden style={{ opacity: 0, pointerEvents: 'none', userSelect: 'none' }}>
              <div className="h-10 w-32 rounded-full bg-white/10" />
            </div>
          );
        }
        if (!connected) {
          return (
            <button
              onClick={openConnectModal}
              type="button"
              className="rounded-full px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition"
            >
              Connect Wallet
            </button>
          );
        }
        if (chain.unsupported) {
          return (
            <button
              onClick={() => openChainModal?.()}
              type="button"
              className="rounded-full px-4 py-2 text-sm font-medium bg-amber-500 hover:bg-amber-600 text-white"
            >
              Wrong network
            </button>
          );
        }
        return (
          <div className="flex items-center gap-2">
            <button
              onClick={() => openChainModal?.()}
              type="button"
              className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 bg-white/10 hover:bg-white/15 border border-white/20 transition cursor-pointer"
            >
              {chain.hasIcon && chain.iconUrl && (
                <span
                  className="flex h-5 w-5 rounded-full overflow-hidden shrink-0"
                  style={{ background: chain.iconBackground }}
                >
                  <img src={chain.iconUrl} alt={chain.name ?? 'Chain'} className="h-5 w-5" />
                </span>
              )}
              <span className="text-white">{chain.name ?? 'Unknown'}</span>
            </button>
            <button
              onClick={openAccountModal}
              type="button"
              className="flex items-center gap-2 rounded-full pl-1 pr-3 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 bg-white/10 hover:bg-white/15 border border-white/20 transition cursor-pointer"
            >
              <WalletAvatar address={account.address as `0x${string}`} fallbackUrl={account.ensAvatar} size={24} />
              <span className="text-white">{account.displayName}</span>
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function AppContent() {
  const { address, status, isConnected } = useAccount();
  const showMintRedeem = isConnected;
  const isWalletSettling = status === 'connecting' || status === 'reconnecting';
  const [product, setProduct] = useState<'eth' | 'btc'>(() =>
    isConfiguredAddress(CONTRACTS.kashYieldBtc) ? 'btc' : 'eth'
  );
  const showBtcTab = isConfiguredAddress(CONTRACTS.kashYieldBtc);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        .app-page {
          font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
          background: #0A0A1E;
          color: #FFFFFF;
          line-height: 1.6;
          min-height: 100vh;
          position: relative;
          overflow-x: hidden;
        }
        .app-page::before {
          content: '';
          position: fixed;
          inset: 0;
          background-image:
            linear-gradient(rgba(0, 255, 255, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 255, 255, 0.03) 1px, transparent 1px);
          background-size: 40px 40px;
          pointer-events: none;
          z-index: 0;
        }
        .app-page::after {
          content: '';
          position: fixed;
          inset: 0;
          background: radial-gradient(ellipse 80% 50% at 50% 0%, rgba(0, 255, 255, 0.06) 0%, transparent 50%);
          pointer-events: none;
          z-index: 0;
        }
        .app-page .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; position: relative; z-index: 1; }
        .app-page .nav {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          padding: 16px 20px;
          background: rgba(10, 10, 30, 0.92);
          backdrop-filter: blur(12px);
          border-bottom: 1px solid rgba(0, 255, 255, 0.2);
          z-index: 100;
          box-shadow: 0 0 20px rgba(0, 255, 255, 0.05);
        }
        .app-page .nav-content {
          max-width: 1200px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: center;
          gap: 24px;
          position: relative;
          z-index: 101;
        }
        .app-page .app-nav-links {
          display: flex;
          align-items: center;
          gap: 24px;
          flex-wrap: wrap;
          justify-self: start;
        }
        .app-page .app-nav-wallet {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          justify-self: end;
        }
        .app-page .nav-logo { font-size: 1.5rem; font-weight: 700; color: #00FFFF; text-decoration: none; text-shadow: 0 0 10px rgba(0, 255, 255, 0.5); }
        .app-page .nav-logo:hover { color: #00FFFF; }
        .app-page .nav-link { color: rgba(255, 255, 255, 0.85); text-decoration: none; font-size: 0.9rem; transition: all 0.3s ease; }
        .app-page .nav-link:hover { color: #00FFFF; text-shadow: 0 0 8px rgba(0, 255, 255, 0.5); }
        .app-page .app-title { color: #00FFFF !important; text-shadow: 0 0 10px rgba(0, 255, 255, 0.4); }
        .app-page .app-subtitle { color: rgba(255, 255, 255, 0.75) !important; }
        .app-page .bg-white { background: rgba(0, 255, 255, 0.03) !important; border-color: rgba(0, 255, 255, 0.2) !important; }
        .app-page .border-gray-100, .app-page .border-gray-200 { border-color: rgba(0, 255, 255, 0.2) !important; }
        .app-page .text-gray-900 { color: #FFFFFF !important; }
        .app-page .text-gray-700 { color: rgba(255, 255, 255, 0.9) !important; }
        .app-page .text-gray-600 { color: rgba(255, 255, 255, 0.85) !important; }
        .app-page .text-gray-500 { color: rgba(255, 255, 255, 0.75) !important; }
        .app-page .bg-indigo-100, .app-page .bg-green-100, .app-page .bg-purple-100, .app-page .bg-blue-100 { background: rgba(0, 255, 255, 0.12) !important; }
        .app-page .text-indigo-600, .app-page .text-green-600, .app-page .text-purple-600, .app-page .text-blue-600 { color: #00FFFF !important; }
        .app-page input { background: rgba(0, 10, 30, 0.9) !important; border: 1px solid rgba(0, 255, 255, 0.3) !important; color: #FFFFFF !important; border-radius: 4px; }
        .app-page input::placeholder { color: rgba(0, 255, 255, 0.4); }
        .app-page input:focus { outline: none; box-shadow: 0 0 0 2px rgba(0, 255, 255, 0.4), 0 0 10px rgba(0, 255, 255, 0.2); border-color: #00FFFF !important; }
        .app-page .border-gray-300 { border-color: rgba(0, 255, 255, 0.25) !important; }
        .app-page .focus\\:ring-indigo-500:focus { box-shadow: 0 0 0 2px rgba(0, 255, 255, 0.4); }
        .app-page button.bg-indigo-600, .app-page .bg-indigo-600 { background: #00FFFF !important; color: #0A0A1E !important; border: 2px solid #00FFFF; box-shadow: 0 0 10px rgba(0, 255, 255, 0.4); }
        .app-page button.bg-indigo-600:hover:not(:disabled), .app-page .hover\\:bg-indigo-700:hover { background: transparent !important; color: #00FFFF !important; box-shadow: 0 0 20px #00FFFF, 0 0 30px rgba(0, 255, 255, 0.3); }
        .app-page .from-indigo-600, .app-page .to-purple-600, .app-page .bg-linear-to-r { background: #00FFFF !important; background-image: none !important; color: #0A0A1E !important; border: 2px solid #00FFFF; box-shadow: 0 0 10px rgba(0, 255, 255, 0.4); }
        .app-page .hover\\:from-indigo-700:hover, .app-page .hover\\:to-purple-700:hover { background: transparent !important; background-image: none !important; color: #00FFFF !important; box-shadow: 0 0 20px #00FFFF, 0 0 30px rgba(0, 255, 255, 0.3); }
        .app-page .bg-purple-600 { background: #00FFFF !important; color: #0A0A1E !important; }
        .app-page .hover\\:bg-purple-700:hover { background: transparent !important; color: #00FFFF !important; box-shadow: 0 0 20px #00FFFF; }
        .app-page .border-indigo-600, .app-page .border-purple-600 { border-color: #00FFFF !important; }
        .app-page .bg-indigo-50, .app-page .bg-purple-50 { background: rgba(0, 255, 255, 0.08) !important; }
        .app-page .text-indigo-700, .app-page .text-purple-700 { color: #00FFFF !important; }
        .app-page .border-gray-200, .app-page .hover\\:border-gray-300:hover { border-color: rgba(0, 255, 255, 0.25) !important; }
        .app-page .disabled\\:bg-gray-300, .app-page .disabled\\:from-gray-300, .app-page .disabled\\:to-gray-400 { background: rgba(0, 255, 255, 0.15) !important; color: rgba(255, 255, 255, 0.6) !important; }
        .app-page .bg-green-50 { background: rgba(0, 255, 255, 0.08) !important; border-color: rgba(0, 255, 255, 0.3) !important; }
        .app-page .border-green-200 { border-color: rgba(0, 255, 255, 0.3) !important; }
        .app-page .text-green-800, .app-page .text-green-700 { color: #00FFFF !important; }
        .app-page .bg-amber-50 { background: rgba(255, 189, 46, 0.12) !important; border-color: rgba(255, 189, 46, 0.35) !important; }
        .app-page .border-amber-200 { border-color: rgba(255, 189, 46, 0.35) !important; }
        .app-page .text-amber-800, .app-page .text-amber-700 { color: #ffbd2e !important; }
        .app-page .bg-orange-50 { background: rgba(255, 189, 46, 0.12) !important; }
        .app-page .border-orange-200 { border-color: rgba(255, 189, 46, 0.35) !important; }
        .app-page .text-orange-800, .app-page .text-orange-900, .app-page .text-orange-700 { color: #ffbd2e !important; }
        .app-page .bg-amber-600, .app-page button.bg-amber-600 { background: #ffbd2e !important; color: #0A0A1E !important; border: 2px solid #ffbd2e; }
        .app-page .hover\\:bg-amber-700:hover { background: transparent !important; color: #ffbd2e !important; box-shadow: 0 0 16px rgba(255, 189, 46, 0.35); }
        .app-page .bg-green-700, .app-page button.bg-green-700 { background: #00FFFF !important; color: #0A0A1E !important; border: 2px solid #00FFFF; box-shadow: 0 0 10px rgba(0, 255, 255, 0.35); }
        .app-page .hover\\:bg-green-800:hover { background: transparent !important; color: #00FFFF !important; box-shadow: 0 0 20px rgba(0, 255, 255, 0.35); }
        .app-page .text-gray-800 { color: rgba(255, 255, 255, 0.9) !important; }
        .app-page .kash-notice-nested { background: rgba(0, 255, 255, 0.05) !important; border-color: rgba(0, 255, 255, 0.22) !important; }
        .app-page .bg-red-50 { background: rgba(255, 95, 86, 0.15) !important; border-color: rgba(255, 95, 86, 0.4) !important; }
        .app-page .border-red-200 { border-color: rgba(255, 95, 86, 0.4) !important; }
        .app-page .text-red-800, .app-page .text-red-700, .app-page .text-red-600, .app-page .text-red-500 { color: #ff5f56 !important; }
        .app-page .shadow-md { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 20px rgba(0, 255, 255, 0.08); }
        .app-page .shadow-xl { box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4), 0 0 25px rgba(0, 255, 255, 0.1); }
        .app-page .bg-white:hover { box-shadow: 0 0 20px rgba(0, 255, 255, 0.15), 0 0 40px rgba(0, 255, 255, 0.05) !important; }
        @media (max-width: 768px) {
          .app-page .nav-content {
            grid-template-columns: 1fr;
            grid-template-areas:
              "logo"
              "navlinks"
              "wallet";
            gap: 0;
            row-gap: 0;
          }
          .app-page .nav-logo {
            grid-area: logo;
            justify-self: center;
            align-self: center;
            padding-bottom: 10px;
            border-bottom: 1px solid rgba(0, 255, 255, 0.12);
            width: 100%;
            text-align: center;
            font-size: 1.65rem;
          }
          .app-page .app-nav-links {
            grid-area: navlinks;
            justify-self: stretch;
            width: 100%;
            justify-content: center;
            gap: 20px;
            padding: 10px 0;
            border-bottom: 1px solid rgba(0, 255, 255, 0.12);
          }
          .app-page .app-nav-wallet {
            grid-area: wallet;
            justify-self: stretch;
            align-self: center;
            width: 100%;
            justify-content: center;
            flex-wrap: wrap;
            gap: 8px;
            padding-top: 10px;
            min-width: 0;
          }
          .app-page main { padding-top: 13rem !important; padding-left: 16px !important; padding-right: 16px !important; }
        }
        @media (max-width: 480px) {
          .app-page .container { padding: 0 16px; }
        }
      ` }} />
      <div className="app-page">
        <nav className="nav">
          <div className="nav-content">
            <Link href="/" className="nav-logo">KASH</Link>
            <div className="app-nav-links">
              <Link href="/" className="nav-link">Home</Link>
              <Link href="#features" className="nav-link">Features</Link>
              <a href="https://github.com/jt1777/Kash" className="nav-link" target="_blank" rel="noopener noreferrer">GitHub</a>
            </div>
            <div className="app-nav-wallet">
              <CustomWalletButton />
            </div>
          </div>
        </nav>

        <main className="pt-24 pb-16" style={{ maxWidth: 1200, margin: '0 auto', paddingLeft: 20, paddingRight: 20 }}>
          <header className="mb-8">
            <Link href="/" className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(0, 255, 255, 0.2)', boxShadow: '0 0 12px rgba(0, 255, 255, 0.3)' }}>
                <span className="font-bold text-xl app-title">K</span>
              </div>
              <div>
                <h1 className="text-2xl font-bold app-title">Kash - Enhanced Yield Protocol</h1>
                <p className="text-xs app-subtitle"></p>
              </div>
            </Link>
          </header>

          {showBtcTab && (
            <div className="flex gap-2 mb-6">
              <button
                type="button"
                onClick={() => setProduct('btc')}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  product === 'btc'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white/10 text-gray-400 hover:text-white border border-white/20'
                }`}
              >
                KASH-BTC
              </button>
              <button
                type="button"
                onClick={() => setProduct('eth')}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  product === 'eth'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white/10 text-gray-400 hover:text-white border border-white/20'
                }`}
              >
                KASH-ETH
              </button>
            </div>
          )}

          <StatusIndicator product={product} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <StatsCard product={product} />
          </div>

          {showMintRedeem ? (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-2xl p-6 border bg-white shadow-xl" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
                  <div className="flex items-center space-x-2 mb-6">
                    <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-gray-900">Mint KASH</h2>
                  </div>
                  <p className="text-gray-600 mb-6">
                    Deposit selected asset to receive KASH tokens
                  </p>
                  <MintForm product={product} />
                </div>

                <div className="rounded-2xl p-6 border bg-white shadow-xl" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
                  <div className="flex items-center space-x-2 mb-6">
                    <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                      </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-gray-900">Redeem Assets</h2>
                  </div>
                  <p className="text-gray-600 mb-6">
                    Redeem {product === 'btc' ? 'KASH-BTC' : 'KASH-ETH'} tokens for your deposited asset
                  </p>
                  <RedeemForm product={product} />
                </div>
              </div>

              <RecentActivity key={address ?? 'disconnected'} />
            </>
          ) : isWalletSettling ? (
            <div className="rounded-2xl p-12 text-center border bg-white shadow-xl" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
              <h3 className="text-2xl font-bold text-gray-900 mb-2">Restoring wallet connection</h3>
              <p className="text-gray-600">
                {address
                  ? `Reconnecting ${address.slice(0, 6)}…${address.slice(-4)}. Mint and redeem will appear in a moment.`
                  : 'Please wait…'}
              </p>
            </div>
          ) : (
            <div className="rounded-2xl p-12 text-center border bg-white shadow-xl" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
              <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 bg-indigo-100">
                <svg className="w-8 h-8 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-2">Connect Your Wallet</h3>
              <p className="text-gray-600 mb-6">
                Connect your wallet to start minting and redeeming KASH tokens
              </p>
              <div className="inline-block">
                <CustomWalletButton />
              </div>
            </div>
          )}

          <div id="features" className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-xl p-6 border bg-white" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
              <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Enhanced Yield</h3>
              <p className="text-sm text-gray-600">
                Innovative process provides additional yield on top of normal funding rates.
              </p>
            </div>          
            
            <div className="rounded-xl p-6 border bg-white" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Daily Batch Processing</h3>
              <p className="text-sm text-gray-600">
                Submit requests before 23:45 UTC. Batch processes run between 23:45-23:59 daily.
              </p>
            </div>

            <div className="rounded-xl p-6 border bg-white" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
              <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Low Fees</h3>
              <p className="text-sm text-gray-600">
                Only 0.05% (5 bps) fee on all transactions. No hidden costs.
              </p>
            </div>            
          </div>
        </main>

        <SiteFooter
          className="mt-16"
          contractAddress={
            product === 'btc' && showBtcTab
              ? CONTRACTS.kashYieldBtc
              : CONTRACTS.kashYieldEth
          }
        />
      </div>
    </>
  );
}

export default function AppPage() {
  return (
    <ClientOnly>
      <AppContent />
    </ClientOnly>
  );
}
