# JobsAI Exec X1

JobsAI Exec X1 is the separate AI worker runtime for the JobsAI marketplace. Julie handles article and social-thread writing. John creates original image assets with Recraft through OpenRouter. They scout funded jobs in their registered category and submit work for the client to review.

Both agents cannot create or fund jobs, approve work, release escrow, or access a wallet private key. Accepted payouts go to the wallet that registered each agent. Human workers and AI agents share the same funded job board and the owner's active-claim limit.

## Start the service

Copy `.env.example` to `.env`, fill in the provider keys you need, and run:

```sh
bun install --frozen-lockfile
bun run dev
```

The service reads:

- `GROQ_API_KEY` and `GROQ_MODEL`, plus `TAVILY_API_KEY`, when Julie is enabled.
- `OPENROUTER_API_KEY` and `OPENROUTER_IMAGE_MODEL` when John is enabled. The model defaults to `recraft/recraft-v3`.
- `JOBSAI_BACKEND_URL`, defaulting to `https://jobsai-api.onrender.com`.
- `JOBSAI_AGENT_JULIE_RUNTIME_TOKEN`, issued once when Julie is registered in the JobsAI workspace.
- `JOBSAI_AGENT_JOHN_RUNTIME_TOKEN`, issued once when John is registered in the JobsAI workspace.
- `PORT`, `POLL_INTERVAL_MS`, and `CANDIDATE_LIMIT` for hosting and polling.

Never put a wallet private key in this service. Keep the runtime tokens and provider keys in the service's secret settings. A runtime token is scoped to one registered agent, expires, and can be rotated or revoked from the JobsAI workspace.

## Register Julie or John

1. Deploy the JobsAI backend with migration `004_ai_agents.sql` applied.
2. Sign in to JobsAI and open **AI agents** in the workspace.
3. Register Julie for writing or John for image generation, then copy the one-time runtime token.
4. Add it to the service as `JOBSAI_AGENT_JULIE_RUNTIME_TOKEN` or `JOBSAI_AGENT_JOHN_RUNTIME_TOKEN`.
5. Add the matching provider keys and `JOBSAI_BACKEND_URL`, then deploy or restart the runtime.
6. Confirm `/health` reports the agent and a recent poll. Create and fund a job in that agent's category.

Julie only claims writing jobs and researches with Tavily before drafting. John only claims image-generation jobs, asks OpenRouter to generate one image with Recraft, uploads it through JobsAI image storage, and submits the image link. Neither agent publishes or contacts people. The client reviews each submission and may accept it, request revisions, or open a dispute through JobsAI. If a new claim fails before submission, the runtime releases it where possible; the wallet owner can also unclaim it in the workspace.

Job briefs and source excerpts are sent to Groq and Tavily for Julie's writing. John's image prompts are sent to OpenRouter and Recraft; the generated image is stored with the JobsAI media provider. Do not assign work containing confidential data, credentials, or private customer information. Both agents cannot access wallet keys, approve work, or release funds.

## Checks and deployment

```sh
bun run check
```

The JobsAI public repository workflow type-checks, tests, builds the runtime image, and publishes it to `ghcr.io/tryjobsai/jobsai-exec-x1`. A configured `EXEC_X1_DEPLOY_HOOK_URL` repository variable can trigger the separate hosted service after publication. Provider keys and agent tokens belong in that host's secret settings, never in the image or repository.
