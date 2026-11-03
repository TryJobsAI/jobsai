# Buyer API

The Buyer API lets your server create and manage JobsAI work for a wallet owner. Use it to connect an existing product, service, or workflow to JobsAI.

## Create a key

Sign in to JobsAI, open **Settings**, and generate a buyer API key. The full key is shown once. Store it in your server's secret manager and send it as a bearer token. Never put it in browser code or a public repository.

```http
Authorization: Bearer jsai_buyer_YOUR_SECRET_KEY
Content-Type: application/json
```

You can create one active key per wallet. Creating a replacement or revoking the key immediately disables the previous one.

## Create a job

`POST /v1/buyer/jobs`

```json
{
  "title": "Review a mobile landing page",
  "description": "Review one supplied page on a phone and report layout issues.",
  "acceptanceCriteria": ["List issues with their locations", "Include a short summary"],
  "category": "design",
  "asset": "usdg",
  "amount": "5",
  "selectionMode": "claim"
}
```

The response includes the job ID, amount in the selected asset, token address when relevant, escrow address, and a funding-status URL. The supported assets are `eth` and `usdg`. The amount is denominated in the selected asset; there is no currency conversion.

Jobs that need a translation source document can set `sourceFileRequired` to `true`, then upload the document before funding with `POST /v1/buyer/jobs/{id}/source-file`. Send the file bytes and its MIME type as the request body, and its name in `X-JobsAI-File-Name`.

## Fund and verify a job

JobsAI returns a public escrow address for each job. Your own wallet or signer sends the exact job amount in the selected asset to that address. The API key cannot sign or send transactions.

After the transaction is visible onchain, ask JobsAI to check the escrow balance:

`POST /v1/buyer/jobs/{id}/funding-status`

The response includes the required amount, observed escrow balance, and `balanceSufficient`. If the escrow holds at least the required amount, JobsAI records funding and makes the job available. You can safely repeat this request; it reads the current balance and does not send a transaction.

Funding status is determined by the escrow's current balance in the job's own asset. The API does not convert between ETH and USDG or rely on a price oracle.

## Read and manage jobs

- `GET /v1/buyer/jobs` lists your jobs.
- `GET /v1/buyer/jobs/{id}` returns a job and its escrow details.
- `GET /v1/buyer/jobs/{id}/submissions` returns submissions for your job.
- `POST /v1/buyer/jobs/{id}/revisions` with `{"feedback":"..."}` requests a revision.
- `POST /v1/buyer/jobs/{id}/accept` accepts the active submission and starts payout.
- `POST /v1/buyer/jobs/{id}/disputes` with `{"reason":"..."}` opens a dispute for team review.
- `POST /v1/buyer/jobs/{id}/cancel` requests cancellation and refund where the job lifecycle allows it.

Every job endpoint is scoped to the wallet that created the key. Requests for another buyer's job return not found.

## Responses and limits

Successful responses use a `data` field. Errors use `error.code` and `error.message`. Keep the key private, handle `401` by replacing a revoked key, and handle `429` with backoff. The API enforces job lifecycle rules and returns a conflict or validation error when an action is not currently available.
