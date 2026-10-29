import { config } from "./config.js";
import { jobsAI, type AgentProfile, type AgentSubmission, type WritingJob } from "./jobsai.js";
import { assessWritingFit, isWritingJob, writeJob } from "./julie.js";
import { assessImageJob, generateImageJob, isImageGenerationJob } from "./john.js";

let running = false;
let lastPollAt: string | null = null;
let lastError: string | null = null;
let completedCount = 0;

export function workerStatus() {
  return { running, lastPollAt, lastError, completedCount, configuredProfiles: config.runtimeProfiles.length };
}

type RuntimeDependencies = {
  profile(token: string): Promise<AgentProfile>;
  assignedJobs(token: string): Promise<WritingJob[]>;
  availableJobs(token: string): Promise<WritingJob[]>;
  claim(jobId: string, token: string): Promise<unknown>;
  submit(jobId: string, token: string, body: AgentSubmission): Promise<unknown>;
  unclaim(jobId: string, token: string): Promise<unknown>;
  assess(job: WritingJob, category: string): Promise<{ suitable: boolean; reason?: string; queries?: string[] }>;
  write(job: WritingJob, queries: string[], token: string, category: string): Promise<AgentSubmission>;
};

export async function processAgentToken(token: string, deps: RuntimeDependencies = {
  profile: jobsAI.profile,
  assignedJobs: jobsAI.assignedJobs,
  availableJobs: jobsAI.availableJobs,
  claim: jobsAI.claim,
  submit: jobsAI.submit,
  unclaim: jobsAI.unclaim,
  assess: (job, category) => category === "writing" ? assessWritingFit(job) : Promise.resolve(assessImageJob(job)),
  write: (job, queries, token, category) => category === "writing"
    ? writeJob(job, queries)
    : generateImageJob(job, token, jobsAI.uploadImage),
}) {
  const profile = await deps.profile(token);
  const supportedCategories = profile.categories.filter((item) => item === "writing" || item === "image_generation");
  if (!supportedCategories.length) return { processed: 0, skipped: "This worker's categories need a matching task handler." };
  const configuredCategories = supportedCategories.filter((category) => category === "writing"
    ? Boolean(config.groqApiKey && config.groqModel && config.tavilyApiKey)
    : Boolean(config.openRouterApiKey));
  if (!configuredCategories.length) throw new Error("Add the provider keys required for this worker's selected task categories.");
  const configuredCategorySet = new Set<string>(configuredCategories);
  const matchesCategory = (job: WritingJob) => configuredCategorySet.has(job.category) &&
    (job.category === "writing" ? isWritingJob(job) : isImageGenerationJob(job));
  const assigned = (await deps.assignedJobs(token)).filter(matchesCategory);
  const available = assigned.length ? [] : (await deps.availableJobs(token)).filter(matchesCategory);
  let lastCandidateError: unknown;
  for (const candidate of [...assigned, ...available]) {
    const alreadyAssigned = candidate.status === "in_progress" || candidate.status === "revision_requested";
    let claimedByRuntime = false;
    try {
      const category = candidate.category;
      const fit = await deps.assess(candidate, category);
      if (!fit.suitable || (category === "writing" && !fit.queries?.length)) continue;
      if (!alreadyAssigned) { await deps.claim(candidate.id, token); claimedByRuntime = true; }
      const submission = await deps.write(candidate, fit.queries || [], token, category);
      await deps.submit(candidate.id, token, submission);
      completedCount++;
      return { processed: 1, jobId: candidate.id };
    } catch (error) {
      lastCandidateError = error;
      if (claimedByRuntime) await deps.unclaim(candidate.id, token).catch((releaseError) => {
        console.error(`[JobsAI Exec X1] Could not release job ${candidate.id}:`, releaseError instanceof Error ? releaseError.message : "release failed");
      });
    }
  }
  if (lastCandidateError) throw lastCandidateError;
  return { processed: 0 };
}

async function pollOnce() {
  if (running) return;
  running = true;
  lastPollAt = new Date().toISOString();
  lastError = null;
  try {
    for (const profile of config.runtimeProfiles) {
      try { await processAgentToken(profile.token); }
      catch (error) {
        lastError = error instanceof Error ? error.message : "Unknown runtime error.";
        console.error(`[JobsAI Exec X1] Agent ${profile.key} poll failed:`, lastError);
      }
    }
  } finally { running = false; }
}

export function startWorker() {
  if (!config.runtimeProfiles.length) {
    console.info("[JobsAI Exec X1] No agent tokens configured; runtime is idle.");
    return;
  }
  void pollOnce();
  setInterval(() => void pollOnce(), config.pollIntervalMs);
}
