const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  allocRedeemNetAmounts,
  buildRedeemMerkleTree,
} = require("./helpers/redeemMerkle");

describe("redeem merkle", function () {
  it("allocates net redeem amounts with last-redeemer dust rule", function () {
    const entries = allocRedeemNetAmounts(
      ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"],
      [60n, 40n],
      100n,
      1_000_000n,
      100n,
    );
    const net = entries.reduce((s, e) => s + e.amount, 0n);
    expect(net).to.be.lessThan(1_000_000n);
    expect(entries[0].amount + entries[1].amount).to.equal(net);
  });

  it("builds proofs verifiable on-chain", async function () {
    const batchCycle = 42n;
    const user = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 12345n;
    const { root, proofs } = buildRedeemMerkleTree(batchCycle, [{ user, amount }]);
    const proof = proofs.get(user.toLowerCase());
    expect(proof).to.be.an("array");

    const MerkleVerify = await ethers.getContractFactory("MerkleVerifyHarness");
    const harness = await MerkleVerify.deploy();
    const leaf = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint256"], [batchCycle, user, amount]),
    );
    expect(await harness.verify(proof, root, leaf)).to.equal(true);
  });
});
