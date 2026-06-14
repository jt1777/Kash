# Redeeming

Redeeming converts KASH tokens back into ETH or wBTC, capturing any yield that has accrued since deposit.

---

## How redemptions work

Like deposits, redemptions go through the **daily batch**:

1. A redemption request is submitted, specifying how many KASH tokens to redeem
2. KASH tokens are locked in the contract until the batch runs
3. At the next batch (around **23:59 UTC**), KASH is burned and the redeem amount becomes claimable

After settlement, use the app's **Claim** button to receive ETH or wBTC. The claim uses a Merkle proof published for the processed batch.

---

## Batch wallet limit

Each batch cycle accepts at most **500 unique wallet addresses** for redemptions. This is a hard on-chain limit (`MAX_REDEEM_USERS`).

- When the limit is reached, **new wallets** cannot submit a redemption request for that cycle.
- A wallet that **already has a pending redemption** in the current cycle may add to its existing request.
- If a participant **cancels** before batch processing, that slot becomes available for another wallet.

The app shows how many redeem slots are used in the current cycle (for example, `142/500 wallets`).

Mint and redeem limits are tracked **separately** — a full mint batch does not block redemptions, and vice versa.

---

## Batch timing and capacity

Batch **cycle length** and **processing windows** are configurable on-chain to accommodate demand. The operator can adjust parameters such as `cycleDurationSeconds` and the user vs processing windows.

At launch, the typical schedule is:

| Phase | Typical time (UTC) |
|-------|-------------------|
| User window | Submissions accepted throughout the cycle (e.g. until ~23:45) |
| Processing window | Batch runs (~23:45–23:59) |

If demand grows, cycles may be shortened or scheduling updated so more batches run per day. Confirm the live schedule in the app before submitting a request.

---

## Yield on exit

On redemption, assets are returned based on the **current NAV** at the time of the batch. Because NAV increases as the protocol earns yield, the redemption value typically exceeds the original deposit value.

**Example:**
- A deposit of 1 ETH when KASH-ETH NAV = $1.00 → 1,800 KASH received
- Redemption when KASH-ETH NAV = $1.06 → ETH worth 1,800 × $1.06 / ETH price

Yield is the difference in NAV between entry and exit.

---

## Step-by-step: redeem

1. Open the app and select the correct tab (ETH or BTC)
2. In the **Redeem** form, enter the amount of KASH tokens to redeem
3. If prompted, **Approve** the contract to spend KASH tokens
4. Click **Redeem** and confirm the transaction
5. Wait for the daily batch (by 23:59 UTC)
6. Click **Claim** after settlement to receive ETH or wBTC

---

## Partial redemptions

Any portion of a KASH balance may be redeemed. A full exit is not required.

---

## Timing

Redemption requests submitted **after the batch starts** (~23:45 UTC) will be queued for the **following day's batch**. Requests must be submitted before 23:45 UTC to be included in the current day's batch.

---

## Fees

The same **0.05% fee (5 basis points)** applies to redemptions. This is deducted during batch processing.

---

## Cancelling a redemption request

A pending redemption request may be cancelled as long as the batch for that day **has not yet been processed**. KASH tokens are returned to the wallet immediately on cancellation.

To cancel, click the **Cancel Redeem Request** button in the app (visible when a pending request exists), or find the pending transaction in the Recent Activity panel and click **Cancel redeem**.

Once the daily batch has run (~23:59 UTC), the request can no longer be cancelled.
