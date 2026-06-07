# KashYield Deployment Guide (Arbitrum One)

This guide covers production deployment of **KashYieldETH** and/or **KashYieldBtc** (`contracts/KashYieldBtc.sol`) on **Arbitrum One**. Deploy **one product or both** — neither requires the other. All protocol dependencies are live mainnet contracts (Aave V3, Chainlink, Uniswap V3, Hyperliquid bridge).

---

## Prerequisites

1. **Node.js and npm** — use a Node version compatible with Hardhat (Hardhat may warn on Node 25+).
2. **Hardhat** — configured in this repo (`hardhat.config.js` includes the `arbitrumOne` network).
3. **dotenv** — `npm install dotenv` at repo root if needed; scripts load the **root** `.env`.

---

## Two wallets on mainnet (required)

Use **two different Arbitrum addresses**. Do not reuse the deployer key for batch ops or Hyperliquid API signing.

| Role | Wallet | Keys / env | On-chain identity |
|------|--------|------------|-------------------|
| **Owner** | Cold / multisig (high security) | Root `.env` → **`PRIVATE_KEY`** only for **owner** scripts | `KashYield*.owner()` — config, reserves, `setSpotDex`, `setExchangeFacade`, `ownerWithdraw*`; **ExchangeFacade** owner — `setHyperliquid`, timelocks |
| **Bot / keeper** | Hot operator (limited funds) | **Private `kash-ops` repo `.env`** — `PRIVATE_KEY` and `HYPERLIQUID_API_PRIVATE_KEY` (same bot address) | `KashYield*.botAddress()` — `performUpkeep`, batch ops, `markBatchOpsDone`, Aave/spot on vault; HL writes via **ExchangeFacade** |

**Deploy wiring**

- **`scripts/deploy-arbitrum-sepolia.js`** and **`scripts/deploy-kashyieldbtc.js`** set **`owner = msg.sender`** (whoever signs the deploy tx with root `PRIVATE_KEY`).
- Pass **`BOT_ADDRESS=<bot_wallet>`** on the deploy command so the vault’s **`botAddress`** is the bot, **not** the owner.

```bash
# Example — owner signs deploy; bot is a different address
BOT_ADDRESS=0xYourBotWalletOnly \
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumOne
```

**After deploy, verify (Hardhat console or Arbiscan “Read contract”)**

```javascript
const ky = await ethers.getContractAt("KashYieldETH", "<KASH_YIELD_ETH_ADDRESS>")
console.log("owner:", await ky.owner())
console.log("botAddress:", await ky.botAddress())
// owner !== botAddress
```

**Optional third address:** `keeperRegistry` via `setKeeperRegistry(bot)` if you use Chainlink Automation with a dedicated keeper; otherwise leave **`0x0`** and the **bot** alone calls batch functions.

**Hyperliquid (mainnet: bootstrap / `directDepositMode = true`)**

- **Ideal custody** (`directDepositMode = false`): HL master = **adapter contract**; bot is an HL **agent** only. Requires `extraAgents(adapter)` after `approveAgent`.
- **Blocked on production HL today:** adapter `isValidSignature` (EIP-1271) passes on-chain, but HL’s off-chain `approveAgent` does **not** register agents on the contract address — approvals land on the owner EOA instead. HL **agents also cannot sign `withdraw3`**; only the master can withdraw.
- **Use the bootstrap fallback** (Steps 4a / B3): `directDepositMode = true`, `hlAccount =` on-chain **bot EOA**. Bot is the HL **master** (trades + `withdraw3`); no `approveHlAgent`. See **Hyperliquid adapter setup (bootstrap)** below.
- **Trust boundary:** user wBTC/Aave collateral stays in vault contracts; only the **current HL USDC/perp float** is exposed to the bot hot key. Bot code hardcodes `withdraw3` → adapter, but a **stolen bot HL master key** can sign HL API withdrawals to any address (see **Security → bot key compromise**).

---

## Critical rules — read before deploying

1. **`WETH_ADDRESS` must be canonical WETH9** on Arbitrum (`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`) — it must support `deposit()` / `withdraw()`.

