/**
 * Phase from BatchPhaseUpdated on a receipt. Mirrors kash-ops bot/src/batch/batchPhaseReceipt.ts.
 */
function phaseFromBatchPhaseUpdatedLogs(logs, batchCycle, vaultAddress, iface) {
  const vault = vaultAddress.toLowerCase();
  let phase = null;
  for (const log of logs) {
    if (log.address.toLowerCase() !== vault) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== "BatchPhaseUpdated") continue;
    if (BigInt(parsed.args.batchCycle) !== BigInt(batchCycle)) continue;
    phase = Number(parsed.args.phase);
  }
  return phase;
}

module.exports = { phaseFromBatchPhaseUpdatedLogs };
