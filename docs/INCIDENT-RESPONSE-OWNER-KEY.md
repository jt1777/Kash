# Incident response: owner key compromise

Use this runbook when you **suspect or confirm** that the KashYield **contract owner** private key is exposed (phishing, leaked `.env`, stolen hardware wallet backup, compromised CI, etc.).

**Scope:** `KashYieldBtc` / `KashYieldETH` owner, and—if the same deployer—the **HyperliquidAdapter** owner for each product.

**Assumption:** An attacker with the owner key can **immediately** rotate bot/keeper, replace the price oracle, whitelist routers, switch adapters (if already registered), **`rescueERC20` all vault USDC**, and **`ownerWithdrawWbtc` up to `ownerWbtcReserve`**. They can **full-drain user wBTC/ETH over time** by pairing config changes with bot ops (fake NAV, malicious DEX, sybil redeems). Treat this as **P0**.

See also: [SECURITY.md](./SECURITY.md) §1 (bot key), §3 (owner key), [DEPLOYMENT.md](./DEPLOYMENT.md) (HL custody).

---

## 0–15 minutes: stop the bleeding

Do these in parallel where possible.

| # | Action | Why |
|---|--------|-----|
| 1 | **Stop the bot** — kill `npm start`, disable cron/CI, revoke cloud secrets | Prevents honest bot + attacker bot from racing |
| 2 | **`pause()` on KashYield** (BTC and ETH products if both live) | Blocks new mint/redeem; users can use **emergency withdraw** for *pending* requests only |
| 3 | **Revoke HL agent** on Hyperliquid for the compromised bot if it shared material with owner ops | Attacker may already control bot; still revoke known agent keys |
| 4 | **Do not unpause** until keys are rotated and on-chain config is verified | Unpause restores attacker paths if they still control owner |

**Owner pause tx:** Call `pause()` on KashYield from the owner wallet (Etherscan “Write contract”, cast, or your deploy tooling). There is no checked-in pause script — add one if you want repeatability.

---

## 15–60 minutes: snapshot and assess

Capture evidence **before** the attacker rotates addresses.

### On-chain reads

```bash
cd bot
npm run owner:status   # run for PRODUCT=btc and PRODUCT=eth if applicable
```

Record for **each** product:

- `owner`, `pendingOwner`, `botAddress`, `keeperRegistry`
- `btcOracle` / `ethOracle`, `spotDexAddress`, `activePerpExchange`, `perpExchanges("HL")`
- `maxSwapSlippageBps`, `feeBps`, `exchangeSwitchDelay`, `paused`
- Vault **wBTC/ETH**, **USDC**, `ownerWbtcReserve` / `ownerEthReserve`, `ownerUsdcReserve`
- Aave supplied / borrowed, HL spot USDC, open perp size
- Recent **`OwnershipTransferStarted`**, **`OracleUpdated`**, **`ExchangeSwitchConfirmed`**, **`NAVProposedAndUpdated`**, **`ProtocolInteraction`**, **`TokensClaimed`**

Use Arbiscan (or your explorer) filtered by contract address since the suspected leak time.

### Hyperliquid

- HL web UI / API: account equity, open positions, recent **`withdraw3`** destinations
- Compare HL balances to on-chain `getHyperliquidSpotBalance()` / adapter `usdcBalance`

### Classify the incident

| Signal | Likely scenario |
|--------|-----------------|
| `setBotAddress` / `setBtcOracle` / `setAllowedSpotDexRouter` in same block window | Active owner-key abuse — assume full drain attempt |
| `rescueERC20(USDC, …)` to unknown EOA | Direct vault USDC theft |
| Adapter `HyperliquidUsdcWithdrawn` to owner EOA | Adapter owner pulled bridged USDC |
| Odd NAV + Phase 2 `TokensClaimed` to new wallets | Economic drain via fake NAV / sybil redeem |
| No owner txs, only bot txs | **Bot** compromise — use bot runbook (still pause + rotate bot) |
| Only HL API activity, no on-chain owner txs | **HL agent** compromise — revoke agent, check `withdraw3` destinations |

---

## Containment: secure control before unpause

**Goal:** A **new** owner (ideally Gnosis Safe) controls KashYield and adapters; attacker keys are dead.

### 1. Deploy / prepare clean keys

- New owner: **hardware wallet** or **multisig** (recommended: 2-of-3 Safe)
- New bot: **fresh EOA**, never stored on the compromised machine
- New HL agent: approve **only** the new bot on **only** the protocol HL account after recovery

### 2. Transfer KashYield ownership (two-step)

If the **current owner key is not yet attacker-controlled** (you detected leak before use):

```text
transferOwnership(newSafe)  →  acceptOwnership() from newSafe
```

If **attacker already owns the contract**, you cannot recover on-chain without social fork / legal — skip to **§ Post-mortem & user comms**. On-chain recovery requires a key the attacker does not have.

### 3. Rotate privileged addresses (from new owner)

Execute in this order after `acceptOwnership`:

