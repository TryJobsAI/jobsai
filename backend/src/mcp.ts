import type { IncomingMessage } from "node:http";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { asyncRoute } from "./http.js";

export const MCP_INSTRUCTIONS = `JobsAI is a marketplace where clients fund work in escrow before it starts. You are connected as one registered AI worker, limited to its work categories and its owner's active-job limit.
Work loop: call list_assigned_jobs first and finish or revise anything there. Otherwise call find_jobs, read each brief and its acceptance criteria, and only claim_job (instant-start jobs) or send_proposal (jobs where the client picks) when you can meet every criterion. Do the work, then submit_work with a summary, the deliverable, and evidence links. The client reviews and accepts before payment; you cannot release funds. If you cannot finish a claimed job, call unclaim_job before submitting so another worker can take it.`;

type RuntimeCall = (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;

class RuntimeApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
}

// Tools go through the agent runtime routes, so token scope, categories, claim limits, and pauses apply unchanged.
export function runtimeCaller(baseUrl: string, authorization: string, forwardedFor?: string, fetcher: typeof fetch = fetch): RuntimeCall {
  return async (path, init = {}) => {
    const response = await fetcher(`${baseUrl}/v1/agent-runtime${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization,
        ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const payload = await response.json().catch(() => null) as { data?: unknown; error?: { code?: string; message?: string } } | null;
    if (!response.ok) throw new RuntimeApiError(response.status, payload?.error?.code, payload?.error?.message ?? `JobsAI returned HTTP ${response.status}.`);
    return payload?.data;
  };
}

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

async function attempt(action: () => Promise<unknown>) {
  try { return result(await action()); }
  catch (error) {
    const message = error instanceof RuntimeApiError ? `${error.message}${error.code ? ` (${error.code})` : ""}` : "JobsAI could not complete this request.";
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

const jobId = z.string().uuid().describe("The JobsAI job ID.");
const readOnly = { readOnlyHint: true, openWorldHint: false };

export function buildMcpServer(call: RuntimeCall) {
  const server = new McpServer({ name: "jobsai", title: "JobsAI", version: "1.0.0" }, { instructions: MCP_INSTRUCTIONS });

  server.registerTool("get_profile", {
    title: "Get worker profile",
    description: "Show this AI worker's name, registered work categories, skills, and the wallet that receives its payouts.",
    annotations: readOnly,
  }, () => attempt(() => call("/profile")));

  server.registerTool("list_assigned_jobs", {
    title: "List assigned jobs",
    description: "List jobs already assigned to this worker that still need work, including the client's latest revision feedback. Check this before looking for new work.",
    annotations: readOnly,
  }, () => attempt(() => call("/assigned-jobs")));

  server.registerTool("find_jobs", {
    title: "Find funded jobs",
    description: "Find funded jobs in this worker's categories. 'claim' jobs can be claimed immediately with claim_job; 'proposals' jobs need send_proposal and the client chooses. Amounts are in base units (wei for ETH, 6 decimals for USDG).",
    inputSchema: {
      selection: z.enum(["claim", "proposals"]).default("claim").describe("'claim' for instant-start jobs, 'proposals' for jobs where the client picks a worker."),
      limit: z.number().int().min(1).max(30).default(10),
    },
    annotations: readOnly,
  }, ({ selection, limit }) => attempt(() => call(`/jobs?selection=${selection}&limit=${limit}`)));

  server.registerTool("claim_job", {
    title: "Claim a job",
    description: "Claim an instant-start funded job so this worker can do it. Only claim when every acceptance criterion can be met. A claim with no submission is released after 24 hours.",
    inputSchema: { jobId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ jobId }) => attempt(() => call(`/jobs/${jobId}/claim`, { method: "POST", body: {} })));

  server.registerTool("send_proposal", {
    title: "Send a proposal",
    description: "Pitch for a job where the client chooses a worker. The price is the funded amount and cannot be changed. Sending again updates a waiting proposal. If chosen, the job appears in list_assigned_jobs.",
    inputSchema: {
      jobId,
      pitch: z.string().min(20).max(2_000).describe("Why this worker fits and how it will approach the job."),
      deliveryDays: z.number().int().min(1).max(30).optional().describe("Promised delivery time in days."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ jobId, pitch, deliveryDays }) => attempt(() => call(`/jobs/${jobId}/proposals`, { method: "POST", body: { pitch, ...(deliveryDays ? { deliveryDays } : {}) } })));

  server.registerTool("list_my_proposals", {
    title: "List my proposals",
    description: "List this worker's proposals and whether each is pending, accepted, withdrawn, or released.",
    annotations: readOnly,
  }, () => attempt(() => call("/proposals")));

  server.registerTool("submit_work", {
    title: "Submit work",
    description: "Submit the finished work for an assigned job. The deliverable must satisfy every acceptance criterion. The client then accepts it and releases payment, or requests a revision.",
    inputSchema: {
      jobId,
      summary: z.string().min(1).max(10_000).describe("A short description of what was completed."),
      deliverable: z.string().min(1).max(100_000).describe("The finished work itself, or a link to it."),
      evidence: z.array(z.string().url()).max(20).default([]).describe("Links that support the submission."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ jobId, summary, deliverable, evidence }) => attempt(() => call(`/jobs/${jobId}/submissions`, { method: "POST", body: { summary, deliverable, evidence } })));

  server.registerTool("unclaim_job", {
    title: "Unclaim a job",
    description: "Hand an assigned job back before any work is submitted, so another worker can take it.",
    inputSchema: { jobId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ jobId }) => attempt(() => call(`/jobs/${jobId}/unclaim`, { method: "POST", body: {} })));

  server.registerPrompt("work_a_job", {
    title: "Find and complete a JobsAI job",
    description: "Walk through the JobsAI work loop: check assigned work, pick a job you can finish, do it, and submit.",
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text: `${MCP_INSTRUCTIONS}\n\nStart now. Tell me which job you picked and why before you claim it or send a proposal.` } }],
  }));

  return server;
}

// Stateless Streamable HTTP: each request gets a fresh server bound to the caller's own runtime token.
export const handleMcpRequest = asyncRoute(async (request: Request, response: Response) => {
  const baseUrl = `http://127.0.0.1:${request.socket.localPort}`;
  const server = buildMcpServer(runtimeCaller(baseUrl, request.header("authorization")!, request.ip));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  // Express types request.auth as the wallet session; agent runtime requests never set it.
  await transport.handleRequest(request as unknown as IncomingMessage, response, request.body);
});
