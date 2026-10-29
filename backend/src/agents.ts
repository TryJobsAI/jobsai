import { createHash, randomBytes } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { assertActiveClaimCapacity, assertCanSubmit, assertNewWorkAvailable } from "./lifecycle.js";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { decryptPayload, encryptPayload, payloadDigest } from "./crypto.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { jobCategories, submissionInputSchema } from "./job-input.js";
import { releaseExpiredClaims } from "./jobs.js";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES, uploadSubmissionImage } from "./media.js";

export const agentsRouter = Router();
export const agentRuntimeRouter = Router();
const uuid = z.string().uuid();
const tokenLifetimeDays = z.number().int().min(1).max(365).default(90);
const agentInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().min(1).max(2_000),
  categories: z.array(z.enum(jobCategories)).min(1).max(jobCategories.length)
    .refine((categories) => new Set(categories).size === categories.length, "Choose each work category once."),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  expiresInDays: tokenLifetimeDays,
}).strict();

export function newAgentRuntimeToken() {
  return `jsai_agent_${randomBytes(32).toString("base64url")}`;
}

export function hashAgentRuntimeToken(token: string) {
  return createHash("sha256").update(`${config.AUTH_TOKEN_PEPPER}:${token}`).digest("hex");
}

declare global {
  namespace Express {
    interface Request {
      agentRuntime?: { agentId: string; ownerUserId: string; ownerWallet: string; name: string; categories: string[]; capabilities: string[] };
    }
  }
}

async function requireAgentRuntime(request: Request, _response: Response, next: NextFunction) {
  try {
    const token = request.header("authorization")?.match(/^Bearer\s+(jsai_agent_[A-Za-z0-9_-]+)$/)?.[1];
    if (!token) throw new ApiError(401, "agent_runtime_unauthenticated", "A JobsAI agent runtime token is required.");
    const result = await db.query<{ token_id: string; agent_id: string; owner_user_id: string; owner_wallet: string; name: string; categories: string[]; capabilities: string[] }>(
      `SELECT t.id AS token_id,a.id AS agent_id,a.owner_user_id,u.wallet_address AS owner_wallet,a.name,a.categories,a.capabilities
         FROM ai_agent_runtime_tokens t JOIN ai_agents a ON a.id=t.agent_id JOIN users u ON u.id=a.owner_user_id
        WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now() AND a.active`,
      [hashAgentRuntimeToken(token)],
    );
    const agent = result.rows[0];
    if (!agent) throw new ApiError(401, "agent_runtime_invalid", "This agent token is expired, revoked, or inactive.");
    await db.query("UPDATE ai_agent_runtime_tokens SET last_used_at=now() WHERE id=$1", [agent.token_id]);
    request.agentRuntime = { agentId: agent.agent_id, ownerUserId: agent.owner_user_id, ownerWallet: agent.owner_wallet, name: agent.name, categories: agent.categories, capabilities: agent.capabilities };
    next();
  } catch (error) { next(error); }
}

agentsRouter.get("/", requireAuth, asyncRoute(async (request, response) => {
  const result = await db.query(
    `SELECT a.id,a.name,a.description,a.categories,a.capabilities,a.active,a.created_at AS "createdAt",
            t.expires_at AS "runtimeExpiresAt",t.last_used_at AS "lastRuntimeSeen",
            (t.last_used_at>now()-interval '2 minutes') AS "runtimeRecentlyActive"
       FROM ai_agents a LEFT JOIN LATERAL (
         SELECT expires_at,last_used_at FROM ai_agent_runtime_tokens
          WHERE agent_id=a.id AND revoked_at IS NULL AND expires_at>now()
          ORDER BY created_at DESC LIMIT 1
       ) t ON true
      WHERE a.owner_user_id=$1 ORDER BY a.created_at DESC`, [request.auth!.userId],
  );
  response.json({ data: result.rows });
}));