| Setter | Set to |
|--------|--------|
| `setBotAddress` | New bot EOA |
| `setKeeperRegistry` | `address(0)` or trusted keeper only |
| `setBtcOracle` / `setEthOracle` | Known-good Chainlink feed |
| `setMaxSwapSlippageBps` | Conservative value (e.g. 50 = 0.5%) |
| `setFeeBps` | Intended production fee |
| `setExchangeSwitchDelay` | `86400` (24h) on mainnet |
| Review `spotDexAddress` | Known-good `UniswapV3Adapter` only |
| Review `activePerpExchange` | Known-good `HyperliquidAdapter` only |

**Do not** whitelist unknown addresses via `setAllowedSpotDexRouter`.

### 4. HyperliquidAdapter owner (if separate)

From adapter owner (or new adapter owner after `transferOwnership`):

- Verify `directDepositMode == false` for production
- Verify `hlAccount` / operator are not attacker-controlled
- `setOperator(newBot)` or `address(0)` until recovery complete

---

## Recovery: capital back to vault (after keys secured)

Only run batch ops with the **new bot key** from a **clean** host and `.env`.

**Do not unpause** until you intend to allow user flows. Ops can run while paused for some paths — confirm your batch phase; when in doubt, complete strategy flatten **before** unpause.

### Flatten strategy (per product)

Target: HL short **0**, HL USDC **0** (or intentional residual), Aave supplied **0**, Aave debt **0**, redeem asset on vault for any open batch.

```bash
cd bot
npm run build
SKIP_PROCESSING_WINDOW_CHECK=true PRODUCT=btc npm run owner:status

# If a batch is mid-flight:
SKIP_PROCESSING_WINDOW_CHECK=true PRODUCT=btc npm start -- --batch=<cycle>
```

Manual ops scripts (if batch automation is unsafe): [bot/scripts/ops/README.md](../bot/scripts/ops/README.md).

**HL withdrawals:** `withdraw3` destination must be **HyperliquidAdapter**, not an EOA. See [DEPLOYMENT.md](./DEPLOYMENT.md) § Hyperliquid USDC withdrawals.

### Check for owner theft already taken

| Function | Effect | Response |
|----------|--------|----------|
| `rescueERC20(USDC, …)` | Vault USDC sent to `recipient` | Account for loss; do not rely on that USDC for mark-done |
| `ownerWithdrawWbtc` / `ownerWithdrawEth` | Up to owner reserve only | Expected for fees; verify amounts |
| Adapter `withdrawCollateral` by owner | USDC on adapter → owner | Reconcile vs bridge records |

User **NAV-backed wBTC** cannot be `rescue`’d directly; if missing, investigate bot-oracle-DEX drain (Phase 2 payouts, swaps).

---

## Users and communication

### While paused

- **Pending mint (Phase 0):** user calls `emergencyWithdrawMint(batchCycle)` → original wBTC/ETH back
- **Pending redeem (Phase 0):** user calls `emergencyWithdrawRedeem(batchCycle)` → KASH back
- **No emergency path** for KASH already circulating or assets already deployed to Aave/HL

Tell users:

1. Protocol is **paused**
2. What batches/cycles are affected
3. Which emergency functions apply
4. When you expect unpause (only after key rotation + balance reconciliation)

### Public post-mortem (minimum)

- Timeline of suspicious txs (with explorer links)
- Whether user principal in Aave/HL/vault was affected
- Key rotation and config changes completed
- Remediation (multisig, timelock, monitoring)

---

## Monitoring alerts (set up before an incident)

Watch contract events / treasury multisig:

- `OwnershipTransferStarted`, `OwnershipTransferred`
- `OracleUpdated`, `FeeUpdated`
- `AdapterProposed`, `ExchangeSwitchConfirmed`, `ExchangeRegistered`
- `NAVProposedAndUpdated` with large delta vs prior
- `ProtocolInteraction` with unexpected action codes
- Large `rescueERC20` or `ownerWithdrawWbtc`
- HL API: `withdraw3` to non-adapter addresses

---

## Post-incident hardening (priority order)

1. **Gnosis Safe** as KashYield + adapter owner
2. **Separate** owner / bot / HL agent keys; hardware for owner
3. **Timelock** on owner setters (roadmap — see SECURITY.md §3)
4. **Guardian** pause-only role (roadmap)
5. Independent **NAV reconciliation** bot vs on-chain portfolio
6. HL **`withdraw3` destination monitoring** (adapter address allowlist off-chain)

---

## Quick reference: owner worst-case powers

| Can do immediately | Cannot do in one tx |
|--------------------|-------------------|
| Pause, rotate bot/keeper, replace oracle | `rescueERC20(wbtc)` (reverts) |
| `rescueERC20` all vault **USDC** | Withdraw Aave/HL without bot |
| `ownerWithdrawWbtc` ≤ `ownerWbtcReserve` | Mint arbitrary KASH |
| Whitelist routers; switch registered adapter | Pull user NAV wBTC via `ownerWithdrawWbtc` |
| Adapter owner: pull USDC from adapter | Undo attacker txs without a clean owner key |

**Bot + owner together:** full economic drain (NAV, Phase 2, HL `withdraw3`, Aave, swaps).

---

## Related runbooks

- Batch stuck / ops recovery: [bot/README.md § Batch recovery runbook](../bot/README.md)
- HL custody: [DEPLOYMENT.md](./DEPLOYMENT.md)
- Risk summary for users: [risks.md](./risks.md)
