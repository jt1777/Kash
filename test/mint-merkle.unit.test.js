const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  allocMintKashAmounts,
  buildMintMerkleTree,
} = require("./helpers/mintMerkle");

describe("mint merkle", function () {
  it("allocates mint kash amounts with last-minter dust rule", function () {
    const entries = allocMintKashAmounts(
      ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"],
      [60n, 40n],
      100n,
      1_000_000n,
    );
    const total = entries.reduce((s, e) => s + e.amount, 0n);
    expect(total).to.equal(1_000_000n);
    expect(entries[0].amount + entries[1].amount).to.equal(total);
  });

  it("builds proofs verifiable on-chain", async function () {
    const batchCycle = 42n;
    const user = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 12345n;
    const { root, proofs } = buildMintMerkleTree(batchCycle, [{ user, amount }]);
    const proof = proofs.get(user.toLowerCase());
    expect(proof).to.be.an("array");

    const MerkleVerify = await ethers.getContractFactory("MerkleVerifyHarness");
    const harness = await MerkleVerify.deploy();
    const leaf = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint256"], [batchCycle, user, amount]),
    );
    expect(await harness.verify(proof, root, leaf)).to.equal(true);
  });

  it("builds verifiable proofs for 3+ leaves", async function () {
    const batchCycle = 99n;
    const entries = [
      { user: "0x0000000000000000000000000000000000000001", amount: 100n },
      { user: "0x0000000000000000000000000000000000000002", amount: 200n },
      { user: "0x0000000000000000000000000000000000000003", amount: 300n },
      { user: "0x0000000000000000000000000000000000000004", amount: 400n },
    ];
    const { root, proofs } = buildMintMerkleTree(batchCycle, entries);
    const MerkleVerify = await ethers.getContractFactory("MerkleVerifyHarness");
    const harness = await MerkleVerify.deploy();
    for (const e of entries) {
      const leaf = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "address", "uint256"],
          [batchCycle, e.user, e.amount],
        ),
      );
      const proof = proofs.get(e.user.toLowerCase());
      expect(await harness.verify(proof, root, leaf)).to.equal(true);
    }
  });
});
