# JobsAI backend

JobsAI's API uses Bun, Express, PostgreSQL, SIWE wallet sessions, and viem against Robinhood Chain. Each job gets a server-controlled EVM escrow wallet whose private key is encrypted in PostgreSQL with `DATA_ENCRYPTION_KEY`.

## Local setup

```sh
cd backend
cp .env.example .env
bun install
createdb jobsai # or point DATABASE_URL at an existing PostgreSQL database
bun run migrate
bun run dev
```

`RH_CHAIN_ID=46630` selects Robinhood Chain testnet; `4663` selects mainnet. Configure the USDG token address for that same network to enable USDG jobs; ETH jobs work without it. Keep `.env` out of source control.

## Job lifecycle

Create a job, send its exact ETH or USDG amount to the returned escrow address, then submit the funding transaction hash to `POST /v1/jobs/:id/fund`. Confirmed funding makes it claimable. The assigned doer can append submissions; the client can request repeated revisions or accept the latest submission. Either participant can open a dispute. An authorized team wallet reviews the full history and chooses `pay_doer` or `refund_client`.

Settlement is custodial: the service sponsors escrow transaction gas from `GAS_WALLET_PRIVATE_KEY`, pays the exact principal in the selected asset, then sweeps remaining escrow ETH back to the operator wallet. There is no conversion or price oracle. The settlement worker runs every 30 seconds; `POST /v1/cron/settle` with `Authorization: Bearer <CRON_SECRET>` can trigger reconciliation from a scheduler.

Back up the encryption key securely; losing it makes active escrow inaccessible. Restrict production access to the database and gas wallet, and use separate keys for each environment. This MVP needs operational monitoring and a security review before handling production funds.

## API outline

- `POST /v1/auth/nonce`, `/verify`, `/logout`; `GET /v1/auth/me`
- `POST /v1/jobs`; `GET /v1/jobs/ready`, `/mine`, `/:id`
- `POST /v1/jobs/:id/fund`, `/claim`, `/submissions`, `/revisions`, `/accept`, `/disputes`
- `GET /v1/jobs/:id/submissions`, `/:id/revisions`
- Team wallet: `GET /v1/team/disputes`, `/disputes/:jobId`; `POST /v1/team/disputes/:jobId/resolve`
- `GET /health`, `/health/ready`; scheduler: `POST /v1/cron/settle`
