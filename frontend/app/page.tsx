import Link from 'next/link';

export const metadata = {
  title: 'KASH - The Yield Token for AI Agents',
  description: 'The first yield-bearing token designed for AI agents. Deposit ETH, earn automated yield from decentralized funding rates.',
};

export default function Home() {
  return (
    <>
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
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          text-align: center;
          position: relative;
          z-index: 1;
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
        .landing .subtitle {
          font-size: clamp(1rem, 2.5vw, 1.3rem);
          color: rgba(255, 255, 255, 0.85);
          max-width: 600px;
          margin-bottom: 40px;
          line-height: 1.7;
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
        .landing footer {
          padding: clamp(40px, 6vw, 60px) 0;
          text-align: center;
          border-top: 1px solid rgba(0, 255, 255, 0.15);
          color: rgba(255, 255, 255, 0.75);
          position: relative;
          z-index: 1;
        }
        .landing .links { margin-top: 20px; }
        .landing .links a {
          color: #00FFFF;
          text-decoration: none;
          margin: 0 15px;
          transition: all 0.3s ease;
          text-shadow: 0 0 8px rgba(0, 255, 255, 0.3);
        }
        .landing .links a:hover { text-decoration: none; text-shadow: 0 0 12px #00FFFF; }
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
        @media (max-width: 768px) {
          .landing .hero { padding-top: 120px; }
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
              <a href="#integration" className="nav-link">Integration</a>
              <a href="https://github.com/jt1777/yieldproduct" className="nav-link" target="_blank" rel="noopener noreferrer">GitHub</a>
              <Link href="/app" className="nav-button">Launch App →</Link>
            </div>
          </div>
        </nav>

        <section className="hero">
          <div className="container">
            <div className="badge">🤖 BY AGENTS, FOR AGENTS</div>
            <h1>KASH<span className="cursor" /></h1>
            <p className="subtitle">The first yield-bearing token designed for AI agents. Deposit ETH, earn automated yield from decentralized funding rates. No humans required.</p>
            <div>
              <Link href="/app" className="cta-button">🚀 Launch App</Link>
              <a href="#integration" className="secondary-cta">Documentation</a>
              <a href="https://github.com/jt1777/yieldproduct" className="secondary-cta" target="_blank" rel="noopener noreferrer">GitHub →</a>
            </div>
          </div>
        </section>

        <section className="stats">
          <div className="container">
            <div className="stats-grid">
              <div><div className="stat-value">70%</div><div className="stat-label">Max LTV</div></div>
              <div><div className="stat-value">1.7x</div><div className="stat-label">Leverage</div></div>
              <div><div className="stat-value">Δ</div><div className="stat-label">Delta Neutral</div></div>
              <div><div className="stat-value">24/7</div><div className="stat-label">Autonomous</div></div>
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
              <div className="feature-card">
                <div className="feature-icon">🛡️</div>
                <h3 className="feature-title">Delta Neutral</h3>
                <p className="feature-desc">Your ETH is protected from price swings. We hedge with 1.7x short positions on Hyperliquid.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🔋</div>
                <h3 className="feature-title">Funding Rate Yield</h3>
                <p className="feature-desc">Earn from perpetual exchange funding rates. When shorts pay longs, your agent gets paid.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🌐</div>
                <h3 className="feature-title">Arbitrum Native</h3>
                <p className="feature-desc">Low gas, fast finality. Perfect for high-frequency agent operations and micro-strategies.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">📊</div>
                <h3 className="feature-title">Transparent Metrics</h3>
                <p className="feature-desc">On-chain yield tracking. Query your agent&apos;s earnings anytime with a simple view function.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🤖</div>
                <h3 className="feature-title">Agent Optimized</h3>
                <p className="feature-desc">Batch processing, time windows, and gas-efficient operations designed for automated systems.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="code-section" id="integration">
          <div className="container">
            <h2 className="section-title">Integration in 5 Lines</h2>
            <div className="code-block">
              <div className="code-header">
                <div className="dot red" /><div className="dot yellow" /><div className="dot green" />
              </div>
              <pre>{`// Connect to KASH vault
KashYield vault = KashYield(0x...);

// Deposit ETH and start earning
depositETH{value: 1 ether}();

// Check accumulated yield
int256 fees = vault.getAccumulatedFees();

// Redeem principal + yield
requestRedemption(kashEthBalance);`}</pre>
            </div>
            <h2 className="section-title" style={{ marginTop: 60 }}>Python SDK Example</h2>
            <div className="code-block">
              <div className="code-header">
                <div className="dot red" /><div className="dot yellow" /><div className="dot green" />
              </div>
              <pre>{`from web3 import Web3
from kash_sdk import KashVault

# Initialize agent wallet
agent = KashVault(private_key=AGENT_KEY)

# Automated yield strategy
def autonomous_deposit(amount):
    if agent.balance > amount:
        tx = agent.deposit_eth(amount)
        agent.log(f"Deposited {amount} ETH")
        return tx

# Check earnings every hour
earnings = agent.get_yield_accrual()
if earnings > 0.01:  # Threshold trigger
    agent.auto_compound()  # Reinvest yield`}</pre>
            </div>
          </div>
        </section>

        <section className="for-ai">
          <div className="container">
            <h2 className="section-title">Built for AI Agents</h2>
            <ul className="ai-list">
              <li><strong>API-First Design</strong> — No frontend needed. Pure smart contract interactions.</li>
              <li><strong>Time-Batched Processing</strong> — Deposit windows optimized for automated scheduling.</li>
              <li><strong>Gas-Efficient</strong> — Minimal operations, designed for high-frequency agent strategies.</li>
              <li><strong>Composable</strong> — Integrate KASH into your agent&apos;s treasury management system.</li>
              <li><strong>Autonomous Rebalancing</strong> — Delta-neutral positions maintained automatically.</li>
              <li><strong>Queryable State</strong> — All metrics available on-chain for agent decision-making.</li>
            </ul>
          </div>
        </section>

        <footer>
          <div className="container">
            <p>KASH Yield Token — Arbitrum</p>
            <div className="links">
              <a href="https://github.com/jt1777/yieldproduct" target="_blank" rel="noopener noreferrer">GitHub</a>
              <a href="#">Documentation</a>
              <a href="#">Contract Address</a>
            </div>
            <p style={{ marginTop: 30, fontSize: '0.85rem', opacity: 0.6 }}>
              Built by agents, for agents. Not financial advice. DYOR.
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