2. **Use native USDC** (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`), not USDC.e (`0xff970a...`). Aave and Hyperliquid expect native USDC on Arbitrum.

3. **`AAVE_POOL_ADDRESS` in env is informational for scripts** — `KashYieldETH` / `KashYieldBtc` embed the Arbitrum One Aave V3 pool (`0x794a61358D6845594F94dc1DB02A252b5b4814aD`) in the implementation; deploy scripts do not override it.

4. **`exchangeSwitchDelay`** lives on **ExchangeFacade** (fixed **24 hours** in current bytecode). The **first** perp adapter registration on a fresh facade is immediate; the delay applies when you **later** propose **another** adapter. Legacy `scripts/setExchangeSwitchDelay.js` targets the **vault** and does **not** apply to current bytecode.

5. **Owner / treasury reserves** (`ownerUsdcReserve`, asset-specific owner buffers). These balances are **not** part of user NAV. The bot may call `coverUsdcShortfall` to move reserved USDC into the working float. Batch phase 2 credits protocol fees to owner asset reserves; `ownerWithdraw*` pulls only from those reserves. Ops and `snapshotOpsContext` use **adjusted** balances (raw minus reserves) as the deployable float.

   **Crediting owner reserves (one transaction each; cannot re-label existing user NAV float):**

   | Function | Contract | How tokens move |
   |----------|----------|-----------------|
   | `markOwnerEthDeposit()` | KashYieldETH | Payable — send ETH as **`msg.value`** in the same call (no separate transfer). |
   | `markOwnerUsdcDeposit(amount)` | KashYieldETH, KashYieldBtc | **`transferFrom`** owner → vault in the same call. Owner must **`approve` the vault** for USDC first (separate tx unless using a batch wallet). |
   | `markOwnerWbtcDeposit(amount)` | KashYieldBtc | Same as USDC — **`approve` wBTC** on the vault, then call `markOwnerWbtcDeposit` (pulls and credits in one tx). |

   Example (Hardhat console or script), after approval:

   ```javascript
   // USDC — KashYieldETH or KashYieldBtc
   await usdc.approve(kashYieldAddress, amount)
   await kashYield.markOwnerUsdcDeposit(amount)

   // wBTC — KashYieldBtc only
   await wbtc.approve(kashYieldAddress, amount)
   await kashYield.markOwnerWbtcDeposit(amount)

   // ETH — KashYieldETH only (single tx)
   await kashYield.markOwnerEthDeposit({ value: amount })
   ```

6. **Contract size (EIP-170, 24576 bytes).** `hardhat.config.js` enables the Solidity optimizer (`runs: 1`), `viaIR: true`, and `metadata.bytecodeHash: "none"`. `ProtocolInteraction` uses **`uint8` action codes** (see `contracts/libraries/ProtocolActionCodes.sol`). After `npx hardhat compile`, confirm there is no “contract code size exceeds 24576 bytes” warning before deploy.

7. **`BOT_ADDRESS` must differ from owner.** If you omit `BOT_ADDRESS`, deploy scripts default **`botAddress = deployer`**, which collapses owner and bot into one key — avoid on mainnet.

8. **Redeploy = new vault + new KASH token.** Each `KashYieldETH` / `KashYieldBtc` deploy creates a **new** `KashToken*` in the constructor. Update **`frontend/lib/contracts/addresses.ts`** and env files only after cutover; finish in-flight batches on **old** vaults first. Current bytecode adds: **ExchangeFacade** (HL writes moved out), **Merkle pull claims** (`claimRedeem`, `processBatchPhase2ForCycle`), **`lockedClaimWbtc` / `lockedClaimEth`**, user caps, swap **`minOut`** args, and **`markBatchOpsDone(batchCycle, G)`** — incompatible with older vaults for mid-batch resume.

9. **Redeem payouts are pull-based.** Phase 2 no longer loops redeemers with `safeTransfer`. The bot passes a Merkle root into `processBatchPhase2ForCycle`; users call **`claimRedeem`**. Host proof manifests for the frontend (`NEXT_PUBLIC_REDEEM_PROOF_BASE_URL`).

---

## Protocol contract addresses (Arbitrum One)

### Tokens

| Token | Address |
|-------|---------|
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| USDC (native) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| wBTC | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` |

### Aave V3

| Contract | Address |
|----------|---------|
| Pool | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| WrappedTokenGatewayV3 | `0x5283BEcEd7ADF6D003225C13896E536f2D4264FF` |

### Chainlink price feeds

| Feed | Address |
|------|---------|
| ETH / USD | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |
| BTC / USD | `0x6ce185860a4963106506C203335A2910413708e9` |

### Uniswap V3

| Contract | Address |
|----------|---------|
| SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| UniswapV3Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |

Key pools (0.05% fee tier): WETH/USDC and wBTC/USDC via `factory.getPool(token0, token1, 500)`.

### Hyperliquid

| Contract | Address |
|----------|---------|
| Bridge 2 (Arbitrum → HL) | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` |

USDC only; minimum deposit 5 USDC.

---

## Architecture: Hyperliquid on mainnet

On mainnet, Hyperliquid is separate from Arbitrum execution. The **HyperliquidAdapter** on Arbitrum talks to the **bridge** for USDC deposits; spot and perp trades are **off-chain** via the HL API (bot), then synced on-chain with `syncBalances` / `syncPosition` as your deployment expects.

| Action | How it works |
|--------|----------------|
| Deposit USDC | On-chain: USDC to bridge `0x2Df1c51E...` |
| Spot / perp trades | Off-chain: HL API |
| Withdraw USDC | HL withdrawal settles back to Arbitrum (~minutes); **destination address is operator-chosen** |

Ops scripts `04`–`07` behave as API-driven steps on mainnet, not synchronous mock contract calls. On-chain HL **write** calls go through **ExchangeFacade** (not the vault); the bot calls `approveExchangeFacadeUsdc` before USDC-pulling facade ops.

### Hyperliquid USDC withdrawals and custody

Hyperliquid bridges USDC to **whichever Arbitrum address you specify** (HL API `withdraw3` or the web app “withdraw”). KashYield then pulls USDC **from the HyperliquidAdapter** via `withdrawFromHyperliquid` → `withdrawCollateral`, so **on-chain float only moves if USDC actually sits on the adapter** after the bridge.

**Operational rules**

- **Always** set the HL withdrawal **destination** to your deployed **HyperliquidAdapter** address for protocol float—not the KashYield vault by default unless your runbook explicitly allows it, and **not** an operator EOA unless you intend temporary custody outside the adapter.
- Prefer **automated** withdrawals: operator bot `withdraw3` with `destination =` adapter. If you use the **HL web app**, open the destination field and **paste the adapter address**; do **not** assume the default “linked wallet” is correct.
- After USDC lands on Arbitrum, confirm **`USDC.balanceOf(adapter)`** (script `08-withdraw-usdc-from-perp.js` prints this) before expecting `08` to move meaningful balances.

**`directDepositMode` — ideal vs bootstrap**

| Mode | HL master | `approveAgent` | Autonomous `withdraw3` | Mainnet status |
|------|-----------|----------------|------------------------|----------------|
| `false` | Adapter contract | Agent on `extraAgents(adapter)` | Master (contract) must sign — EIP-1271 | **Blocked:** HL off-chain does not honor contract master |
| `true` | Bot EOA (`hlAccount`) | Not needed | Bot master signs directly | **Production fallback** (this guide) |

- **`directDepositMode = true` (bootstrap):** Vault → adapter `depositCollateral` forwards USDC to **`hlAccount`** (bot EOA); bot bridges to HL. Bot signs HL orders and **`withdraw3`** with **`destination =` HyperliquidAdapter**. **Ops rule:** never use the HL web UI for withdrawals (defaults to bot EOA). Mis-routed USDC on the bot EOA: forward **EOA → adapter** on Arbitrum, then manual ops step `08` (private `kash-ops` repo).
- **`directDepositMode = false` (ideal, not viable alone on HL today):** Deposits bridge as adapter-as-account. Documented for future HL contract-wallet support or test environments where agent + master paths work.

**Bot key compromise (bootstrap mode):** the bot **cannot** change `hlAccount` on-chain (`setDirectDepositMode` is **owner-only**). A stolen **HL master** private key can still call HL’s API directly and sign **`withdraw3` to any Arbitrum address** — they do not need your bot software or the adapter config. Exposure is limited to **HL float** (USDC/perps on that HL account), not vault/Aave user collateral. Rotate: owner `setBotAddress` + new adapter `setOperator` + stop bot + new HL master wallet.

---

## Architecture: ExchangeFacade (perp registry + HL writes)

To stay under EIP-170, perp exchange registry and Hyperliquid operation wrappers live in **`ExchangeFacade.sol`**, deployed **once per vault** (ETH and BTC each get their own facade).

| Component | Role |
|-----------|------|
| `KashYield*.exchangeFacade` | Owner sets facade address; vault forwards HL **view** calls |
| `ExchangeFacade` | `perpExchanges`, `activePerpExchange`, `depositToHyperliquid`, `openShort`, etc. |
| `approveExchangeFacadeUsdc` | Vault approves USDC so facade can `safeTransferFrom` for HL deposits |

**Deploy and wire (owner, per product)**

```bash
# After vault + HyperliquidAdapter exist:
KASH_YIELD_ADDRESS=<vault> BOT_ADDRESS=<bot> PRIMARY_ASSET=0x0 \
  npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
# PRIMARY_ASSET = WBTC address for KashYieldBtc; 0x0 for ETH product
```

```bash
PRODUCT=eth \
KASH_YIELD_ETH_ADDRESS=<vault> \
EXCHANGE_FACADE_ETH=<facade> \
HL_ADAPTER_ADDRESS_ETH=<hl_adapter> \
npx hardhat run scripts/wire-exchange-facade.js --network arbitrumOne
```

(`PRODUCT=btc` with `KASH_YIELD_BTC_ADDRESS`, `EXCHANGE_FACADE_BTC`, `HL_ADAPTER_ADDRESS_BTC` for KashYieldBtc.)

**Verify:** script readback shows `vault.exchangeFacade()` = facade; `facade.hyperliquidAddress()` = adapter; `facade.activePerpExchange()` = `"HL"`; `hlAdapter.authorizedCaller()` = facade.

> **Legacy scripts:** `scripts/setHyperliquid.js` and `scripts/setActivePerpExchange.js` call methods on the **vault** and apply only to **older** bytecode. For current vaults, register HL on the **facade** as above.

---

## Architecture: Merkle redeem claims

| Step | Who | Action |
|------|-----|--------|
| Mark-done | Bot | `markBatchOpsDone(batchCycle, G)` — locks gross redeem asset **G** |
| Phase 2 | Bot | `processBatchPhase2ForCycle(batchCycle, merkleRoot)` — mints KASH (push), commits root, increments `lockedClaim*` |
| Claim | User | `claimRedeem(batchCycle, netAmount, proof)` — receives wBTC/ETH; decrements claim reserve |

- **Mint-only batches** can still use `performUpkeep` for Phase 2 (no Merkle root).
- **Redeem batches** must use bot-driven Phase 2 with root; `performUpkeep` reverts when redeems need a root.
- Operator bot writes proofs and publishes to static hosting (see redeem proof hosting below).
- Frontend: `NEXT_PUBLIC_REDEEM_PROOF_BASE_URL` → base URL where those JSON files are hosted (e.g. `https://cdn.example.com/redeem-proofs`).

Claim expiry: **30 days** after settlement; unclaimed amounts can be swept per on-chain policy (`sweepExpiredClaims`).

---

## Architecture: Uniswap V3 spot adapter

The `UniswapV3Adapter` implements `ISpotDex` and wraps `SwapRouter02`. Typical routing: **0.05%** pools for WETH/USDC and wBTC/USDC. Use sane `amountOutMinimum` / slippage on mainnet — never `0`.

---

## Environment setup

### Root `.env` — owner / deployer only (Arbitrum One)

Used by Hardhat **deploy** and **owner** configuration scripts (`setSpotDex`, `setExchangeFacade`, adapter `setDirectDepositMode`, facade `setHyperliquid`, etc.). **Do not** put the bot hot key here unless you intentionally use one wallet for everything.

```env
# OWNER — signs deploy + owner-only txs (hardware wallet / multisig)
PRIVATE_KEY=0x...

ARBITRUM_ONE_RPC_URL=https://arb1.g.alchemy.com/v2/YOUR_API_KEY
ARBISCAN_API_KEY=your_arbiscan_api_key

# Canonical tokens (override only if you know what you are doing)
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
AAVE_POOL_ADDRESS=0x794a61358D6845594F94dc1DB02A252b5b4814aD
UNISWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
BTC_ORACLE_ADDRESS=0x6ce185860a4963106506C203335A2910413708e9
HL_BRIDGE_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7

# Filled in as you deploy (examples):
# UNISWAP_ADAPTER_ADDRESS=
# KASH_YIELD_ETH_ADDRESS=
# KASH_TOKEN_ETH=
# EXCHANGE_FACADE_ETH=
# HL_ADAPTER_ADDRESS_ETH=
# KASH_YIELD_BTC_ADDRESS=
# KASH_TOKEN_BTC=
# EXCHANGE_FACADE_BTC=
# HL_ADAPTER_ADDRESS_BTC=
```

### Bot operator configuration (private repo)

Bot signing keys, HL API keys, vault addresses for batch ops, and manual ops scripts live in the **private `kash-ops` repository** (not published here). After deploy, configure the operator `.env` there to match on-chain `botAddress()`.

See the private ops repo runbook (`docs/DEPLOYMENT-OPS.md`) for field-by-field env setup, batch bot startup, and mainnet ops playbooks.

### `frontend/.env.local`

Use `NEXT_PUBLIC_` prefixes for each vault the UI exposes (BTC-only deploys can omit the ETH lines):

```env
# Omit if not deployed yet
NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS=<KashYieldETH>
NEXT_PUBLIC_KASH_TOKEN_ETH=<KashTokenEth>
NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS=<KashYieldBtc>
NEXT_PUBLIC_KASH_TOKEN_BTC=<KashTokenBtc>

# Required for redeem claim UI — host bot proof manifests (see Merkle redeem claims)
NEXT_PUBLIC_REDEEM_PROOF_BASE_URL=https://your-cdn.example.com/redeem-proofs
```

---

## Pre-launch checklist

- [ ] `npx hardhat compile` — no EIP-170 size errors on `KashYieldETH` / `KashYieldBtc`.
- [ ] Smart contract audit completed (or accepted risk documented).
- [ ] **Two wallets:** owner `PRIVATE_KEY` (root `.env`) ≠ bot operator key (private `kash-ops` repo); on-chain `owner()` ≠ `botAddress()`.
- [ ] **`BOT_ADDRESS`** set on both vault deploy commands to the **bot** address (not omitted).
- [ ] **`directDepositMode = true`** + `hlAccount = botAddress` on each **HyperliquidAdapter** (bootstrap); bot `.env` uses **same key** for `PRIVATE_KEY` and `HYPERLIQUID_API_PRIVATE_KEY`; HL `withdraw3` targets **adapter** only.
- [ ] HL **bootstrap** configured per adapter (`set-direct-deposit-mode.js`); adapter **`operator`** = bot (deploy env or `setOperator`). Skip `approveHlAgent` unless you revert to `directDepositMode=false`.
- [ ] **ExchangeFacade** deployed per vault you operate; `setExchangeFacade` + `facade.setHyperliquid` + `facade.setActivePerpExchange("HL")` + `hlAdapter.setAuthorizedCaller(facade)` complete.
- [ ] ExchangeFacade timelock is **24h** for future adapter proposals (first HL registration is immediate).
- [ ] Contracts verified on Arbiscan (vault, facade, adapters); `diagnose-eth.js` (and BTC ops smoke) clean.
- [ ] `frontend/.env.local` points at **new** vault/token addresses; `NEXT_PUBLIC_REDEEM_PROOF_BASE_URL` set; proof hosting plan in place.
- [ ] Configure private `kash-ops` repo with matching vault addresses; fork/unit tests pass if you have RPC (`test/redeem-merkle.unit.test.js`, optional fork e2e).

---

## Hyperliquid adapter setup (bootstrap — `directDepositMode = true`)

Complete **per product** before the first live `npm start` batch.

**Why bootstrap:** Hyperliquid does not support production **`approveAgent`** for an adapter contract master (EIP-1271 on-chain passes; off-chain registration lands on the owner EOA; agents cannot `withdraw3`). The bot must be the HL **master** EOA while keeping vault/Aave collateral on-chain.

1. **Custody mode (owner key)** — Step 4a / B3: `scripts/set-direct-deposit-mode.js` with `hlAccount =` on-chain bot (`BOT_ADDRESS`).

2. **Adapter operator (owner key)** — bot calls `syncBalances` / `syncPosition`:
   - At deploy: `HL_ADAPTER_OPERATOR_ADDRESS=<bot_wallet>` in `deploy-hyperliquid-adapter.js`, **or** `adapter.setOperator(<BOT_WALLET>)`.

3. **Bot `.env` (same EOA for on-chain + HL master):**

```env
PRIVATE_KEY=0x...                      # = KashYield botAddress
HYPERLIQUID_API_PRIVATE_KEY=0x...      # same key as PRIVATE_KEY
```

No **`approveHlAgent.js`** in bootstrap mode.

4. **Withdrawals** — automated `withdraw3` uses **`destination =` HyperliquidAdapter** only. Do not use the HL web UI for withdrawals.

<details>
<summary>Reference — ideal path (`directDepositMode = false` + EIP-1271) if HL adds contract-master support</summary>

1. `ENABLED=false` via `scripts/set-direct-deposit-mode.js` (or `setDirectDepositMode(false, 0x0)`).
2. `approveHlAgent.js` with `SIGNER=adapter`; success = `extraAgents(adapter)` lists agent (not owner).
3. Separate `HYPERLIQUID_API_PRIVATE_KEY` (fresh agent) from on-chain `PRIVATE_KEY` if the bot EOA is already an HL user.

</details>

---

## Mainnet deployment overview

Choose **one path** (or run both later — products are independent):

| Path | When to use | Steps |
|------|-------------|--------|
| **BTC only** | Launch KASH-BTC first; no ETH vault | [0](#shared-step-0--compile) → [B1](#step-b1--deploy-kashyieldbtc) → [U](#shared-step-u--deploy-uniswapv3adapter) → [B2–B9](#deployment--btc-product-kashyieldbtcsol) |
| **ETH only** | Launch KASH-ETH only | [0](#shared-step-0--compile) → [3](#step-3--deploy-kashyieldeth) → [U](#shared-step-u--deploy-uniswapv3adapter) → [4–11](#deployment--eth-product-kashyieldeth) |
| **Both** | Full product line | Shared **0 + U** once, then complete **either** product end-to-end before the second (reuse the same `UNISWAP_ADAPTER_ADDRESS`) |

**UniswapV3Adapter** is **one shared contract** per network (router + WETH wrapper). It is **not** tied to ETH vs BTC — either product can be deployed first. Save `UNISWAP_ADAPTER_ADDRESS` after Step U and wire it on each vault you deploy (Step 8 or B7).

### BTC-only quick map

| Order | What | Step |
|------:|------|------|
| 0 | Compile | [0](#shared-step-0--compile) |
| 1 | **KashYieldBtc** + **KashTokenBtc** | [B1](#step-b1--deploy-kashyieldbtc) |
| 2 | **UniswapV3Adapter** (with `KASH_YIELD_BTC_ADDRESS` → auto spot DEX) | [U](#shared-step-u--deploy-uniswapv3adapter) |
| 3 | **HyperliquidAdapter** (BTC) | [B2](#step-b2--deploy-hyperliquidadapter-btc) |
| 4 | HL bootstrap `directDepositMode=true` | [B3](#step-b3--hyperliquid-adapter-custody-mode-btc-adapter) |
| 5 | **ExchangeFacade** (BTC) + wire HL | [B5](#step-b5--deploy-and-wire-exchangefacade-btc) |
| 6 | Whitelist Uniswap + set spot DEX (BTC) — **skip if Step U auto-registered** | [B7](#step-b7--whitelist-uniswap-adapter-and-set-spot-dex-btc) |
| 7 | Cycle duration (BTC) | [B8](#step-b8--set-cycle-duration-btc) |
| 8 | Bot `.env` HL master key (no `approveAgent`) | [Hyperliquid adapter setup](#hyperliquid-adapter-setup-bootstrap--directdepositmode--true) |
| 9 | Verify on Arbiscan | [B9](#step-b9--verify-on-arbiscan-btc) |

**Why B1 before Uniswap:** `deploy-uniswap-adapter.js` can whitelist and `setSpotDex` on KashYieldBtc only if the vault already exists. Pass **`KASH_YIELD_BTC_ADDRESS`** and leave **`KASH_YIELD_ETH_ADDRESS` unset** when running Step U.

**Alternative (Uniswap before B1):** deploy Step U with no vault env vars, then run B7 manually after B1. Same end state, extra owner txs.

### ETH-only quick map

| Order | What | Step |
|------:|------|------|
| 0 | Compile | [0](#shared-step-0--compile) |
| 1 | **KashYieldETH** + **KashTokenEth** | [3](#step-3--deploy-kashyieldeth) |
| 2 | **UniswapV3Adapter** (with `KASH_YIELD_ETH_ADDRESS` → auto spot DEX) | [U](#shared-step-u--deploy-uniswapv3adapter) |
| 3 | **HyperliquidAdapter** (ETH) | [4](#step-4--deploy-hyperliquidadapter-eth) |
| 4 | HL bootstrap `directDepositMode=true` | [4a](#step-4a--hyperliquid-adapter-custody-mode-bootstrap-directdepositmode--true) |
| 5 | **ExchangeFacade** (ETH) + wire HL | [4b](#step-4b--deploy-and-wire-exchangefacade-eth) |
| 6 | ETH oracle (recommended) | [5](#step-5--set-chainlink-eth-oracle-recommended) |
| 7 | Whitelist Uniswap + set spot DEX (ETH) — **skip if Step U auto-registered** | [8](#step-8--whitelist-uniswap-adapter-and-set-spot-dex-eth) |
| 8 | Cycle duration (ETH) | [9](#step-9--set-cycle-duration-eth) |
| 9 | Bot `.env` HL master key (no `approveAgent`) | [Hyperliquid adapter setup](#hyperliquid-adapter-setup-bootstrap--directdepositmode--true) |
| 10 | Verify + smoke test | [10](#step-10--verify-on-arbiscan), [11](#step-11--post-deployment-verification-eth) |

**Why Step 3 before Uniswap:** same as BTC — `deploy-uniswap-adapter.js` auto-whitelists and `setSpotDex` when **`KASH_YIELD_ETH_ADDRESS`** is set. Leave **`KASH_YIELD_BTC_ADDRESS` unset** on an ETH-only deploy.

**Alternative (Uniswap before Step 3):** deploy Step U with no vault env vars, then run Step 8 manually after Step 3.

### Full reference table (both products)

| Order | What | Script / action | Step |
|------:|------|-----------------|------|
| 0 | Compile | `npx hardhat compile` | [0](#shared-step-0--compile) |
| U | **UniswapV3Adapter** (shared spot DEX) | `scripts/deploy-uniswap-adapter.js` | [U](#shared-step-u--deploy-uniswapv3adapter) |
| — | **KashYieldETH** + **KashTokenEth** | `scripts/deploy-arbitrum-sepolia.js` | [3](#step-3--deploy-kashyieldeth) |
| — | **HyperliquidAdapter** (ETH) | `scripts/deploy-hyperliquid-adapter.js` (`IS_ETH_ASSET=true`) | [4](#step-4--deploy-hyperliquidadapter-eth) |
| — | HL custody / facade / oracle / spot / cycle (ETH) | see ETH section | [4a–11](#deployment--eth-product-kashyieldeth) |
| — | **KashYieldBtc** + **KashTokenBtc** | `scripts/deploy-kashyieldbtc.js` | [B1](#step-b1--deploy-kashyieldbtc) |
| — | **HyperliquidAdapter** (BTC) | `scripts/deploy-hyperliquid-adapter.js` (`IS_ETH_ASSET=false`) | [B2](#step-b2--deploy-hyperliquidadapter-btc) |
| — | HL custody / facade / spot / cycle (BTC) | see BTC section | [B3–B9](#deployment--btc-product-kashyieldbtcsol) |

**Scripts named `deploy-arbitrum-sepolia.js` and `MOCK_HL_ADDRESS` are historical** — on mainnet use `--network arbitrumOne` and the live HL Bridge2 address (`0x2Df1…`).

---

## Shared — compile and Uniswap adapter

### Shared Step 0 — Compile

```bash
npx hardhat compile
```

### Shared Step U — Deploy UniswapV3Adapter

One **UniswapV3Adapter** serves spot swaps for **both** KashYieldETH and KashYieldBtc (wBTC/USDC and WETH/USDC routing inside the adapter). Deploy it **once per network** before or after your first vault — it does **not** require KashYieldETH to exist first.

Constructor is **`(swapRouter, weth)`** — defaults match Arbitrum One when using `--network arbitrumOne`.

**BTC-only (auto-register on vault after B1):**

```bash
# Omit KASH_YIELD_ETH_ADDRESS from .env for this run
KASH_YIELD_BTC_ADDRESS=<KASH_YIELD_BTC_ADDRESS from B1> \
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

**BTC-only or ETH-only (deploy adapter only; wire spot DEX later in Step 8 / B7):**

```bash
# Unset KASH_YIELD_ETH_ADDRESS and KASH_YIELD_BTC_ADDRESS in .env
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

**ETH-only (auto-register on vault after Step 3):**

```bash
KASH_YIELD_ETH_ADDRESS=<KASH_YIELD_ETH_ADDRESS> \
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

(Optional explicit router/WETH overrides:)

```bash
UNISWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

Save to root `.env`:

```env
UNISWAP_ADAPTER_ADDRESS=<UniswapV3Adapter from output>
```

> **`.env` tip:** `deploy-uniswap-adapter.js` auto-registers on any vault address present in env. Set only the vault you have deployed: **BTC-only** → `KASH_YIELD_BTC_ADDRESS` only; **ETH-only** → `KASH_YIELD_ETH_ADDRESS` only.

---

## Deployment — ETH product (`KashYieldETH`)

> **Optional.** Skip this entire section if you are deploying **BTC only**.  
> **Order matters (ETH path):** **0** → **KashYieldETH (Step 3)** → **Uniswap (Step U)** → **HyperliquidAdapter (Step 4)**. HL adapter constructor needs the vault address. Do **not** set `HL_ADAPTER_ADDRESS_ETH` in `.env` when running `deploy-arbitrum-sepolia.js` for the first time, or the vault may bind an old adapter at deploy time.

### Step 3 — Deploy KashYieldETH

```bash
BOT_ADDRESS=<your_bot_wallet> \
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumOne
```

Save to root `.env`, private `kash-ops` `.env`, and `frontend/.env.local`:

```env
KASH_YIELD_ETH_ADDRESS=<KashYieldETH from output>
KASH_TOKEN_ETH=<KashTokenEth from output>
```

```env
# frontend/.env.local
NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS=<KashYieldETH from output>
NEXT_PUBLIC_KASH_TOKEN_ETH=<KashTokenEth from output>
```

### Step 4 — Deploy HyperliquidAdapter (ETH)

Pass the **Bridge2** address as **`HL_BRIDGE_ADDRESS`**, **`MOCK_HL_ADDRESS`**, or **`HYPERLIQUID_ADDRESS`** (same value; pick one).

```bash
MOCK_HL_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
IS_ETH_ASSET=true \
KASH_YIELD_ADDRESS=<KASH_YIELD_ETH_ADDRESS from step 3> \
HL_ADAPTER_OPERATOR_ADDRESS=<BOT_WALLET from kash-ops .env> \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Save to root `.env`:

```env
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from output>
```

### Step 4a — Hyperliquid adapter custody mode (bootstrap: `directDepositMode = true`)

**Mainnet production path** — EIP-1271 contract-master `approveAgent` is not available on Hyperliquid; use bootstrap so the bot EOA is the HL master (trades + `withdraw3`). Owner key (root `.env` `PRIVATE_KEY`), repo root:

```bash
HL_ADAPTER_ADDRESS_ETH=<HL_ADAPTER_ADDRESS_ETH> \
HL_ACCOUNT_ADDRESS=<BOT_ADDRESS> \
npx hardhat run scripts/set-direct-deposit-mode.js --network arbitrumOne
```

**Readback:** `directDepositMode` is **`true`**; `hlAccount` matches **`BOT_ADDRESS`** (on-chain `botAddress`).

Then complete **Hyperliquid adapter setup (bootstrap)** in the private `kash-ops` repo — same key for `PRIVATE_KEY` and `HYPERLIQUID_API_PRIVATE_KEY`.

**Deploy-time operator (recommended):** `HL_ADAPTER_OPERATOR_ADDRESS=<BOT_WALLET>` when running `deploy-hyperliquid-adapter.js`.

To revert to adapter-as-HL-account (only if HL contract-master works for you):

```bash
ENABLED=false HL_ADAPTER_ADDRESS_ETH=<HL_ADAPTER_ADDRESS_ETH> \
npx hardhat run scripts/set-direct-deposit-mode.js --network arbitrumOne
```

**How to confirm success**

- **`receipt.status === 1`** — transaction succeeded (in Hardhat/ethers v6 this appears as `status: 1n` or `1` on the receipt object). **`status: 0`** means the call reverted.
- **`receipt.contractAddress === null`** — normal for this step: you are calling an existing adapter, not deploying a new contract.
- **`receipt.to`** — must match your **`HL_ADAPTER_ADDRESS_ETH`** (the adapter you configured).
- **On-chain check:** paste **`receipt.hash`** into Arbiscan; the UI should show **Success**.

### Step 4b — Deploy and wire ExchangeFacade (ETH)

After Steps 3–4a (vault + HL adapter + bootstrap custody):

```bash
KASH_YIELD_ADDRESS=<KASH_YIELD_ETH_ADDRESS> \
BOT_ADDRESS=<bot_wallet> \
PRIMARY_ASSET=0x0000000000000000000000000000000000000000 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
```

Save `EXCHANGE_FACADE_ETH=<address>` to root `.env`.

**Wire** (owner key — `scripts/wire-exchange-facade.js`):

```bash
PRODUCT=eth \
KASH_YIELD_ETH_ADDRESS=<KASH_YIELD_ETH_ADDRESS> \
EXCHANGE_FACADE_ETH=<EXCHANGE_FACADE_ETH> \
HL_ADAPTER_ADDRESS_ETH=<HL_ADAPTER_ADDRESS_ETH> \
npx hardhat run scripts/wire-exchange-facade.js --network arbitrumOne
```

The script runs `setExchangeFacade`, `setHyperliquid`, `setActivePerpExchange("HL")`, and `setAuthorizedCaller`, then prints readback. Safe to re-run if already wired (skips completed steps).

**Readback:** `vault.exchangeFacade()` = facade; `facade.hyperliquidAddress()` = adapter; `hlAdapter.authorizedCaller()` = facade.

### Step 5 — Set Chainlink ETH oracle (recommended)

`KashYieldETH` defaults to the Arbitrum ETH/USD feed; calling `setEthOracle` makes configuration explicit.

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612 \
npx hardhat run scripts/setEthOracle.js --network arbitrumOne
```

### Step 6 — ExchangeFacade timelock (informational)

HL registration on the **facade** (Step 4b) is **immediate** for the **first** adapter. The facade uses a fixed **24h** timelock for **subsequent** adapter proposals (`exchangeSwitchDelay` on `ExchangeFacade`).

**Later**, if you propose a **new** adapter: wait 24h, then `facade.confirmPerpExchange("HL")`, then `facade.setActivePerpExchange("HL")`. Do **not** use legacy `scripts/setExchangeSwitchDelay.js` on the vault.

### Step 8 — Whitelist Uniswap adapter and set spot DEX (ETH)

Use **`UNISWAP_ADAPTER_ADDRESS`** from [Shared Step U](#shared-step-u--deploy-uniswapv3adapter). Skip if Step U already auto-registered on KashYieldETH.

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
ROUTER_ADDRESS=<UNISWAP_ADAPTER_ADDRESS> \
npx hardhat run scripts/setAllowedSpotDexRouter.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
SPOT_DEX_ADDRESS=<UNISWAP_ADAPTER_ADDRESS> \
npx hardhat run scripts/setSpotDex.js --network arbitrumOne
```

If the script reports a spot-DEX timelock, wait and run `confirmSpotDex.js` as printed.

### Step 9 — Set cycle duration (ETH)

```bash
CYCLE_SECONDS=86400 PRODUCT=eth KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumOne
```

### Step 10 — Verify on Arbiscan

```bash
npx hardhat verify --network arbitrumOne <KASH_YIELD_ETH_ADDRESS> <BOT_ADDRESS> \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831

npx hardhat verify --network arbitrumOne <UNISWAP_ADAPTER_ADDRESS> \
  0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1

  npx hardhat verify --network arbitrumOne <HL_ADAPTER_ADDRESS_ETH> \
  0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  "0x0000000000000000000000000000000000000000" true \
  <KASH_YIELD_ETH_ADDRESS>

npx hardhat verify --network arbitrumOne <EXCHANGE_FACADE_ETH> <OWNER> <BOT_ADDRESS> \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  0x0000000000000000000000000000000000000000 \
  <KASH_YIELD_ETH_ADDRESS>
```

### Step 11 — Post-deployment verification (ETH)

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/diagnose-eth.js --network arbitrumOne
```

### ETH deployment — summary checklist

- [ ] UniswapV3Adapter deployed; `UNISWAP_ADAPTER_ADDRESS` saved
- [ ] KashYieldETH deployed; `KASH_YIELD_ETH_ADDRESS` / `KASH_TOKEN_ETH` saved
- [ ] HyperliquidAdapter (ETH) deployed; `HL_ADAPTER_ADDRESS_ETH` saved; **Hyperliquid custody mode** set per Step 4a
- [ ] **ExchangeFacade** deployed and wired (Step 4b); `EXCHANGE_FACADE_ETH` saved
- [ ] `setEthOracle.js` run (recommended)
- [ ] HL bootstrap: `set-direct-deposit-mode.js`; `kash-ops` `.env` same key for `PRIVATE_KEY` + `HYPERLIQUID_API_PRIVATE_KEY`
- [ ] `setAllowedSpotDexRouter.js` + `setSpotDex.js` — spot DEX live (confirm timelock if applicable)
- [ ] `setCycleDuration.js` for ETH
- [ ] Contracts verified; `diagnose-eth.js` clean
- [ ] Private `kash-ops` repo and `frontend/.env.local` updated (`NEXT_PUBLIC_REDEEM_PROOF_BASE_URL` for claims)

---

## Deployment — BTC product (`KashYieldBtc.sol`)

Deploy **KashYieldBtc** independently — **no ETH vault required**. Complete shared **Step 0** (compile) and **Step U** (UniswapV3Adapter) as in [BTC-only quick map](#btc-only-quick-map). The Aave pool and tokens are the same canonical Arbitrum One addresses as ETH.

> **Do not** pass `SPOT_DEX_ADDRESS` / `MOCK_SPOT_DEX_ADDRESS` into `deploy-kashyieldbtc.js` on first deploy unless you have already whitelisted that adapter on the new vault (you cannot whitelist before the vault exists). Prefer: deploy BTC vault (B1), then **Step U** with `KASH_YIELD_BTC_ADDRESS` **or** manual whitelist + `setSpotDex` in Step B7 using `UNISWAP_ADAPTER_ADDRESS`.

### Step B1 — Deploy KashYieldBtc

[`scripts/deploy-kashyieldbtc.js`](../scripts/deploy-kashyieldbtc.js) deploys `KashYieldBtc` and `KashTokenBtc`, and calls **`setBtcOracle`** with `BTC_ORACLE_ADDRESS` (Chainlink BTC/USD).

```bash
BOT_ADDRESS=<your_bot_wallet> \
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
BTC_ORACLE_ADDRESS=0x6ce185860a4963106506C203335A2910413708e9 \
npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumOne
```

Save to root `.env`, private `kash-ops` `.env`, and `frontend/.env.local`:

```env
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc from output>
KASH_TOKEN_BTC=<KashTokenBtc from output>
```

```env
# frontend/.env.local
NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS=<KashYieldBtc from output>
NEXT_PUBLIC_KASH_TOKEN_BTC=<KashTokenBtc from output>
```

### Step B2 — Deploy HyperliquidAdapter (BTC)

Use **`IS_ETH_ASSET=false`** (recommended if root `.env` also sets `KASH_YIELD_ETH_ADDRESS` — the deploy script picks the vault from the product flag) and supply **`WBTC_ADDRESS`**. `KASH_YIELD_BTC_ADDRESS` identifies the vault.

```bash
MOCK_HL_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
IS_ETH_ASSET=false \
KASH_YIELD_BTC_ADDRESS=<KASH_YIELD_BTC_ADDRESS from step B1> \
HL_ADAPTER_OPERATOR_ADDRESS=<BOT_WALLET from kash-ops .env> \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Save:

```env
HL_ADAPTER_ADDRESS_BTC=<HyperliquidAdapter from output>
```

### Step B3 — Hyperliquid adapter custody mode (BTC adapter)

Same as **Step 4a** (bootstrap). Owner key, repo root:

```bash
HL_ADAPTER_ADDRESS_BTC=<HL_ADAPTER_ADDRESS_BTC> \
HL_ACCOUNT_ADDRESS=<BOT_ADDRESS> \
npx hardhat run scripts/set-direct-deposit-mode.js --network arbitrumOne
```

**Readback:** `directDepositMode` is **`true`**; `hlAccount` = **`BOT_ADDRESS`**.

Confirm **`operator`** is the bot (`HL_ADAPTER_OPERATOR_ADDRESS` at deploy or `setOperator`). Complete **Hyperliquid adapter setup (bootstrap)** in the private `kash-ops` repo.

### Step B4 — BTC oracle

Already applied in **Step B1** via `setBtcOracle`. Re-run only if you need to change the feed later (owner script / contract method per your process).

### Step B5 — Deploy and wire ExchangeFacade (BTC)

```bash
KASH_YIELD_ADDRESS=<KASH_YIELD_BTC_ADDRESS> \
BOT_ADDRESS=<bot_wallet> \
PRIMARY_ASSET=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
npx hardhat run scripts/deploy-exchange-facade.js --network arbitrumOne
```

Save `EXCHANGE_FACADE_BTC=<address>` to root `.env`.

**Wire** (owner key — same script as Step 4b):

```bash
PRODUCT=btc \
KASH_YIELD_BTC_ADDRESS=<KASH_YIELD_BTC_ADDRESS> \
EXCHANGE_FACADE_BTC=<EXCHANGE_FACADE_BTC> \
HL_ADAPTER_ADDRESS_BTC=<HL_ADAPTER_ADDRESS_BTC> \
npx hardhat run scripts/wire-exchange-facade.js --network arbitrumOne
```

**HL master key (private `kash-ops` repo)** — skip if you completed Step B3 bootstrap:

```env
PRIVATE_KEY=0x...                 # on-chain botAddress
HYPERLIQUID_API_PRIVATE_KEY=0x...   # same key — HL master (orders + withdraw3)
```

No **`approveHlAgent.js`** when `directDepositMode = true`.

<details>
<summary>Only if you use `directDepositMode = false` (EIP-1271 ideal — blocked on HL production today)</summary>

`approveHlAgent.js` with `SIGNER=adapter`; must see `extraAgents(adapter)` list the agent (not owner). See collapsed section in **Hyperliquid adapter setup (bootstrap)**.

</details>

### Step B7 — Whitelist Uniswap adapter and set spot DEX (BTC)

Use **`UNISWAP_ADAPTER_ADDRESS`** from [Shared Step U](#shared-step-u--deploy-uniswapv3adapter). Skip this step if Step U already auto-registered the adapter on KashYieldBtc (you saw `setSpotDex on KashYieldBtc` in the deploy output). The same router-backed adapter handles wBTC/USDC routing in the adapter implementation.

```bash
PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
ROUTER_ADDRESS=<UNISWAP_ADAPTER_ADDRESS> \
npx hardhat run scripts/setAllowedSpotDexRouter.js --network arbitrumOne

PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
SPOT_DEX_ADDRESS=<UNISWAP_ADAPTER_ADDRESS> \
npx hardhat run scripts/setSpotDex.js --network arbitrumOne
```

Confirm any spot-DEX timelock with `confirmSpotDex.js` if the script instructs you to.

### Step B8 — Set cycle duration (BTC)

```bash
CYCLE_SECONDS=86400 PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumOne
```

### Step B9 — Verify on Arbiscan (BTC)

Constructor args for `KashYieldBtc` are **`(botAddress, wbtc, usdc)`**:

```bash
npx hardhat verify --network arbitrumOne <KASH_YIELD_BTC_ADDRESS> <BOT_ADDRESS> \
  0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831

npx hardhat verify --network arbitrumOne <HL_ADAPTER_ADDRESS_BTC> \
  0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f false \
  <KASH_YIELD_BTC_ADDRESS>

npx hardhat verify --network arbitrumOne <EXCHANGE_FACADE_BTC> <OWNER> <BOT_ADDRESS> \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
  <KASH_YIELD_BTC_ADDRESS>
```

### BTC deployment — summary checklist

- [ ] Shared Step **0** + **U** — `UNISWAP_ADAPTER_ADDRESS` saved; spot DEX wired on KashYieldBtc (Step U auto-register or B7)
- [ ] `deploy-kashyieldbtc.js` — `KASH_YIELD_BTC_ADDRESS`, `KASH_TOKEN_BTC`, Chainlink BTC oracle wired
- [ ] HyperliquidAdapter (BTC) deployed; `HL_ADAPTER_ADDRESS_BTC` saved; **Hyperliquid custody mode** set per Step B3
- [ ] **ExchangeFacade** deployed and wired (Step B5); `EXCHANGE_FACADE_BTC` saved; HL bootstrap (`directDepositMode=true`, bot master key in `kash-ops`)
- [ ] `setAllowedSpotDexRouter.js` + `setSpotDex.js` with `PRODUCT=btc` — using `UNISWAP_ADAPTER_ADDRESS` from Step U (or auto-registered during Step U)
- [ ] `setCycleDuration.js` with `PRODUCT=btc`
- [ ] Contracts verified; `kash-ops` and frontend envs updated for **PRODUCT=btc** when operating BTC

---

## Adding a second perp exchange (GMX, Aster, etc.)

Register on the vault’s **ExchangeFacade** (owner Hardhat console). Example for ETH facade:

```javascript
const facade = await ethers.getContractAt("ExchangeFacade", "<EXCHANGE_FACADE_ETH>")
await (await facade.setPerpExchange("GMX", "<GMX_ADAPTER_ADDRESS>")).wait()
// After facade timelock:
await (await facade.confirmPerpExchange("GMX")).wait()
await (await facade.setActivePerpExchange("GMX")).wait()
```

Repeat with `EXCHANGE_FACADE_BTC` for the BTC product. With non-zero facade `exchangeSwitchDelay`, wait for the timelock between proposal and confirmation.

---

## Diagnosing stuck batches (ETH)

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/diagnose-eth.js --network arbitrumOne
```

---

## Useful scripts (Arbitrum One)

```bash
KASH_YIELD_ETH_ADDRESS=<addr> npx hardhat run scripts/diagnose-eth.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<addr> DELAY_SECONDS=86400 \
  npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<addr> npx hardhat run scripts/check-contract-config.js --network arbitrumOne

npx hardhat run scripts/checkBalance.js --network arbitrumOne
```

---

## Network reference

| Network | Chain ID | RPC | Explorer |
|---------|----------|-----|----------|
| Arbitrum One | 42161 | `https://arb1.arbitrum.io/rpc` | https://arbiscan.io |

---

## Security

- Never commit `.env` or private keys.
- **Owner** (root `.env`) and **bot operator** (private `kash-ops` repo) are different wallets with different key material.
- Owner holds governance/config; bot holds only enough ETH for gas and never owns the vault `owner()` role.
- Audit contracts before significant TVL.
- Keep `exchangeSwitchDelay` non-zero on mainnet unless you explicitly accept operational risk on future adapter changes.
- **Bootstrap (`directDepositMode = true`):** bot EOA is HL master — limit bot key exposure; never HL-UI withdraw to bot EOA; see **bot key compromise** under *Hyperliquid USDC withdrawals and custody*.

---

## Post-deploy operational notes

Items called out elsewhere in this guide but easy to miss during cutover. Detailed batch ops, HL bootstrap env, and manual ops scripts are documented in the **private `kash-ops` repository**.

### Redeem proof hosting (required for claim UI)

After each redeem Phase 2, the operator bot publishes Merkle proof manifests to static hosting. Set **`NEXT_PUBLIC_REDEEM_PROOF_BASE_URL`** in `frontend/.env.local`. Users claim via **`claimRedeem`** in the app (not automatic transfer).

External reference: [Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/).

### Wrong `botAddress` after deploy

Deploy scripts set **`botAddress`** from **`BOT_ADDRESS`**. If you omitted it or used the wrong address, fix with the **owner** key (root `.env`):

```bash
# ETH vault
KASH_YIELD_ETH_ADDRESS=<KASH_YIELD_ETH> BOT_ADDRESS=<bot_wallet> \
  npx hardhat run scripts/setBotAddress.js --network arbitrumOne

# BTC vault
PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KASH_YIELD_BTC> BOT_ADDRESS=<bot_wallet> \
  npx hardhat run scripts/setBotAddress.js --network arbitrumOne
```

Verify on-chain: `owner() ≠ botAddress()` and `botAddress()` matches the bot operator wallet configured in `kash-ops`.

### `rescueERC20` and USDC on the vault

**`rescueERC20`** lets the **owner** transfer arbitrary ERC-20 balances held by the vault. **wBTC and ETH (deposit assets) are blocked**; **USDC is not**. That means owner can pull **all on-vault USDC**, including float that backs user NAV — not only **`ownerUsdcReserve`**. Use only for mis-sent tokens, wind-down, or other cases you accept the risk for.

- Policy and trust model: [SECURITY.md](SECURITY.md)

Prefer **`markOwnerUsdcDeposit`** / **`coverUsdcShortfall`** / batch ops for normal treasury and working-float USDC.
