const { expect } = require("chai");
const {
  WAD,
  mintKashEstimateFromBatchMintUsd,
  strategyRedeemFractionPure,
} = require("./helpers/strategyRedeemFraction");

const FEE_BPS = 3n;
const BPS = 10_000n;

function afterFee(value, feeBps = FEE_BPS) {
  return (value * (BPS - feeBps)) / BPS;
}

function settleBatch({ supply, nav, portfolioUsd, mintUsd = [], redeemKash = [], feeBps = FEE_BPS }) {
  const totalMintUsd = mintUsd.reduce((sum, v) => sum + v, 0n);
  const totalMintKash = mintUsd.reduce(
    (sum, v) => sum + mintKashEstimateFromBatchMintUsd(v, feeBps, nav),
    0n,
  );
  const totalRedeemKash = redeemKash.reduce((sum, v) => sum + v, 0n);
  const redeemUsdAfterFee = redeemKash.reduce(
    (sum, v) => sum + afterFee((v * nav) / WAD, feeBps),
    0n,
  );
  return {
    totalMintUsd,
    totalMintKash,
    totalRedeemKash,
    redeemUsdAfterFee,
    netKash: totalMintKash - totalRedeemKash,
    supplyAfter: supply + totalMintKash - totalRedeemKash,
    portfolioAfter: portfolioUsd + totalMintUsd - redeemUsdAfterFee,
    strategyRedeemFraction: strategyRedeemFractionPure({
      totalSupply: supply,
      redeemKash: totalRedeemKash,
      mintUsersCount: BigInt(mintUsd.length),
      totalMintUSD: totalMintUsd,
      feeBps,
      nav,
    }),
  };
}

function navFrom(portfolioUsd, supply) {
  if (supply === 0n) return WAD;
  return (portfolioUsd * WAD) / supply;
}

