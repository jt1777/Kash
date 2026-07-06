# Risks & Safeguards

KASH is a decentralised finance protocol on **Arbitrum One**. Participation involves depositing real assets; the risks involved should be understood before use.

> **Important:** KASH should be treated as high risk until contract review and operational security are satisfactory. Only amounts that can be affordably lost should be deposited.

This documentation describes the **V3 ownerless vaults** on the **`aster` branch** — deployed with **Aster** as the on-chain perp DEX. The legacy **Hyperliquid (HL)** deployment on the `main` branch is a separate, older stack with different custody and governance tradeoffs.

---

## Do not send tokens directly to the contract

> **Critical:** Never transfer ETH, wETH, wBTC, or any other token **directly** to a KASH vault contract address (for example from a wallet’s “Send” screen or a raw ERC-20 transfer). Deposits **must** go through the app’s **Mint KASH** flow, which calls `requestMint` on the correct vault. Tokens sent any other way are **not** credited as a deposit and, in most cases, **cannot be returned to you**.

The vault contracts only recognize deposits submitted via **Submit Mint Request** during the open user window. A plain transfer to the contract address does **not** create a mint request, does **not** mint KASH, and is **not** refundable through the app.

| Vault | Accepted asset | Correct method | What goes wrong if you transfer directly |
|-------|----------------|----------------|----------------------------------------|
| **KASH-ETH** | ETH or wETH | Use **Mint KASH** on the ETH tab (calls `requestMint`) | **Native ETH** sent to the contract is accepted by `receive()` but is **not** tied to your wallet — you receive no KASH and have **no way to reclaim it** (V3 vaults are ownerless; there is no rescue function). **wETH** sent without calling `requestMint` is likewise not credited. |
| **KASH-BTC** | wBTC only | Use **Mint KASH** on the BTC tab (calls `requestMint`) | **wBTC** sent via a direct ERC-20 transfer is **not** credited and **cannot be recovered** — there is no owner or rescue path on V3. |

**Use the right vault for the right asset:**

- Do **not** send **ETH** or **wETH** to the **KASH-BTC** contract (no `receive()` hook; the transaction should revert, but never attempt it).
- Do **not** send **wBTC** to the **KASH-ETH** contract — wrong product; it will not mint KASH-BTC.
- Do **not** send **wBTC** to the **KASH-BTC** contract except through **Mint KASH** — a direct transfer is the most common way to permanently lose funds.

Live vault addresses are shown in the app footer and in [`frontend/lib/contracts/addresses.ts`](../frontend/lib/contracts/addresses.ts). See [Depositing](depositing.md) for the step-by-step flow.

---

## Smart contract risk

The protocol is governed entirely by smart contracts. If there is a bug in the code, funds could be lost or locked. Mitigations in place:

