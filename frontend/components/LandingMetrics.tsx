'use client';

import { useVaultMetrics } from '@/hooks/useVaultMetrics';
import {
  formatNavForLanding,
  formatTotalNavCompact,
} from '@/lib/vaultMetrics/formatNav';

export function LandingMetrics() {
  const btc = useVaultMetrics('btc');
  const eth = useVaultMetrics('eth');
  const products = [btc, eth].filter((p) => p.enabled);
  const isOnChainLoading = products.some((p) => p.isOnChainLoading);

  if (products.length === 0) {
    return (
      <section className="metrics" id="metrics">
        <div className="container">
          <p className="section-caption">
            Vault addresses are not configured in this environment. Set the KASH env addresses to display live metrics.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="metrics" id="metrics">
      <div className="container">
        <h2 className="section-title">Live metrics</h2>
        <p className="section-caption">
          Indicative yield and on-chain NAV for each KASH product. Refresh market rates with the button in the app; these values read the chain directly.
        </p>
        <div className="metrics-grid">
          {products.map((product) => {
            const yieldData = product.yield.data;
            const apyDisplay = yieldData?.paYieldDisplay ?? '—';
            const apyClass =
              yieldData && yieldData.paYieldPct >= 0 ? 'metric-positive' : 'metric-negative';

            return (
              <div key={product.product} className="metric-card">
                <div className="metric-product">{product.productName}</div>
                <div className="metric-rows">
                  <div className="metric-block">
                    <div className="metric-label">P.A. Yield</div>
                    <div className={`metric-value ${apyClass}`}>
                      {product.yield.isFetching && !yieldData ? '…' : apyDisplay}
                    </div>
                  </div>
                  <div className="metric-block">
                    <div className="metric-label">Per-Token NAV</div>
                    <div className="metric-value">
                      {isOnChainLoading ? '…' : formatNavForLanding(product.nav)}
                    </div>
                  </div>
                  <div className="metric-block">
                    <div className="metric-label">Total NAV</div>
                    <div className="metric-value">
                      {isOnChainLoading ? '…' : formatTotalNavCompact(product.totalNav)}
                    </div>
                  </div>
                </div>
                {product.yield.isError && (
                  <div className="metric-error">Could not load market rates — refresh to retry.</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
