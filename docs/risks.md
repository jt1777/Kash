# Risks

KASH is an experimental protocol on testnet. Before using it with real funds on mainnet, you should understand the risks involved.

> **Important:** KASH has not been audited. Do not use with real funds until a full audit is completed.

---

## Smart contract risk

The protocol is governed entirely by smart contracts. If there is a bug in the code, funds could be lost or locked. Mitigations in place:

- All user-facing functions are protected against reentrancy attacks
- Ownership transfer requires two steps — the new owner must explicitly accept
- New exchange adapters require a 48-hour waiting period before they can be activated (preventing a compromised key from instantly routing funds to a malicious contract)
- An emergency pause function exists that can halt all user activity

**What you can do:** Review the contract addresses on Arbiscan and verify they match what is displayed in the app footer.

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

The yield strategy depends on the lending protocol and perp DEX continuing to function correctly. Risks include:

- Exchange downtime or insolvency
- Smart contract vulnerabilities in third-party protocols
- Regulatory actions affecting either platform

---

## Safeguards against owner misconduct

A common concern with DeFi protocols is whether the contract owner could misuse their privileges to steal user funds. Several safeguards are built into the KASH contracts to limit this:

**Pending deposits are ring-fenced.** When you submit a deposit, your ETH is tracked in a reserved balance on-chain. The owner's ETH withdrawal function can only access ETH that is *above and beyond* what is reserved for all pending user requests. The contract enforces this automatically — any attempt to withdraw reserved funds reverts. Your queued deposit cannot be taken by the owner.

**Users can self-rescue if the contract is paused.** If the contract is ever paused, you can reclaim your pending ETH deposit or pending KASH tokens directly from the contract, without any involvement from the owner. These functions bypass the owner entirely. Note: accessing them requires interacting with the contract directly (e.g. via the "Write Contract" tab on Arbiscan) rather than through the app UI — this is somewhat technical but does not require coding skills.

**New exchange integrations require a 48-hour waiting period.** The owner cannot instantly swap in a new exchange adapter and redirect funds to it. Every new adapter must be proposed and then confirmed after a 48-hour delay.

**Ownership transfer requires acceptance by the new address.** The new owner must explicitly accept the transfer. This prevents accidental transfers to mistyped or inaccessible addresses — but does not prevent an intentional transfer to a malicious address. It is a protection against mistakes, not malice.

**What remains a trust assumption.** The owner submits the daily NAV update that determines how many KASH tokens depositors receive. While all protocol assets are held in on-chain contracts, the NAV is not calculated automatically — the operator computes the full portfolio value (collateral, perp positions, accrued funding) and submits it manually. A dishonest operator could submit an unfavourable NAV, which would benefit or disadvantage users at the batch level. All NAV updates are visible on-chain, so any manipulation would be publicly auditable after the fact. Replacing the single operator with a multi-signature wallet is on the roadmap to reduce this risk.

---

## Centralisation risk

Protocol operations — batch processing, capital deployment, and NAV updates — are currently performed by a single operator. A compromised or unavailable operator key could delay batch processing or mismanage capital.

**Planned improvements:** Multi-signature control and decentralised batch triggering are on the roadmap.

---

## Oracle risk

The value of your deposit at batch time is calculated using on-chain price feeds. If a price feed provides incorrect data, you could receive fewer KASH tokens than expected when depositing, or fewer assets when redeeming. Industry-standard oracle providers are used, but no price feed is entirely risk-free.

---

## No insurance

Funds deposited in KASH are not insured. There is no protocol-level insurance fund at this stage. Do not deposit more than you are willing to lose.

---

## Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| Smart contract bug | High | Audit planned; reentrancy guards; emergency pause |
| Negative funding rates | Medium | Conservative LTV; strategy designed for bull cycles |
| Lending protocol liquidation | Medium | LTV capped at ~65%; positions naturally hedge; daily monitoring |
| Exchange failure | Medium | Emergency withdrawal path exists |
| Operator key compromise | Medium | 48h timelock on adapter changes; two-step ownership |
| Oracle failure | Low | Staleness checks on price feeds |
