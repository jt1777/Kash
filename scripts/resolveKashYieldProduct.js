/**
 * Resolve ETH vs BTC KashYield vault from env (aligned with deploy-hyperliquid-adapter.js).
 *
 * - PRODUCT=eth|btc forces the product.
 * - If only one of KASH_YIELD_ETH_ADDRESS / KASH_YIELD_BTC_ADDRESS is a valid 0x address, use that vault.
 * - Invalid strings (e.g. "x92c..." without "0x") are treated as unset.
 * - If both are valid, require PRODUCT=eth|btc.
 *
 * @param {*} ethers — `hre.ethers` from Hardhat (must provide `isAddress`)
 * @returns {{ isBtc: boolean, kashYieldAddress: string, contractName: "KashYieldETH" | "KashYieldBtc" }}
 */
function resolveKashYieldProduct(ethers) {
  const productEnv = (process.env.PRODUCT || "").toLowerCase();
  const kashYieldBtc = process.env.KASH_YIELD_BTC_ADDRESS;
  const kashYieldEth = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;

  const btcOk = Boolean(kashYieldBtc && ethers.isAddress(kashYieldBtc));
  const ethOk = Boolean(kashYieldEth && ethers.isAddress(kashYieldEth));

  if (productEnv === "eth") {
    if (!ethOk) {
      throw new Error(
        "PRODUCT=eth: set a valid KASH_YIELD_ETH_ADDRESS or KASH_YIELD_ADDRESS in .env."
      );
    }
    return { isBtc: false, kashYieldAddress: kashYieldEth, contractName: "KashYieldETH" };
  }
  if (productEnv === "btc") {
    if (!btcOk) {
      throw new Error("PRODUCT=btc: set a valid KASH_YIELD_BTC_ADDRESS in .env.");
    }
    return { isBtc: true, kashYieldAddress: kashYieldBtc, contractName: "KashYieldBtc" };
  }

  if (btcOk && !ethOk) {
    return { isBtc: true, kashYieldAddress: kashYieldBtc, contractName: "KashYieldBtc" };
  }
  if (ethOk && !btcOk) {
    return { isBtc: false, kashYieldAddress: kashYieldEth, contractName: "KashYieldETH" };
  }
  if (btcOk && ethOk) {
    throw new Error(
      "Both KASH_YIELD_ETH_ADDRESS and KASH_YIELD_BTC_ADDRESS are set and valid. " +
        "Set PRODUCT=eth or PRODUCT=btc for this script."
    );
  }

  const hint =
    kashYieldEth || kashYieldBtc
      ? ` Check variables are valid 0x-prefixed addresses (ETH="${kashYieldEth || ""}" BTC="${kashYieldBtc || ""}").`
      : "";
  throw new Error(
    "Set KASH_YIELD_ETH_ADDRESS or KASH_YIELD_BTC_ADDRESS (valid 0x address)." + hint
  );
}

module.exports = { resolveKashYieldProduct };
