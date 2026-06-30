/**
 * @deprecated Use the atomic stack deploy instead:
 *   npx hardhat run scripts/deploy-kash-btc-aster-stack.js --network arbitrumOne
 *
 * AsterAdapter, ExchangeFacade, and KashYieldBtc V3 reference each other at
 * construction. Split deploys require fragile nonce coordination between runs.
 */
require("dotenv").config();

console.error(`
⚠️  deploy-aster-adapter.js is deprecated.

Use the single-run stack script (Option 1 — nonce prediction):

  npx hardhat run scripts/deploy-kash-btc-aster-stack.js --network arbitrumOne

Or:

  npm run deploy:btc-aster

See scripts/deploy-kash-btc-aster-stack.js for required env vars.
`);

process.exit(1);
