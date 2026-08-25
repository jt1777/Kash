import Link from 'next/link';
import { DisclaimerGate } from '@/components/DisclaimerGate';
import { LandingMetrics } from '@/components/LandingMetrics';
import { SiteFooter } from '@/components/SiteFooter';
import {
  ARBITRUM_ONE_BLOCK_EXPLORER,
  ARBITRUM_ONE_CHAIN_ID,
  CONTRACTS,
  arbiscanAddressUrl,
  hasBtcProduct,
  hasEthProduct,
  isArbiscanVerifiedKashYield,
  isConfiguredAddress,
} from '@/lib/contracts/addresses';

export const metadata = {
  title: 'KASH - The Yield Token for AI Agents',
  description:
    'Yield-bearing KASH tokens on Arbitrum for programmable treasuries. Deposit ETH or wBTC via smart contracts; returns vary with funding rates — verify NAV and risks on-chain.',
};

/** GitBook docs (same Markdown sources live under docs/ in the repo) */
const GITBOOK_SPACE =
  'https://kash-2.gitbook.io/kash-enhanced-yield-protocol';

const GITBOOK_AGENT_QUICKSTART = `${GITBOOK_SPACE}/agent-integration/agent-quickstart`;
const GITBOOK_HOW_YIELD_WORKS = `${GITBOOK_SPACE}/how-it-works/how-yield-works`;
const GITBOOK_RISKS = `${GITBOOK_SPACE}/how-it-works/risks`;
const GITBOOK_VERIFY_NAV = `${GITBOOK_SPACE}/how-it-works/verify-nav`;

/** Hyperliquid master accounts (bootstrap directDepositMode). Confirm via HyperliquidAdapter.hlAccount() on Arbiscan. */
const HL_ACCOUNTS = {
  kashEth: '0x54BF441Eb2BF0d6EDee63040B1eA2Acd78Eb5E35' as `0x${string}`,
  kashBtc: '0x8ab8A21e70a869B0472b20B1fB903E685B0F7B9F' as `0x${string}`,
};

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function resolvePublicAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '') ||
    'https://www.kash-token.io'
  );
}

