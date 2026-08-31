import Link from 'next/link';
import { DisclaimerGate } from '@/components/DisclaimerGate';
import { LandingMetrics } from '@/components/LandingMetrics';
import { ExplainerVideo } from '@/components/ExplainerVideo';
import { SiteFooter } from '@/components/SiteFooter';

export const metadata = {
  title: 'KASH - The Yield Token for AI Agents',
  description:
    'Yield-bearing KASH tokens on Arbitrum for programmable treasuries. Deposit ETH or wBTC via smart contracts; returns vary with funding rates — verify NAV and risks on-chain.',
};

/** GitBook docs (same Markdown sources live under docs/ in the repo) */
const GITBOOK_SPACE =
  'https://kash-2.gitbook.io/kash-enhanced-yield-protocol';

const GITBOOK_AGENT_QUICKSTART = `${GITBOOK_SPACE}/agent-integration/agent-quickstart`;
const GITBOOK_RISKS = `${GITBOOK_SPACE}/how-it-works/risks`;

export default function Home() {

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
        .landing .hero-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: 24px;
        }
        .landing .hero-actions .secondary-cta {
          margin-left: 0;
        }
        .landing .section-title {
          font-size: clamp(1.5rem, 4vw, 2rem);
          margin-bottom: 50px;
          text-align: center;
          color: #FFFFFF;
          text-shadow: 0 0 10px rgba(0, 255, 255, 0.3);
        }
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
        .landing .video-section {
          padding: clamp(60px, 10vw, 100px) 0;
          position: relative;
          z-index: 1;
        }
        .landing .video-frame {
          width: 100%;
          max-width: 1200px;
          margin: 0 auto;
          aspect-ratio: 16 / 9;
          border-radius: 8px;
          overflow: hidden;
          border: 1px solid rgba(0, 255, 255, 0.2);
          background: rgba(0, 255, 255, 0.04);
        }
        .landing .video-frame video {
          display: block;
          width: 100%;
          height: 100%;
        }
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
            justify-content: flex-start;
            padding-top: clamp(10.5rem, 32vw, 14.5rem);
          }
          .landing #metrics,
          .landing #video,
          .landing #features {
            scroll-margin-top: clamp(7.5rem, 24vw, 10.5rem);
          }
          .landing .secondary-cta { display: block; margin: 0; }
          .landing .nav-content { justify-content: center; }
          .landing .nav-links { justify-content: center; }
          .landing .hero-actions { flex-direction: column; }
          .landing .hero-actions a { margin-left: 0; }
        }
        @media (max-width: 480px) {
          .landing .container { padding: 0 16px; }
          .landing .feature-card { padding: 20px; }
        }
      ` }} />
      <div className="landing">
        <nav className="nav">
          <div className="nav-content">
            <Link href="/" className="nav-logo">KASH</Link>
            <div className="nav-links">
              <a href="#metrics" className="nav-link">Metrics</a>
              <a href="#video" className="nav-link">How it works</a>
              <a href="#features" className="nav-link">Features</a>
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
              <strong>Agents:</strong> start at the{' '}
              <a
                href={GITBOOK_AGENT_QUICKSTART}
                target="_blank"
                rel="noopener noreferrer"
                className="hero-human-hint-action"
              >
                Agent Quickstart
              </a>
              .
            </p>
            <div className="hero-actions">
              <a href={GITBOOK_SPACE} target="_blank" rel="noopener noreferrer" className="secondary-cta">Documentation</a>
              <Link href="/app" className="cta-button">🚀 Launch App</Link>
            </div>
          </div>
        </section>

        <LandingMetrics />

        <section className="video-section" id="video">
          <div className="container">
            <h2 className="section-title">How KASH works</h2>
            <div className="video-frame">
              <ExplainerVideo />
            </div>
          </div>
        </section>

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

        <SiteFooter showAgentLinks />
      </div>
    </DisclaimerGate>
  );
}
