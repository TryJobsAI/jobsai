import { Router } from "express";
import { formatUnits } from "viem";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { appendEvent } from "./jobs.js";
import { assertHumanWorkerProfileEligibility, assertNewWorkAvailable } from "./lifecycle.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";

export const invitationsRouter = Router();
const uuid = z.string().uuid();
const ACTIVE_WORK_STATUSES = "('in_progress','submitted','revision_requested','disputed','settlement_pending')";

export const invitationInputSchema = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Enter the worker's 0x wallet address.").transform((value) => value.toLowerCase()),
  message: z.string().trim().min(1).max(1_000).nullish(),
}).strict();

type InvitationRow = {
  id: string; job_id: string; message: string | null; created_at: Date; client_wallet: string; client_user_tag: string | null;
  title: string; description: string; acceptance_criteria: string[]; category: string;
  asset: "eth" | "usdg"; amount_raw: string; deadline_at: Date | null; funded_at: Date | null;
};

function presentInvitation(row: InvitationRow) {
  return {
    id: row.id,
    message: row.message,
    createdAt: row.created_at,
    job: {
      id: row.job_id,
      clientWallet: row.client_wallet,
      clientUserTag: row.client_user_tag,
      title: row.title,
      description: row.description,
      acceptanceCriteria: row.acceptance_criteria,
      category: row.category,
      asset: row.asset.toUpperCase(),
      amount: formatUnits(BigInt(row.amount_raw), row.asset === "eth" ? 18 : config.USDG_DECIMALS),
      deadlineAt: row.deadline_at,
      fundedAt: row.funded_at,
    },
  };
}

// Only funded invitations are shown; an unfunded job could still be changed or abandoned.
invitationsRouter.get("/invitations/mine", requireAuth, asyncRoute(async (request, response) => {
  const result = await db.query<InvitationRow>(
    `SELECT i.id,i.job_id,i.message,i.created_at,c.wallet_address AS client_wallet,c.user_tag AS client_user_tag,j.title,j.description,j.acceptance_criteria,
            j.category,j.asset,j.amount_raw::text,j.deadline_at,j.funded_at
       FROM job_invitations i JOIN jobs j ON j.id=i.job_id JOIN users c ON c.id=j.client_id
      WHERE i.invitee_wallet=$1 AND i.status='pending' AND j.status='ready' AND j.selection_mode='invite'
      ORDER BY i.created_at DESC LIMIT 50`,
    [request.auth!.walletAddress.toLowerCase()]);
  response.json({ data: result.rows.map(presentInvitation) });
}));

invitationsRouter.post(
  "/:id/invitation",
  requireAuth,
  rateLimit([{ scope: "job-invitation-user", limit: 20, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser }]),
  asyncRoute(async (request, response) => {
    assertNewWorkAvailable(config.PAUSE_NEW_WORK);
    const id = uuid.parse(request.params.id);
    const input = invitationInputSchema.parse(request.body);
    if (input.wallet === request.auth!.walletAddress.toLowerCase())
      throw new ApiError(400, "cannot_invite_self", "You cannot invite your own wallet to your job.");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ client_id: string; status: string; selection_mode: string }>(
        "SELECT client_id,status,selection_mode FROM jobs WHERE id=$1 FOR UPDATE", [id]);
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      if (job.client_id !== request.auth!.userId) throw new ApiError(403, "client_only", "Only the client can invite a worker.");
      if (job.selection_mode !== "invite" || !["awaiting_funding", "ready"].includes(job.status))
        throw new ApiError(409, "job_not_invitable", "Only an unassigned invite-only job can be sent to another worker.");
      await client.query("UPDATE job_invitations SET status='cancelled',responded_at=now() WHERE job_id=$1 AND status='pending'", [id]);
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO job_invitations (job_id,client_id,invitee_wallet,message) VALUES ($1,$2,$3,$4) RETURNING id",
        [id, request.auth!.userId, input.wallet, input.message ?? null]);
      await appendEvent(client, id, request.auth!.userId, "job.worker_invited", { invitationId: inserted.rows[0].id, wallet: input.wallet });
      const invitee = await client.query<{ user_tag: string | null }>("SELECT user_tag FROM users WHERE wallet_address=$1", [input.wallet]);
      await client.query("COMMIT");
      response.status(201).json({ data: { id: inserted.rows[0].id, jobId: id, wallet: input.wallet, userTag: invitee.rows[0]?.user_tag ?? null, status: "pending" } });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }),
);

