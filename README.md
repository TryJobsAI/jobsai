# JobsAI

**Your AI for work.** JobsAI brings career support and paid, clearly scoped work together: explore opportunities, prepare with confidence, and get AI-assisted work done against requirements you can review.

<p align="center">
  <video src="public/hero-city-original.mp4" width="100%" autoplay muted loop playsinline controls aria-label="JobsAI city hero video"></video>
</p>

<p align="center">
  <a href="https://github.com/TryJobsAI/jobsai/actions/workflows/backend.yml"><img src="https://github.com/TryJobsAI/jobsai/actions/workflows/backend.yml/badge.svg" alt="Backend workflow"></a>
  <img src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white" alt="Bun runtime">
  <img src="https://img.shields.io/badge/chain-Robinhood%20Chain-ccff00" alt="Robinhood Chain">
  <img src="https://img.shields.io/badge/job%20assets-ETH%20%7C%20USDG-627eea" alt="ETH and USDG job assets">
</p>

JobsAI makes work easier to start and clearer to finish. Clients set the scope, acceptance criteria, and payment amount. A doer claims the funded job, submits work, and can respond to requested revisions. The client releases payment on acceptance; disputes pause the job for team review.

Each job uses ETH or USDG from start to finish. The client chooses the asset and amount; JobsAI does not convert currencies or use a price oracle.

## Explore JobsAI

- **Career workspace:** Explore interactive job discovery, application preparation, interview practice, and progress tracking.
- **Funded work board:** Browse available funded jobs and claim one with an EVM wallet.
- **Escrow lifecycle:** Create and fund jobs, track submissions and revisions, accept delivery for settlement, or resolve a dispute through the team API.
- **Robinhood Chain:** Backend transactions use the configured Robinhood Chain network. The included development setup defaults to testnet.

The website is an interactive product experience, and the backend exposes the complete job lifecycle. Career accounts, employer feeds, AI generation, and career payments are not connected yet. The current web app connects the funded work board and wallet claim flow; the other job management actions are available through the API while their web screens are being built.

## Run locally

### Website

```sh
bun run build
bun run start
```

Open the local URL printed by the server. The frontend has no external package dependencies. Its same-origin `/api/jobsai` route forwards requests to the backend at `https://jobsai-api.onrender.com`. Vercel handles this with an external rewrite; the local server uses the same proxy path during development.

### Backend

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

## Job lifecycle API

Wallet authentication uses SIWE. Authenticated clients and doers can use these routes:

| Action | Endpoint |
| --- | --- |
| Sign in | `POST /v1/auth/nonce`, `POST /v1/auth/verify` |
| Create and fund a job | `POST /v1/jobs`, `POST /v1/jobs/:id/fund` |
| Find and claim work | `GET /v1/jobs/ready`, `POST /v1/jobs/:id/claim` |
| Submit and revise | `POST /v1/jobs/:id/submissions`, `POST /v1/jobs/:id/revisions` |
| Accept and pay | `POST /v1/jobs/:id/accept` |
| Open a dispute | `POST /v1/jobs/:id/disputes` |
| Review and resolve disputes | `GET /v1/team/disputes`, `GET /v1/team/disputes/:jobId`, `POST /v1/team/disputes/:jobId/resolve` |
| Check service health | `GET /health`, `GET /health/ready` |

See [`backend/src/jobs.ts`](backend/src/jobs.ts) for route behavior and [`backend/src/settlement.ts`](backend/src/settlement.ts) for settlement handling.

## Escrow and operations

The MVP creates a server-controlled escrow wallet for each job, stores encrypted escrow keys in the database, and uses a JobsAI-funded gas wallet to sponsor transactions. This is a custodial architecture. Use testnet during development and complete production key management and operational review before handling production funds.

## Backend container

The GitHub Actions workflow type-checks the backend and builds its container. On pushes to `main`, it publishes:

```text
ghcr.io/tryjobsai/jobsai-backend:latest
ghcr.io/tryjobsai/jobsai-backend:<commit-sha>
```

Provide runtime secrets through the deployment platform; the image does not contain credentials.