- All user-facing functions are protected against reentrancy attacks
- Each V3 vault is **ownerless**: the bot address, `ExchangeFacade`, `AsterAdapter`, spot DEX, oracle, fees, batch timing, and user caps are **fixed permanently at deploy** — there is no privileged key that could redirect integrations or parameters after launch
- There is **no emergency pause** — see [Safeguards](#safeguards) for the tradeoffs of the ownerless design

**Verification steps:** The Contract Address link in the app footer leads to the verified contract page on Arbiscan. Contracts are source-code verified on Arbiscan; the full Solidity is also published in the public GitHub repository and can be cross-checked against deployed bytecode.

---

## Funding rate risk

Yield comes primarily from earning the funding rate on short positions held on the perp DEX (**Aster** on V3). Funding rates are not guaranteed and can go negative — meaning the protocol would **pay** funding instead of earning it. During extended bear markets or periods of low speculative activity, yield could be zero or negative.

The protocol does not promise a fixed APY. Yield is variable and reflects current market conditions. The app’s indicative P.A. Yield is computed in the browser from live market inputs; it is not a guarantee.

---

## Liquidation risk

The yield strategy uses Aave, a perp DEX, and on-chain spot swaps. Liquidation on any leg is possible in theory if collateral or margin falls below protocol thresholds.

In practice the strategy is designed to stay **delta-neutral**: collateral (ETH or wBTC) is hedged with an offsetting short on Aster. The operator bot also rebalances margin and collateral during each batch. A sharp move combined with failed batch ops or oracle issues could still stress the book — treat this as non-zero tail risk.

---

## Exchange and counterparty risk

The strategy depends on **Aave**, **Aster**, and (when used) **Uniswap** continuing to function correctly. Risks include downtime, insolvency, smart-contract bugs, or regulatory action against those protocols.

---

## Centralisation risk

Protocol operations — batch processing, capital deployment, and NAV updates — are performed by a **bot** (and optionally a **keeper** for Chainlink-style upkeep). A compromised or unavailable bot key could delay batches, mis-size hedges, or submit an incorrect NAV.

**Mitigations on V3:**

- The bot address is **immutable** at deploy — it cannot be rotated on-chain after launch (a misconfigured bot requires redeploying the stack and user migration)
- Capital movement (Aave, Aster, spot DEX) is **bot/keeper-gated** only
- **Chainlink Automation** (keeper registry address fixed at deploy) can invoke upkeep on a schedule, reducing reliance on a single always-online operator

**Remaining trust:** NAV is **submitted** by the bot from an off-chain portfolio mark (built from on-chain balances and Aster/Aave state), not recomputed inside the vault in a single on-chain formula. Users must trust correct bot behavior for daily NAV and batch ops.

**Planned improvements:** Multi-signature or decentralised control over the bot key remains on the roadmap.

---

## Perp DEX custody (Aster) — improved vs legacy HL

On **V3 + Aster**, perpetual exposure is managed **entirely on Arbitrum** through an **`AsterAdapter`** bound to an immutable **`ExchangeFacade`**. The adapter calls Aster’s clearing house and vault contracts; the bot triggers those calls **through the facade**, not by holding a separate cross-chain master wallet.

| | **V3 (Aster, `aster` branch)** | **Legacy (`main` branch, HL)** |
|--|----------------------------------|--------------------------------|
| Perp venue | Aster on Arbitrum | Hyperliquid (cross-chain) |
| Custody model | Adapter + facade on-chain; bot is operator only | Direct-deposit mode: bot EOA is HL master |
| Post-deploy redirect | **Not possible** (immutable wiring) | Owner could change bot/adapter (V2) |
| Agent approval / EIP-712 HL issues | **Not applicable** (native Arbitrum DEX) | Blocked ideal adapter-as-master path |

This removes the **Hyperliquid hot-wallet master account** risk class for new Aster deployments. Residual risk: a **compromised bot key** can still invoke allowed facade/adapter actions (open/close shorts, Aave flows, swaps) until the bot is stopped off-chain.

---

## Oracle risk

Deposit and redeem sizing at batch time uses **Chainlink** price feeds (`getEthPrice()` / `getBtcPrice()` on the vault). If a feed is wrong or stale, mint/redeem amounts can be affected.

---

## Batch overlap

V3 blocks starting **Phase 1** for cycle **N+1** while cycle **N** is still in **Phase 1** (ops running). This reduces the risk of concurrent batches corrupting NAV or ops sizing during long on-chain perp chunks. It does **not** guarantee the bot finishes every batch before the next user window — monitor `batchPhase` on-chain.

---

## No insurance

Funds deposited in KASH are not insured. There is no protocol-level insurance fund. Deposits should not exceed amounts participants are willing to lose.

---

## Safeguards

KASH V3 is designed with layered protections against **external exploits** and **post-deploy privileged misuse**. No design eliminates all risk.

**Both KASH-ETH and KASH-BTC vaults are ownerless.** There is no contract owner, no pause, and no post-deploy setters. An incident can only be mitigated by the bot stopping operations and, if needed, users migrating to a redeployed vault.

### Protections against hacks and external exploits

**Capital deployment is bot/keeper-gated.** Aave, Aster (via `ExchangeFacade`), and spot DEX calls can only be invoked by the configured **bot** or **keeper**. Random users cannot trigger hedge or withdrawal functions.

**Reentrancy guards** on batch settlement and external protocol interactions.

**Immutable integrations.** Each vault is bound to one `ExchangeFacade`, one `AsterAdapter`, and one spot DEX address at construction. Nobody can point the vault at a malicious router after deploy.

**Bot-supplied swap bounds.** On-chain swaps require a minimum output from a live quote at execution time (bounded by immutable `maxSwapSlippageBps`).

**Batch processing limits flash-loan abuse.** Deposits and redemptions queue for the **daily batch**; there is no same-block deposit-and-redeem loop.

**Batch overlap guard.** Phase 1 for a new cycle reverts if the previous cycle is still in Phase 1.

**Pull claims with expiry.** Mint and redeem payouts use **Merkle roots** committed at settlement; users call `claimMint` / `claimRedeem` with proofs. Unclaimed funds can be swept after **30 days** to the immutable **fee receiver** (see [Fees](fees.md)).

**Verified, auditable code.** Source is verified on Arbiscan and published in GitHub.

### No owner misuse is possible

There is no owner key — no pause abuse, no rotating integrations, no arbitrary fee changes after deploy. Protocol fees (`feeBps`) and the **fee receiver** address are also **immutable**.

**Users can cancel before the batch runs.** While the user window is open and the batch has not entered processing, pending mint or redeem requests may be **cancelled** and assets or KASH returned.

### Operator and NAV transparency

**Bot-only privilege.** The bot (and keeper) is the only address that can move strategy capital or submit `updateNAV`.

**NAV updates are recorded on-chain.** Each batch, the bot submits NAV used for settlement. Events and `currentNAV` are public. A buggy or malicious bot could still post an unfair NAV — treat operator trust as a remaining risk.

**How to sanity-check NAV (plain language):**

1. Read **`getNAV()`** and **`totalSupply()`** on the KASH token — total vault NAV ≈ NAV × supply ÷ 10¹⁸.
2. On Arbiscan, open the vault **Read Contract** tab and check **`botAddress()`** — that operator runs batch txs.
3. Read **`exchangeFacade()`** → on the facade, **`perpExchangeAddress()`** should be your **`AsterAdapter`**; adapter **`clearingHouse()`** / **`vault()`** point at Aster protocol contracts on Arbitrum.
4. For a full recompute, use the component checklist in the landing **Verify** section (Aave collateral, USDC debt, vault balances, Aster position value, Chainlink prices) — same inputs the bot uses off-chain.

**Planned improvements:** Chainlink Automation for decentralised upkeep triggering; multi-signature bot control — see [Centralisation risk](#centralisation-risk).

---

## Claim expiry

Mint and redeem claims expire **30 days** after the Merkle root is committed (`batchClaimInfo(batchCycle).claimDeadline`). Claim before the deadline or funds may be swept per contract rules. See [Agent Quickstart](agent-quickstart.md) for proof URLs and claim flows.
