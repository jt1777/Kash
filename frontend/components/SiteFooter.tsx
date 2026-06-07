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
};

export function SiteFooter({ className, contractAddress }: SiteFooterProps) {
  const verified = contractAddress ? isArbiscanVerifiedKashYield(contractAddress) : false;

  return (
    <footer className={[styles.footer, className].filter(Boolean).join(' ')}>
      <div className={styles.inner}>
        <p>KASH — Enhanced Yield Protocol</p>
        <div className={styles.links}>
          <a href="https://github.com/jt1777/yieldproduct" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href="https://kash-2.gitbook.io/kash-enhanced-yield-protocol" target="_blank" rel="noopener noreferrer">Documentation</a>
          {contractAddress && (
            <a
              href={arbiscanAddressUrl(contractAddress, { code: verified })}
              target="_blank"
              rel="noopener noreferrer"
            >
              {verified ? 'Verified on Arbiscan ↗' : 'Contract Address'}
            </a>
          )}
        </div>
        <p className={styles.disclaimer}></p>
      </div>
    </footer>
  );
}
