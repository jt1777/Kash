# Risks & Safeguards

KASH is a Decentralized Finance protocol on **Arbitrum One** mainnet. Participation involves depositing real assets; the risks involved should be understood before use.

> **Important:** KASH should be treated as high risk until contract review and operational security are satisfactory. Only amounts that can be affordably lost should be deposited.

---

## Smart contract risk

The protocol is governed entirely by smart contracts. If there is a bug in the code, funds could be lost or locked. Mitigations in place:

- All user-facing functions are protected against reentrancy attacks
- New exchanges that KASH may interact with require a **24-hour waiting period** before they can be activated (preventing a compromised key from instantly routing funds to a malicious contract)
- An emergency pause function exists that can halt all user activity

**Verification steps:** The Contract Address link in the app footer leads to the verified contract page on Arbiscan.

Contracts are fully source-code verified on Arbiscan, so the complete Solidity source code can be reviewed under the Contract tab. Arbiscan has confirmed that this code compiles byte-for-byte into the exact bytecode deployed on Arbitrum.

For maximum transparency, the full source code is also published in the public GitHub repository — it can be cross-checked against the verified code on Arbiscan to confirm it matches the official version the team intended to deploy.


---

## Funding rate risk

Yield comes primarily from earning the funding rate on short positions held on the perp DEX. Funding rates are not guaranteed and can go negative — meaning the protocol would **pay** funding instead of earning it. During extended bear markets or periods of low speculative activity, yield could be zero or negative.

The protocol does not promise a fixed APY. Yield is variable and reflects current market conditions.

---

## Liquidation risk

The protocol's yield strategy involves transactions with perpetual DEX's, spot DEX's, and borrowing & lending protocols. As such, it may be subject to liquidation risk on any of these protocols due to a sharp drop in collateral value. However, this is not a significant risk in practice for two reasons:

1. **The positions are always 100% hedged.** If the protocol holds ETH or wBTC, it will have an equal short position on a perp DEX. If the asset price falls, the short position gains an equivalent amount. Conversely, if the asset price rises, the short position loses value. The two sides of the trade perfectly hedge each other.

2. **The protocol actively monitors and manages collateral.** When needed, the protocol transfers collateral from the various protocols to keep safe from being liquidated on any individual protocol.

---

## Exchange and counterparty risk

The yield strategy depends on the lending protocol and perp DEX continuing to function correctly. Risks may include but are not limited to:

- Downtime or insolvency of the lending platform or perp DEX
- Smart contract vulnerabilities in the above protocols
- Regulatory actions

---

## Centralisation risk

Protocol operations — batch processing, capital deployment, and NAV updates — are currently performed by a single operator. A compromised or unavailable operator key could delay batch processing or mismanage capital.

**Planned improvements:** **Chainlink Automation** is planned so upkeep and batch processing can be invoked on a decentralised schedule, reducing reliance on a single always-online operator key and lowering the risk of missed batches due to downtime. Multi-signature control remains on the roadmap as well.

---

## Oracle risk

The value of a deposit at batch time is calculated using on-chain price feeds. If a price feed provides incorrect or stale data, fewer KASH tokens than expected may be received on deposit, or fewer assets on redemption. Industry-standard oracle providers are used, but no price feed is entirely risk-free.

---

## No insurance

Funds deposited in KASH are not insured. There is no protocol-level insurance fund at this stage. Deposits should not exceed amounts participants are willing to lose.

---

## Safeguards

KASH is designed with layered protections against **external exploits** (hacks, malicious contracts, reentrancy) and **privileged-key misuse** (rugpulls by owner or operator). No set of safeguards eliminates all risk — see the sections above — but the following are built into the live contracts.

### Protections against hacks and external exploits

**Capital deployment is bot-gated.** Moving funds to Aave, Hyperliquid, or spot DEXs — opening or closing shorts, borrowing, repaying, and swapping — can only be called by the configured **bot** or **keeper** addresses. A random attacker who finds a UI bug or phishes users cannot invoke these functions directly; they would need to compromise the bot or keeper key.

**Reentrancy guards on high-risk paths.** Batch settlement and all external protocol interactions (Aave, perp DEX, spot swaps) use reentrancy protection. State is updated before outbound calls where it matters, reducing classic reentrancy drain vectors.

**Whitelisted integrations only.** Spot swaps can only route through **pre-approved DEX adapter contracts**, and only among **allowed tokens**. The owner cannot point the vault at an arbitrary malicious router in a single transaction.

**Timelock before new exchange adapters.** Registering a new perp or spot DEX adapter starts a **24-hour waiting period** on mainnet. A compromised owner key cannot instantly redirect the entire vault to a fake exchange — users and monitors have time to react before the adapter is confirmed and activated. The owner can lengthen this delay if desired.

**Swap slippage cap.** On-chain swaps enforce a maximum slippage bound, limiting how much value can be lost to sandwich attacks or misconfigured routes in a single swap.

**Safe token handling.** ERC-20 transfers use standard safe-transfer patterns, avoiding non-standard token return-value bugs.

**Batch processing limits flash-loan abuse.** Deposits and redemptions queue for the **next daily batch**; there is no same-block deposit-and-redeem loop to farm NAV or funding in one transaction.

**Emergency pause.** The owner can pause mints and redemptions. While paused, normal user flows stop — limiting damage while an incident is investigated.

**Verified, auditable code.** Contract source is **verified on Arbiscan** and published in the public GitHub repo so anyone can compare deployed bytecode to the intended source.

### Protections against owner misuse

**Pending user funds are ring-fenced.** When a deposit is submitted, ETH or wBTC is tracked in an on-chain **reserved** balance. Owner withdrawal functions can only take assets **above** what is reserved for pending mints and estimated redeems across recent unprocessed batches. Any attempt to withdraw reserved funds **reverts automatically**.

**Users can cancel before the batch runs.** While the user window is open and the batch has not entered processing, a pending mint or redeem may be **cancelled** and assets or KASH returned — without owner involvement.

**Users can self-rescue if the contract is paused.** If the contract is paused, dedicated emergency withdrawal paths allow reclamation of a **still-pending** request directly from the contract. These paths do not go through the owner. They require interacting with the contract directly (e.g. Arbiscan “Write Contract”) rather than the app UI.

**Rescue function cannot take deposit collateral.** Token rescue is blocked for the vault’s primary deposit asset (ETH/wBTC), so the owner cannot use “token rescue” as a back door to sweep user collateral.

**Stray tokens only.** Token rescue exists to recover mistakenly sent ERC-20s (not the main deposit asset), sent to a designated recipient.

### Operator and NAV transparency

**Separate bot key from owner.** Day-to-day batch ops use a dedicated **bot** address, distinct from the contract **owner**. Compromising one key does not automatically grant the other’s privileges — though either compromise remains serious.

**NAV updates are recorded on-chain.** Each batch, the bot submits the new NAV used for mint and redeem pricing. The value is not recomputed inside the smart contract; it reflects off-chain portfolio marking from on-chain balances and perp economics. Each update is emitted on-chain for public audit after the fact. A compromised or buggy bot could still post an unfair NAV — **multi-signature** or additional controls for NAV submission remain on the roadmap.

**Planned improvements:** **Chainlink Automation** for decentralised batch triggering, and **multi-sig** owner/operator control — see [Centralisation risk](#centralisation-risk) above.

---
