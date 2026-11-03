import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { appendEvent } from "./jobs.js";
import { assertNewWorkAvailable } from "./lifecycle.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";

export const proposalsRouter = Router();
const uuid = z.string().uuid();
const MAX_PENDING_PROPOSALS_PER_JOB = 50;
const MAX_PENDING_PROPOSALS_PER_WORKER = 20;
const ACTIVE_WORK_STATUSES = "('in_progress','submitted','revision_requested','disputed','settlement_pending')";

export const proposalInputSchema = z.object({
  pitch: z.string().trim().min(20).max(2_000),
  deliveryDays: z.number().int().min(1).max(30).nullish(),
  agentId: z.string().uuid().nullish(),
}).strict();
export type ProposalInput = z.infer<typeof proposalInputSchema>;

type ProposalRow = {
  id: string; job_id: string; proposer_id: string; proposer_wallet: string; agent_id: string | null; agent_name: string | null;
  pitch: string; delivery_days: number | null; status: string; created_at: Date; updated_at: Date; accepted_at: Date | null;
  completed_jobs: number; active_jobs: number;
};

// Track record counts completed work by the AI worker when one is named, otherwise by the wallet.
const proposalSelect = `SELECT p.*,u.wallet_address AS proposer_wallet,a.name AS agent_name,
    (SELECT count(*)::int FROM jobs dj WHERE dj.status='completed'
       AND CASE WHEN p.agent_id IS NULL THEN dj.doer_id=p.proposer_id ELSE dj.doer_agent_id=p.agent_id END) AS completed_jobs,
    (SELECT count(*)::int FROM jobs aj WHERE aj.doer_id=p.proposer_id AND aj.status IN ${ACTIVE_WORK_STATUSES}) AS active_jobs
  FROM job_proposals p JOIN users u ON u.id=p.proposer_id LEFT JOIN ai_agents a ON a.id=p.agent_id`;

export function presentProposal(proposal: ProposalRow) {
  return {
    id: proposal.id,
    jobId: proposal.job_id,
    proposerWallet: proposal.proposer_wallet,
    workerType: proposal.agent_id ? "ai" : "human",
    agent: proposal.agent_id ? { id: proposal.agent_id, name: proposal.agent_name } : null,
    pitch: proposal.pitch,
    deliveryDays: proposal.delivery_days,
    status: proposal.status,
    completedJobs: proposal.completed_jobs,
    activeJobs: proposal.active_jobs,
    createdAt: proposal.created_at,
    updatedAt: proposal.updated_at,
    acceptedAt: proposal.accepted_at,
  };
}

type OpenJob = { client_id: string; status: string; selection_mode: string; category: string; deadline_at: Date | null };

function assertOpenForProposals(job: OpenJob | undefined, proposerId: string, now = new Date()): asserts job is OpenJob {
  if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
  if (job.client_id === proposerId) throw new ApiError(403, "client_cannot_propose", "You cannot send a proposal for your own job.");
  if (job.selection_mode !== "proposals") throw new ApiError(409, "job_not_accepting_proposals", "This job is open to claim directly and does not take proposals.");
  if (job.status !== "ready") throw new ApiError(409, "job_not_accepting_proposals", "This job is no longer taking proposals.");
  if (job.deadline_at && job.deadline_at <= now) throw new ApiError(409, "job_deadline_passed", "This job's deadline has passed.");
}

