'use client';

import { ReactNode, useEffect, useState } from 'react';

const STORAGE_KEY = 'kash-disclaimer-accepted-v1';

type DisclaimerGateProps = {
  children: ReactNode;
  riskDocsUrl?: string;
};

export function DisclaimerGate({ children, riskDocsUrl }: DisclaimerGateProps) {
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const accepted = localStorage.getItem(STORAGE_KEY) === '1';
    setOpen(!accepted);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || !open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [ready, open]);

  function handleContinue() {
    if (!acknowledged) return;
    localStorage.setItem(STORAGE_KEY, '1');
    setOpen(false);
  }

  return (
    <>
      {children}
      {ready && open && (
        <div
          className="disclaimer-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="disclaimer-title"
          aria-describedby="disclaimer-body"
        >
          <div className="disclaimer-panel">
            <h2 id="disclaimer-title" className="disclaimer-title">
              Disclaimer — Under Development
            </h2>
            <div id="disclaimer-body" className="disclaimer-body">
              <p>
                KASH is experimental software on <strong>Arbitrum One</strong>. This website and
                protocol are <strong>under active development</strong> and may change without notice.
              </p>
              <ul>
                <li>
                  <strong>Not financial advice.</strong> Nothing here is an offer, solicitation, or
                  recommendation to buy or sell any asset.
                </li>
                <li>
                  <strong>Smart contract risk.</strong> Bugs or exploits could cause partial or total
                  loss of deposited funds.
                </li>
                <li>
                  <strong>No guaranteed yield.</strong> Returns depend on market conditions (funding
                  rates, liquidity, counterparties) and can be zero or negative.
                </li>
                <li>
                  <strong>Batch settlement.</strong> Mints and redeems are not instant; settlement
                  follows the on-chain batch schedule.
                </li>
                <li>
                  <strong>Operator dependency.</strong> Batch processing and NAV updates rely on
                  off-chain infrastructure that can fail or be delayed.
                </li>
                <li>
                  <strong>Your responsibility.</strong> Verify contract addresses, NAV, fees, and risks
                  on-chain before depositing. Only use funds you can afford to lose.
                </li>
              </ul>
              {riskDocsUrl ? (
                <p className="disclaimer-link-row">
                  Full risk disclosure:{' '}
                  <a href={riskDocsUrl} target="_blank" rel="noopener noreferrer">
                    Read risks documentation
                  </a>
                </p>
              ) : null}
            </div>
            <label className="disclaimer-check">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>I understand these risks and wish to continue.</span>
            </label>
            <button
              type="button"
              className="disclaimer-continue"
              disabled={!acknowledged}
              onClick={handleContinue}
            >
              Continue to site
            </button>
          </div>
          <style jsx>{`
            .disclaimer-overlay {
              position: fixed;
              inset: 0;
              z-index: 10000;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
              background: rgba(5, 5, 18, 0.92);
              backdrop-filter: blur(8px);
              font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
            }
            .disclaimer-panel {
              width: 100%;
              max-width: 520px;
              max-height: min(90vh, 720px);
              overflow-y: auto;
              padding: 28px 24px;
              border-radius: 12px;
              border: 1px solid rgba(0, 255, 255, 0.35);
              background: #0a0a1e;
              box-shadow: 0 0 40px rgba(0, 255, 255, 0.12);
              color: #fff;
            }
            .disclaimer-title {
              font-size: 1.25rem;
              font-weight: 700;
              color: #00ffff;
              margin-bottom: 16px;
              text-shadow: 0 0 10px rgba(0, 255, 255, 0.35);
            }
            .disclaimer-body {
              font-size: 0.875rem;
              line-height: 1.65;
              color: rgba(255, 255, 255, 0.88);
            }
            .disclaimer-body p {
              margin-bottom: 12px;
            }
            .disclaimer-body ul {
              margin: 0 0 12px 1.1rem;
              padding: 0;
            }
            .disclaimer-body li {
              margin-bottom: 10px;
            }
            .disclaimer-body strong {
              color: #fff;
            }
            .disclaimer-link-row a {
              color: #00ffff;
              text-decoration: underline;
            }
            .disclaimer-check {
              display: flex;
              align-items: flex-start;
              gap: 10px;
              margin-top: 20px;
              font-size: 0.875rem;
              cursor: pointer;
              color: rgba(255, 255, 255, 0.9);
            }
            .disclaimer-check input {
              margin-top: 3px;
              width: 16px;
              height: 16px;
              accent-color: #00ffff;
              flex-shrink: 0;
              cursor: pointer;
            }
            .disclaimer-continue {
              width: 100%;
              margin-top: 16px;
              padding: 12px 16px;
              border-radius: 8px;
              border: 2px solid #00ffff;
              background: #00ffff;
              color: #0a0a1e;
              font-family: inherit;
              font-size: 0.9rem;
              font-weight: 600;
              cursor: pointer;
              transition: background 0.2s, color 0.2s, box-shadow 0.2s;
            }
            .disclaimer-continue:disabled {
              opacity: 0.45;
              cursor: not-allowed;
              box-shadow: none;
            }
            .disclaimer-continue:not(:disabled):hover {
              background: transparent;
              color: #00ffff;
              box-shadow: 0 0 20px rgba(0, 255, 255, 0.35);
            }
          `}</style>
        </div>
      )}
    </>
  );
}
