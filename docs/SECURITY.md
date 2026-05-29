# KASH Security Analysis

Internal threat model and mitigation tracker for the KashYield protocol (KashYieldETH / KashYieldBtc on Arbitrum One).

> **Audience:** Operators, auditors, and contributors — not end-user documentation. See [Risks & Safeguards](risks.md) for the public-facing summary.

**Last updated:** 2026-05-21  
**Solidity:** ^0.8.28 (`KashYieldETH.sol`, `KashYieldBtc.sol`)

> **Provenance:** Findings from the preliminary 2026-02-20 code review (`SECURITY_REVIEW.md`, since merged here) were re-validated against the current two-phase batch architecture. Obsolete items (e.g. monolithic `processBatch()`, `testMintKash`) are recorded as resolved below.

---

## Overview

KASH is a batch-processed yield vault. Users queue mints/redeems; a bot/keeper runs capital deployment between Phase 1 and Phase 2; NAV is submitted off-chain then written on-chain before token distribution.

**Trust boundaries:**

| Layer | Trust assumption |
|-------|------------------|
| KashYield smart contracts | Code + owner/bot access control |
| Aave V3 | External protocol |
| Hyperliquid (via adapter) | Off-chain trading + on-chain bridge; adapter state sync |
| Chainlink oracles | Price feeds for mint/redeem sizing |
| Bot / operator | NAV submission, HL API actions, key custody |

---

## Architecture (current)

### Batch flow

1. **User window** — users submit mint/redeem requests.
2. **Phase 1** — contract values mints via oracle, records batch totals, sets phase to ops-pending.
3. **Ops (off-chain bot)** — Aave deposit/borrow, HL deposit/short (or unwind on redeem); bot submits NAV; marks ops done.
4. **Phase 2** — contract mints/burns KASH, distributes KASH to minters and asset to redeemers.

### Access control (on-chain)

| Role | Capabilities |
|------|--------------|
| **Users** | Mint/redeem requests, cancel pending requests, emergency withdraw when paused |
| **Bot / keeper** | All capital deployment, NAV update, mark ops done, batch Phase 2 trigger |
| **Owner** | Pause, config setters, adapter registration (with timelock for new adapters), owner treasury withdraw of *excess* asset |

### Key on-chain mitigations (implemented)

- `ReentrancyGuard` on batch settlement and external protocol calls
- Bot/keeper-only capital movement (`onlyBotOrKeeper`)
- 24-hour default timelock on **new** perp/spot adapter registration (first adapter on fresh deploy is immediate)
- Whitelisted spot DEX routers and allowed swap tokens
- Max swap slippage bound (default 50 bps)
- OpenZeppelin `SafeERC20`
- Reserved balance ring-fence for owner asset withdraw (11-cycle lookback)
- `rescueERC20` blocked for primary deposit asset
- Source verified on Arbiscan + public GitHub

---

## Threat matrix

| Threat | Likelihood | Impact | Priority | Status |
|--------|------------|--------|----------|--------|
| Bot/keeper key compromise | Medium | Critical | **P0** | Mitigate operationally; multi-sig / NAV bounds on roadmap |
| Unfair NAV submission | Low–Medium | High | **P0** | Events auditable; no on-chain sanity check |
| Owner key compromise (instant setters) | Low | Critical | **P0** | Partial — adapter timelock only for *new* adapters |
| Smart contract bug (reentrancy, logic) | Low | Critical | **P0** | Guards in place; no formal audit published |
| HL off-chain state / sync dishonesty | Low–Medium | High | **P1** | Adapter `syncBalances` / `syncPosition` trust operator |
| Oracle stale/manipulated price | Low–Medium | High | **P1** | No staleness check on `latestRoundData` |
| Aave / HL / Uniswap compromise | Low | High | **P1** | Counterparty risk |
| Batch Phase 2 gas DoS | Low–Medium | Medium | **P2** | Unbounded minter/redeemer loops |
| Reserved lookback edge case | Low | Medium | **P2** | 10-cycle lookback; stuck old batches |
| Frontend phishing / wrong contract | Medium | High | **P2** | User education; verify addresses |
| Supply-chain / infra compromise | Low–Medium | Critical | **P1** | `.env`, CI, npm, bot server |
| Flash-loan batch gaming | Low | Low–Medium | **P3** | Batch queuing helps |
| MEV on bot swaps | Medium | Low–Medium | **P3** | Slippage cap partial |

---

## Critical risks

### 1. Bot / keeper key compromise

