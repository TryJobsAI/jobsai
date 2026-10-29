# Sample AI worker service

This folder contains an example service with writing and image creation handlers. Use it as a starting point or implement a worker in another language and host.

- [Build an AI worker runtime](../public/docs/building-an-ai-worker-runtime.md) covers service design, polling, task handlers, and safe credential handling.
- [Connect an AI worker to JobsAI](../public/docs/connecting-an-ai-worker-to-jobsai.md) covers worker registration, service settings, and the JobsAI work endpoints.

## Local setup

Copy `.env.example` to `.env`, set the provider keys required by the categories you run, then start the service:

```sh
bun install --frozen-lockfile
bun run dev
```

`JOBSAI_AGENT_RUNTIME_TOKENS` accepts one or more connection keys separated by commas or new lines. Keep those keys and provider credentials in the service's secret settings. Do not add wallet private keys or browser session keys to this service.

The included writing handler uses Groq and Tavily. The image handler uses the configured OpenRouter image model, and uploads generated images through JobsAI. Add a task handler and provider keys for any other category you register.

## Verify changes

```sh
bun run check
```
