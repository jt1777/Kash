'use client';

import '@rainbow-me/rainbowkit/styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { getConfig } from '@/lib/wagmi';
import { ReactNode, useState, useMemo, useEffect } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const config = useMemo(() => {
    if (typeof window !== 'undefined') {
      return getConfig();
    }
    return null;
  }, []);

  const app = !mounted || !config ? children : (
    <WagmiProvider config={config}>
      <RainbowKitProvider>{children}</RainbowKitProvider>
    </WagmiProvider>
  );

  return <QueryClientProvider client={queryClient}>{app}</QueryClientProvider>;
}
