const { expect } = require("chai");
const {
  WAD,
  mintKashEstimateFromBatchMintUsd,
  strategyRedeemFractionPure,
} = require("./helpers/strategyRedeemFraction");

describe("strategyRedeemFraction (pure)", function () {
  it("no redeems: strategy fraction is zero", function () {
    const strat = strategyRedeemFractionPure({
      totalSupply: 1000n * WAD,
      redeemKash: 0n,
      mintUsersCount: 1n,
      totalMintUSD: 100n * WAD,
      feeBps: 0n,
      nav: WAD,
    });
    expect(strat).to.equal(0n);
  });

  it("redeem-only: strategy fraction equals gross fraction", function () {
    const totalSupply = 1000n * WAD;
    const redeemKash = 250n * WAD;
    const gross = strategyRedeemFractionPure({
      totalSupply,
      redeemKash,
      mintUsersCount: 0n,
      totalMintUSD: 0n,
      feeBps: 0n,
      nav: WAD,
    });
    expect(gross).to.equal((redeemKash * WAD) / totalSupply);
  });

  it("mint+redeem: strategy unwind is below gross when mint does not fully cover redeem", function () {
    const totalSupply = 1000n * WAD;
    const redeemKash = 400n * WAD;
    const nav = WAD;
    const feeBps = 0n;
    const totalMintUSD = 100n * WAD; // USD value 100 (18-dec)

    const gross = (redeemKash * WAD) / totalSupply;
    const strat = strategyRedeemFractionPure({
      totalSupply,
      redeemKash,
      mintUsersCount: 2n,
      totalMintUSD,
      feeBps,
      nav,
    });
    const mintKashEst = mintKashEstimateFromBatchMintUsd(totalMintUSD, feeBps, nav);
    expect(mintKashEst).to.be.gt(0n);
    expect(strat).to.be.lt(gross);
  });

  it("mint fully offsets redeem KASH estimate: strategy unwind is zero", function () {
    const nav = WAD;
    const feeBps = 0n;
    const totalMintUSD = 500n * WAD;
    const mintKashEst = mintKashEstimateFromBatchMintUsd(totalMintUSD, feeBps, nav);

    const totalSupply = 1000n * WAD;
    const redeemKash = mintKashEst; // after-fee mint USD -> KASH equals redeem

    const strat = strategyRedeemFractionPure({
      totalSupply,
      redeemKash,
      mintUsersCount: 1n,
      totalMintUSD,
      feeBps,
      nav,
    });
    expect(strat).to.equal(0n);
  });
});
