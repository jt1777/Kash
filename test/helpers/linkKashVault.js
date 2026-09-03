const { ethers } = require("hardhat");

async function deployVaultLibraries() {
  const nav = await (await ethers.getContractFactory("KashVaultNavLib")).deploy();
  const ops = await (await ethers.getContractFactory("KashVaultOpsLib")).deploy();
  const batch = await (await ethers.getContractFactory("KashVaultBatchLib")).deploy();
  return {
    KashVaultNavLib: await nav.getAddress(),
    KashVaultOpsLib: await ops.getAddress(),
    KashVaultBatchLib: await batch.getAddress(),
  };
}

async function getLinkedVaultFactory(name) {
  const libraries = await deployVaultLibraries();
  return ethers.getContractFactory(name, { libraries });
}

module.exports = { deployVaultLibraries, getLinkedVaultFactory };
