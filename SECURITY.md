# JobsAI security

This page explains how JobsAI handles job payments, who can act on a job, and what protections and limits are currently in place. JobsAI is an early release, and some protections found in mature payment services are not available yet.

## How job payments work

Each job has its own digital wallet. When a client funds a job, the payment goes to that wallet in the asset the client selected: ETH or USDG. JobsAI does not convert between them.

The JobsAI service holds the encrypted keys needed to send money out of those wallets. It sends payment to the worker after the client accepts the work, or sends a refund after an eligible cancellation or team decision. JobsAI also pays the network fees for these transfers from a separate company wallet.

This means payments rely on JobsAI's systems and key protection. No separate program on the blockchain controls when funds can move. If the service or its key storage were compromised, job funds could be at risk.

## Who can act on a job

- **Client:** Creates and funds a job, can cancel it before a worker claims it, reviews the work, requests changes, accepts it, or asks for a team review.
- **Worker:** Claims an available funded job, submits work and revisions, can return the job before submitting work, or asks for a team review.
- **JobsAI reviewer:** Signs in with an approved team wallet and the team password, reviews the job history, and chooses whether the payment goes to the worker or back to the client. The current version allows one reviewer to make that decision.

When a dispute is opened, the job is paused while it awaits review. The reviewer can consider the original task, requirements, submissions, revision requests, reason for the dispute, and job history.

JobsAI is developing an AI tool to help organize and compare those records. A person on the JobsAI team makes the decision. The AI tool is not connected to the live payment process and cannot send a payment or refund.

## Protections in place

- A client can cancel a funded job only before a worker claims it. This starts a refund to the client, which can take time to complete. After a worker claims the job, disagreements go through team review.
- One wallet can claim up to two active jobs at a time. An unsubmitted claim returns to the board after 24 hours by default, and the client can release the worker before a submission. Operators can change the expiry period. The wallet limit does not prevent someone from using multiple wallets.
- New jobs have a minimum amount of 0.001 ETH or 1 USDG by default. Operators can raise these minimums. This reduces very small jobs that cost more in network fees than they can reasonably support; it does not guarantee every job is economical.
- API requests are rate limited by client IP, and wallet sign-in requests have tighter limits by IP and wallet. Job creation is also capped per client wallet. These controls reduce automated bursts but do not stop distributed abuse.
- Before sponsoring an escrow transfer, the service checks that the gas wallet can cover the estimated sponsorship and remain above its configured reserve. If it cannot, settlement pauses before the sponsorship transaction is sent.
- Operators can set `PAUSE_NEW_WORK=true` to reject job creation, funding registration, and claims. Cancellation refunds, client acceptance, disputes, team review, and settlement processing remain available so existing work can finish. This API switch cannot stop someone from sending a wallet transaction directly to an escrow address.
- If a gas-wallet transaction stays pending beyond its configured wait, the service can replace it with a higher-fee transaction using the same nonce. Earlier signed transaction hashes are retained so a late confirmation is recognized.
- The service logs alerts when the gas wallet falls below the required reserve, a settlement reaches its fourth attempt, or a gas transaction is replaced. Set `OPS_ALERT_WEBHOOK_URL` to also send these structured events to an operations webhook; webhook delivery failures are logged and do not stop settlement processing.
- If a payout fails before a payout transaction is signed, the worker can replace the recipient wallet and retry. The protected team review queue can also resolve a failed payout by choosing the worker or client. Once a payout transaction has been signed, these recovery choices are locked to avoid sending a second payment.
- Only the client and assigned worker can take part in the job's normal actions. The service checks who is acting and whether the requested action is allowed at that point in the job.
- The service checks that a funding payment used the right network, payment type (ETH or USDG), amount, and job wallet before making the job available.
- Earlier submissions and job actions are kept in the job history. Private submission and dispute text is encrypted in the database.
- Team review requires an approved JobsAI reviewer wallet and the team password. Team-review access lasts up to eight hours in a browser session. Changing the team password ends existing team-review sessions. A copied sign-in token may remain usable until it expires.

## Planned reviewer approval for dispute payouts

The current release lets one authorized reviewer choose whether a disputed job pays the worker or refunds the client. Before JobsAI handles larger balances, the planned control is a 2-of-N approval from distinct reviewer wallets:

1. A first reviewer reads the complete job record and submits a proposed `pay_doer` or `refund_client` decision with a note. This proposal does not create a settlement or move funds.
2. A second reviewer, using a different approved wallet, independently reviews the same job history and either approves that exact outcome or rejects it. A reviewer cannot approve their own proposal.
3. The service creates the settlement only after two distinct reviewer approvals for the same outcome are recorded atomically with the job decision. A changed proposal clears prior approvals. Duplicate submissions cannot create a second settlement.
4. The audit record retains each reviewer wallet, decision, note, and timestamp. Reviewer-wallet changes are restricted to operators and recorded.

The approval threshold will fail closed if fewer than two eligible reviewer wallets are available: the dispute stays locked and no payout or refund is created until the required reviewers can act. Client acceptance and the existing pre-claim cancellation refund do not require dispute-review approval. This control is planned and is not implemented in the current release.

## Current limits

- A transfer can be delayed or fail. Failed payouts with no signed payout transaction can be retried by the worker with a replacement wallet or handled through team review. Other failures may need help from the JobsAI operations team.
- Sending the wrong asset, amount, network, or destination does not trigger an automatic refund. Check the payment details carefully before sending.
- JobsAI does not yet automatically return funds when a job sits untouched for too long, or automatically remove old job records. Submission records remain stored. Uploaded images follow the retention settings of JobsAI's image storage provider.
- No independent security firm has reviewed JobsAI yet. Payments are managed by the JobsAI service and are not governed by a separate blockchain payment contract.
- The one-wallet claim limit cannot stop someone from claiming jobs with several different wallets.

## Keeping accounts and funds safe

Use the Robinhood Chain test network while developing. JobsAI operators should keep service passwords, wallet keys, and encryption keys in the hosting provider's secure settings, use different keys for development and live systems, limit who can access payment systems, and watch for delayed transfers and low fee-wallet balances. Losing the encryption key could make funds in active jobs inaccessible.

## Report a security issue

Email **tryjobsai@atomicmail.io** with a clear description of the issue, where it occurs, and steps to reproduce it. Do not include private wallet keys or send transactions that move real funds.