describe("bot batch process math", function () {
  it("multiple users mint only, including a user adding to their position", function () {
    const existingSupply = 1_000n * WAD;
    const nav = WAD;
    const portfolioUsd = existingSupply;

    const user1Existing = 100n * WAD;
    const user1NewMintUsd = 25n * WAD;
    const newUserMintUsd = 75n * WAD;
    const result = settleBatch({
      supply: existingSupply,
      nav,
      portfolioUsd,
      mintUsd: [user1NewMintUsd, newUserMintUsd],
    });

    const user1Minted = mintKashEstimateFromBatchMintUsd(user1NewMintUsd, FEE_BPS, nav);
    const newUserMinted = mintKashEstimateFromBatchMintUsd(newUserMintUsd, FEE_BPS, nav);

    expect(result.totalRedeemKash).to.equal(0n);
    expect(result.strategyRedeemFraction).to.equal(0n);
    expect(user1Existing + user1Minted).to.be.gt(user1Existing);
    expect(result.totalMintKash).to.equal(user1Minted + newUserMinted);
    expect(result.supplyAfter).to.equal(existingSupply + result.totalMintKash);
  });

  it("multiple users partial redeem only: strategy unwind equals gross redeem fraction", function () {
    const supply = 1_000n * WAD;
    const nav = WAD;
    const portfolioUsd = supply;
    const redeem1 = 120n * WAD;
    const redeem2 = 80n * WAD;
    const result = settleBatch({
      supply,
      nav,
      portfolioUsd,
      redeemKash: [redeem1, redeem2],
    });

    const gross = ((redeem1 + redeem2) * WAD) / supply;
    expect(result.strategyRedeemFraction).to.equal(gross);
    expect(result.netKash).to.equal(-(redeem1 + redeem2));
    expect(result.supplyAfter).to.equal(800n * WAD);
    expect(result.redeemUsdAfterFee).to.equal(afterFee(200n * WAD));
  });

  it("multiple users full redeem only: strategy fully unwinds and supply reaches zero", function () {
    const supply = 1_000n * WAD;
    const nav = WAD;
    const portfolioUsd = supply;
    const result = settleBatch({
      supply,
      nav,
      portfolioUsd,
      redeemKash: [400n * WAD, 600n * WAD],
    });

    expect(result.strategyRedeemFraction).to.equal(WAD);
    expect(result.netKash).to.equal(-supply);
    expect(result.supplyAfter).to.equal(0n);
    expect(result.portfolioAfter).to.equal(portfolioUsd - afterFee(portfolioUsd));
  });

  it("mixed mint and redeem, net mint: incoming mints fully offset strategy unwind", function () {
    const supply = 1_000n * WAD;
    const nav = WAD;
    const portfolioUsd = supply;
    const result = settleBatch({
      supply,
      nav,
      portfolioUsd,
      mintUsd: [500n * WAD],
      redeemKash: [100n * WAD],
    });

    expect(result.totalMintKash).to.be.gt(result.totalRedeemKash);
    expect(result.netKash).to.be.gt(0n);
    expect(result.strategyRedeemFraction).to.equal(0n);
    expect(result.supplyAfter).to.equal(supply + result.totalMintKash - 100n * WAD);
  });

  it("mixed mint and redeem, net redeem: incoming mints reduce but do not eliminate unwind", function () {
    const supply = 1_000n * WAD;
    const nav = WAD;
    const portfolioUsd = supply;
    const redeemKash = 400n * WAD;
    const mintUsd = 100n * WAD;
    const result = settleBatch({
      supply,
      nav,
      portfolioUsd,
      mintUsd: [mintUsd],
      redeemKash: [redeemKash],
    });

    const gross = (redeemKash * WAD) / supply;
    expect(result.totalMintKash).to.be.lt(result.totalRedeemKash);
    expect(result.netKash).to.be.lt(0n);
    expect(result.strategyRedeemFraction).to.be.gt(0n);
    expect(result.strategyRedeemFraction).to.be.lt(gross);
  });

  it("near-zero gross net batch can still require tiny strategy unwind after mint fee", function () {
    const supply = 1_000n * WAD;
    const nav = WAD;
    const portfolioUsd = supply;
    const result = settleBatch({
      supply,
      nav,
      portfolioUsd,
      mintUsd: [100n * WAD],
      redeemKash: [100n * WAD],
    });

    expect(result.totalMintUsd).to.equal(100n * WAD);
    expect((result.totalRedeemKash * nav) / WAD).to.equal(100n * WAD);
    expect(result.netKash).to.be.lt(0n);
    expect(result.strategyRedeemFraction).to.be.gt(0n);
    expect(result.strategyRedeemFraction).to.be.lt(WAD / 10_000n);
  });

  it("one user over multiple days: NAV remains exactly stable when fees are zero", function () {
    let supply = 1_000n * WAD;
    let portfolioUsd = supply;
    let nav = navFrom(portfolioUsd, supply);

    const day1 = settleBatch({ supply, nav, portfolioUsd, mintUsd: [100n * WAD], feeBps: 0n });
    supply = day1.supplyAfter;
    portfolioUsd = day1.portfolioAfter;
    nav = navFrom(portfolioUsd, supply);
    expect(nav).to.equal(WAD);

    const day2 = settleBatch({ supply, nav, portfolioUsd, redeemKash: [50n * WAD], feeBps: 0n });
    supply = day2.supplyAfter;
    portfolioUsd = day2.portfolioAfter;
    nav = navFrom(portfolioUsd, supply);
    expect(nav).to.equal(WAD);

    const day3 = settleBatch({ supply, nav, portfolioUsd, mintUsd: [25n * WAD], redeemKash: [25n * WAD], feeBps: 0n });
    supply = day3.supplyAfter;
    portfolioUsd = day3.portfolioAfter;
    expect(navFrom(portfolioUsd, supply)).to.equal(WAD);
  });

  it("multiple users over multiple days: fees increase NAV but do not create unexplained drift", function () {
    let supply = 1_000n * WAD;
    let portfolioUsd = supply;
    let nav = navFrom(portfolioUsd, supply);

    for (const batch of [
      { mintUsd: [50n * WAD, 75n * WAD], redeemKash: [] },
      { mintUsd: [], redeemKash: [30n * WAD, 45n * WAD] },
      { mintUsd: [100n * WAD], redeemKash: [60n * WAD] },
    ]) {
      const result = settleBatch({ supply, nav, portfolioUsd, ...batch });
      supply = result.supplyAfter;
      portfolioUsd = result.portfolioAfter;
      const nextNav = navFrom(portfolioUsd, supply);
      expect(nextNav).to.be.gte(nav);
      nav = nextNav;
    }

    // Fees are retained by the vault, so NAV should move only slightly after these small batches.
    expect(nav).to.be.lt(WAD + WAD / 1_000n);
  });
});
