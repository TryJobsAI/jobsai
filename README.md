# JobsAI

**Your AI for work.** JobsAI gives clients and workers a clear way to agree on a task, fund it, deliver the work, and complete payment.

<p align="center">
  <video src="public/hero-city-original.mp4" width="100%" autoplay muted loop playsinline controls aria-label="JobsAI city hero video"></video>
</p>

<p align="center">
  <a href="https://github.com/TryJobsAI/jobsai/actions/workflows/backend.yml"><img src="https://github.com/TryJobsAI/jobsai/actions/workflows/backend.yml/badge.svg" alt="Backend workflow"></a>
  <img src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white" alt="Bun runtime">
  <img src="https://img.shields.io/badge/chain-Robinhood%20Chain-ccff00" alt="Robinhood Chain">
  <img src="https://img.shields.io/badge/job%20assets-ETH%20%7C%20USDG-627eea" alt="ETH and USDG job assets">
</p>

Clients describe the work, explain what counts as a good result, choose a payment amount, and fund the job. A worker claims the job, submits the work, and can make revisions when requested. The client reviews the result and accepts it to release payment. If there is a disagreement, either side can ask the JobsAI team to review the job history before any payment or refund is made.

The client chooses whether to pay in ETH or USDG and sets the amount. That same asset is used for the payment or refund. JobsAI does not exchange one asset for the other.

## Explore JobsAI

- **Create and fund a task:** Clients describe the work, explain what's required, choose ETH or USDG, and set the amount before funding the job.
- **Find and claim work:** Workers browse funded jobs and claim work that fits them. A worker can return a claimed job before submitting any work. An unsubmitted claim expires after 24 hours by default, and clients can release the worker sooner.
- **Submit and revise:** Workers can submit work and respond to revision requests. Earlier submissions stay in the job history.
- **Review and pay:** The client accepts completed work to start payment to the worker.
- **Cancel or request a review:** Before anyone claims the job, the client can cancel and request a refund. If a disagreement happens after a claim, the job pauses for team review.

The live dashboard supports the funded task flow from creation through payment or dispute review. Career accounts, employer listings, AI-generated applications, and career-related payments are not connected to live services.

JobsAI is developing an AI tool to help reviewers organize the task brief, requirements, submissions, revision requests, and job history when looking into a dispute. A team reviewer makes the decision. This tool is not connected to the live payment process.

## For developers

### Run the website locally

```sh
bun install
bun run build
bun run start
```

Open the local URL printed by the server. The `/auth.html` entry connects a wallet through RainbowKit, signs the JobsAI login message, and opens the dashboard with that wallet session. The workspace uses RainbowKit and Wagmi on Robinhood Chain. Set `VITE_WALLETCONNECT_PROJECT_ID` in your local environment and Vercel project settings for WalletConnect support. The same-origin `/api/jobsai` route forwards requests to the backend at `https://jobsai-api.onrender.com`. Vercel handles this with an external rewrite; the local server uses the same proxy path during development.

### Run the backend locally

Use Robinhood Chain testnet (`RH_CHAIN_ID=46630`) while developing. Configure PostgreSQL and backend environment values first:

```sh
cd backend
cp .env.example .env
bun install
createdb jobsai # or set DATABASE_URL to an existing PostgreSQL database
bun run migrate
bun run dev
```

Keep real secrets in `backend/.env`; do not commit that file. See [`backend/.env.example`](backend/.env.example) for the full environment variable list.

### Run backend tests

From `backend`, run the type check and unit tests:

```sh
bun run check
bun test
```

PostgreSQL route tests and Anvil settlement tests are opt-in with `JOBSAI_DB_INTEGRATION=1`; the chain suite also needs `JOBSAI_ANVIL_INTEGRATION=1`. They require `DATABASE_URL` to point to a disposable database whose name includes `test`; they run migrations and create/delete their own fixture rows. Never use a production or shared database. GitHub Actions provisions an isolated PostgreSQL 16 database and local Anvil chain for CI.

To run the database route tests locally, start an isolated PostgreSQL database:

```sh
docker run --rm --detach --name jobsai-test-postgres \
  --env POSTGRES_USER=jobsai \
  --env POSTGRES_PASSWORD=jobsai \
  --env POSTGRES_DB=jobsai_test \
  --publish 5432:5432 postgres:16
```

Then, from `backend`, set the test database and opt-in flag when running Bun. Your `backend/.env` must also contain valid test values for the required backend configuration, including `AUTH_TOKEN_PEPPER`, `DATA_ENCRYPTION_KEY`, `GAS_WALLET_PRIVATE_KEY`, `CRON_SECRET`, `JOBSAI_TEAM_PASSWORD`, and `TEAM_WALLET_ADDRESSES`. The PostgreSQL route suite uses a local RPC URL (`http://127.0.0.1:8545`) and does not call it. The Anvil suite sends test transactions only to a local chain: install Foundry, start Anvil with chain ID `46630`, and deploy the local mock token from `backend`:

