'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { MintForm } from '@/components/MintForm';
import { RedeemForm } from '@/components/RedeemForm';
import { StatsCard } from '@/components/StatsCard';
import { StatusIndicator } from '@/components/StatusIndicator';
import { ClientOnly } from '@/components/ClientOnly';
import { useAccount } from 'wagmi';
import Link from 'next/link';

function AppContent() {
  const { isConnected } = useAccount();

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
        .app-page .nav-content { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; position: relative; z-index: 101; }
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
        .app-page .bg-red-50 { background: rgba(255, 95, 86, 0.15) !important; border-color: rgba(255, 95, 86, 0.4) !important; }
        .app-page .border-red-200 { border-color: rgba(255, 95, 86, 0.4) !important; }
        .app-page .text-red-800, .app-page .text-red-700, .app-page .text-red-600, .app-page .text-red-500 { color: #ff5f56 !important; }
        .app-page .shadow-md { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 20px rgba(0, 255, 255, 0.08); }
        .app-page .shadow-xl { box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4), 0 0 25px rgba(0, 255, 255, 0.1); }
        .app-page .bg-white:hover { box-shadow: 0 0 20px rgba(0, 255, 255, 0.15), 0 0 40px rgba(0, 255, 255, 0.05) !important; }
        .app-page footer { border-top: 1px solid rgba(0, 255, 255, 0.2); background: #0A0A1E !important; position: relative; z-index: 1; }
        .app-page footer a:hover { color: #00FFFF !important; text-shadow: 0 0 8px rgba(0, 255, 255, 0.5); }
        @media (max-width: 768px) {
          .app-page .nav-content { justify-content: center; }
          .app-page main { padding-top: 10rem !important; padding-left: 16px !important; padding-right: 16px !important; }
        }
        @media (max-width: 480px) {
          .app-page .container { padding: 0 16px; }
        }
      ` }} />
      <div className="app-page">
        <nav className="nav">
          <div className="nav-content">
            <Link href="/" className="nav-logo">KASH</Link>
            <div className="flex items-center gap-6">
              <Link href="/" className="nav-link">Home</Link>
              <Link href="#features" className="nav-link">Features</Link>
              <a href="https://github.com/jt1777/yieldproduct" className="nav-link" target="_blank" rel="noopener noreferrer">GitHub</a>
              <ConnectButton />
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
                <h1 className="text-2xl font-bold app-title">KashYield</h1>
                <p className="text-xs app-subtitle">Arbitrum Sepolia</p>
              </div>
            </Link>
          </header>

          <StatusIndicator />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <StatsCard />
          </div>

          {isConnected ? (
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
                  Deposit your assets to receive KASH tokens at the daily NAV
                </p>
                <MintForm />
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
                  Redeem your KASH tokens for your preferred asset
                </p>
                <RedeemForm />
              </div>
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
                <ConnectButton />
              </div>
            </div>
          )}

          <div id="features" className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="rounded-xl p-6 border bg-white" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Daily Batch Processing</h3>
              <p className="text-sm text-gray-600">
                Submit requests before 23:50 UTC. Batch processes between 23:50-23:59 daily.
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
                Only 0.03% (3 bps) fee on all transactions. No hidden costs.
              </p>
            </div>

            <div className="rounded-xl p-6 border bg-white" style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}>
              <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Multi-Asset Support</h3>
              <p className="text-sm text-gray-600">
                Deposit and withdraw in ETH, wETH, or wBTC.
              </p>
            </div>
          </div>
        </main>

        <footer className="mt-16 border-t py-8">
          <div className="container">
            <div className="flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">
              <div className="text-sm app-subtitle">
                © 2025 KashYield. All rights reserved.
              </div>
              <div className="flex space-x-6">
                <a href="https://sepolia.arbiscan.io/address/0xc4aF7357c36DE37da8183ACeebe8519d4cd1e310"
                   target="_blank"
                   rel="noopener noreferrer"
                   className="text-sm app-subtitle hover:text-[#00FFFF] transition-colors">
                  Contract
                </a>
                <a href="#" className="text-sm app-subtitle hover:text-[#00FFFF] transition-colors">
                  Docs
                </a>
                <a href="https://github.com/jt1777/yieldproduct" target="_blank" rel="noopener noreferrer" className="text-sm app-subtitle hover:text-[#00FFFF] transition-colors">
                  GitHub
                </a>
              </div>
            </div>
          </div>
        </footer>
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