invitationsRouter.post("/:id/invitation/accept", requireAuth, asyncRoute(async (request, response) => {
  assertNewWorkAvailable(config.PAUSE_NEW_WORK);
  const id = uuid.parse(request.params.id);
  const { agentId } = z.object({ agentId: z.string().uuid().nullish() }).strict().parse(request.body ?? {});
  const userId = request.auth!.userId, wallet = request.auth!.walletAddress.toLowerCase();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Same per-worker lock as claiming, so accepting cannot race past the active-job limit.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
    const selected = await client.query<{ client_id: string; status: string; selection_mode: string; category: string; deadline_at: Date | null }>(
      "SELECT client_id,status,selection_mode,category,deadline_at FROM jobs WHERE id=$1 FOR UPDATE", [id]);
    const job = selected.rows[0];
    const invitation = await client.query<{ id: string }>(
      "SELECT id FROM job_invitations WHERE job_id=$1 AND invitee_wallet=$2 AND status='pending' FOR UPDATE", [id, wallet]);
    if (!job || !invitation.rowCount) throw new ApiError(404, "invitation_not_found", "You do not have an open invitation for this job.");
    if (job.client_id === userId) throw new ApiError(403, "client_cannot_claim", "The client cannot accept their own job.");
    if (job.status !== "ready" || job.selection_mode !== "invite")
      throw new ApiError(409, "invitation_not_acceptable", "This job is not funded and waiting for you yet.");
    if (job.deadline_at && job.deadline_at <= new Date()) throw new ApiError(409, "job_deadline_passed", "This job's deadline has passed.");
    if (!agentId) {
      const profile = await client.query<{ status: string }>("SELECT status FROM worker_profiles WHERE user_id=$1 FOR SHARE", [userId]);
      assertHumanWorkerProfileEligibility(profile.rows[0]?.status);
    }
    if (agentId) {
      const agent = await client.query<{ active: boolean; categories: string[] }>(
        "SELECT active,categories FROM ai_agents WHERE id=$1 AND owner_user_id=$2", [agentId, userId]);
      if (!agent.rowCount) throw new ApiError(404, "agent_not_found", "Choose one of your own AI workers.");
      if (!agent.rows[0].active) throw new ApiError(409, "agent_inactive", "Activate this AI worker before giving it the job.");
      if (!agent.rows[0].categories.includes(job.category))
        throw new ApiError(409, "agent_category_mismatch", "This AI worker is not registered for the job's category.");
    }
    const active = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs WHERE doer_id=$1 AND status IN ${ACTIVE_WORK_STATUSES}`, [userId]);
    if (active.rows[0].count >= config.MAX_ACTIVE_CLAIMS_PER_WALLET)
      throw new ApiError(409, "active_claim_limit", `You already have ${active.rows[0].count} active jobs. Finish or unclaim one before accepting this invitation.`);
    await client.query("UPDATE jobs SET status='in_progress',doer_id=$2,doer_agent_id=$3,claimed_at=now(),updated_at=now() WHERE id=$1",
      [id, userId, agentId ?? null]);
    const invitationId = invitation.rows[0].id;
    await client.query("UPDATE job_invitations SET status='accepted',accepted_by=$2,agent_id=$3,responded_at=now() WHERE id=$1",
      [invitationId, userId, agentId ?? null]);
    await appendEvent(client, id, userId, "job.invitation_accepted", { invitationId });
    await appendEvent(client, id, userId, "job.claimed", {
      via: "invitation",
      invitationId,
      ...(agentId ? { workerType: "ai", agentId } : { workerType: "human" }),
    });
    await client.query("COMMIT");
    response.json({ data: { jobId: id, status: "in_progress", workerType: agentId ? "ai" : "human" } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));

invitationsRouter.post("/:id/invitation/decline", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ id: string }>(
      "UPDATE job_invitations SET status='declined',responded_at=now() WHERE job_id=$1 AND invitee_wallet=$2 AND status='pending' RETURNING id",
      [id, request.auth!.walletAddress.toLowerCase()]);
    if (!updated.rowCount) throw new ApiError(404, "invitation_not_found", "You do not have an open invitation for this job.");
    await appendEvent(client, id, request.auth!.userId, "job.invitation_declined", { invitationId: updated.rows[0].id });
    await client.query("COMMIT");
    response.json({ data: { jobId: id, status: "declined" } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));

// Lets a client stop waiting on an invitation and publish the job the usual way.
invitationsRouter.post("/:id/open", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  const { selectionMode } = z.object({ selectionMode: z.enum(["claim", "proposals"]) }).strict().parse(request.body);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{ client_id: string; status: string; selection_mode: string }>(
      "SELECT client_id,status,selection_mode FROM jobs WHERE id=$1 FOR UPDATE", [id]);
    const job = selected.rows[0];
    if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
    if (job.client_id !== request.auth!.userId) throw new ApiError(403, "client_only", "Only the client can change who can take this job.");
    if (job.selection_mode !== "invite" || !["awaiting_funding", "ready"].includes(job.status))
      throw new ApiError(409, "job_not_reopenable", "Only an unassigned invite-only job can be opened to other workers.");
    await client.query("UPDATE job_invitations SET status='cancelled',responded_at=now() WHERE job_id=$1 AND status='pending'", [id]);
    await client.query("UPDATE jobs SET selection_mode=$2,updated_at=now() WHERE id=$1", [id, selectionMode]);
    await appendEvent(client, id, request.auth!.userId, "job.opened_to_workers", { selectionMode });
    await client.query("COMMIT");
    response.json({ data: { jobId: id, status: job.status, selectionMode } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));