```sh
anvil --chain-id 46630 --host 127.0.0.1 --port 8545 --accounts 10 --balance 10000
# In another terminal, from backend:
forge create contracts/MockUSDG.sol:MockUSDG \
  --rpc-url http://127.0.0.1:8545 \
  --private-key "$ANVIL_TEST_PRIVATE_KEY" \
  --broadcast --json
```

Set `ANVIL_TEST_PRIVATE_KEY` to one of the test-only keys printed by your local Anvil process. Set `USDG_TOKEN_ADDRESS` to the printed `deployedTo` address and use the matching local-chain test settings (`RH_CHAIN_ID=46630`, `RH_CONFIRMATIONS=1`). Then enable both flags when running the test suite. The Anvil integration run also enforces at least 85% line coverage for `src/settlement.ts`.

```sh
DATABASE_URL=postgresql://jobsai:jobsai@127.0.0.1:5432/jobsai_test \
JOBSAI_DB_INTEGRATION=1 \
RH_CHAIN_ID=46630 \
RH_RPC_URL=http://127.0.0.1:8545 \
GAS_WALLET_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 \
bun test
```

To include the Anvil settlement case after starting Anvil and deploying the local mock token, add `JOBSAI_ANVIL_INTEGRATION=1`, `RH_CONFIRMATIONS=1`, and your Anvil-only `ANVIL_TEST_PRIVATE_KEY` to that command.

Stop the isolated database afterward with `docker stop jobsai-test-postgres`. Ordinary `bun test` skips the database route tests unless `JOBSAI_DB_INTEGRATION=1` is explicitly set.

### Job lifecycle API

Wallet authentication uses SIWE. Authenticated clients and workers can use these routes:

| Action | Endpoint |
| --- | --- |
| Sign in | `POST /v1/auth/nonce`, `POST /v1/auth/verify` |
| Create and fund a job | `POST /v1/jobs`, `POST /v1/jobs/:id/fund` |
| Cancel a funded job before it is claimed | `POST /v1/jobs/:id/cancel` |
| Find and claim work | `GET /v1/jobs/ready`, `POST /v1/jobs/:id/claim`, `POST /v1/jobs/:id/unclaim`, `POST /v1/jobs/:id/release-worker` |
| Submit and revise | `POST /v1/jobs/:id/submissions`, `POST /v1/jobs/:id/revisions` |
| Accept and pay | `POST /v1/jobs/:id/accept` |
| Open a dispute | `POST /v1/jobs/:id/disputes` |
| Review and resolve disputes | `GET /v1/team/disputes`, `GET /v1/team/disputes/:jobId`, `POST /v1/team/disputes/:jobId/resolve` |
| Check service health | `GET /health`, `GET /health/ready` |

See [`backend/src/jobs.ts`](backend/src/jobs.ts) for route behavior and [`backend/src/settlement.ts`](backend/src/settlement.ts) for settlement handling.

Workers can hold at most `MAX_ACTIVE_CLAIMS_PER_WALLET` active jobs at once. The default is two. Claims are serialized per wallet so concurrent requests cannot bypass this limit. A claim with no submission expires after 24 hours by default; clients can release a worker sooner.

### AI workers

AI workers can be registered from the signed-in workspace with a name, description, work categories, and skills. Connect each one to a service that can find and complete matching funded jobs. The client reviews every submission before accepting payment. The wallet owner can take over while work is in progress or after a revision is requested.

AI and human workers use the same funded jobs and per-wallet claim limit. Accepted funds are paid to the wallet that registered the AI worker. The worker service cannot approve work or release escrow. Job briefs may be sent to the model, search, or storage services selected by the worker's owner, so do not include confidential information.

See the guides for [building an AI worker](https://www.tryjobsai.com/docs/building-an-ai-worker-runtime.md) and [connecting it to JobsAI](https://www.tryjobsai.com/docs/connecting-an-ai-worker-to-jobsai.md).

Operators can set `PAUSE_NEW_WORK=true` to pause job creation, funding registration, and claims while existing refunds, acceptances, disputes, reviews, and settlements continue. Configure `OPS_ALERT_WEBHOOK_URL` to receive alerts for low gas-wallet reserves, a settlement's fourth attempt, and gas transaction replacements. The service logs these events even when no webhook URL is configured. Pausing the API cannot prevent a user from sending a wallet transaction directly to an escrow address.

### How payments are handled

The MVP creates a dedicated escrow wallet for each job. Its encrypted signing key is managed by the backend service, and a JobsAI-funded gas wallet sponsors settlement transactions. This setup depends on protecting the service and its keys. Use testnet during development and complete production key management and operational review before handling production funds.

See [`SECURITY.md`](SECURITY.md) for the security model, known limits, operational responsibilities, and disclosure contact.

## Backend container

The GitHub Actions workflow type-checks the backend and builds its container. On pushes to `main`, it publishes:

```text
ghcr.io/tryjobsai/jobsai-backend:latest
ghcr.io/tryjobsai/jobsai-backend:<commit-sha>
```

Provide runtime secrets through the deployment platform; the image does not contain credentials.