**Attack:** Stolen bot key invokes legitimate contract paths — deposit to Aave, borrow, HL withdraw, open/close shorts, spot swaps, **submit arbitrary NAV**, mark ops done, trigger Phase 2.

**Why it matters:** This is authorized theft, not a Solidity bypass. The bot can also sign Hyperliquid API actions (withdrawals, trades) if it holds HL agent rights.

**Mitigations (current):**

- Separate bot key from owner key (split blast radius)
- Bot key on hardware wallet / HSM where feasible
- Monitor on-chain ops + NAV events; alert on anomalies
- HL withdrawal destination allowlisting in bot config

**Mitigations (roadmap):**

- Multi-sig or timelock on bot address rotation
- On-chain NAV bounds or independent NAV oracle
- Chainlink Automation as keeper (scheduled, not discretionary)

---

### 2. Malicious or incorrect NAV

**Attack:** Bot posts NAV above/below fair mark-to-market before Phase 2.

**Impact:**

- **Low NAV on mint batch** → existing holders diluted; new minters get extra KASH
- **High NAV on redeem batch** → redeemers drain asset; remaining holders hurt

**Mitigations (current):**

- NAV + snapshot params emitted on-chain (`NAVProposedAndUpdated`, etc.)
- Post-hoc public audit against portfolio reads

**Mitigations (roadmap):**

- On-chain `calculateNAV()` from vault + Aave + adapter reads
- Multi-sig NAV submission
- Circuit breaker if NAV delta exceeds threshold

---

### 3. Owner key compromise — instant configuration

**Attack:** Owner can **immediately** (no timelock):

- Rotate bot or keeper address → attacker-controlled ops
- Replace ETH/BTC Chainlink oracle → manipulate mint/redeem sizing
- Whitelist malicious spot DEX router
- Set slippage cap very high → sandwich drain on swaps
- Set adapter registration delay to zero
- **Activate already-confirmed malicious adapter** via `setActivePerpExchange` (switching registered adapters is instant)

**Mitigations (current):**

- 24-hour delay only on **proposing/confirming new** adapters
- Reserved balances limit owner asset withdraw
- Pause + user emergency withdraw paths

**Mitigations (roadmap):**

- Timelock on all owner setters (24–48h)
- Gnosis Safe multi-sig owner
- Monitor + social alert on config changes

---

### 4. Hyperliquid off-chain trust boundary

**Attack / failure modes:**

- Bot executes HL trades off-chain; on-chain adapter records state via `syncBalances` / `syncPosition`
- Compromised bot reports false balances before/after moving USDC on HL L1
- HL bridge/API downtime prevents withdraw or hedge adjustment
- `directDepositMode`: USDC credited to bot EOA on HL — custody blur between protocol and hot wallet

**Mitigations (current):**

- Adapter capital movement restricted to KashYield + owner
- Documented ops: HL actions then adapter sync
- Prefer adapter-as-HL-account (`directDepositMode = false`) in production

**Mitigations (roadmap):**

- Independent reconciliation bot comparing HL API vs on-chain adapter
- Cross-chain proof / oracle for HL balances (hard problem)

---

### 5. Smart contract vulnerabilities

#### Reentrancy

**Status:** ✅ `nonReentrant` on Phase 2, Aave, HL, spot swap entrypoints.

**Residual:** Review any new external calls; maintain checks-effects-interactions.

#### Integer overflow

**Status:** ✅ Solidity 0.8+ checked arithmetic.

#### Access control

**Status:** ✅ Bot/keeper gate on ops; owner on admin; users on mint/redeem/cancel/emergency.

**Residual:** KashToken mint/burn is `onlyOwner` — vault must own token contract.

#### Logic / economic bugs

**Review areas:**

- Phase 2 distribution math (fees, rounding, insufficient asset revert)
- Redeem asset estimate in reserved calculation vs Phase 2 exact payout
- `markMint*Deployed` caps vs batch mint totals

---

## High risks

### 6. Oracle manipulation and staleness

**Location:** `getEthPrice()` / `getBtcPrice()` → Chainlink `latestRoundData()` without staleness or deviation checks.

**Attack vectors:**

- Stale feed during volatility → wrong mint USD sizing or redeem asset amount
- Oracle exploit (rare on major feeds) → mispriced batch settlement

**Recommendations:**

```solidity
(, int256 price,, uint256 updatedAt,) = feed.latestRoundData();
require(price > 0, "Invalid price");
require(block.timestamp - updatedAt < MAX_ORACLE_STALENESS, "Stale price");
```

- Optional: TWAP backup, max deviation vs previous price

