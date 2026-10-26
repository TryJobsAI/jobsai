# JobsAI job and payment invariants

These rules describe conditions the API, settlement worker, and tests must preserve.

## Job assignment

- Only a funded `ready` job can be claimed, and its client cannot claim it.
- An unsubmitted `in_progress` claim is released after `CLAIM_EXPIRY_HOURS` (24 by default). The client may release that worker earlier.
- Releasing a claim clears the assigned worker and claim timestamp, returns the job to `ready`, and records an event. Jobs with a submission cannot be released this way.
- One wallet can hold no more active claims than `MAX_ACTIVE_CLAIMS_PER_WALLET`.

## Settlement outcome and recipient

- A `pay_doer` settlement pays the currently assigned worker. A `refund_client` settlement pays the client.
- A worker may change the recipient only for a failed `pay_doer` settlement and only before a payout transaction is signed.
- A team reviewer may resolve an eligible failed settlement to the worker or client. This decision updates both the outcome and recipient in one database transaction and records a review entry and event.
- Once a payout transaction is signed, neither participant nor a reviewer can redirect it or create a second payout.
- Before sponsoring gas, the service estimates required costs and keeps the configured gas-wallet reserve. A stuck gas-wallet transaction can be replaced at the same nonce; every signed attempt remains recorded so a late confirmation can be recognized.

## Review and history

- Client acceptance starts the worker payment. A dispute pauses the job until team review chooses payment or refund.
- Every submission and revision is retained in order. Settlement decisions and claim release or expiry are recorded in the job event history.
- ETH and USDG amounts remain denominated in the asset selected for that job. JobsAI does not convert them or use a price oracle.