agentsRouter.post("/", requireAuth, asyncRoute(async (request, response) => {
  const input = agentInput.parse(request.body);
  const lifetime = input.expiresInDays;
  const token = newAgentRuntimeToken();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query<{ id: string }>(
      `INSERT INTO ai_agents(owner_user_id,name,description,categories,capabilities) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [request.auth!.userId,input.name,input.description,input.categories,input.capabilities],
    );
    const tokenRow = await client.query<{ expires_at: Date }>(
      `INSERT INTO ai_agent_runtime_tokens(agent_id,token_hash,expires_at)
       VALUES($1,$2,now()+($3::int*interval '1 day')) RETURNING expires_at`,
      [created.rows[0].id,hashAgentRuntimeToken(token),lifetime],
    );
    await client.query("COMMIT");
    response.status(201).json({ data: { id: created.rows[0].id,name: input.name,description: input.description,categories: input.categories,capabilities: input.capabilities,active: true,runtimeToken: token,runtimeExpiresAt: tokenRow.rows[0].expires_at }, tokenWarning: "Copy this token now. It is shown only once." });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}));

agentsRouter.post("/:id/runtime-token", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  const lifetime = z.object({ expiresInDays: tokenLifetimeDays }).parse(request.body ?? {}).expiresInDays;
  const token = newAgentRuntimeToken();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query("SELECT 1 FROM ai_agents WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",[id,request.auth!.userId]);
    if (!owned.rowCount) throw new ApiError(404,"agent_not_found","Agent not found for this wallet.");
    await client.query("UPDATE ai_agent_runtime_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE agent_id=$1",[id]);
    const inserted = await client.query<{ expires_at: Date }>(
      "INSERT INTO ai_agent_runtime_tokens(agent_id,token_hash,expires_at) VALUES($1,$2,now()+($3::int*interval '1 day')) RETURNING expires_at",
      [id,hashAgentRuntimeToken(token),lifetime],
    );
    await client.query("COMMIT");
    response.status(201).json({ data: { agentId:id,runtimeToken:token,runtimeExpiresAt:inserted.rows[0].expires_at },tokenWarning:"Copy this token now. It is shown only once." });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}));

agentsRouter.patch("/:id", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  const active = z.object({ active:z.boolean() }).strict().parse(request.body).active;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query("SELECT 1 FROM ai_agents WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",[id,request.auth!.userId]);
    if (!owned.rowCount) throw new ApiError(404,"agent_not_found","Agent not found for this wallet.");
    if (!active) {
      const assigned = await client.query("SELECT 1 FROM jobs WHERE doer_agent_id=$1 AND status IN ('in_progress','submitted','revision_requested','disputed','settlement_pending') LIMIT 1",[id]);
      if (assigned.rowCount) throw new ApiError(409,"agent_has_active_jobs","Finish or unclaim this agent’s current jobs before deactivating it.");
    }
    await client.query("UPDATE ai_agents SET active=$2,updated_at=now() WHERE id=$1",[id,active]);
    const result = await client.query("UPDATE ai_agent_runtime_tokens SET revoked_at=CASE WHEN $2 THEN revoked_at ELSE COALESCE(revoked_at,now()) END WHERE agent_id=$1",[id,active]);
    await client.query("COMMIT");
    response.json({ data:{ id,active,revokedTokens:result.rowCount ?? 0 } });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}));

agentRuntimeRouter.use(requireAgentRuntime);

agentRuntimeRouter.post("/jobs/:id/images", express.raw({ type: [...IMAGE_CONTENT_TYPES], limit: MAX_IMAGE_BYTES }), asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  if (!Buffer.isBuffer(request.body)) throw new ApiError(415, "unsupported_image_type", "The generated result must be a JPEG, PNG, WebP, or GIF image.");
  const job = await db.query<{ status: string }>(
    `SELECT status FROM jobs WHERE id=$1 AND doer_agent_id=$2 AND doer_id=$3 AND category='image_generation'`,
    [id, request.agentRuntime!.agentId, request.agentRuntime!.ownerUserId],
  );
  if (!job.rowCount || !["in_progress", "revision_requested"].includes(job.rows[0].status))
    throw new ApiError(403, "agent_image_upload_forbidden", "This image agent is not assigned to an active image-generation job.");
  const type = request.header("content-type")?.split(";")[0].trim().toLowerCase() || "";
  const uploaded = await uploadSubmissionImage(request.body, type, id);
  response.status(201).json({ data: uploaded });
}));

agentRuntimeRouter.get("/profile", (request,response) => {
  const { agentId,name,categories,capabilities,ownerWallet } = request.agentRuntime!;
  response.json({ data:{ id:agentId,name,categories,capabilities,ownerWallet } });
});

agentRuntimeRouter.get("/assigned-jobs", asyncRoute(async (request,response) => {
  const result=await db.query(
    `SELECT j.id,j.title,j.description,j.acceptance_criteria AS "acceptanceCriteria",j.category,j.asset,
            j.amount_raw::text AS "amountRaw",j.deadline_at AS "deadlineAt",j.status,
            r.revision AS "revisionNumber",r.feedback_ciphertext AS "revisionFeedbackCiphertext"
       FROM jobs j LEFT JOIN LATERAL (
         SELECT s.revision,r.feedback_ciphertext FROM job_revisions r
           JOIN job_submissions s ON s.id=r.submission_id
          WHERE r.job_id=j.id ORDER BY r.created_at DESC LIMIT 1
       ) r ON true
      WHERE j.doer_agent_id=$1 AND j.doer_id=$2
         AND j.status IN ('in_progress','revision_requested')
      ORDER BY j.updated_at ASC LIMIT 10`,
    [request.agentRuntime!.agentId,request.agentRuntime!.ownerUserId],
  );
  response.json({data:result.rows.map(({revisionNumber,revisionFeedbackCiphertext,...job}:any)=>({
    ...job,
    revisionFeedback: revisionFeedbackCiphertext ? decryptPayload(revisionFeedbackCiphertext,`revision:${job.id}:${revisionNumber}`) : null,
  }))});
}));

agentRuntimeRouter.get("/jobs", asyncRoute(async (request,response) => {
  const limit = z.coerce.number().int().min(1).max(30).default(20).parse(request.query.limit);
  await releaseExpiredClaims();
  const result = await db.query(
    `SELECT j.id,j.title,j.description,j.acceptance_criteria AS "acceptanceCriteria",j.category,j.asset,
            j.amount_raw::text AS "amountRaw",j.deadline_at AS "deadlineAt",j.funded_at AS "fundedAt"
       FROM jobs j JOIN ai_agents a ON a.id=$1 AND a.active
      WHERE j.status='ready' AND j.client_id<>a.owner_user_id
        AND (j.deadline_at IS NULL OR j.deadline_at>now()) AND j.category=ANY(a.categories)
      ORDER BY j.funded_at ASC NULLS LAST,j.created_at ASC LIMIT $2`,[request.agentRuntime!.agentId,limit],
  );
  response.json({ data:result.rows });
}));

agentRuntimeRouter.post("/jobs/:id/claim", asyncRoute(async (request,response) => {
  assertNewWorkAvailable(config.PAUSE_NEW_WORK);
  const id=uuid.parse(request.params.id), agent=request.agentRuntime!;
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[agent.ownerUserId]);
    const row=await client.query<{ client_id:string;status:string;category:string;deadline_at:Date|null;owner_user_id:string;categories:string[];active:boolean }>(
      `SELECT j.client_id,j.status,j.category,j.deadline_at,a.owner_user_id,a.categories,a.active
         FROM jobs j CROSS JOIN ai_agents a WHERE j.id=$1 AND a.id=$2 FOR UPDATE OF j,a`,[id,agent.agentId],
    );
    const job=row.rows[0];
    if (!job) throw new ApiError(404,"job_not_found","This job does not exist.");
    if (!job.active) throw new ApiError(409,"agent_inactive","This agent is inactive.");
    if (job.client_id===job.owner_user_id) throw new ApiError(409,"agent_cannot_claim_own_job","An agent cannot claim a job funded by its owner.");
    if (!job.categories.includes(job.category)) throw new ApiError(403,"agent_category_mismatch","This job is outside the agent’s registered categories.");
    if (job.status!=="ready" || (job.deadline_at && job.deadline_at<=new Date())) throw new ApiError(409,"job_not_claimable","This funded job is no longer available to claim.");
    const active=await client.query<{count:string}>("SELECT count(*)::text AS count FROM jobs WHERE doer_id=$1 AND status IN ('in_progress','submitted','revision_requested','disputed','settlement_pending')",[job.owner_user_id]);
    assertActiveClaimCapacity(Number(active.rows[0].count),config.MAX_ACTIVE_CLAIMS_PER_WALLET);
    await client.query("UPDATE jobs SET doer_id=$2,doer_agent_id=$3,status='in_progress',claimed_at=now(),updated_at=now() WHERE id=$1",[id,job.owner_user_id,agent.agentId]);
    await client.query("INSERT INTO job_events(job_id,actor_id,event_type,details) VALUES($1,$2,'job.claimed',$3)",[id,job.owner_user_id,JSON.stringify({workerType:"ai",agentId:agent.agentId,agentName:agent.name})]);
    await client.query("COMMIT");
    response.json({ data:{jobId:id,status:"in_progress",workerType:"ai",agent:{id:agent.agentId,name:agent.name},payoutWallet:agent.ownerWallet} });
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));

agentRuntimeRouter.post("/jobs/:id/submissions", asyncRoute(async (request,response) => {
  const id=uuid.parse(request.params.id), agent=request.agentRuntime!, input=submissionInputSchema.parse(request.body);
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const selected=await client.query<{status:string;doer_id:string|null;doer_agent_id:string|null;category:string}>("SELECT status,doer_id,doer_agent_id,category FROM jobs WHERE id=$1 FOR UPDATE",[id]);
    const job=selected.rows[0];
    if (!job) throw new ApiError(404,"job_not_found","This job does not exist.");
    if (job.doer_agent_id!==agent.agentId || job.doer_id!==agent.ownerUserId) throw new ApiError(403,"agent_job_forbidden","This agent is not assigned to this job.");
    assertCanSubmit(job,agent.ownerUserId);
    if (job.category === "image_generation" && !input.evidence.some((url) => url.startsWith("https://res.cloudinary.com/")))
      throw new ApiError(400,"generated_image_required","An image-generation submission must include its hosted JobsAI image.");
    const previous=await client.query<{revision:number}>("SELECT COALESCE(MAX(revision),0)::int AS revision FROM job_submissions WHERE job_id=$1",[id]);
    const revision=previous.rows[0].revision+1,payload=JSON.stringify(input);
    const inserted=await client.query<{id:string;created_at:Date}>(
      `INSERT INTO job_submissions(job_id,submitted_by,revision,payload_ciphertext,payload_digest,submitted_by_agent_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,
      [id,agent.ownerUserId,revision,encryptPayload(payload,`submission:${id}:${revision}`),payloadDigest(payload),agent.agentId],
    );
    await client.query("UPDATE jobs SET status='submitted',active_submission_id=$2,submitted_at=now(),updated_at=now() WHERE id=$1",[id,inserted.rows[0].id]);
    await client.query("INSERT INTO job_events(job_id,actor_id,event_type,details) VALUES($1,$2,'job.submitted',$3)",[id,agent.ownerUserId,JSON.stringify({submissionId:inserted.rows[0].id,revision,workerType:"ai",agentId:agent.agentId,agentName:agent.name})]);
    await client.query("COMMIT");
    response.status(201).json({data:{id:inserted.rows[0].id,jobId:id,revision,submittedAt:inserted.rows[0].created_at,submittedByAgent:{id:agent.agentId,name:agent.name}}});
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));

agentRuntimeRouter.post("/jobs/:id/unclaim", asyncRoute(async (request,response) => {
  const id=uuid.parse(request.params.id),agent=request.agentRuntime!,client=await db.connect();
  try {
    await client.query("BEGIN");
    const row=await client.query<{status:string;doer_agent_id:string|null;doer_id:string|null;has_submissions:boolean}>(
      `SELECT j.status,j.doer_agent_id,j.doer_id,EXISTS(SELECT 1 FROM job_submissions s WHERE s.job_id=j.id) AS has_submissions
         FROM jobs j WHERE j.id=$1 FOR UPDATE`,[id],
    );
    const job=row.rows[0];
    if (!job) throw new ApiError(404,"job_not_found","This job does not exist.");
    if (job.doer_agent_id!==agent.agentId || job.doer_id!==agent.ownerUserId) throw new ApiError(403,"agent_job_forbidden","This agent is not assigned to this job.");
    if (job.status!=="in_progress" || job.has_submissions) throw new ApiError(409,"job_not_unclaimable","An agent can unclaim only before submitting work.");
    await client.query("UPDATE jobs SET doer_id=NULL,doer_agent_id=NULL,status='ready',claimed_at=NULL,updated_at=now() WHERE id=$1",[id]);
    await client.query("INSERT INTO job_events(job_id,actor_id,event_type,details) VALUES($1,$2,'job.unclaimed',$3)",[id,agent.ownerUserId,JSON.stringify({workerType:"ai",agentId:agent.agentId})]);
    await client.query("COMMIT");
    response.json({data:{jobId:id,status:"ready"}});
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));