---

### 7. External protocol dependencies

#### Aave V3

| Risk | Mitigation |
|------|------------|
| Liquidation cascade | Target ~70% LTV; delta-neutral hedge |
| Supply/borrow caps | Pre-check before ops |
| Aave pause | Ops fail gracefully; batch may stall |
| Aave contract bug | Counterparty risk; pause vault |

#### Hyperliquid

| Risk | Mitigation |
|------|------------|
| Negative funding | Strategy/monitoring; Phase 2 negative-funding Play (roadmap) |
| HL insolvency / API outage | Counterparty risk; emergency unwind playbook |
| Bridge delay | Bot wait/retry logic |

#### Uniswap V3 (spot tail swaps)

| Risk | Mitigation |
|------|------------|
| Sandwich | Slippage cap; private RPC for bot |
| Illiquid pool | Min output checks |

---

### 8. Batch distribution DoS (gas griefing)

**Risk:** Unbounded `batchMintUsers` / `batchRedeemUsers` arrays; Phase 2 loops all users in one transaction → block gas limit exceeded → batch cannot settle.

**Impact:** Liveness failure; users stuck in pending state until ops split batches or owner intervenes.

**Recommendations:**

- Cap max users per batch cycle (e.g. 500)
- Paginated Phase 2 distribution (multi-tx)

---

### 9. Pending-batch observability lookback edge case

**Behavior:** `npm run owner:status` estimates unprocessed batch footprint over the last **11 cycles** only (off-chain; not enforced on-chain). Owner asset pulls are capped by **`ownerWbtcReserve` / `ownerEthReserve`** only.

**Risk:** If a batch remains unprocessed for >11 cycles (bot outage, ops failure, griefing), status tooling may under-report older pending obligations. Stale batches still hold vault assets until Phase 2 completes.

**Recommendations:**

- Monitoring: alert on unprocessed batches older than N cycles
- Ops: use per-cycle `batchPhase`, `batchTotalRedeemValueUSD` (locked G), and mark-done checks — not a global reserved view

---

## Medium risks

### 10. Economic / MEV

| Vector | Notes |
|--------|-------|
| Flash-loan mint/redeem same batch | Mitigated by batch queuing |
| Oracle flash loan at batch time | Staleness/deviation checks would help |
| MEV on user mint txs | Usually low impact |
| MEV on bot Uniswap swaps | Slippage cap; private mempool |
| Fee manipulation | Owner can raise `feeBps` instantly — disclose in risks |

---

### 11. Centralisation and availability

- Single bot must run daily batch ops
- Missed batch → user wait + potential reserved lookback issues
- **Roadmap:** Chainlink Automation keeper, multi-sig owner

---

### 12. Frontend / social engineering

- Fake site depositing to wrong contract
- User approves malicious token spender

**Mitigations:** Publish canonical addresses; app footer links to Arbiscan; user docs emphasize address verification.

---

### 13. Operational / supply chain

- Leaked `bot/.env` private keys
- Compromised npm dependency in bot or frontend
- Malicious deploy script or CI artifact

**Mitigations:**

- Hardware wallet for owner; isolated bot key
- Secret management (no keys in repo)
- Dependency pinning + audit
- Separate deployer vs operator keys

---

## Low risks

### 14. Token standards

- **Status:** ✅ `SafeERC20` for vault transfers
- Rebase / fee-on-transfer tokens not supported as deposit assets

### 15. Precision / rounding

- Integer division dust in KASH mint and redeem loops — accept small dust; monitor cumulative drift

### 16. Time manipulation

- `block.timestamp` for batch windows — negligible on Arbitrum

### 17. Emergency withdraw stale batch state

**Source:** 2026-02-20 review (L4) — **still open.**

When paused, users can emergency-withdraw a pending mint or redeem. The request mapping is cleared, but the user may remain in `batchMintUsers` / `batchRedeemUsers` and batch totals (`batchTotalMintBtc`, etc.) are not decremented.

**Impact:** Low — mostly stale indexing; Phase 1/2 loops skip zeroed requests, but reserved/batch accounting can be inconsistent until the cycle is abandoned or corrected.

**Recommendations:**

- Decrement batch totals and optionally remove user from batch arrays on emergency withdraw
- Or mark requests as cancelled with an explicit flag consumed by batch loops

### 18. Dust mint rounding to zero KASH

**Source:** 2026-02-20 review (C2) — **partially relevant** (design changed).