function resolveProofBaseUrl(envValue: string | undefined, path: string): string {
  const trimmed = envValue?.trim().replace(/\/+$/, '');
  if (trimmed) {
    return trimmed.startsWith('http') ? trimmed : `${resolvePublicAppUrl()}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
  }
  return `${resolvePublicAppUrl()}${path}`;
}

export default function Home() {
  const appUrl = resolvePublicAppUrl();
  const mintProofBase = resolveProofBaseUrl(process.env.NEXT_PUBLIC_MINT_PROOF_BASE_URL, '/mint-proofs');
  const redeemProofBase = resolveProofBaseUrl(process.env.NEXT_PUBLIC_REDEEM_PROOF_BASE_URL, '/redeem-proofs');

  const agentBrief = {
    chainId: ARBITRUM_ONE_CHAIN_ID,
    network: 'Arbitrum One',
    explorerBase: ARBITRUM_ONE_BLOCK_EXPLORER,
    appUrl,
    depositAssets: {
      kashEth: 'Native ETH or WETH on Arbitrum One only — not USDC or other ERC-20',
      kashBtc: 'wBTC on Arbitrum One only (8 decimals) — not USDC or other assets',
    },
    minimums: {
      mintUsd:
        '~$10 notional enforced by frontend UI and batch ops skip threshold — on-chain requestMint has no $10 floor',
      redeemUsd: 'No minimum redeem size',
      minHoldingPeriod: 'One day — deposit in batch N, redeem earliest in batch N+1',
    },
    products: {
      kashEth: {
        kashYield: CONTRACTS.kashYieldEth,
        kashToken: CONTRACTS.kashTokenEth,
        hyperliquidAdapter: '0xb60A539b3377a4cBFb434C7c3a5d3262be874174',
        hlAccount: HL_ACCOUNTS.kashEth,
        mintNativeEth:
          'requestMint(0) with tx.value = depositWei (or WETH: approve + requestMint(wethWei))',
        redeem:
          'approve(kashYieldEth, kashWei) on KASH-ETH token, then requestRedeem(kashWei)',
      },
      kashBtc: {
        kashYield: CONTRACTS.kashYieldBtc,
        kashToken: CONTRACTS.kashTokenBtc,
        hyperliquidAdapter: '0xc2d8Fb0f6E20Ba5E10af671d20F37c9e9A86b011',
        hlAccount: HL_ACCOUNTS.kashBtc,
        mint:
          'approve(kashYieldBtc, wbtcWei) on wBTC, then requestMint(wbtcWei)',
        redeem:
          'approve(kashYieldBtc, kashWei) on KASH-BTC token, then requestRedeem(kashWei)',
      },
    },
    scheduleHint:
      'Mint/redeem requests accepted until batch cutoff (~23:40 UTC). isUserWindow() and isProcessingWindow() are not mutually exclusive — read both. After settlement, call claimMint or claimRedeem with hosted Merkle proofs.',
    abiNote:
      'kashYieldABI.ts merges ETH+BTC ABIs; dedupe by name + input types for one product, or use the vault ABI from Arbiscan — duplicate selectors break some libraries (e.g. web3.py).',
    navVerificationDocs: GITBOOK_VERIFY_NAV,
    reads: [
      'isUserWindow()',
      'isProcessingWindow()',
      'currentNAV() / getNAV()',
      'feeBps()',
      'getCurrentBatchCycle()',
      'getPendingMintRequest(user, batchCycle)',
      'getPendingRedeemRequest(user, batchCycle)',
      'getBatchInfo(batchCycle)',
      'batchClaimInfo(batchCycle)',
      'mintClaimed(batchCycle, user)',
      'redeemClaimed(batchCycle, user)',
    ],
    eventsToWatch: [
      'MintRequested',
      'RedeemRequested',
      'BatchProcessed',
      'TokensClaimed',
    ],
    redeemClaimProofs: redeemProofBase,
    redeemClaimProofPattern: `${redeemProofBase}/{eth|btc}-batch-{batchCycle}.json`,
    mintClaimProofs: mintProofBase,
    mintClaimProofPattern: `${mintProofBase}/{eth|btc}-mint-batch-{batchCycle}.json`,
    quickstartDocs: GITBOOK_AGENT_QUICKSTART,
    riskDocs: GITBOOK_RISKS,
    mechanicsDocs: GITBOOK_HOW_YIELD_WORKS,
  };

  const ethVaultVerified = isArbiscanVerifiedKashYield(CONTRACTS.kashYieldEth);
  const btcVaultVerified = isArbiscanVerifiedKashYield(CONTRACTS.kashYieldBtc);
  const ethVaultHref = arbiscanAddressUrl(CONTRACTS.kashYieldEth, { code: ethVaultVerified });
  const btcVaultHref = arbiscanAddressUrl(CONTRACTS.kashYieldBtc, { code: btcVaultVerified });
  const ethTokenHref = arbiscanAddressUrl(CONTRACTS.kashTokenEth);
  const btcTokenHref = arbiscanAddressUrl(CONTRACTS.kashTokenBtc);

  return (
    <DisclaimerGate riskDocsUrl={GITBOOK_RISKS}>
      <style dangerouslySetInnerHTML={{ __html: `
        .landing * { margin: 0; padding: 0; box-sizing: border-box; }
        .landing {
          font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
          background: #0A0A1E;
          color: #FFFFFF;
          line-height: 1.6;
          overflow-x: hidden;
          min-height: 100vh;
          position: relative;
        }
        .landing::before {
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
        .landing::after {
          content: '';
          position: fixed;
          inset: 0;
          background: radial-gradient(ellipse 80% 50% at 50% 0%, rgba(0, 255, 255, 0.06) 0%, transparent 50%);
          pointer-events: none;
          z-index: 0;
        }
        .landing .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; position: relative; z-index: 1; }
        .landing .hero {
          /* Taller than one viewport so content breathes; dvh/svh behave better than vh on mobile */
          min-height: calc(100vh + 2.5rem);
          min-height: calc(100svh + 2.5rem);
          min-height: calc(100dvh + 2.5rem);
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          text-align: center;
          position: relative;
          z-index: 1;
          padding-top: clamp(5.75rem, 11vw, 7.75rem);
          padding-bottom: clamp(2.5rem, 5vh, 4rem);
          box-sizing: border-box;
          background-color: #0A0A1E;
          background-image:
            linear-gradient(
              180deg,
              rgba(10, 10, 30, 0.45) 0%,
              rgba(10, 10, 30, 0.5) 40%,
              rgba(10, 10, 30, 0.55) 100%
            ),
            url('/AdobeStock_576595621.jpeg');
          background-size: cover;
          background-position: center;
          background-repeat: no-repeat;
        }
        .landing .badge {
          display: inline-block;
          background: rgba(0, 255, 255, 0.08);
          border: 1px solid rgba(0, 255, 255, 0.4);
          padding: 8px 16px;
          border-radius: 4px;
          font-size: 0.85rem;
          margin-bottom: 30px;
          color: #00FFFF;
          text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
          box-shadow: 0 0 15px rgba(0, 255, 255, 0.15);
        }
        .landing h1 {
          font-size: clamp(2.5rem, 8vw, 5rem);
          font-weight: 700;
          margin-bottom: 20px;
          color: #FFFFFF;
          text-shadow: 0 0 20px rgba(0, 255, 255, 0.4), 0 0 40px rgba(0, 255, 255, 0.2);
          letter-spacing: -2px;
        }
        .landing .hero h2 {
          font-size: clamp(1.35rem, 4.2vw, 2.35rem);
          font-weight: 600;
          letter-spacing: -0.02em;
          margin-bottom: 24px;
          color: #00FFFF;
          text-shadow: 0 0 18px rgba(0, 255, 255, 0.45), 0 0 36px rgba(0, 255, 255, 0.2);
        }
        .landing .subtitle {
          font-size: clamp(1rem, 2.5vw, 1.3rem);
          color: rgba(255, 255, 255, 0.85);
          max-width: 600px;
          margin-left: auto;
          margin-right: auto;
          margin-bottom: 40px;
          line-height: 1.7;
          text-align: center;
        }
        .landing .hero-human-hint {
          display: block;
          max-width: 560px;
          margin: -16px auto 28px;
          padding: 14px 20px;
          text-align: center;
          font-size: clamp(0.88rem, 2.2vw, 1rem);
          line-height: 1.55;
          color: rgba(255, 255, 255, 0.93);
          background: rgba(0, 255, 255, 0.12);
          border: 1px solid rgba(0, 255, 255, 0.5);
          border-radius: 8px;
          box-shadow: 0 0 22px rgba(0, 255, 255, 0.18), inset 0 0 24px rgba(0, 255, 255, 0.04);
        }
        .landing .hero-human-hint strong {
          color: #00FFFF;
          font-weight: 600;
          text-shadow: 0 0 10px rgba(0, 255, 255, 0.35);
        }
        .landing .hero-human-hint-action {
          color: #00FFFF;
          font-weight: 600;
          text-shadow: 0 0 10px rgba(0, 255, 255, 0.35);
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        .landing .hero-human-hint-action:hover {
          color: #7DF9FF;
        }
        .landing .cta-button {
          display: inline-block;
          background: #00FFFF;
          color: #0A0A1E;
          padding: 16px 40px;
          border-radius: 4px;
          text-decoration: none;
          font-weight: 600;
          font-size: 1.1rem;
          transition: all 0.3s ease;
          border: 2px solid #00FFFF;
          box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
          animation: pulse-glow 2s ease-in-out infinite;
        }
        .landing .cta-button:hover {
          background: transparent;
          color: #00FFFF;
          box-shadow: 0 0 25px #00FFFF, 0 0 50px rgba(0, 255, 255, 0.4);
          transform: scale(1.02);
        }
        .landing .secondary-cta {
          display: inline-block;
          color: #00FFFF;
          padding: 16px 40px;
          text-decoration: none;
          margin-left: 20px;
          border: 1px solid rgba(0, 255, 255, 0.5);
          border-radius: 4px;
          transition: all 0.3s ease;
          text-shadow: 0 0 8px rgba(0, 255, 255, 0.3);
        }
        .landing .secondary-cta:hover {
          box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
          border-color: #00FFFF;
          background: rgba(0, 255, 255, 0.08);
        }
        .landing .code-section {
          background: rgba(0, 0, 0, 0.4);
          padding: clamp(60px, 10vw, 100px) 0;
          border-top: 1px solid rgba(0, 255, 255, 0.15);
          position: relative;
          z-index: 1;
        }
        .landing .section-title {
          font-size: clamp(1.5rem, 4vw, 2rem);
          margin-bottom: 50px;
          text-align: center;
          color: #FFFFFF;
          text-shadow: 0 0 10px rgba(0, 255, 255, 0.3);
        }
        .landing .code-block {
          background: rgba(0, 10, 30, 0.8);
          border: 1px solid rgba(0, 255, 255, 0.25);
          border-radius: 8px;
          padding: 24px;
          margin: 20px 0;
          overflow-x: auto;
          box-shadow: 0 0 20px rgba(0, 255, 255, 0.1), inset 0 0 30px rgba(0, 255, 255, 0.02);
        }
        .landing .code-header { display: flex; gap: 8px; margin-bottom: 20px; }
        .landing .dot { width: 12px; height: 12px; border-radius: 50%; }
        .landing .dot.red { background: #ff5f56; }
        .landing .dot.yellow { background: #ffbd2e; }
        .landing .dot.green { background: #00FFFF; box-shadow: 0 0 8px #00FFFF; }
        .landing pre { color: rgba(255, 255, 255, 0.9); font-size: clamp(0.8rem, 2vw, 0.95rem); line-height: 1.8; }
        .landing .keyword { color: #00FFFF; text-shadow: 0 0 5px rgba(0, 255, 255, 0.3); }
        .landing .function { color: #7DF9FF; }
        .landing .string { color: #a5d6ff; }
        .landing .comment { color: rgba(255, 255, 255, 0.5); }
        .landing .number { color: #00FFFF; }
        .landing .features {
          padding: clamp(60px, 10vw, 100px) 0;
          position: relative;
          z-index: 1;
        }
        .landing .features-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
          gap: 24px;
          margin-top: 50px;
        }
        .landing .feature-card {
          background: rgba(0, 255, 255, 0.03);
          border: 1px solid rgba(0, 255, 255, 0.2);
          padding: 28px;
          border-radius: 8px;
          transition: all 0.3s ease;
        }
        .landing .feature-card:hover {
          border-color: #00FFFF;
          box-shadow: 0 0 20px rgba(0, 255, 255, 0.2), inset 0 0 20px rgba(0, 255, 255, 0.03);
          transform: translateY(-4px);
        }
        .landing .feature-icon { font-size: 2rem; margin-bottom: 15px; filter: drop-shadow(0 0 6px rgba(0, 255, 255, 0.4)); }
        .landing .feature-title { font-size: 1.2rem; margin-bottom: 10px; color: #00FFFF; text-shadow: 0 0 10px rgba(0, 255, 255, 0.4); }
        .landing .feature-desc { color: rgba(255, 255, 255, 0.8); font-size: 0.95rem; }
        .landing .section-caption {
          max-width: 720px;
          margin: -36px auto 40px;
          text-align: center;
          color: rgba(255, 255, 255, 0.72);
          font-size: clamp(0.9rem, 2vw, 1rem);
          line-height: 1.65;
        }
        .landing .metrics {
          padding: clamp(60px, 10vw, 100px) 0;
          position: relative;
          z-index: 1;
        }
        .landing .metrics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
          gap: 24px;
          margin-top: 24px;
        }
        .landing .metric-card {
          background: rgba(0, 255, 255, 0.04);
          border: 1px solid rgba(0, 255, 255, 0.2);
          border-radius: 8px;
          padding: 28px;
          transition: all 0.3s ease;
        }
        .landing .metric-card:hover {
          border-color: #00FFFF;
          box-shadow: 0 0 20px rgba(0, 255, 255, 0.2), inset 0 0 20px rgba(0, 255, 255, 0.03);
          transform: translateY(-4px);
        }
        .landing .metric-product {
          font-size: 1.2rem;
          margin-bottom: 18px;
          color: #00FFFF;
          text-shadow: 0 0 10px rgba(0, 255, 255, 0.4);
          font-weight: 600;
        }
        .landing .metric-rows {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 16px;
        }
        .landing .metric-block {
          padding: 12px 0;
        }
        .landing .metric-label {
          color: rgba(255, 255, 255, 0.7);
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          margin-bottom: 6px;
        }
        .landing .metric-value {
          font-size: clamp(1.15rem, 3vw, 1.45rem);
          font-weight: 700;
          color: #FFFFFF;
          text-shadow: 0 0 10px rgba(0, 255, 255, 0.3);
        }
        .landing .metric-positive { color: #00FF9D; text-shadow: 0 0 10px rgba(0, 255, 157, 0.3); }
        .landing .metric-negative { color: #FF5F56; text-shadow: 0 0 10px rgba(255, 95, 86, 0.3); }
        .landing .metric-error {
          margin-top: 12px;
          padding: 8px 12px;
          border-radius: 6px;
          border: 1px dashed rgba(255, 189, 46, 0.5);
          background: rgba(255, 189, 46, 0.08);
          color: rgba(255, 255, 255, 0.85);
          font-size: 0.8rem;
          line-height: 1.5;
        }
        .landing .proof-section {
          padding: clamp(60px, 10vw, 100px) 0;
          border-top: 1px solid rgba(0, 255, 255, 0.15);
          position: relative;
          z-index: 1;
          background: rgba(0, 20, 35, 0.35);
        }
        .landing .proof-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
          gap: 20px;
          margin-top: 24px;
        }
        .landing .proof-card {
          background: rgba(0, 255, 255, 0.04);
          border: 1px solid rgba(0, 255, 255, 0.2);
          border-radius: 8px;
          padding: 20px;
        }
        .landing .proof-card h3 {
          color: #00FFFF;
          font-size: 1rem;
          margin-bottom: 10px;
          text-shadow: 0 0 8px rgba(0, 255, 255, 0.35);
        }
        .landing .proof-card a {
          color: #7DF9FF;
          word-break: break-all;
        }
        .landing .proof-card-body p,
        .landing .proof-card p {
          color: rgba(255, 255, 255, 0.82);
          font-size: 0.88rem;
          line-height: 1.65;
        }
        .landing .proof-card--url-scroll {
          min-width: 0;
          overflow-x: auto;
        }
        .landing .proof-url-scroll {
          margin-top: 8px;
          max-width: 100%;
          overflow-x: auto;
          border-radius: 4px;
          background: rgba(0, 0, 0, 0.25);
          padding: 8px 10px;
        }
        .landing .proof-url-scroll code {
          display: block;
          white-space: nowrap;
          word-break: normal;
          font-size: 0.82rem;
        }
        .landing .code-block,
        .landing .proof-url-scroll,
        .landing .proof-card--url-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 255, 255, 0.35) rgba(0, 20, 35, 0.55);
        }
        .landing .code-block::-webkit-scrollbar,
        .landing .proof-url-scroll::-webkit-scrollbar,
        .landing .proof-card--url-scroll::-webkit-scrollbar {
          height: 6px;
        }
        .landing .code-block::-webkit-scrollbar-track,
        .landing .proof-url-scroll::-webkit-scrollbar-track,
        .landing .proof-card--url-scroll::-webkit-scrollbar-track {
          background: rgba(0, 20, 35, 0.55);
          border-radius: 3px;
        }
        .landing .code-block::-webkit-scrollbar-thumb,
        .landing .proof-url-scroll::-webkit-scrollbar-thumb,
        .landing .proof-card--url-scroll::-webkit-scrollbar-thumb {
          background: rgba(0, 255, 255, 0.3);
          border-radius: 3px;
          border: 1px solid rgba(0, 255, 255, 0.12);
        }
        .landing .code-block::-webkit-scrollbar-thumb:hover,
        .landing .proof-url-scroll::-webkit-scrollbar-thumb:hover,
        .landing .proof-card--url-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 255, 255, 0.5);
        }
        .landing .ai-section-divider {
          margin: 0 auto 16px;
          padding: 0;
        }
        .landing .proof-details {
          margin-top: 12px;
          border-top: 1px solid rgba(0, 255, 255, 0.15);
          padding-top: 12px;
        }
        .landing .proof-details summary {
          color: #7DF9FF;
          font-size: 0.85rem;
          cursor: pointer;
          list-style: none;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .landing .proof-details summary::before {
          content: '▶';
          font-size: 0.7rem;
          color: #00FFFF;
          transition: transform 0.2s ease;
        }
        .landing .proof-details[open] summary::before {
          transform: rotate(90deg);
        }
        .landing .proof-details ol {
          margin: 12px 0 0 0;
          padding-left: 18px;
          color: rgba(255, 255, 255, 0.78);
          font-size: 0.82rem;
          line-height: 1.65;
        }
        .landing .proof-details li {
          margin-bottom: 8px;
        }
        .landing .verify-note {
          margin-top: 28px;
          padding: 16px 18px;
          border-radius: 8px;
          border: 1px dashed rgba(0, 255, 255, 0.35);
          background: rgba(0, 255, 255, 0.05);
          color: rgba(255, 255, 255, 0.78);
          font-size: 0.88rem;
          line-height: 1.65;
        }
        .landing .agent-json-caption {
          text-align: center;
          color: rgba(255, 255, 255, 0.65);
          font-size: 0.85rem;
          margin-bottom: 12px;
          margin-top: -24px;
        }
        .landing .for-ai {
          padding: clamp(60px, 10vw, 100px) 0;
          background: rgba(0, 0, 0, 0.35);
          position: relative;
          z-index: 1;
        }
        .landing .ai-list { list-style: none; max-width: 800px; margin: 40px auto; }
        .landing .ai-list li {
          padding: 18px 20px;
          margin: 10px 0;
          background: rgba(0, 255, 255, 0.04);
          border-left: 3px solid #00FFFF;
          font-size: clamp(0.95rem, 2vw, 1.1rem);
          color: rgba(255, 255, 255, 0.9);
          box-shadow: 0 0 15px rgba(0, 255, 255, 0.05);
        }
        .landing .ai-list li::before { content: '► '; color: #00FFFF; text-shadow: 0 0 8px #00FFFF; }
        .landing .nav {
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
        .landing .nav-content { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
        .landing .nav-logo {
          font-size: 1.5rem;
          font-weight: 700;
          color: #00FFFF;
          text-decoration: none;
          text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
        }
        .landing .nav-links { display: flex; gap: clamp(16px, 4vw, 30px); align-items: center; flex-wrap: wrap; }
        .landing .nav-link {
          color: rgba(255, 255, 255, 0.85);
          text-decoration: none;
          font-size: 0.9rem;
          transition: all 0.3s ease;
        }
        .landing .nav-link:hover { color: #00FFFF; text-shadow: 0 0 8px rgba(0, 255, 255, 0.5); }
        .landing .nav-button {
          background: #00FFFF;
          color: #0A0A1E;
          padding: 8px 20px;
          border-radius: 4px;
          text-decoration: none;
          font-weight: 600;
          font-size: 0.9rem;
          transition: all 0.3s ease;
          border: 1px solid #00FFFF;
          box-shadow: 0 0 10px rgba(0, 255, 255, 0.4);
        }
        .landing .nav-button:hover {
          box-shadow: 0 0 20px #00FFFF, 0 0 30px rgba(0, 255, 255, 0.3);
          transform: scale(1.03);
        }
        .landing .cursor {
          display: inline-block;
          width: 10px;
          height: 1.2em;
          background: #00FFFF;
          animation: blink 1s infinite;
          vertical-align: middle;
          margin-left: 5px;
          box-shadow: 0 0 8px #00FFFF;
        }
        @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
        @keyframes pulse-glow {
          0%, 100% { box-shadow: 0 0 15px rgba(0, 255, 255, 0.5); }
          50% { box-shadow: 0 0 25px rgba(0, 255, 255, 0.7), 0 0 40px rgba(0, 255, 255, 0.2); }
        }
        @media (min-width: 769px) {
          .landing .hero .subtitle {
            max-width: min(48rem, 86vw);
          }
          .landing .hero .hero-human-hint {
            max-width: min(44rem, 82vw);
          }
        }
        @media (max-width: 768px) {
          .landing .hero {
            /* flex-start keeps the badge below the wrapped fixed nav */
            justify-content: flex-start;
            padding-top: clamp(10.5rem, 32vw, 14.5rem);
          }
          /* Fixed nav covers hash targets on mobile — offset scroll snap */
          .landing #features,
          .landing #agent-brief,
          .landing #verify,
          .landing #agent-quickstart,
          .landing #integration {
            scroll-margin-top: clamp(7.5rem, 24vw, 10.5rem);
          }
          .landing .secondary-cta { display: block; margin: 16px 0 0 0; }
          .landing .nav-content { justify-content: center; }
          .landing .nav-links { justify-content: center; }
          .landing .hero .container > div:last-child { display: flex; flex-direction: column; align-items: center; gap: 12px; }
          .landing .hero .container > div:last-child a { margin-left: 0; }
        }
        @media (max-width: 480px) {
          .landing .container { padding: 0 16px; }
          .landing .code-block { padding: 16px; }
          .landing .feature-card { padding: 20px; }
        }
      ` }} />
      <div className="landing">
        <nav className="nav">
          <div className="nav-content">
            <Link href="/" className="nav-logo">KASH</Link>
            <div className="nav-links">
              <a href="#features" className="nav-link">Features</a>
              <a href="#agent-brief" className="nav-link">For AI</a>
              <a href="#verify" className="nav-link">Verify</a>
              <a href="#agent-quickstart" className="nav-link">Quickstart</a>
              <a href="#integration" className="nav-link">Integration</a>
              <Link href="/app" className="nav-button">Launch App →</Link>
            </div>
          </div>
        </nav>

        <section className="hero">
          <div className="container">
            <div className="badge">🤖 AI Agent Friendly</div>
            <h1>KASH<span className="cursor" /></h1>
            <h2>Enhanced Yield Protocol</h2>
            <p className="subtitle">
              Programmable treasury yield on Arbitrum: deposit ETH or wBTC, receive KASH tokens, redeem through daily batches.
              Returns based on funding rates — verify contracts and read risk disclosure before allocating capital.
            </p>
            <p className="hero-human-hint" role="note">
              <strong>FOR HUMANS:</strong> read{' '}
              <a href={GITBOOK_SPACE} target="_blank" rel="noopener noreferrer" className="hero-human-hint-action">Documentation</a>
              {' '}first, then click{' '}
              <Link href="/app" className="hero-human-hint-action">Launch App</Link>
              {' '}to begin.
            </p>
            <div>
              <a href="https://kash-2.gitbook.io/kash-enhanced-yield-protocol" target="_blank" rel="noopener noreferrer" className="secondary-cta">Documentation</a>
              <Link href="/app" className="cta-button">🚀 Launch App</Link>
            </div>
          </div>
        </section>

        <LandingMetrics />

        <section className="features" id="features">
          <div className="container">
            <h2 className="section-title">Why KASH?</h2>
            <div className="features-grid">
              <div className="feature-card">
                <div className="feature-icon">🔋</div>
                <h3 className="feature-title">Funding Rate Yield</h3>
                <p className="feature-desc">
                  Strategy targets market-neutral funding income; superior yield from innovative strategies.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">📊</div>
                <h3 className="feature-title">Transparent Metrics</h3>
                <p className="feature-desc">
                  Verify user assets on chain. Read NAV and batch events (e.g. getNAV(), BatchProcessed) — every position is auditable in real time.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">💰</div>
                <h3 className="feature-title">Passive Income</h3>
                <p className="feature-desc">
                  Deposit wBTC or ETH to receive KASH tokens that increase in value over time. Full redemption within 24 hours.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="for-ai" id="agent-brief">
          <div className="container">
            <p className="section-caption ai-section-divider" role="note">Everything below this is for AI Agents</p>
            <h2 className="section-title">Built for AI agents</h2>
            <p className="section-caption">
              Machine-readable integration brief. Deposits require native ETH, WETH, or wBTC on Arbitrum One (minimum $10 notional). Confirm addresses before mainnet execution.
            </p>
            <p className="agent-json-caption">Copy as JSON for tools / planners</p>
            <div className="code-block" style={{ marginBottom: 48 }}>
              <div className="code-header">
                <div className="dot red" /><div className="dot yellow" /><div className="dot green" />
              </div>
              <pre>{JSON.stringify(agentBrief, null, 2)}</pre>
            </div>
            <ul className="ai-list">
              <li><strong>Deposit assets</strong> — KASH-ETH accepts native ETH or WETH; KASH-BTC accepts wBTC. USDC and other tokens are not supported — swap first if needed.</li>
              <li><strong>Minimums</strong> — ~$10 mint notional is enforced by the frontend and batch ops skip threshold only; a raw <code style={{ color: '#00FFFF' }}>requestMint</code> can still land on-chain below that. Redeems have no minimum.</li>
              <li><strong>Contract-first</strong> — Integrate via KashYield + ERC-20 KASH; optional UI is unrelated to execution.</li>
              <li><strong>Deterministic scheduling</strong> — Poll <code style={{ color: '#00FFFF' }}>isUserWindow()</code> and <code style={{ color: '#00FFFF' }}>isProcessingWindow()</code> (not mutually exclusive); submit before batch cutoff; await <code style={{ color: '#00FFFF' }}>BatchProcessed</code>.</li>
              <li><strong>Bounded surface area</strong> — Primary flows: mint, redeem, cancel; approvals only where ERC-20 pulls apply.</li>
              <li><strong>Composable ERC-20</strong> — Move KASH like any token; remember redeems move KASH back to the vault during requests.</li>
              <li><strong>Ops reality</strong> — Strategy execution and NAV inputs rely on protocol operators — audit trust assumptions in docs, not buzzwords.</li>
              <li><strong>Decision-grade reads</strong> — NAV, fee bps, pending requests, and batch tuples are exposed for monitoring / risk triggers.</li>
            </ul>
          </div>
        </section>

        <section className="proof-section" id="verify">
          <div className="container">
            <h2 className="section-title">Verify before you allocate</h2>
            <p className="section-caption">
              Verification checklist: confirm each item against live chain state using your own RPC, Arbiscan, or an indexer before you allocate capital.
            </p>
            <div className="proof-grid">
              <div className="proof-card">
                <h3>NAV</h3>
                <div className="proof-card-body">
                  <p>
                    Read <code style={{ color: '#00FFFF' }}>getNAV()</code> on each KashYield vault and <code style={{ color: '#00FFFF' }}>totalSupply()</code> on the matching KASH token. Multiply: <code style={{ color: '#00FFFF' }}>totalNAV = nav × supply / 10^18</code>. Full steps:{' '}
                    <a href={GITBOOK_VERIFY_NAV} target="_blank" rel="noopener noreferrer">Verify NAV</a>.
                  </p>
                  <details className="proof-details">
                    <summary>Audit every NAV component</summary>
                    <ol>
                      <li>
                        <strong>Asset leg (USD):</strong> sum vault ETH/wBTC (minus <code style={{ color: '#00FFFF' }}>ownerEthReserve</code> / <code style={{ color: '#00FFFF' }}>ownerWbtcReserve</code> and locked redeem claims), plus Aave supplied WETH/wBTC, plus <code style={{ color: '#00FFFF' }}>getExchangeAssetBalance()</code> (HL spot on the adapter). Mark to market with vault <code style={{ color: '#00FFFF' }}>getEthPrice()</code> / <code style={{ color: '#00FFFF' }}>getBtcPrice()</code> — <strong>18-decimal USD</strong> (<code style={{ color: '#00FFFF' }}>1e18 = $1</code>). Do not use raw Chainlink <code style={{ color: '#00FFFF' }}>latestRoundData()</code> (8-dec feeds).
                      </li>
                      <li>
                        <strong>Net USDC leg (USD):</strong> vault USDC minus <code style={{ color: '#00FFFF' }}>ownerUsdcReserve()</code>, plus HL <code style={{ color: '#00FFFF' }}>marginSummary.accountValue</code> from <code style={{ color: '#00FFFF' }}>{"{type: 'clearinghouseState', user: hlAccount}"}</code>, minus Aave USDC variable debt, minus <code style={{ color: '#00FFFF' }}>totalOwnerCoverUsdc()</code>. Do <strong>not</strong> subtract perp short (or long) size from the asset leg — perp PnL and margin are already inside <code style={{ color: '#00FFFF' }}>accountValue</code>.
                      </li>
                      <li>
                        <strong>HL accounts:</strong> KASH-ETH <code style={{ color: '#00FFFF' }}>{HL_ACCOUNTS.kashEth}</code>; KASH-BTC <code style={{ color: '#00FFFF' }}>{HL_ACCOUNTS.kashBtc}</code> (confirm via <code style={{ color: '#00FFFF' }}>HyperliquidAdapter.hlAccount()</code> on Arbiscan).
                      </li>
                      <li>
                        <strong>Recompute:</strong> <code style={{ color: '#00FFFF' }}>portfolio USD = asset USD + net USDC USD</code> (both 18-dec), then <code style={{ color: '#00FFFF' }}>NAV = portfolio × 10^18 / totalSupply</code>. Compare to <code style={{ color: '#00FFFF' }}>getNAV()</code> — they should match closely right after an <code style={{ color: '#00FFFF' }}>updateNAV</code> tx; between writes, published NAV is a stale snapshot and may diverge until the next write.
                      </li>
                    </ol>
                  </details>
                </div>
              </div>
              <div className="proof-card">
                <h3>Fee</h3>
                <p>
                  Read <code style={{ color: '#00FFFF' }}>feeBps()</code> on the same contracts. Protocol fee is <strong>5 bps</strong>; confirm on-chain before sizing trades.
                </p>
              </div>
              <div className="proof-card">
                <h3>Batches &amp; settlement</h3>
                <p>
                  Poll <code style={{ color: '#00FFFF' }}>isUserWindow()</code> frequently (e.g. every 60s) and submit mint/redeem requests well before the window closes. The cutoff is around 23:40 UTC — validate against the deployed contract. <code style={{ color: '#00FFFF' }}>isUserWindow()</code> and <code style={{ color: '#00FFFF' }}>isProcessingWindow()</code> are not mutually exclusive — read both. After submission, watch for <code style={{ color: '#00FFFF' }}>BatchProcessed</code>, then <code style={{ color: '#00FFFF' }}>TokensClaimed</code> after you claim.
                </p>
              </div>
              <div className="proof-card">
                <h3>TVL</h3>
                <div className="proof-card-body">
                  <p>
                    Published TVL is <code style={{ color: '#00FFFF' }}>getNAV() × totalSupply / 10^18</code> per product — that is what the app shows. For each vault, read <code style={{ color: '#00FFFF' }}>getNAV()</code> on KashYield and <code style={{ color: '#00FFFF' }}>totalSupply()</code> on the KASH token.
                  </p>
                  <details className="proof-details">
                    <summary>Step-by-step TVL verification</summary>
                    <ol>
                      <li>
                        KASH-ETH: <code style={{ color: '#00FFFF' }}>getNAV()</code> on <a href={ethVaultHref} target="_blank" rel="noopener noreferrer">{shortenAddress(CONTRACTS.kashYieldEth)}</a> × <code style={{ color: '#00FFFF' }}>totalSupply()</code> on <a href={ethTokenHref} target="_blank" rel="noopener noreferrer">{shortenAddress(CONTRACTS.kashTokenEth)}</a>.
                      </li>
                      <li>
                        KASH-BTC: <code style={{ color: '#00FFFF' }}>getNAV()</code> on <a href={btcVaultHref} target="_blank" rel="noopener noreferrer">{shortenAddress(CONTRACTS.kashYieldBtc)}</a> × <code style={{ color: '#00FFFF' }}>totalSupply()</code> on <a href={btcTokenHref} target="_blank" rel="noopener noreferrer">{shortenAddress(CONTRACTS.kashTokenBtc)}</a>.
                      </li>
                      <li>
                        Optionally cross-check by rebuilding portfolio USD from vault + Aave + HL (<a href={GITBOOK_VERIFY_NAV} target="_blank" rel="noopener noreferrer">Verify NAV</a>). Published TVL (<code style={{ color: '#00FFFF' }}>getNAV() × totalSupply / 10^18</code>) is the product number; a live rebuild is an independent spot check and may differ between <code style={{ color: '#00FFFF' }}>updateNAV</code> writes — investigate persistent or large gaps.
                      </li>
                      <li>
                        Do not infer yield from marketing copy. Use only on-chain NAV and your own price feeds for TVL.
                      </li>
                    </ol>
                  </details>
                </div>
              </div>
              <div className="proof-card">
                <h3>Verified source code</h3>
                <p>
                  {hasEthProduct() && ethVaultVerified && (
                    <>
                      KashYield ETH vault:{' '}
                      <a href={ethVaultHref} target="_blank" rel="noopener noreferrer">
                        View verified code ↗
                      </a>
                      {' '}({shortenAddress(CONTRACTS.kashYieldEth)}). KASH-ETH token:{' '}
                      <a href={ethTokenHref} target="_blank" rel="noopener noreferrer">
                        {shortenAddress(CONTRACTS.kashTokenEth)} ↗
                      </a>
                      .
                      {hasBtcProduct() && btcVaultVerified ? ' ' : ''}
                    </>
                  )}
                  {hasEthProduct() && !ethVaultVerified && isConfiguredAddress(CONTRACTS.kashYieldEth) && (
                    <>
                      KashYield ETH vault:{' '}
                      <a href={ethVaultHref} target="_blank" rel="noopener noreferrer">
                        {shortenAddress(CONTRACTS.kashYieldEth)} on Arbiscan
                      </a>
                      .
                      {hasBtcProduct() ? ' ' : ''}
                    </>
                  )}
                  {hasBtcProduct() && btcVaultVerified && (
                    <>
                      KashYield BTC vault:{' '}
                      <a href={btcVaultHref} target="_blank" rel="noopener noreferrer">
                        View verified code ↗
                      </a>
                      {' '}({shortenAddress(CONTRACTS.kashYieldBtc)}). KASH-BTC token:{' '}
                      <a href={btcTokenHref} target="_blank" rel="noopener noreferrer">
                        {shortenAddress(CONTRACTS.kashTokenBtc)} ↗
                      </a>
                      .
                    </>
                  )}
                  {hasBtcProduct() && !btcVaultVerified && (
                    <>
                      Review the BTC vault on{' '}
                      <a href={btcVaultHref} target="_blank" rel="noopener noreferrer">Arbiscan</a>
                      {' '}before allocating.
                    </>
                  )}
                  {!hasEthProduct() && !hasBtcProduct() && (
                    <>Confirm vault addresses in the app environment before allocating.</>
                  )}
                </p>
              </div>
            </div>
            <p className="verify-note">
              <strong>Risks &amp; mechanics:</strong>{' '}
              <a href={GITBOOK_RISKS} target="_blank" rel="noopener noreferrer">Risks</a>
              {' · '}
              <a href={GITBOOK_HOW_YIELD_WORKS} target="_blank" rel="noopener noreferrer">How yield works</a>
              {' · '}
              <a href={GITBOOK_SPACE} target="_blank" rel="noopener noreferrer">GitBook</a>
            </p>
          </div>
        </section>

        <section className="proof-section" id="agent-quickstart">
          <div className="container">
            <h2 className="section-title">Agent Quickstart</h2>
            <p className="section-caption">
              Follow this sequence if you are an agent evaluating whether to allocate idle ETH or wBTC. The complete guide is{' '}
              <a href={GITBOOK_AGENT_QUICKSTART} target="_blank" rel="noopener noreferrer">Agent Quickstart</a>
              {' '}in the Documentation.
            </p>
            <div className="proof-grid">
              <div className="proof-card">
                <h3>1. Load facts</h3>
                <p>
                  Chain ID <strong>{ARBITRUM_ONE_CHAIN_ID}</strong>, RPC <code style={{ color: '#00FFFF' }}>https://arb1.arbitrum.io/rpc</code>, ABI from{' '}
                  <a href="https://github.com/jt1777/Kash/blob/main/frontend/lib/contracts/kashYieldABI.ts" target="_blank" rel="noopener noreferrer">kashYieldABI.ts</a>{' '}
                  (ETH+BTC merged — dedupe by name + input types per product, or use the vault ABI from Arbiscan; duplicate selectors break some libraries such as web3.py).
                </p>
              </div>
              <div className="proof-card">
                <h3>2. Preflight reads</h3>
                <p>
                  Before signing, read <code style={{ color: '#00FFFF' }}>paused()</code>, <code style={{ color: '#00FFFF' }}>isUserWindow()</code>,{' '}
                  <code style={{ color: '#00FFFF' }}>isProcessingWindow()</code> (not mutually exclusive with user window),{' '}
                  <code style={{ color: '#00FFFF' }}>currentNAV()</code>, <code style={{ color: '#00FFFF' }}>feeBps()</code>, and <code style={{ color: '#00FFFF' }}>getCurrentBatchCycle()</code>.
                </p>
              </div>
              <div className="proof-card">
                <h3>3. Mint</h3>
                <p>
                  Hold the correct asset on Arbitrum One: native ETH or WETH (KASH-ETH), or wBTC (KASH-BTC). ~$10 mint notional is enforced by the frontend and batch ops only — not on-chain. ETH: call{' '}
                  <code style={{ color: '#00FFFF' }}>requestMint(0)</code> with <code style={{ color: '#00FFFF' }}>msg.value</code>. wBTC: approve the BTC vault, then call{' '}
                  <code style={{ color: '#00FFFF' }}>requestMint(wbtcAmount)</code> (8 decimals).
                </p>
              </div>
              <div className="proof-card">
                <h3>4. Monitor</h3>
                <p>
                  Watch events <code style={{ color: '#00FFFF' }}>MintRequested</code>, <code style={{ color: '#00FFFF' }}>RedeemRequested</code>, <code style={{ color: '#00FFFF' }}>BatchProcessed</code>, and <code style={{ color: '#00FFFF' }}>TokensClaimed</code> after you claim. Read <code style={{ color: '#00FFFF' }}>mintClaimed(batchCycle, user)</code> / <code style={{ color: '#00FFFF' }}>redeemClaimed(batchCycle, user)</code> to check claim status (views, not events).
                </p>
              </div>
              <div className="proof-card proof-card--url-scroll">
                <h3>5. Claim mint</h3>
                <p>
                  After settlement, fetch the hosted mint proof manifest and call{' '}
                  <code style={{ color: '#00FFFF' }}>claimMint(batchCycle, amount, proof)</code>. Proofs are public JSON at:
                </p>
                <div className="proof-url-scroll">
                  <code style={{ color: '#a5d6ff' }}>{mintProofBase}/{'{eth|btc}'}-mint-batch-{'{batchCycle}'}.json</code>
                </div>
                <p style={{ marginTop: 8 }}>(or rebuild from chain if unavailable).</p>
              </div>
              <div className="proof-card proof-card--url-scroll">
                <h3>6. Redeem</h3>
                <p>
                  Approve the relevant KASH token to its KashYield vault, call <code style={{ color: '#00FFFF' }}>requestRedeem(kashAmount)</code> before the batch cutoff, then call <code style={{ color: '#00FFFF' }}>claimRedeem(batchCycle, amount, proof)</code> after settlement. Redeem proofs:
                </p>
                <div className="proof-url-scroll">
                  <code style={{ color: '#a5d6ff' }}>{redeemProofBase}/{'{eth|btc}'}-batch-{'{batchCycle}'}.json</code>
                </div>
              </div>
              <div className="proof-card">
                <h3>7. Risk gate</h3>
                <p>
                  Do not infer yield from copy. Check NAV history, operator assumptions, portfolio exposure, batch status, and{' '}
                  <a href={GITBOOK_RISKS} target="_blank" rel="noopener noreferrer">Risks</a> before sizing capital.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="code-section" id="integration">
          <div className="container">
            <h2 className="section-title">Minimal integration (matches deployed ABI)</h2>
            <p className="section-caption">
              Contracts use <code style={{ color: '#00FFFF' }}>requestMint</code> / <code style={{ color: '#00FFFF' }}>requestRedeem</code>, then <code style={{ color: '#00FFFF' }}>claimMint</code> / <code style={{ color: '#00FFFF' }}>claimRedeem</code> after settlement. ABI reference:{' '}
              <code style={{ color: '#a5d6ff' }}>frontend/lib/contracts/kashYieldABI.ts</code>.
            </p>
            <div className="code-block">
              <div className="code-header">
                <div className="dot red" /><div className="dot yellow" /><div className="dot green" />
              </div>
              <pre>{`// viem-style sketch — KASH-ETH native deposit
const vaultEth = '${CONTRACTS.kashYieldEth}' as \`0x\${string}\`;
const kashTokenEth = '${CONTRACTS.kashTokenEth}' as \`0x\${string}\`;

const open = await client.readContract({ address: vaultEth, abi, functionName: 'isUserWindow' });
if (!open) throw new Error('Outside user window');

const hash = await wallet.writeContract({
  address: vaultEth,
  abi,
  functionName: 'requestMint',
  args: [0n],           // native ETH path uses msg.value
  value: depositWei,
});

// After batch settlement: claimMint(batchCycle, kashAmount, proof) using hosted mint proof JSON.
// To exit: approve KASH, requestRedeem(kashWei), then claimRedeem(batchCycle, amount, proof).`}
              </pre>
            </div>
            <h2 className="section-title" style={{ marginTop: 60 }}>Python (Web3.py) — no pip SDK yet</h2>
            <p className="section-caption">
              Pass the KashYield ABI into Web3.py (same JSONABI shape as Hardhat artifacts)—copy the array from{' '}
              <code style={{ color: '#a5d6ff' }}>frontend/lib/contracts/kashYieldABI.ts</code>, export it as JSON, or use your compiled contract artifact.
              There is <strong>no</strong> published <code style={{ color: '#00FFFF' }}>kash_sdk</code> package today.
            </p>
            <div className="code-block">
              <div className="code-header">
                <div className="dot red" /><div className="dot yellow" /><div className="dot green" />
              </div>
              <pre>{`from web3 import Web3

RPC = "https://arb1.arbitrum.io/rpc"
w3 = Web3(Web3.HTTPProvider(RPC))

vault_eth = Web3.to_checksum_address("${CONTRACTS.kashYieldEth}")
# abi = json.load(open("kashYield.json"))["abi"]
c = w3.eth.contract(address=vault_eth, abi=abi)

assert c.functions.isUserWindow().call()

tx = c.functions.requestMint(0).build_transaction({
    "from": agent_address,
    "value": deposit_wei,
    "nonce": w3.eth.get_transaction_count(agent_address),
    "gas": ...,
    "maxFeePerGas": ...,
    "maxPriorityFeePerGas": ...,
})
signed = w3.eth.account.sign_transaction(tx, private_key=AGENT_KEY)
w3.eth.send_raw_transaction(signed.raw_transaction)

# KASH-BTC: approve(wbtc, vault_btc) then requestMint(wbtc_amount)
# Redeem: approve(kash_token, vault) then requestRedeem(kash_amount)`}
              </pre>
            </div>
          </div>
        </section>

        <SiteFooter />
      </div>
    </DisclaimerGate>
  );
}
