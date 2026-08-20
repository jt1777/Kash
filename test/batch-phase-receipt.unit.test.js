/**
 * Receipt-log phase verify (no latest eth_call). Matches kash-ops bot batchPhaseReceipt.ts.
 * Run: npx hardhat test test/batch-phase-receipt.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { phaseFromBatchPhaseUpdatedLogs } = require("./helpers/batchPhaseReceipt");

const EVENT = "event BatchPhaseUpdated(uint256 indexed batchCycle, uint8 phase, uint256 indicativeNAV)";

describe("BatchPhaseUpdated receipt parse", function () {
  it("returns phase for the matching cycle from receipt logs", function () {
    const vault = "0x083926c2dAbcF1D5bdDF86B6A99A329c5a25E4D3";
    const iface = new ethers.Interface([EVENT]);
    const encoded = iface.encodeEventLog(iface.getEvent("BatchPhaseUpdated"), [
      20684n,
      1,
      10n ** 18n,
    ]);
    const logs = [{ address: vault, topics: encoded.topics, data: encoded.data }];
    expect(phaseFromBatchPhaseUpdatedLogs(logs, 20684n, vault, iface)).to.equal(1);
    expect(phaseFromBatchPhaseUpdatedLogs(logs, 1n, vault, iface)).to.equal(null);
  });
});