Classic ERC4626 “donate to inflate share price” is **less applicable** because NAV is operator-submitted, not derived from raw vault balance alone. However, tiny mints can still round to **zero KASH** at Phase 2 when `(amountAfterFee * 1e18) / exactNAV == 0`.

**Mitigations (current):**

- Frontend enforces ~$10 minimum deposit
- Bot skips ops below `NET_MINT_SKIP_OPS_MIN_USDC` for net mints

**Recommendations:**

- On-chain minimum mint USD or minimum KASH out
- Revert Phase 2 distribution if any minter would receive 0 KASH while `amountInUSD > 0`

### 19. Aave return values and health factor

**Source:** 2026-02-20 review (H2, H3) — **still open (bot-side).**

`withdrawFromAave` / `repayToAave` ignore Aave return values. No on-chain health-factor check runs after `borrowFromAave`.

**Recommendations:**

- Bot verifies withdrawn/repaid amounts match intent
- Bot reads `getUserAccountData` after borrow; revert ops if health factor below threshold
- Optional: on-chain require on Aave return value

### 20. User redeem slippage protection

**Source:** 2026-02-20 review (M2) — **still open (by design).**

Redeemers do not specify a minimum asset out at request time. Settlement uses batch NAV and oracle price at Phase 2.

**Mitigations (current):** Batch queuing (not same-block); oracle is Chainlink; fees are small.

**Recommendations:** Optional `minAssetOut` on redeem requests for sophisticated users/agents.

---

## Emergency procedures

### Pause

Owner calls pause → mints/redemptions blocked.

Users with **pending, unvalued** mint requests (Phase 1 not completed for that request) can use emergency mint withdraw when paused. Users with pending redeems can emergency withdraw KASH.

**Gap:** Emergency paths require direct contract interaction (not app UI). Document in user risks.

### Pause and governance roadmap

**Current (deployed):** Only the contract owner can pause and unpause. While paused, users can reclaim pending mint/redeem requests via emergency withdraw paths (direct contract interaction).

**Recommended progression:**

| Phase | Approach | Notes |
|-------|----------|-------|
| **Now** | Single owner + documented runbook | Keep pause key on hardware wallet |
| **Near-term** | Gnosis Safe multi-sig owner (2-of-3 or 3-of-5) | No contract change beyond `transferOwnership` to Safe |
| **Medium-term** | Timelock on owner config setters (24–48h) | Users can exit before bot/oracle/router changes |
| **Medium-term** | Guardian role (pause-only, optional HF trigger) | Fast emergency stop without unpause power |
| **Long-term** | Automated circuit breakers | e.g. max daily outflow, critical health factor — needs careful tuning |
| **Long-term** | Token-governed emergency council | Only if a governance token launches |

Multi-sig owner is the highest-leverage next step: industry standard, one transaction, compatible with adding timelock or guardian later.

---

1. Pause vault
2. Stop bot
3. Snapshot on-chain + HL/Aave balances
4. Assess key compromise vs logic bug
5. Communicate publicly
6. Rotate keys / deploy fix / unwind positions via ops scripts

### If Aave or HL is compromised

1. Pause
2. Close HL shorts, withdraw USDC, repay Aave, withdraw collateral to vault
3. Enable user emergency paths if batches stuck

---

## Code review findings tracker

Merged from preliminary review (2026-02-20). Status as of current `KashYieldETH` / `KashYieldBtc`.

| ID | Finding | Severity (original) | Status |
|----|---------|-------------------|--------|
| C1 | Reentrancy on batch settlement | Critical | **Resolved** — `nonReentrant` on Phase 2 and all Aave/HL/swap ops |
| C2 | First depositor / share inflation | Critical | **Superseded** — NAV is bot-submitted; see **§18** for dust rounding |
| H1 | Oracle staleness check | High | **Open** — see **§6** |
| H2 | Aave withdraw return values | High | **Open** — see **§19** |
| H3 | Health factor after borrow | High | **Open** — bot responsibility; see **§19** |
| M1 | Centralized NAV / no rate limit | Medium | **Open** — see **§2**; fee capped via `MAX_FEE_BPS` |
| M2 | No user min output on redeem | Medium | **Open** — see **§20** |
| M3 | `testMintKash` owner backdoor | Medium | **Resolved** — function removed |
| M4 | No max batch user count | Medium | **Open** — see **§8** |
| M5 | Owner setters without timelock | Medium | **Partial** — 24h timelock on new adapters only; see **§3** |
| L1 | Integer precision / dust | Low | **Accepted** — see **§15** |
| L2 | Missing zero-address checks | Low | **Partial** — oracles and several setters check; audit remainder |
| L3 | Missing events on setters | Low | **Partial** — `FeeUpdated`, `OracleUpdated`, adapter events exist |
| L4 | Emergency withdraw batch cleanup | Low | **Open** — see **§17** |
| I1 | Gas / unbounded batch arrays | Info | **Open** — see **§8**, **§17** |
| I6 | HL adapter interface versioning | Info | **Open** — see `contracts/interfaces/IPerpExchange.sol`, [bot/README.md](../bot/README.md) (Mainnet Hyperliquid Setup), [DEPLOYMENT.md](DEPLOYMENT.md) |