// Shared by signed-in workers and AI worker runtimes. Resending replaces a pending or withdrawn proposal.
export async function submitProposal(proposerId: string, jobId: string, input: ProposalInput) {
  assertNewWorkAvailable(config.PAUSE_NEW_WORK);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`proposals:${proposerId}`]);
    const selected = await client.query<OpenJob>("SELECT client_id,status,selection_mode,category,deadline_at FROM jobs WHERE id=$1 FOR SHARE", [jobId]);
    const job = selected.rows[0];
    assertOpenForProposals(job, proposerId);
    if (input.agentId) {
      const agent = await client.query<{ active: boolean; categories: string[] }>(
        "SELECT active,categories FROM ai_agents WHERE id=$1 AND owner_user_id=$2", [input.agentId, proposerId]);
      if (!agent.rowCount) throw new ApiError(404, "agent_not_found", "Choose one of your own AI workers.");
      if (!agent.rows[0].active) throw new ApiError(409, "agent_inactive", "Activate this AI worker before proposing with it.");
      if (!agent.rows[0].categories.includes(job.category))
        throw new ApiError(409, "agent_category_mismatch", "This AI worker is not registered for the job's category.");
    }
    const existing = await client.query<{ status: string }>("SELECT status FROM job_proposals WHERE job_id=$1 AND proposer_id=$2 FOR UPDATE", [jobId, proposerId]);
    const previous = existing.rows[0]?.status;
    if (previous && !["pending", "withdrawn"].includes(previous))
      throw new ApiError(409, "proposal_closed", "Your earlier proposal for this job was already chosen, so it cannot be sent again.");
    if (previous !== "pending") {
      const counts = await client.query<{ job_pending: number; worker_pending: number }>(
        `SELECT (SELECT count(*)::int FROM job_proposals WHERE job_id=$1 AND status='pending') AS job_pending,
                (SELECT count(*)::int FROM job_proposals p JOIN jobs j ON j.id=p.job_id
                  WHERE p.proposer_id=$2 AND p.status='pending' AND j.status='ready') AS worker_pending`, [jobId, proposerId]);
      if (counts.rows[0].job_pending >= MAX_PENDING_PROPOSALS_PER_JOB)
        throw new ApiError(409, "proposal_limit", "This job already has the maximum number of proposals waiting for the client.");
      if (counts.rows[0].worker_pending >= MAX_PENDING_PROPOSALS_PER_WORKER)
        throw new ApiError(409, "proposal_limit", `You can have up to ${MAX_PENDING_PROPOSALS_PER_WORKER} open proposals. Withdraw one before sending another.`);
    }
    const saved = await client.query<{ id: string }>(
      `INSERT INTO job_proposals (job_id,proposer_id,agent_id,pitch,delivery_days) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (job_id,proposer_id) DO UPDATE SET agent_id=EXCLUDED.agent_id,pitch=EXCLUDED.pitch,
         delivery_days=EXCLUDED.delivery_days,status='pending',updated_at=now()
       RETURNING id`,
      [jobId, proposerId, input.agentId ?? null, input.pitch, input.deliveryDays ?? null],
    );
    await appendEvent(client, jobId, proposerId, previous ? "job.proposal_updated" : "job.proposal_submitted", {
      proposalId: saved.rows[0].id,
      ...(input.agentId ? { workerType: "ai", agentId: input.agentId } : { workerType: "human" }),
    });
    const created = await client.query<ProposalRow>(`${proposalSelect} WHERE p.id=$1`, [saved.rows[0].id]);
    await client.query("COMMIT");
    return { proposal: presentProposal(created.rows[0]), updated: Boolean(previous) };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function proposalsByWorker(proposerId: string, agentId?: string) {
  const result = await db.query<ProposalRow>(
    `${proposalSelect} WHERE p.proposer_id=$1 AND ($2::uuid IS NULL OR p.agent_id=$2) ORDER BY p.updated_at DESC LIMIT 50`,
    [proposerId, agentId ?? null]);
  return result.rows.map(presentProposal);
}

proposalsRouter.get("/proposals/mine", requireAuth, asyncRoute(async (request, response) => {
  response.json({ data: await proposalsByWorker(request.auth!.userId) });
}));

proposalsRouter.get("/:id/proposals", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  const job = await db.query<{ client_id: string }>("SELECT client_id FROM jobs WHERE id=$1", [id]);
  if (!job.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
  const isClient = job.rows[0].client_id === request.auth!.userId;
  // Clients compare every proposal; a worker only ever sees their own.
  const result = await db.query<ProposalRow>(
    `${proposalSelect} WHERE p.job_id=$1 AND ($2::boolean OR p.proposer_id=$3)
     ORDER BY (p.status='accepted') DESC,(p.status='pending') DESC,p.created_at ASC LIMIT 100`,
    [id, isClient, request.auth!.userId]);
  response.json({ data: result.rows.map(presentProposal) });
}));

proposalsRouter.post(
  "/:id/proposals",
  requireAuth,
  rateLimit([{ scope: "job-proposal-user", limit: 30, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser }]),
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const { proposal, updated } = await submitProposal(request.auth!.userId, id, proposalInputSchema.parse(request.body));
    response.status(updated ? 200 : 201).json({ data: proposal });
  }),
);

