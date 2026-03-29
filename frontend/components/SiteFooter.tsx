'use client';

import { ARBITRUM_SEPOLIA_BLOCK_EXPLORER } from '@/lib/contracts/addresses';
import styles from './SiteFooter.module.css';

type SiteFooterProps = {
  className?: string;
  /** When provided, renders a "Contract Address" link to Arbiscan. Omit to hide the link. */
  contractAddress?: `0x${string}`;
};

export function SiteFooter({ className, contractAddress }: SiteFooterProps) {
  return (
    <footer className={[styles.footer, className].filter(Boolean).join(' ')}>
      <div className={styles.inner}>
        <p>KASH — Enhanced Yield Protocol</p>
        <div className={styles.links}>
          <a href="https://github.com/jt1777/yieldproduct" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href="#">Documentation</a>
          {contractAddress && (
            <a
              href={`${ARBITRUM_SEPOLIA_BLOCK_EXPLORER}/address/${contractAddress}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Contract Address
            </a>
          )}
        </div>
        <p className={styles.disclaimer}>Don&apos;t Trust, Verify.</p>
      </div>
    </footer>
  );
}
