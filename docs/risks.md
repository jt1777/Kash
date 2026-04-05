# Risks

KASH is a Decentralized Finance protocol on **Arbitrum One** mainnet. Using it means depositing real assets; you should understand the risks involved.

> **Important:** Treat KASH as high risk until you are satisfied with contract review and operational security. Only deposit what you can afford to lose.

---

## Smart contract risk

The protocol is governed entirely by smart contracts. If there is a bug in the code, funds could be lost or locked. Mitigations in place:

- All user-facing functions are protected against reentrancy attacks
- New exchanges that KASH may interact with require a 48-hour waiting period before they can be activated (preventing a compromised key from instantly routing funds to a malicious contract)
- An emergency pause function exists that can halt all user activity

**What you can do:** Click the Contract Address link in the app footer. This takes you straight to the verified contract page on Arbiscan.  
Our contracts are fully source-code verified on Arbiscan, so you can review the complete Solidity source code under the Contract tab. Arbiscan has already confirmed that this code compiles byte-for-byte into the exact bytecode deployed on Arbitrum.  
For maximum transparency, we also publish the full source code in our public GitHub repository — you can cross-check it against the verified code on Arbiscan to confirm it matches the official version the team intended to deploy.


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

## Safeguards against owner misconduct

A common concern with DeFi protocols is whether the contract owner could misuse their privileges to steal user funds. Several safeguards are built into the KASH contracts to limit this:

**Pending deposits are ring-fenced.** When you submit a deposit, your ETH is tracked in a reserved balance on-chain. The owner's ETH withdrawal function can only access ETH that is *above and beyond* what is reserved for all pending user requests. The contract enforces this automatically — any attempt to withdraw reserved funds reverts. Your queued deposit cannot be taken by the owner.

**Users can self-rescue if the contract is paused.** If the contract is ever paused, you can reclaim your pending ETH deposit or pending KASH tokens directly from the contract, without any involvement from the owner. These functions bypass the owner entirely. Note: accessing them requires interacting with the contract directly (e.g. via the "Write Contract" tab on Arbiscan) rather than through the app UI — this is somewhat technical but does not require coding skills.

**New exchange integrations require a 48-hour waiting period.** The owner cannot instantly connect to a new spot or perp DEX. New DEX can only be confirmed after a 48-hour time-lock.

**NAV calculation** For each batch, the **bot** calls `updateNAV` on the contract with the NAV that will price mints and redemptions for that cycle. The figure is **not** recomputed inside Solidity: the contract records whatever value is submitted. In normal operations, that value is **derived automatically** from **on-chain balances** the contract exposes together with **perp PnL** from the perp DEX, so the update reflects custodied assets and open perp economics. A **compromised or buggy bot**, or misuse of the bot key, could still post a NAV that does not match a fair mark-to-market.  Each update is accompanied by on-chain parameters and **events** (`NAVProposedAndUpdated`, etc.), so the posted NAV and snapshot are **publicly auditable** after the fact. Replacing the single operator/bot key with a **multi-signature** or additional controls is on the roadmap to reduce this risk.

---

## Centralisation risk

Protocol operations — batch processing, capital deployment, and NAV updates — are currently performed by a single operator. A compromised or unavailable operator key could delay batch processing or mismanage capital.

**Planned improvements:** **Chainlink Automation** is planned so upkeep and batch processing can be invoked on a decentralised schedule, reducing reliance on a single always-online operator key and lowering the risk of missed batches due to downtime. Multi-signature control remains on the roadmap as well.

---

## Oracle risk

The value of your deposit at batch time is calculated using on-chain price feeds. If a price feed provides incorrect data, you could receive fewer KASH tokens than expected when depositing, or fewer assets when redeeming. Industry-standard oracle providers are used, but no price feed is entirely risk-free.

---

## No insurance

Funds deposited in KASH are not insured. There is no protocol-level insurance fund at this stage. Do not deposit more than you are willing to lose.

---