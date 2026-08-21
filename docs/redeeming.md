# Redeeming

Redeeming converts KASH tokens back into ETH or wBTC, capturing any yield that has accrued since deposit.

---

## How redemptions work

Like deposits, redemptions go through the **daily batch**:

1. A redemption request is submitted, specifying how many KASH tokens to redeem
2. KASH tokens are locked in the contract until the batch runs
3. At the next batch (around **23:59 UTC**), KASH is burned and the redeem amount becomes claimable

After settlement, use the app's **Claim** button to receive ETH or wBTC.  **Redeemed tokens must be claimed within 30 days**

---

## Batch wallet limit

Each batch cycle accepts at most **10,000 unique wallet addresses** for redemptions through the app, configurable in the contract up to a maximum of 100,000 addresses.

- When the limit is reached, **new wallets** cannot submit a redemption request for that cycle in the app.
- A wallet that **already has a pending redemption** in the current cycle may add to its existing request.
- If a participant **cancels** before batch processing, that slot becomes available for another wallet.

The app shows batch capacity for the current cycle as a status indicator: **Available**, **Mostly full**, **Almost full**, or **Full**.

Mint and redeem limits are tracked **separately** — a full mint batch does not block redemptions, and vice versa.

---

## Batch timing and capacity

Batch **cycle length** and **processing windows** are configurable by the operator to accommodate demand.

At launch, the schedule is:

| Phase | Time (UTC) |
|-------|-------------------|
| User window Open | Submissions accepted throughout the cycle (e.g. until ~23:40) |
| Processing window | Batch runs (~23:40–23:59), submissions not accepted |

If demand grows, cycles may be shortened or scheduling updated so more batches run per day. Confirm the live schedule in the app before submitting a request.

---

## Yield on exit

On redemption, assets are returned based on the **current NAV** at the time of the batch. Because NAV increases as the protocol earns yield, the redemption value should typically exceed the original deposit value.

Redeeming involves costs — including the **protocol fee** and the shared costs of unwinding the yield strategy during the batch — so the amount you receive is **NAV minus costs**, not the full gross NAV value.

**Example:**
- A deposit of 1 ETH when KASH-ETH NAV = $1.00 → 1,800 KASH received
- Redemption when KASH-ETH NAV = $1.06 → ETH worth 1,800 × $1.06 / ETH price

Yield is the difference in NAV between entry and exit.

---

## Step-by-step: redeem

1. Open the app and select the correct tab (ETH or BTC)
2. In the **Redeem Assets** form, enter the amount of KASH tokens to redeem
3. If prompted, click **Approve KASH** and sign in your wallet to approve to spend the KASH tokens
4. Click **Submit Redeem Request** and confirm the transaction
5. Wait for the daily batch (by 23:59 UTC)
6. Click **Claim** after settlement to receive your ETH or wBTC

---

## Partial redemptions

Any portion of a KASH balance may be redeemed. A full exit is not required.

---

## Timing

During the **processing window** (~23:40 UTC until the end of the cycle), mint and redeem requests are **suspended** — `requestMint` and `requestRedeem` revert with `UserWindowClosed`. Nothing is queued automatically.

To redeem in the **current day's batch**, submit before **23:40 UTC**. If you miss that cutoff, wait until the **next cycle** opens (typically 00:00 UTC), then submit a new redemption request for that batch.

---

## Fees

The same **0.05% fee (5 basis points)** applies to redemptions. This is deducted during batch processing.

---

## Cancelling a redemption request

A pending redemption request may be cancelled as long as the batch for that day **has not yet been processed**. KASH tokens are returned to the wallet immediately on cancellation.

To cancel, click the **Cancel Redeem Request** button in the app (visible when a pending request exists), or find the pending transaction in the Recent Activity panel and click **Cancel redeem**.

Once the daily batch has run (~23:59 UTC), the request can no longer be cancelled.
