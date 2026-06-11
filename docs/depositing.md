# Depositing

Depositing into KASH mints KASH tokens that accrue yield over time.

---

## Before depositing

- Ensure the wallet is connected to the app on **Arbitrum One** (chain ID 42161)
- The wallet must hold ETH (for KASH-ETH) or wBTC (for KASH-BTC)
- A small amount of ETH is required for gas fees

---

## How deposits work

KASH uses a **batch system**. Deposits are not processed instantly. Instead:

1. A deposit request is submitted — this queues funds for the next batch
2. Once per day, the batch is processed (around **23:45 UTC**)
3. After processing completes, KASH tokens are sent to the depositor's wallet automatically — no claim step is needed

This means there is a **waiting period** between request submission and KASH token receipt. The wait is at most 24 hours.
**Minimum deposit:** the minimum deposit size is 10 USDC worth of ETH or wBTC.

---

## Batch wallet limit

Each batch cycle accepts at most **500 unique wallet addresses** for deposits. This is a hard on-chain limit (`MAX_MINT_USERS`).

- When the limit is reached, **new wallets** cannot submit a mint request for that cycle.
- A wallet that **already has a pending deposit** in the current cycle may add to its existing request.
- If a participant **cancels** before batch processing, that slot becomes available for another wallet.

The app shows how many mint slots are used in the current cycle (for example, `142/500 wallets`).

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

## Step-by-step: deposit ETH

1. Open the app and ensure the **ETH** tab is selected
2. Enter the amount of ETH to deposit in the **Deposit** form
3. Click **Deposit ETH**
4. Confirm the transaction in the wallet
5. Wait for the daily batch to process (by 23:59 UTC)
6. Click the "Add to wallet" link in the "Your KASH Balance" box to display KASH-ETH tokens in the wallet
7. A mint request may be cancelled at any time prior to the batch process run time; deposited ETH will be returned to the wallet

---

## Step-by-step: deposit wBTC

1. Open the app and select the **BTC** tab
2. Enter the amount of wBTC to deposit
3. On first use, **Approve** the contract to spend wBTC — confirm this transaction
4. Click **Deposit wBTC** and confirm the deposit transaction
5. Wait for the daily batch
6. Click the "Add to wallet" link in the "Your KASH Balance" box to display KASH-BTC tokens in the wallet
7. A mint request may be cancelled at any time prior to the batch process run time; deposited wBTC will be returned to the wallet

---

## What happens to funds during the batch?

Deposited ETH or wBTC is held in the smart contract until the batch runs. The protocol deploys the ETH or wBTC received in a yield strategy, then KASH tokens are minted at the latest NAV and sent to the depositor's wallet.

---

## Fees

There is a **0.05% fee (5 basis points)** on deposits and redemptions. This is deducted from the amount processed in each batch.

---

## Checking a position

After KASH tokens arrive, the following are visible in the app:

- **KASH balance** in the stats panel
- Current **NAV** — the USD value of each KASH token
- Total deposits in the **Deposits** card

---

## Minimum holding period

The minimum holding period is **one day** — a deposit in one batch may be redeemed in the next.

However, depositing for just one day is likely to result in a small **net loss**. Each time the protocol puts on or takes off its yield strategy (opening and closing positions across the lending and trading protocols), it incurs transaction fees. Over a single day, those costs will typically outweigh any funding rate income earned.

KASH is designed for **medium to long-term holding**. The longer the holding period, the more yield accrues relative to the one-time cost of entering and exiting the strategy.

---

## Next step

To exit a position, see [Redeeming](redeeming.md).
