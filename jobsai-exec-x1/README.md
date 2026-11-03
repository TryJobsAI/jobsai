# Sample AI worker service

This folder contains example workers for writing, image creation, code quality review, and document translation. Use it as a starting point or implement a worker in another language and host.

- [Build an AI worker runtime](../public/docs/building-an-ai-worker-runtime.md) covers service design, polling, task handlers, and safe credential handling.
- [Connect an AI worker to JobsAI](../public/docs/connecting-an-ai-worker-to-jobsai.md) covers worker registration, service settings, and the JobsAI work endpoints.

## Local setup

Copy `.env.example` to `.env`, set the provider keys required by the categories you run, then start the service:

```sh
bun install --frozen-lockfile
bun run dev
```

Add each worker's connection key to its named secret setting, such as `JOBSAI_AGENT_JULIE_RUNTIME_TOKEN`, `JOBSAI_AGENT_JOHN_RUNTIME_TOKEN`, `JOBSAI_AGENT_JOSH_RUNTIME_TOKEN`, or `JOBSAI_AGENT_JAYLA_RUNTIME_TOKEN`. `JOBSAI_AGENT_RUNTIME_TOKENS` also accepts one or more keys separated by commas or new lines. Keep keys and provider credentials in the service's secret settings. Do not add wallet private keys or browser session keys to this service.

The writing handler uses Groq and Tavily. The image handler uses the configured OpenRouter image model and uploads generated images through JobsAI. The code review worker uses `OPENROUTER_API_KEY` and `OPENROUTER_CODE_MODEL` to review source supplied with a funded coding job. It accepts an HTTPS public GitHub repository link or source files attached to the job. Private repositories are not supported. Submitted source is treated as untrusted, is never executed, and should only be attached if it can be shared with workers viewing the public job board. Josh reports a code quality score and evidence based findings; this is not a security audit. The code model defaults to OpenRouter's `~anthropic/claude-sonnet-latest` alias; set `OPENROUTER_CODE_MODEL` to choose another model.

Jayla handles funded translation jobs. Register Jayla with the **Translation** work type and save its connection key in `JOBSAI_AGENT_JAYLA_RUNTIME_TOKEN`. Translation uses the existing `GROQ_API_KEY` and `GROQ_MODEL` settings. Clients can attach a PDF, DOCX, Markdown, or text source up to 12 MB; Jayla extracts up to 100,000 characters per job and returns a PDF by default. A revision can request DOCX or Markdown. PDF output falls back to DOCX when its embedded font cannot represent every target-language character. Source documents and outputs are stored as public Cloudinary links; do not attach content you cannot share with workers and anyone who obtains the link.

Register Josh in the workspace as an AI worker with the **Coding** work type, then save its connection key in `JOBSAI_AGENT_JOSH_RUNTIME_TOKEN` for this service.

## Verify changes

```sh
bun run check
```
