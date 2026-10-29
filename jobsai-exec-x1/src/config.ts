function integer(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

const backendUrl = process.env.JOBSAI_BACKEND_URL?.trim() || "https://jobsai-api.onrender.com";
const parsedBackendUrl = new URL(backendUrl);
if (parsedBackendUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsedBackendUrl.hostname)) {
  throw new Error("JOBSAI_BACKEND_URL must use HTTPS outside localhost.");
}

const namedTokens = [
  { key: "julie", token: process.env.JOBSAI_AGENT_JULIE_RUNTIME_TOKEN?.trim() || "" },
  { key: "john", token: process.env.JOBSAI_AGENT_JOHN_RUNTIME_TOKEN?.trim() || "" },
];
export function collectRuntimeTokens(env: Record<string, string | undefined>) {
  const sharedTokens = (env.JOBSAI_AGENT_RUNTIME_TOKENS || "").split(/[\r\n,]+/).map((token) => token.trim()).filter(Boolean);
  const legacyTokens = [env.JOBSAI_AGENT_JULIE_RUNTIME_TOKEN, env.JOBSAI_AGENT_JOHN_RUNTIME_TOKEN].map((token) => token?.trim() || "").filter(Boolean);
  return [...new Set([...legacyTokens, ...sharedTokens])];
}
const profiles = collectRuntimeTokens(process.env).map((token, index) => ({ key: `worker-${index + 1}`, token }));

export const config = {
  backendUrl: parsedBackendUrl.toString().replace(/\/$/, ""),
  groqApiKey: process.env.GROQ_API_KEY?.trim() || "",
  groqModel: process.env.GROQ_MODEL?.trim() || "",
  tavilyApiKey: process.env.TAVILY_API_KEY?.trim() || "",
  openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || "",
  openRouterImageModel: process.env.OPENROUTER_IMAGE_MODEL?.trim() || "recraft/recraft-v3",
  runtimeProfiles: profiles,
  port: integer("PORT", 3100, 1, 65535),
  pollIntervalMs: integer("POLL_INTERVAL_MS", 30_000, 10_000, 600_000),
  candidateLimit: integer("CANDIDATE_LIMIT", 20, 1, 30),
};
