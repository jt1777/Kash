const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");

describe("Lock", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployOneYearLockFixture() {
    const ONE_YEAR_IN_SECS = 365 * 24 * 60 * 60;
    const ONE_GWEI = 1_000_000_000;

    const lockedAmount = ONE_GWEI;
    // Removed unlockTime parameter as it's no longer used in constructor
    // const unlockTime = (await time.latest()) + ONE_YEAR_IN_SECS;

    // Contracts are deployed using the first signer/account by default
    const [owner, otherAccount] = await ethers.getSigners();

    const Lock = await ethers.getContractFactory("Lock");
    const lock = await Lock.deploy({ value: lockedAmount });

    return { lock, lockedAmount, owner, otherAccount };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { lock, owner } = await loadFixture(deployOneYearLockFixture);
      expect(await lock.owner()).to.equal(owner.address);
    });

    it("Should receive and store the funds to lock", async function () {
      const { lock, lockedAmount } = await loadFixture(deployOneYearLockFixture);
      expect(await ethers.provider.getBalance(lock.target)).to.equal(lockedAmount);
    });
    // Removed test for unlockTime as it's no longer relevant
  });

  describe("Withdrawals", function () {
    describe("Validations", function () {
      it("Should revert with the right error if called too soon", async function () {
        const { lock } = await loadFixture(deployOneYearLockFixture);
        await expect(lock.withdraw()).to.be.revertedWith("You can't withdraw yet");
      });

      it("Should revert with the right error if called from another account before 24 hours", async function () {
        const { lock, otherAccount } = await loadFixture(deployOneYearLockFixture);
        const depositAmount = ethers.parseEther("1");
        await lock.connect(otherAccount).deposit({ value: depositAmount });
        await expect(lock.connect(otherAccount).withdraw()).to.be.revertedWith("You can't withdraw yet");
      });

      it("Should allow withdrawal after 24 hours for non-owner", async function () {
        const { lock, otherAccount } = await loadFixture(deployOneYearLockFixture);
        const depositAmount = ethers.parseEther("1");
        await lock.connect(otherAccount).deposit({ value: depositAmount });
        await time.increase(1 * 24 * 60 * 60 + 1); // Increase time by 24 hours and 1 second
        await expect(lock.connect(otherAccount).withdraw()).not.to.be.reverted;
      });

      it("Should allow withdrawal after 24 hours for owner", async function () {
        const { lock } = await loadFixture(deployOneYearLockFixture);
        await time.increase(1 * 24 * 60 * 60 + 1); // Increase time by 24 hours and 1 second
        await expect(lock.withdraw()).not.to.be.reverted;
      });
    });

    describe("Events", function () {
      it("Should emit an event on withdrawals", async function () {
        const { lock, lockedAmount } = await loadFixture(deployOneYearLockFixture);

        await time.increase(1 * 24 * 60 * 60 + 1); // Increase time by 24 hours and 1 second

        await expect(lock.withdraw())
          .to.emit(lock, "Withdrawal")
          .withArgs(lockedAmount, anyValue, anyValue);
      });
    });

    describe("Transfers", function () {
      it("Should transfer the funds to the owner", async function () {
        const { lock, lockedAmount, owner } = await loadFixture(deployOneYearLockFixture);

        await time.increase(1 * 24 * 60 * 60 + 1); // Increase time by 24 hours and 1 second

        await expect(lock.withdraw()).to.changeEtherBalances(
          [owner, lock],
          [lockedAmount, -lockedAmount]
        );
      });
    });
  });

  describe("Multi-User Deposits and Withdrawals", function () {
    describe("Deposits", function () {
      it("Should allow non-owner to deposit funds", async function () {
        const { lock, otherAccount } = await loadFixture(deployOneYearLockFixture);
        const depositAmount = ethers.parseEther("1");
        await expect(lock.connect(otherAccount).deposit({ value: depositAmount }))
          .to.emit(lock, "Deposit")
          .withArgs(depositAmount, otherAccount.address, anyValue);
        expect(await lock.getBalance(otherAccount.address)).to.equal(depositAmount);
      });

      it("Should allow multiple deposits from the same account", async function () {
        const { lock, otherAccount } = await loadFixture(deployOneYearLockFixture);
        const depositAmount1 = ethers.parseEther("1");
        const depositAmount2 = ethers.parseEther("2");
        await lock.connect(otherAccount).deposit({ value: depositAmount1 });
        await lock.connect(otherAccount).deposit({ value: depositAmount2 });
        expect(await lock.getBalance(otherAccount.address)).to.equal(depositAmount1 + depositAmount2);
      });

      it("Should revert if deposit amount is 0", async function () {
        const { lock, otherAccount } = await loadFixture(deployOneYearLockFixture);
        await expect(lock.connect(otherAccount).deposit({ value: 0 })).to.be.revertedWith("Deposit amount must be greater than 0");
      });
    });

    describe("Withdrawals by Non-Owner", function () {
      it("Should allow non-owner to withdraw their funds after 24 hours", async function () {
        const { lock, otherAccount } = await loadFixture(deployOneYearLockFixture);
        const depositAmount = ethers.parseEther("1");
        await lock.connect(otherAccount).deposit({ value: depositAmount });
        await time.increase(1 * 24 * 60 * 60 + 1); // Increase time by 24 hours and 1 second
        await expect(lock.connect(otherAccount).withdraw())
          .to.emit(lock, "Withdrawal")
          .withArgs(depositAmount, anyValue, otherAccount.address);
        expect(await lock.getBalance(otherAccount.address)).to.equal(0);
        await expect(lock.connect(otherAccount).withdraw()).to.be.revertedWith("No funds to withdraw");
      });

      it("Should revert if non-owner tries to withdraw before 24 hours", async function () {
        const { lock, otherAccount } = await loadFixture(deployOneYearLockFixture);
        const depositAmount = ethers.parseEther("1");
        await lock.connect(otherAccount).deposit({ value: depositAmount });
        await expect(lock.connect(otherAccount).withdraw()).to.be.revertedWith("You can't withdraw yet");
      });

      it("Should revert if non-owner tries to withdraw with no funds", async function () {
        const { lock, otherAccount } = await loadFixture(deployOneYearLockFixture);
        await expect(lock.connect(otherAccount).withdraw()).to.be.revertedWith("No funds to withdraw");
      });
    });

    describe("Balance Tracking", function () {
      it("Should correctly track owner\'s initial balance", async function () {
        const { lock, lockedAmount, owner } = await loadFixture(deployOneYearLockFixture);
        expect(await lock.getBalance(owner.address)).to.equal(lockedAmount);
        expect(await lock.ownerInitialBalance()).to.equal(lockedAmount);
      });

      it("Should keep owner and non-owner balances separate", async function () {
        const { lock, lockedAmount, owner, otherAccount } = await loadFixture(deployOneYearLockFixture);
        const depositAmount = ethers.parseEther("1");
        await lock.connect(otherAccount).deposit({ value: depositAmount });
        expect(await lock.getBalance(owner.address)).to.equal(lockedAmount);
        expect(await lock.getBalance(otherAccount.address)).to.equal(depositAmount);
      });
    });
  });
});
