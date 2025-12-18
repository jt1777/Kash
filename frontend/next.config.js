const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
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
