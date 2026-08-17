/**
 * ExchangeFacade two-step ownership — local Hardhat unit test.
 * Run: npx hardhat test test/exchange-facade-ownership.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ExchangeFacade ownership", function () {
  async function deployFacade() {
    const [owner, bot, nextOwner, stranger] = await ethers.getSigners();
    const facade = await (await ethers.getContractFactory("ExchangeFacade")).deploy(
      owner.address,
      bot.address,
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      ethers.ZeroAddress,
      owner.address,
    );
    return { facade, owner, bot, nextOwner, stranger };
  }

  it("transfers owner only after acceptOwnership", async function () {
    const { facade, owner, nextOwner, stranger } = await deployFacade();

    await expect(facade.connect(stranger).transferOwnership(nextOwner.address)).to.be.revertedWith(
      "Only owner",
    );

    await expect(facade.connect(owner).transferOwnership(nextOwner.address))
      .to.emit(facade, "OwnershipTransferStarted")
      .withArgs(owner.address, nextOwner.address);
    expect(await facade.owner()).to.equal(owner.address);
    expect(await facade.pendingOwner()).to.equal(nextOwner.address);

    await expect(facade.connect(stranger).acceptOwnership()).to.be.revertedWith("Not pending owner");
    await expect(facade.connect(owner).acceptOwnership()).to.be.revertedWith("Not pending owner");

    await expect(facade.connect(nextOwner).acceptOwnership())
      .to.emit(facade, "OwnershipTransferred")
      .withArgs(owner.address, nextOwner.address);
    expect(await facade.owner()).to.equal(nextOwner.address);
    expect(await facade.pendingOwner()).to.equal(ethers.ZeroAddress);

    await expect(facade.connect(owner).setBotAddress(stranger.address)).to.be.revertedWith("Only owner");
    await facade.connect(nextOwner).setBotAddress(stranger.address);
    expect(await facade.botAddress()).to.equal(stranger.address);
  });
});
