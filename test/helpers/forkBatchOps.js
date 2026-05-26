/**
 * Manual mint/redeem ops helpers for mainnet-fork e2e tests.
 *
 * Phase 2 `_processBatchPhase2` requires the vault to hold protocol fees in the
 * native asset (ETH/wBTC) on the contract. Depositing 100% of the mint to Aave
 * leaves zero balance and reverts with InsufficientEthForRedeems /
 * InsufficientWbtcForRedeems even on mint-only batches.
 *
 * Settlement `updateNAV` usdcBalance is a snapshot for events only — after
 * depositToHyperliquid the contract's ERC-20 USDC is 0, so pass 0n not borrowUsdc.
 */

const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

function mintProtocolFee(amount, feeBps) {
  return (amount * feeBps) / 10_000n;
}

function usdcBorrowForAssetUsd(assetUsd18, ltvPct = 60n) {
  return (assetUsd18 * ltvPct) / 100n / (10n ** 12n);
}

/**
 * Manual ETH mint ops after Phase 1: deposit (mint − protocol fee) to Aave,
 * borrow, HL deposit, optional short sync.
 */
async function manualEthMintOps({
  kashYield,
  bot,
  hlAdapter,
  mintEthAmount,
  shortLeveragePct = 170n,
}) {
  const feeBps = BigInt(await kashYield.feeBps());
  const protocolFeeEth = mintProtocolFee(mintEthAmount, feeBps);
  const deployEth = mintEthAmount - protocolFeeEth;

  const ethPrice = await kashYield.getEthPrice();
  const deployUsd = (deployEth * ethPrice) / (10n ** 18n);
  const borrowUsdc = usdcBorrowForAssetUsd(deployUsd);

  await kashYield.connect(bot).depositToAave(deployEth);
  await kashYield.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
  await kashYield.connect(bot).depositToHyperliquid(borrowUsdc);

  await kashYield.connect(bot).spotBuyOnHyperliquid(borrowUsdc);
  const shortSizeUSD = (deployUsd * shortLeveragePct) / 100n;
  const shortSizeAsset = (shortSizeUSD * 10n ** 18n) / ethPrice;
  await kashYield.connect(bot).openShort("ETH", shortSizeAsset);
  await hlAdapter.syncPosition("ETH", shortSizeAsset, ethPrice, true);

  return { protocolFeeEth, deployEth, borrowUsdc, ethPrice, deployUsd, shortSizeAsset };
}

/**
 * Manual wBTC mint ops after Phase 1 (same fee reserve + usdcBal=0 NAV rules).
 */
async function manualBtcMintOps({
  kashYield,
  bot,
  hlAdapter,
  mintBtcAmount,
  shortLeveragePct = 170n,
}) {
  const feeBps = BigInt(await kashYield.feeBps());
  const protocolFeeBtc = mintProtocolFee(mintBtcAmount, feeBps);
  const deployBtc = mintBtcAmount - protocolFeeBtc;

  const btcPrice = await kashYield.getBtcPrice();
  const deployUsd = (deployBtc * btcPrice) / (10n ** 8n);
  const borrowUsdc = usdcBorrowForAssetUsd(deployUsd);

  await kashYield.connect(bot).depositToAave(deployBtc);
  await kashYield.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
  await kashYield.connect(bot).depositToHyperliquid(borrowUsdc);

  await kashYield.connect(bot).spotBuyOnHyperliquid(borrowUsdc);
  const shortSizeUSD = (deployUsd * shortLeveragePct) / 100n;
  const shortSizeAsset = (shortSizeUSD * 10n ** 18n) / btcPrice;
  await kashYield.connect(bot).openShort("BTC", shortSizeAsset);
  await hlAdapter.syncPosition("BTC", shortSizeAsset, btcPrice, true);

  return { protocolFeeBtc, deployBtc, borrowUsdc, btcPrice, deployUsd, shortSizeAsset };
}

async function settleMintPhase2({ kashYield, bot, batchCycle, nav }) {
  await kashYield.connect(bot).updateNAV(nav, 0n, 0n, 0n);
  await kashYield.connect(bot).markBatchOpsDone(batchCycle);
  await kashYield.connect(bot).performUpkeep("0x");
}

module.exports = {
  USDC_ADDRESS,
  mintProtocolFee,
  usdcBorrowForAssetUsd,
  manualEthMintOps,
  manualBtcMintOps,
  settleMintPhase2,
};
