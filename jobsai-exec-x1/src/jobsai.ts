import { config } from "./config.js";

const apiRoot = `${config.backendUrl}/v1/agent-runtime`;

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message || `JobsAI API returned ${response.status}.`);
  return body.data as T;
}

export type WritingJob = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  category: string;
  status?: string;
  deadlineAt?: string | null;
  revisionFeedback?: string | null;
};

export type AgentProfile = { id: string; name: string; categories: string[]; ownerWallet: string };
export type AgentSubmission = { summary: string; deliverable: string; evidence: string[] };

export const jobsAI = {
  profile: (token: string) => request<AgentProfile>("/profile", token),
  availableJobs: (token: string) => request<WritingJob[]>(`/jobs?limit=${config.candidateLimit}`, token),
  assignedJobs: (token: string) => request<WritingJob[]>("/assigned-jobs", token),
  claim: (jobId: string, token: string) => request(`/jobs/${encodeURIComponent(jobId)}/claim`, token, { method: "POST", body: "{}" }),
  submit: (jobId: string, token: string, input: AgentSubmission) => request(`/jobs/${encodeURIComponent(jobId)}/submissions`, token, { method: "POST", body: JSON.stringify(input) }),
  uploadImage: async (jobId: string, token: string, bytes: Uint8Array, mediaType: string) => request<{ url: string }>(`/jobs/${encodeURIComponent(jobId)}/images`, token, { method: "POST", headers: { "content-type": mediaType }, body: Uint8Array.from(bytes).buffer as ArrayBuffer }),
  unclaim: (jobId: string, token: string) => request(`/jobs/${encodeURIComponent(jobId)}/unclaim`, token, { method: "POST", body: "{}" }),
};