proposalsRouter.post("/:id/proposals/:proposalId/withdraw", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id), proposalId = uuid.parse(request.params.proposalId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      "UPDATE job_proposals SET status='withdrawn',updated_at=now() WHERE id=$1 AND job_id=$2 AND proposer_id=$3 AND status='pending' RETURNING id",
      [proposalId, id, request.auth!.userId]);
    if (!updated.rowCount) throw new ApiError(409, "proposal_not_withdrawable", "Only your own proposal that is still waiting can be withdrawn.");
    await appendEvent(client, id, request.auth!.userId, "job.proposal_withdrawn", { proposalId });
    await client.query("COMMIT");
    response.json({ data: { id: proposalId, jobId: id, status: "withdrawn" } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));

export async function acceptProposal(client: PoolClient, jobId: string, proposalId: string, clientId: string) {
  const proposal = await client.query<{ proposer_id: string }>("SELECT proposer_id FROM job_proposals WHERE id=$1 AND job_id=$2", [proposalId, jobId]);
  if (!proposal.rowCount) throw new ApiError(404, "proposal_not_found", "This proposal does not exist.");
  const proposerId = proposal.rows[0].proposer_id;
  // Same per-worker lock as claiming, so an accepted proposal cannot race past the active-job limit.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [proposerId]);
  const job = await client.query<{ client_id: string; status: string; selection_mode: string; deadline_at: Date | null }>(
    "SELECT client_id,status,selection_mode,deadline_at FROM jobs WHERE id=$1 FOR UPDATE", [jobId]);
  const current = job.rows[0];
  if (!current) throw new ApiError(404, "job_not_found", "This job does not exist.");
  if (current.client_id !== clientId) throw new ApiError(403, "client_only", "Only the client can choose a proposal.");
  if (current.selection_mode !== "proposals" || current.status !== "ready")
    throw new ApiError(409, "job_not_accepting_proposals", "This job is no longer choosing from proposals.");
  if (current.deadline_at && current.deadline_at <= new Date()) throw new ApiError(409, "job_deadline_passed", "This job's deadline has passed.");
  const locked = await client.query<{ status: string; agent_id: string | null; agent_active: boolean | null }>(
    `SELECT p.status,p.agent_id,a.active AS agent_active FROM job_proposals p
       LEFT JOIN ai_agents a ON a.id=p.agent_id WHERE p.id=$1 FOR UPDATE OF p`, [proposalId]);
  const chosen = locked.rows[0];
  if (chosen.status !== "pending") throw new ApiError(409, "proposal_not_pending", "This proposal was withdrawn or already handled.");
  if (chosen.agent_id && !chosen.agent_active) throw new ApiError(409, "agent_inactive", "The AI worker on this proposal has been paused by its owner.");
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM jobs WHERE doer_id=$1 AND status IN ${ACTIVE_WORK_STATUSES}`, [proposerId]);
  if (active.rows[0].count >= config.MAX_ACTIVE_CLAIMS_PER_WALLET)
    throw new ApiError(409, "worker_at_capacity", "This worker already has the maximum number of active jobs. Choose another proposal or try again later.");
  await client.query("UPDATE jobs SET status='in_progress',doer_id=$2,doer_agent_id=$3,claimed_at=now(),updated_at=now() WHERE id=$1",
    [jobId, proposerId, chosen.agent_id]);
  await client.query("UPDATE job_proposals SET status='accepted',accepted_at=now(),updated_at=now() WHERE id=$1", [proposalId]);
  await appendEvent(client, jobId, clientId, "job.proposal_accepted", { proposalId, doerId: proposerId });
  await appendEvent(client, jobId, proposerId, "job.claimed", {
    via: "proposal",
    proposalId,
    ...(chosen.agent_id ? { workerType: "ai", agentId: chosen.agent_id } : { workerType: "human" }),
  });
}

proposalsRouter.post("/:id/proposals/:proposalId/accept", requireAuth, asyncRoute(async (request, response) => {
  assertNewWorkAvailable(config.PAUSE_NEW_WORK);
  const id = uuid.parse(request.params.id), proposalId = uuid.parse(request.params.proposalId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await acceptProposal(client, id, proposalId, request.auth!.userId);
    await client.query("COMMIT");
    response.json({ data: { jobId: id, proposalId, status: "in_progress" } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));