**Not a substitute for professional audit.** Before scaling TVL: third-party audit, bug bounty, and fork tests covering the checklist below.

---

## Testing checklist

- [ ] Reentrancy on Phase 2 and external protocol calls
- [ ] Dust / minimum mint — user receives 0 KASH edge case
- [ ] Oracle stale and deviated price at Phase 1 / Phase 2
- [ ] Batch size gas DoS (many minters/redeemers in one cycle)
- [ ] Owner / bot privilege abuse (NAV, config rotation, adapter switch)
- [ ] Aave withdraw partial fill, borrow cap, health factor near liquidation
- [ ] Hyperliquid API failure, bridge delay, adapter sync mismatch
- [ ] Pause / unpause during pending mint, ops phase, and Phase 2
- [ ] Emergency withdraw — batch totals and reserved balances afterward
- [ ] Reserved lookback with batch unprocessed > 11 cycles
- [ ] Full mainnet-fork mint → ops → redeem happy path (ETH and BTC products)

---

## Formal audit and bug bounty

Recommended before significant TVL:

| Firm / program | Notes |
|----------------|-------|
| OpenZeppelin, Trail of Bits, CertiK | Full contract + economic review |
| Code4rena | Competitive audit |
| Immunefi / Sherlock | Bug bounty post-audit |

---

| Protected well | Partially protected | Not protected on-chain |
|----------------|---------------------|-------------------------|
| Random caller draining vault via ops | Owner instant config changes | NAV fairness |
| Reentrancy on known paths | New adapter timelock (not router/oracle/bot rotation) | HL off-chain state |
| Malicious spot router in one tx | Reserved ring-fence (lookback limit) | Bot key = full ops |
| Flash-loan same-block arb | Slippage on swaps | Formal audit |
| Owner sweeping deposit asset via rescue | | |

---

## Pre-mainnet / ongoing checklist

### Immediate

- [ ] Slither / Mythril on `contracts/`
- [ ] Mainnet fork integration tests (full mint + redeem batch)
- [ ] Hardware wallet or multi-sig owner
- [ ] Bot key isolated; HL agent scoped minimally
- [ ] Monitoring: NAV delta, ops txs, pause events, config changes
- [ ] Confirm `exchangeSwitchDelay` ≠ 0 on mainnet (default 86400 s)
- [ ] Confirm KashToken owner = vault address

### Short-term

- [ ] Timelock on owner setters
- [ ] Oracle staleness checks
- [ ] Max contributors per batch
- [ ] Bug bounty (e.g. Immunefi)
- [ ] Third-party audit

### Long-term

- [ ] On-chain NAV calculation
- [ ] Chainlink Automation keeper
- [ ] DAO / multi-sig governance
- [ ] Extended reserved lookback or request-scoped reservation

---

## Safeguards vs residual gaps (summary)

## Audit tooling

Recommended before major releases:

- [ ] Slither static analysis
- [ ] Mythril / Echidna / Foundry fuzz on batch math
- [ ] Mainnet fork tests (`bot/`, `test/`)
- [ ] Manual review of Phase 2 distribution and reserved math
- [ ] Economic / game-theory review of NAV trust model

---

- Public risks: [risks.md](risks.md)
- Deployment: [DEPLOYMENT.md](DEPLOYMENT.md)
- Hyperliquid ops: [bot/README.md](../bot/README.md), [DEPLOYMENT.md](DEPLOYMENT.md)
- Contracts: `contracts/KashYieldETH.sol`, `contracts/KashYieldBtc.sol`
- [OpenZeppelin Security Guidelines](https://docs.openzeppelin.com/contracts/)
- [Consensys Smart Contract Best Practices](https://consensys.github.io/smart-contract-best-practices/)
- [Chainlink Data Feed Security](https://docs.chain.link/data-feeds/select-feeds)

---

*This document is internal engineering guidance. Update when contracts, bot ops, or threat model change.*
