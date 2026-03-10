const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  // Expose contract address env vars to the client (no NEXT_PUBLIC_ prefix required)
  env: {
    KASH_YIELD_BTC_ADDRESS: process.env.KASH_YIELD_BTC_ADDRESS,
    KASH_TOKEN_BTC: process.env.KASH_TOKEN_BTC,
    MOCK_WBTC: process.env.MOCK_WBTC,
    KASH_YIELD_ETH_ADDRESS: process.env.KASH_YIELD_ETH_ADDRESS,
    KASH_TOKEN_ETH: process.env.KASH_TOKEN_ETH,
  },
  webpack: (config) => {
    // Ignore optional deps used by connectors in Node/SSR
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@react-native-async-storage/async-storage': path.join(__dirname, 'shims/empty.js'),
      '@safe-global/safe-apps-provider': path.join(__dirname, 'shims/empty.js'),
      '@safe-global/safe-apps-sdk': path.join(__dirname, 'shims/empty.js'),
      'pino-pretty': path.join(__dirname, 'shims/empty.js'),
      'lokijs': path.join(__dirname, 'shims/empty.js'),
      'encoding': path.join(__dirname, 'shims/empty.js'),
    };
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: false,
    };
    return config;
  },
};

module.exports = nextConfig;
