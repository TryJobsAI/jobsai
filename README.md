# JobsAI

JobsAI is building a clearer path from AI-assisted discovery to paid work. This repository contains the JobsAI website preview and the backend MVP for creating and completing funded jobs on Robinhood Chain.

> The current website is a product preview with fictional sample roles and local-only interactions. It is not a live job feed, does not submit applications, and is not connected to the backend API yet.

## Product direction

JobsAI is designed around a simple work lifecycle: a client defines and funds a job, an eligible doer claims it, the doer submits work, and the client accepts it for payment. Clients can request repeated revisions while preserving every submission. Either participant can open a dispute for JobsAI team review.

Jobs are denominated in ETH or USDG. The client chooses the asset and amount; the system does not convert between them or use a price oracle.

## What's in this repository

| Area | Contents |
| --- | --- |
| Website | Static HTML, CSS, and JavaScript product preview in `public/`, built into `dist/` |
| Backend | Bun, TypeScript, Express, PostgreSQL, SIWE wallet authentication, and Robinhood Chain transaction handling in `backend/` |
| Database | Initial schema and migration runner in `backend/db/` and `backend/src/db/` |
| Public sync | History-sanitizing mirror script in `scripts/sync-public.py` |

The backend MVP uses a server-controlled escrow wallet per job. Escrow keys are encrypted in the database. A JobsAI gas wallet sponsors settlement transactions. This is a custodial design; secure production key management and operational review are essential before handling production funds.

## Run the website preview

```sh
bun run build
bun run start
```

The website has no external package dependencies. The preview's sample interactions run locally in the browser.

## Run the backend locally

Use Robinhood Chain testnet (`RH_CHAIN_ID=46630`) during development. Configure PostgreSQL and the backend environment first:

```sh
cd backend
cp .env.example .env
bun install
createdb jobsai # or set DATABASE_URL to an existing PostgreSQL database
bun run migrate
bun run dev
```

Set real local values for the required secrets in `backend/.env`; do not commit that file. The backend currently runs independently of the static website preview.

## Core API

- Wallet sign-in: `POST /v1/auth/nonce`, `POST /v1/auth/verify`, `POST /v1/auth/logout`
- Jobs: `POST /v1/jobs`, `GET /v1/jobs/ready`, `GET /v1/jobs/mine`
- Funding and work: `POST /v1/jobs/:id/fund`, `/:id/claim`, `/:id/submissions`, `/:id/revisions`, `/:id/accept`
- Disputes: participant route `POST /v1/jobs/:id/disputes`; team routes `GET /v1/team/disputes`, `GET /v1/team/disputes/:jobId`, `POST /v1/team/disputes/:jobId/resolve`
- Health: `GET /health`, `GET /health/ready`

See [`backend/.env.example`](backend/.env.example) for the environment variable names and [`backend/src/jobs.ts`](backend/src/jobs.ts) for the current route behavior.

## Backend container

The GitHub Actions workflow in `.github/workflows/backend.yml` type-checks the backend, builds the container on pull requests, and publishes it to GitHub Container Registry when changes reach `main` on `TryJobsAI/jobsai`:

```text
ghcr.io/tryjobsai/jobsai-backend:latest
ghcr.io/tryjobsai/jobsai-backend:<commit-sha>
```

The image contains the API and database migrations. Supply backend environment variables through the runtime platform; credentials are not included in the image.

## Dual repository sync

`origin` is the private repository and `public-origin` is the public JobsAI repository. To publish the current `main` branch to both:

```sh
bun run push:all
```

The public sync rewrites commit identities to `JobsAI <tryjobsai@atomicmail.io>` while preserving the source branch and its commit messages apart from co-author trailers.
