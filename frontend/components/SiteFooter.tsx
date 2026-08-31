'use client';

import {
  arbiscanAddressUrl,
  isArbiscanVerifiedKashYield,
} from '@/lib/contracts/addresses';
import styles from './SiteFooter.module.css';

type SiteFooterProps = {
  className?: string;
  /** When provided, renders a "Contract Address" link to Arbiscan. Omit to hide the link. */
  contractAddress?: `0x${string}`;
  /** Quiet machine-entry pointers on the marketing landing only. */
  showAgentLinks?: boolean;
};

export function SiteFooter({ className, contractAddress, showAgentLinks }: SiteFooterProps) {
  const verified = contractAddress ? isArbiscanVerifiedKashYield(contractAddress) : false;

  return (
    <footer className={[styles.footer, className].filter(Boolean).join(' ')}>
      <div className={styles.inner}>
        <p>KASH — Enhanced Yield Protocol</p>
        <div className={styles.links}>
          <a href="https://github.com/jt1777/Kash" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href="https://kash-2.gitbook.io/kash-enhanced-yield-protocol" target="_blank" rel="noopener noreferrer">Documentation</a>
          <a href="https://discord.gg/FxtyWx6Zw5" target="_blank" rel="noopener noreferrer">
            Discord
          </a>
          <a href="https://x.com/KASH_TOKEN_0X0" target="_blank" rel="noopener noreferrer">
            X
          </a>
          {contractAddress && (
            <a
              href={arbiscanAddressUrl(contractAddress, { code: verified })}
              target="_blank"
              rel="noopener noreferrer"
            >
              {verified ? 'Arbiscan' : 'Contract Address'}
            </a>
          )}
        </div>
        {showAgentLinks && (
          <p className={styles.agentLinks}>
            Agents:{' '}
            <a href="/llms.txt">llms.txt</a>
            {' · '}
            <a href="/agent-brief.json">agent-brief.json</a>
            {' · '}
            <a
              href="https://kash-2.gitbook.io/kash-enhanced-yield-protocol/agent-integration/agent-quickstart"
              target="_blank"
              rel="noopener noreferrer"
            >
              Quickstart
            </a>
          </p>
        )}
        <p className={styles.disclaimer}></p>
      </div>
    </footer>
  );
}
