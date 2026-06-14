import Link from 'next/link';
import { DisclaimerGate } from '@/components/DisclaimerGate';
import { SiteFooter } from '@/components/SiteFooter';
import {
  ARBITRUM_ONE_BLOCK_EXPLORER,
  ARBITRUM_ONE_CHAIN_ID,
  CONTRACTS,
  arbiscanAddressUrl,
  isArbiscanVerifiedKashYield,
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

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function Home() {
  const agentBrief = {
    chainId: ARBITRUM_ONE_CHAIN_ID,
    network: 'Arbitrum One',
    explorerBase: ARBITRUM_ONE_BLOCK_EXPLORER,
    products: {
      kashEth: {
        kashYield: CONTRACTS.kashYieldEth,
        kashToken: CONTRACTS.kashTokenEth,
        mintNativeEth:
          'requestMint(0) with tx.value = depositWei (or WETH: approve + requestMint(wethWei))',
        redeem:
          'approve(kashYieldEth, kashWei) on KASH-ETH token, then requestRedeem(kashWei)',
      },
      kashBtc: {
        kashYield: CONTRACTS.kashYieldBtc,
        kashToken: CONTRACTS.kashTokenBtc,
        mint:
          'approve(kashYieldBtc, wbtcWei) on wBTC, then requestMint(wbtcWei)',
        redeem:
          'approve(kashYieldBtc, kashWei) on KASH-BTC token, then requestRedeem(kashWei)',
      },
    },
    scheduleHint:
      'Mint/redeem requests accepted until batch cutoff (~23:45 UTC); mints settle automatically, redeems become claimable after processing.',
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
      'redeemClaimed(batchCycle, user)',
    ],
    eventsToWatch: [
      'MintRequested',
      'RedeemRequested',
      'BatchProcessed',
      'TokensClaimed',
    ],
    redeemClaimProofs:
      process.env.NEXT_PUBLIC_REDEEM_PROOF_BASE_URL || '/redeem-proofs',
    quickstartDocs: GITBOOK_AGENT_QUICKSTART,
    riskDocs: GITBOOK_RISKS,
    mechanicsDocs: GITBOOK_HOW_YIELD_WORKS,
  };

  const ethVaultHref = arbiscanAddressUrl(CONTRACTS.kashYieldEth);
  const btcVaultHref = arbiscanAddressUrl(CONTRACTS.kashYieldBtc, {
    code: isArbiscanVerifiedKashYield(CONTRACTS.kashYieldBtc),
  });
  const btcVaultVerified = isArbiscanVerifiedKashYield(CONTRACTS.kashYieldBtc);

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
        .landing .stats {
          background: linear-gradient(180deg, #0A0A1E 0%, rgba(0, 20, 40, 0.5) 100%);
          padding: clamp(50px, 8vw, 80px) 0;
          border-top: 1px solid rgba(0, 255, 255, 0.15);
          position: relative;
          z-index: 1;
        }
        .landing .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 32px;
          text-align: center;
        }
        .landing .stat-value {
          font-size: clamp(2rem, 5vw, 3rem);
          font-weight: 700;
          color: #00FFFF;
          text-shadow: 0 0 15px rgba(0, 255, 255, 0.6);
        }
        .landing .stat-label { color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 2px; }
        .landing .section-caption {
          max-width: 720px;
          margin: -36px auto 40px;
          text-align: center;
          color: rgba(255, 255, 255, 0.72);
          font-size: clamp(0.9rem, 2vw, 1rem);
          line-height: 1.65;
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
        .landing .proof-card p {
          color: rgba(255, 255, 255, 0.82);
          font-size: 0.88rem;
          line-height: 1.65;
        }
        .landing .proof-card a {
          color: #7DF9FF;
          word-break: break-all;
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
              Returns based on funding rates — verify contracts and risk disclosure before allocating capital.
            </p>
            <p className="hero-human-hint" role="note">
              <strong>FOR HUMANS:</strong> read <strong>Documentation</strong> first, then click <strong>Launch App</strong> to begin.
            </p>
            <div>
              <Link href="/app" className="cta-button">🚀 Launch App</Link>
              <a href="https://kash-2.gitbook.io/kash-enhanced-yield-protocol" target="_blank" rel="noopener noreferrer" className="secondary-cta">Documentation</a>
              <a href="https://github.com/jt1777/Kash" className="secondary-cta" target="_blank" rel="noopener noreferrer">GitHub →</a>
            </div>
          </div>
        </section>

        <section className="stats">
          <div className="container">
            <div className="stats-grid">
              <div><div className="stat-value">On-Chain</div><div className="stat-label">NAV published on-chain; mints and settlements verifiable</div></div>
              <div><div className="stat-value">Δ</div><div className="stat-label">Market-neutral at all times</div></div>
              <div><div className="stat-value">AI</div><div className="stat-label">Batch Ops managed by AI Agent</div></div>
            </div>
          </div>
        </section>

        <section className="features" id="features">
          <div className="container">
            <h2 className="section-title">Why KASH?</h2>
            <div className="features-grid">
              <div className="feature-card">
                <div className="feature-icon">⚡</div>
                <h3 className="feature-title">Programmatic-First</h3>
                <p className="feature-desc">No UI needed. Deposit, earn, and redeem entirely through smart contract calls. Built for automation.</p>
              </div>
              {/*<div className="feature-card">
                <div className="feature-icon">🛡️</div>
                <h3 className="feature-title">Delta Neutral</h3>
                <p className="feature-desc"></p>
              </div>*/}
              <div className="feature-card">
                <div className="feature-icon">🔋</div>
                <h3 className="feature-title">Funding Rate Yield</h3>
                <p className="feature-desc">
                  Strategy targets delta-neutral funding income; superior yield from innovative strategies.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🌐</div>
                <h3 className="feature-title">Arbitrum Native</h3>
                <p className="feature-desc">
                  Low gas on Arbitrum One for mints, redeems, and on-chain reads — NAV, fees, and pending requests settle on a daily batch schedule.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">📊</div>
                <h3 className="feature-title">Transparent Metrics</h3>
                <p className="feature-desc">
                  Read NAV and batch events on-chain (e.g. getNAV(), BatchProcessed). Understand assumptions in docs — not guaranteed APY.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🤖</div>
                <h3 className="feature-title">Agent Optimized</h3>
                <p className="feature-desc">
                  Predictable daily windows for mint/redeem requests and settlement — no need to micromanage intraday swaps.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="for-ai" id="agent-brief">
          <div className="container">
            <h2 className="section-title">Built for AI agents</h2>
            <p className="section-caption">
              Machine-readable integration brief (addresses come from app env defaults — confirm before mainnet execution).
            </p>
            <p className="agent-json-caption">Copy as JSON for tools / planners</p>
            <div className="code-block" style={{ marginBottom: 48 }}>
              <div className="code-header">
                <div className="dot red" /><div className="dot yellow" /><div className="dot green" />
              </div>
              <pre>{JSON.stringify(agentBrief, null, 2)}</pre>
            </div>
            <ul className="ai-list">
              <li><strong>Contract-first</strong> — Integrate via KashYield + ERC-20 KASH; optional UI is unrelated to execution.</li>
              <li><strong>Deterministic scheduling</strong> — Poll <code style={{ color: '#00FFFF' }}>isUserWindow</code>, submit before batch cutoff, await <code style={{ color: '#00FFFF' }}>BatchProcessed</code>.</li>
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
                <p>
                  Call <code style={{ color: '#00FFFF' }}>currentNAV()</code> / <code style={{ color: '#00FFFF' }}>getNAV()</code> on KashYield (ETH vault{' '}
                  <a href={ethVaultHref} target="_blank" rel="noopener noreferrer">{CONTRACTS.kashYieldEth}</a>
                  , BTC vault{' '}
                  <a href={btcVaultHref} target="_blank" rel="noopener noreferrer">{CONTRACTS.kashYieldBtc}</a>
                  ). Compare reads across blocks with docs on update cadence.
                </p>
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
                  Use <code style={{ color: '#00FFFF' }}>isUserWindow()</code> / <code style={{ color: '#00FFFF' }}>isProcessingWindow()</code> and subscribe to{' '}
                  <code style={{ color: '#00FFFF' }}>BatchProcessed</code> events to anchor automation — cutoff time is documented (~23:45 UTC); validate against deployment.
                </p>
              </div>
              <div className="proof-card">
                <h3>TVL &amp; historical performance</h3>
                <p>
                  Not displayed on this page. Derive exposure from total KASH supply × NAV, protocol holdings, and your own dashboards — do not infer APY from marketing copy alone.
                </p>
              </div>
              <div className="proof-card">
                <h3>Verified source code</h3>
                <p>
                  {btcVaultVerified ? (
                    <>
                      KashYield BTC vault contract is verified on Arbiscan:{' '}
                      <a href={btcVaultHref} target="_blank" rel="noopener noreferrer">
                        View verified code ↗
                      </a>
                      {' '}({shortenAddress(CONTRACTS.kashYieldBtc)}).
                    </>
                  ) : (
                    <>
                      Review vault bytecode and source on{' '}
                      <a href={btcVaultHref} target="_blank" rel="noopener noreferrer">Arbiscan</a>
                      {' '}before allocating.
                    </>
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
              {' '}on GitBook.
            </p>
            <div className="proof-grid">
              <div className="proof-card">
                <h3>1. Load facts</h3>
                <p>
                  Chain ID <strong>{ARBITRUM_ONE_CHAIN_ID}</strong>, RPC <code style={{ color: '#00FFFF' }}>https://arb1.arbitrum.io/rpc</code>, ABI from{' '}
                  <a href="https://github.com/jt1777/Kash/blob/main/frontend/lib/contracts/kashYieldABI.ts" target="_blank" rel="noopener noreferrer">kashYieldABI.ts</a>.
                </p>
              </div>
              <div className="proof-card">
                <h3>2. Preflight reads</h3>
                <p>
                  Before signing, read <code style={{ color: '#00FFFF' }}>paused()</code>, <code style={{ color: '#00FFFF' }}>isUserWindow()</code>,{' '}
                  <code style={{ color: '#00FFFF' }}>currentNAV()</code>, <code style={{ color: '#00FFFF' }}>feeBps()</code>, and <code style={{ color: '#00FFFF' }}>getCurrentBatchCycle()</code>.
                </p>
              </div>
              <div className="proof-card">
                <h3>3. Mint</h3>
                <p>
                  ETH: call <code style={{ color: '#00FFFF' }}>requestMint(0)</code> with <code style={{ color: '#00FFFF' }}>msg.value</code>. BTC: approve wBTC to the BTC vault, then call{' '}
                  <code style={{ color: '#00FFFF' }}>requestMint(wbtcAmount)</code>.
                </p>
              </div>
              <div className="proof-card">
                <h3>4. Monitor</h3>
                <p>
                  Watch <code style={{ color: '#00FFFF' }}>MintRequested</code>, <code style={{ color: '#00FFFF' }}>RedeemRequested</code>, <code style={{ color: '#00FFFF' }}>BatchProcessed</code>, and your KASH token balance or redeem claim status after settlement.
                </p>
              </div>
              <div className="proof-card">
                <h3>5. Redeem</h3>
                <p>
                  Approve the relevant KASH token to its KashYield vault, call <code style={{ color: '#00FFFF' }}>requestRedeem(kashAmount)</code> before the batch cutoff, then call <code style={{ color: '#00FFFF' }}>claimRedeem(batchCycle, amount, proof)</code> after settlement.
                </p>
              </div>
              <div className="proof-card">
                <h3>6. Risk gate</h3>
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
              Contracts use <code style={{ color: '#00FFFF' }}>requestMint</code> / <code style={{ color: '#00FFFF' }}>requestRedeem</code>. ABI reference:{' '}
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

// After batch: read NAV, watch BatchProcessed; to exit:
// await wallet.writeContract({ address: kashTokenEth, abi: erc20Abi, functionName: 'approve', args: [vaultEth, kashWei] });
// await wallet.writeContract({ address: vaultEth, abi, functionName: 'requestRedeem', args: [kashWei] });
// After redeem settlement: claimRedeem(batchCycle, amount, proof) using hosted proof JSON.`}
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
