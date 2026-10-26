import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { PoolClient } from "pg";
import { formatUnits } from "viem";
import { z } from "zod";
import { assertTeamPassword, clearTeamSessionCookie, requireAuth, requireTeam, requireTeamPassword, setTeamSessionCookie } from "./auth.js";
import { config, teamWallets } from "./config.js";
import { decryptPayload, encryptPayload, payloadDigest } from "./crypto.js";
import { db } from "./db/index.js";
import { makeEscrowWallet, verifyJobFunding, type FundingTerms, type JobAsset } from "./escrow.js";
import { ApiError, asyncRoute } from "./http.js";
import { processSettlement } from "./settlement.js";
import { assertMinimumJobAmount, createJobInputSchema, parseDeadline, parseJobAmount, submissionInputSchema } from "./job-input.js";
import { assertActiveClaimCapacity, assertCanCancelFundedJob, assertCanDispute, assertCanRequestRevision, assertCanSubmit, assertCanUnclaim, assertClaimable, assertDisputed, assertJobClient, assertParticipants, assertSettlementAllowed } from "./lifecycle.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";

export const jobsRouter = Router();
const uuid = z.string().uuid();
type JobRow = {
  id: string;
  client_id: string;
  client_wallet: string;
  doer_id: string | null;
  doer_wallet: string | null;
  title: string;
  description: string;
  acceptance_criteria: string[];
  asset: JobAsset;
  amount_raw: string;
  token_address: string | null;
  status: string;
  deadline_at: Date | null;
  funding_tx_hash: string | null;
  funding_block: string | null;
  active_submission_id: string | null;
  revision_count: number;
  escrow_address: string;
  created_at: Date;
  funded_at: Date | null;
  claimed_at: Date | null;
  submitted_at: Date | null;
  settled_at: Date | null;
  settlement_status?: string | null;
  settlement_outcome?: string | null;
  settlement_error?: string | null;
  settlement_recipient?: string | null;
  settlement_payout_signed_tx?: string | null;
  settlement_lease_until?: Date | null;
};

const jobSelect = `SELECT j.*, c.wallet_address AS client_wallet, d.wallet_address AS doer_wallet,
    ew.address AS escrow_address, s.status AS settlement_status, s.outcome AS settlement_outcome, s.error AS settlement_error,
    s.recipient AS settlement_recipient, s.payout_signed_tx AS settlement_payout_signed_tx,
    s.lease_until AS settlement_lease_until
  FROM jobs j JOIN users c ON c.id=j.client_id
  LEFT JOIN users d ON d.id=j.doer_id
  JOIN job_escrow_wallets ew ON ew.job_id=j.id
  LEFT JOIN job_settlements s ON s.job_id=j.id`;

function presentJob(job: JobRow) {
  return {
    id: job.id,
    clientWallet: job.client_wallet,
    doerWallet: job.doer_wallet,
    title: job.title,
    description: job.description,
    acceptanceCriteria: job.acceptance_criteria,
    asset: job.asset.toUpperCase(),
    amount: formatUnits(BigInt(job.amount_raw), job.asset === "eth" ? 18 : config.USDG_DECIMALS),
    amountRaw: job.amount_raw,
    tokenAddress: job.token_address,
    status: job.status,
    deadlineAt: job.deadline_at,
    escrowAddress: job.escrow_address,
    fundingTransaction: job.funding_tx_hash,
    revisionCount: job.revision_count,
    createdAt: job.created_at,
    fundedAt: job.funded_at,
    claimedAt: job.claimed_at,
    claimExpiresAt: job.status === "in_progress" && job.claimed_at
      ? new Date(job.claimed_at.getTime() + config.CLAIM_EXPIRY_HOURS * 60 * 60_000)
      : null,
    submittedAt: job.submitted_at,
    settledAt: job.settled_at,
    payoutRecipient: job.settlement_recipient ?? job.doer_wallet,
    payoutRecoveryAvailable: job.status === "settlement_pending" && job.settlement_status === "pending" && job.settlement_outcome === "pay_doer" && Boolean(job.settlement_error) && !job.settlement_payout_signed_tx && (!job.settlement_lease_until || job.settlement_lease_until < new Date()),
  };
}

async function appendEvent(
  client: { query: (text: string, values?: any[]) => Promise<any> },
  jobId: string,
  actorId: string | null,
  eventType: string,
  details: Record<string, unknown> = {},
) {
  await client.query(
    "INSERT INTO job_events (job_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4)",
    [jobId, actorId, eventType, JSON.stringify(details)],
  );
}

export async function releaseExpiredClaims() {
  let released = 0;
  for (let batch = 0; batch < 5; batch++) {
    const result = await db.query(
      `WITH expired AS (
         SELECT j.id,j.doer_id FROM jobs j
         WHERE j.status='in_progress'
           AND j.claimed_at<=now()-($1::int*interval '1 hour')
           AND NOT EXISTS (SELECT 1 FROM job_submissions sub WHERE sub.job_id=j.id)
         ORDER BY j.claimed_at
         LIMIT 100
         FOR UPDATE SKIP LOCKED
       ), released AS (
         UPDATE jobs j SET doer_id=NULL,status='ready',claimed_at=NULL,updated_at=now()
         FROM expired e WHERE j.id=e.id
         RETURNING j.id
       )
       INSERT INTO job_events(job_id,event_type,details)
       SELECT id,'job.claim_expired',jsonb_build_object('claimExpiryHours',$1::int) FROM released
       RETURNING job_id`,
      [config.CLAIM_EXPIRY_HOURS],
    );
    released += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < 100) break;
  }
  return released;
}

jobsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = createJobInputSchema.parse(request.body);
    if (input.asset === "usdg" && !config.USDG_TOKEN_ADDRESS)
      throw new ApiError(503, "usdg_unconfigured", "USDG jobs are not enabled until USDG_TOKEN_ADDRESS is configured.");
    const amount = parseJobAmount(input.asset, input.amount, config.USDG_DECIMALS);
    const minimum = parseJobAmount(input.asset, input.asset === "eth" ? config.MIN_JOB_ETH_AMOUNT : config.MIN_JOB_USDG_AMOUNT, config.USDG_DECIMALS);
    assertMinimumJobAmount(amount, minimum, input.asset);
    const id = randomUUID();
    const escrow = makeEscrowWallet(id);
    const deadlineAt = parseDeadline(request.body?.deadlineAt);

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`jobs:create:${request.auth!.userId}`]);
      const recent = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM jobs WHERE client_id=$1 AND created_at>now()-interval '1 hour'",
        [request.auth!.userId],
      );
      if (Number(recent.rows[0].count) >= 10) throw new ApiError(429, "job_creation_rate_limited", "You have reached the job creation limit. Try again later.");
      await client.query(
        `INSERT INTO jobs (id,client_id,title,description,acceptance_criteria,asset,amount_raw,token_address,deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          request.auth!.userId,
          input.title,
          input.description,
          JSON.stringify(input.acceptanceCriteria),
          input.asset,
          amount.toString(),
          input.asset === "usdg" ? config.USDG_TOKEN_ADDRESS!.toLowerCase() : null,
          deadlineAt,
        ],
      );
      await client.query(
        "INSERT INTO job_escrow_wallets (job_id,address,encrypted_private_key) VALUES ($1,$2,$3)",
        [id, escrow.address, escrow.encryptedPrivateKey],
      );
      await appendEvent(client, id, request.auth!.userId, "job.created", {
        asset: input.asset,
        amountRaw: amount.toString(),
      });
      const created = await client.query<JobRow>(`${jobSelect} WHERE j.id=$1`, [id]);
      await client.query("COMMIT");
      response.status(201).json({ data: presentJob(created.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

jobsRouter.get(
  "/ready",
  asyncRoute(async (request, response) => {
    await releaseExpiredClaims();
    const page = z.coerce.number().int().min(1).max(10_000).default(1).parse(request.query.page);
    const limit = z.coerce.number().int().min(1).max(100).default(30).parse(request.query.limit);
    const result = await db.query<JobRow>(
      `${jobSelect} WHERE j.status='ready' ORDER BY j.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
    response.json({ data: result.rows.map(presentJob), page, limit });
  }),
);

jobsRouter.get(
  "/mine",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query<JobRow>(
      `${jobSelect} WHERE j.client_id=$1 OR j.doer_id=$1 ORDER BY j.updated_at DESC LIMIT 100`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows.map(presentJob) });
  }),
);

jobsRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const result = await db.query<JobRow>(`${jobSelect} WHERE j.id=$1`, [id]);
    const job = result.rows[0];
    if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
    const allowed =
      job.client_id === request.auth!.userId ||
      job.doer_id === request.auth!.userId ||
      teamWallets.has(request.auth!.walletAddress.toLowerCase());
    if (!allowed && job.status !== "ready")
      throw new ApiError(404, "job_not_found", "This job does not exist.");
    response.json({ data: presentJob(job) });
  }),
);

jobsRouter.post(
  "/:id/fund",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(request.body?.transactionHash);
    const job = await db.query<FundingTerms & { status: string }>(
      `SELECT j.id,j.asset,j.amount_raw::text,j.token_address,j.status,u.wallet_address AS client_wallet
       FROM jobs j JOIN users u ON u.id=j.client_id WHERE j.id=$1`,
      [id],
    );
    if (!job.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
    const terms = job.rows[0];
    assertJobClient(terms.client_wallet, request.auth!.walletAddress);
    if (terms.status !== "awaiting_funding") {
      if (terms.status === "ready" && await fundingHashMatches(id, txHash)) {
        response.json({ data: { jobId: id, status: "ready", transactionHash: txHash }, idempotentReplay: true });
        return;
      }
      throw new ApiError(409, "job_not_fundable", "This job is not awaiting funding.");
    }
    const escrow = await db.query<{ address: string }>("SELECT address FROM job_escrow_wallets WHERE job_id=$1", [id]);
    const verified = await verifyJobFunding(terms, escrow.rows[0].address, txHash);

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ status: string; funding_tx_hash: string | null }>(
        "SELECT status,funding_tx_hash FROM jobs WHERE id=$1 FOR UPDATE",
        [id],
      );
      const current = locked.rows[0];
      if (current.status === "ready" && current.funding_tx_hash === txHash.toLowerCase()) {
        await client.query("COMMIT");
        response.json({ data: { jobId: id, status: "ready", transactionHash: txHash }, idempotentReplay: true });
        return;
      }
      if (current.status !== "awaiting_funding")
        throw new ApiError(409, "job_not_fundable", "This job is no longer awaiting funding.");
      await client.query(
        "UPDATE jobs SET status='ready',funding_tx_hash=$2,funding_block=$3,funded_at=now(),updated_at=now() WHERE id=$1",
        [id, verified.hash, verified.blockNumber],
      );
      await appendEvent(client, id, request.auth!.userId, "job.funded", {
        transactionHash: verified.hash,
        blockNumber: verified.blockNumber,
      });
      await client.query("COMMIT");
      response.json({ data: { jobId: id, status: "ready", transactionHash: verified.hash } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

async function fundingHashMatches(jobId: string, txHash: string) {
  const result = await db.query("SELECT 1 FROM jobs WHERE id=$1 AND funding_tx_hash=$2", [jobId, txHash.toLowerCase()]);
  return Boolean(result.rowCount);
}

jobsRouter.post(
  "/:id/claim",
  requireAuth,
  asyncRoute(async (request, response) => {
    await releaseExpiredClaims();
    const id = uuid.parse(request.params.id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [request.auth!.userId]);
      const locked = await client.query<{ status: string; client_id: string; deadline_at: Date | null }>(
        "SELECT status,client_id,deadline_at FROM jobs WHERE id=$1 FOR UPDATE",
        [id],
      );
      const job = locked.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      assertClaimable(job, request.auth!.userId);
      const active = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM jobs WHERE doer_id=$1 AND status IN ('in_progress','submitted','revision_requested','disputed','settlement_pending')",
        [request.auth!.userId],
      );
      assertActiveClaimCapacity(Number(active.rows[0].count), config.MAX_ACTIVE_CLAIMS_PER_WALLET);
      await client.query("UPDATE jobs SET doer_id=$2,status='in_progress',claimed_at=now(),updated_at=now() WHERE id=$1", [
        id,
        request.auth!.userId,
      ]);
      await appendEvent(client, id, request.auth!.userId, "job.claimed");
      await client.query("COMMIT");
      response.json({ data: { jobId: id, status: "in_progress" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

jobsRouter.post(
  "/:id/payout-recipient",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const recipient = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(request.body?.address).toLowerCase();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `SELECT j.id FROM jobs j JOIN job_settlements s ON s.job_id=j.id
         WHERE j.id=$1 AND j.doer_id=$2 AND j.status='settlement_pending'
           AND s.status='pending' AND s.outcome='pay_doer' AND s.error IS NOT NULL AND s.payout_signed_tx IS NULL
           AND (s.lease_until IS NULL OR s.lease_until<now())
         FOR UPDATE OF j,s`, [id, request.auth!.userId],
      );
      if (!result.rowCount) throw new ApiError(409, "payout_recipient_locked", "This job has no recoverable payout. Contact JobsAI team review for help.");
      await client.query("UPDATE job_settlements SET recipient=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE job_id=$1", [id, recipient]);
      await appendEvent(client, id, request.auth!.userId, "job.payout_recipient_updated", { recipient });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    response.status(202).json({ data: { jobId: id, status: "settlement_pending", recipient } });
    void processSettlement(id).catch((error) => console.error(`Payout recovery ${id} failed to start:`, error));
  }),
);

jobsRouter.post(
  "/:id/cancel",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const client = await db.connect();
    let result: { jobId: string; status: string; outcome: string };
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ client_id: string; status: string }>(
        "SELECT client_id,status FROM jobs WHERE id=$1 FOR UPDATE", [id],
      );
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      assertCanCancelFundedJob(job, request.auth!.userId);
      result = await createSettlement(id, request.auth!.userId, "client_cancellation", "refund_client", client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.status(202).json({ data: result });
    void processSettlement(id).catch((error) => console.error(`Cancellation refund ${id} failed to start:`, error));
  }),
);

jobsRouter.post(
  "/:id/unclaim",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ doer_id: string | null; status: string; has_submissions: boolean }>(
        `SELECT j.doer_id,j.status,EXISTS(SELECT 1 FROM job_submissions s WHERE s.job_id=j.id) AS has_submissions
         FROM jobs j WHERE j.id=$1 FOR UPDATE`,
        [id],
      );
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      assertCanUnclaim(job, request.auth!.userId);
      await client.query("UPDATE jobs SET doer_id=NULL,status='ready',claimed_at=NULL,updated_at=now() WHERE id=$1", [id]);
      await appendEvent(client, id, request.auth!.userId, "job.unclaimed");
      await client.query("COMMIT");
      response.json({ data: { jobId: id, status: "ready" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

jobsRouter.post(
  "/:id/release-worker",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ client_id: string; doer_id: string | null; status: string; has_submissions: boolean }>(
        `SELECT j.client_id,j.doer_id,j.status,EXISTS(SELECT 1 FROM job_submissions s WHERE s.job_id=j.id) AS has_submissions
         FROM jobs j WHERE j.id=$1 FOR UPDATE`, [id],
      );
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      if (job.client_id !== request.auth!.userId) throw new ApiError(403, "client_only", "Only the client can release the assigned worker.");
      if (job.status !== "in_progress" || !job.doer_id || job.has_submissions)
        throw new ApiError(409, "worker_not_releasable", "A worker can be released only before any work has been submitted.");
      await client.query("UPDATE jobs SET doer_id=NULL,status='ready',claimed_at=NULL,updated_at=now() WHERE id=$1", [id]);
      await appendEvent(client, id, request.auth!.userId, "job.worker_released_by_client");
      await client.query("COMMIT");
      response.json({ data: { jobId: id, status: "ready" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }),
);

jobsRouter.post(
  "/:id/submissions",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const input = submissionInputSchema.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ status: string; doer_id: string | null }>(
        "SELECT status,doer_id FROM jobs WHERE id=$1 FOR UPDATE",
        [id],
      );
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      assertCanSubmit(job, request.auth!.userId);
      const previous = await client.query<{ revision: number }>(
        "SELECT COALESCE(MAX(revision),0)::int AS revision FROM job_submissions WHERE job_id=$1",
        [id],
      );
      const revision = previous.rows[0].revision + 1;
      const payload = JSON.stringify(input);
      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO job_submissions (job_id,submitted_by,revision,payload_ciphertext,payload_digest)
         VALUES ($1,$2,$3,$4,$5) RETURNING id,created_at`,
        [id, request.auth!.userId, revision, encryptPayload(payload, `submission:${id}:${revision}`), payloadDigest(payload)],
      );
      await client.query(
        "UPDATE jobs SET status='submitted',active_submission_id=$2,submitted_at=now(),updated_at=now() WHERE id=$1",
        [id, inserted.rows[0].id],
      );
      await appendEvent(client, id, request.auth!.userId, "job.submitted", { submissionId: inserted.rows[0].id, revision });
      await client.query("COMMIT");
      response.status(201).json({ data: { id: inserted.rows[0].id, jobId: id, revision, submittedAt: inserted.rows[0].created_at } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

jobsRouter.get(
  "/:id/submissions",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const access = await db.query<{ client_id: string; doer_id: string | null }>(
      "SELECT client_id,doer_id FROM jobs WHERE id=$1",
      [id],
    );
    if (!access.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
    assertParticipants(access.rows[0], request.auth!.userId);
    const rows = await db.query<{
      id: string;
      revision: number;
      payload_ciphertext: string;
      payload_digest: string;
      created_at: Date;
    }>("SELECT id,revision,payload_ciphertext,payload_digest,created_at FROM job_submissions WHERE job_id=$1 ORDER BY revision", [id]);
    response.json({
      data: rows.rows.map(({ payload_ciphertext, ...row }) => ({
        ...row,
        ...JSON.parse(decryptPayload(payload_ciphertext, `submission:${id}:${row.revision}`)),
      })),
    });
  }),
);

jobsRouter.post(
  "/:id/revisions",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const feedback = z.string().trim().min(1).max(10_000).parse(request.body?.feedback);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ client_id: string; status: string; active_submission_id: string | null }>(
        "SELECT client_id,status,active_submission_id FROM jobs WHERE id=$1 FOR UPDATE",
        [id],
      );
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      assertCanRequestRevision(job, request.auth!.userId);
      const previousRevision = await client.query<{ revision: number }>(
        "SELECT revision FROM job_submissions WHERE id=$1",
        [job.active_submission_id],
      );
      const revisionNumber = previousRevision.rows[0].revision;
      await client.query(
        `INSERT INTO job_revisions (job_id,submission_id,requested_by,feedback_ciphertext,feedback_digest)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, job.active_submission_id, request.auth!.userId, encryptPayload(feedback, `revision:${id}:${revisionNumber}`), payloadDigest(feedback)],
      );
      await client.query("UPDATE jobs SET status='revision_requested',revision_count=revision_count+1,updated_at=now() WHERE id=$1", [id]);
      await appendEvent(client, id, request.auth!.userId, "job.revision_requested", { submissionId: job.active_submission_id, revision: revisionNumber });
      await client.query("COMMIT");
      response.json({ data: { jobId: id, status: "revision_requested" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

jobsRouter.get(
  "/:id/revisions",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const access = await db.query<{ client_id: string; doer_id: string | null }>("SELECT client_id,doer_id FROM jobs WHERE id=$1", [id]);
    if (!access.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
    assertParticipants(access.rows[0], request.auth!.userId);
    const rows = await db.query<{ id: string; submission_id: string; feedback_ciphertext: string; feedback_digest: string; created_at: Date; revision: number }>(
      `SELECT r.id,r.submission_id,r.feedback_ciphertext,r.feedback_digest,r.created_at,s.revision
       FROM job_revisions r JOIN job_submissions s ON s.id=r.submission_id WHERE r.job_id=$1 ORDER BY r.created_at`,
      [id],
    );
    response.json({ data: rows.rows.map(({ feedback_ciphertext, revision, ...row }) => ({ ...row, revision, feedback: decryptPayload(feedback_ciphertext, `revision:${id}:${revision}`) })) });
  }),
);

jobsRouter.post(
  "/:id/accept",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const result = await createSettlement(id, request.auth!.userId, "client_acceptance", "pay_doer");
    response.status(202).json({ data: result });
    void processSettlement(id).catch((error) => console.error(`Settlement ${id} failed to start:`, error));
  }),
);

jobsRouter.post(
  "/:id/disputes",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = uuid.parse(request.params.id);
    const reason = z.string().trim().min(1).max(10_000).parse(request.body?.reason);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ client_id: string; doer_id: string | null; status: string }>(
        "SELECT client_id,doer_id,status FROM jobs WHERE id=$1 FOR UPDATE",
        [id],
      );
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      assertCanDispute(job, request.auth!.userId);
      await client.query(
        "INSERT INTO job_disputes (job_id,opened_by,reason_ciphertext,reason_digest) VALUES ($1,$2,$3,$4)",
        [id, request.auth!.userId, encryptPayload(reason, `dispute:${id}`), payloadDigest(reason)],
      );
      await client.query("UPDATE jobs SET status='disputed',updated_at=now() WHERE id=$1", [id]);
      await appendEvent(client, id, request.auth!.userId, "job.disputed");
      await client.query("COMMIT");
      response.status(201).json({ data: { jobId: id, status: "disputed" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

async function createSettlement(jobId: string, actorId: string, cause: "client_acceptance" | "client_cancellation" | "team_dispute_resolution", outcome: "pay_doer" | "refund_client", existingClient?: PoolClient) {
  const client = existingClient ?? await db.connect();
  const ownsTransaction = !existingClient;
  try {
    if (ownsTransaction) await client.query("BEGIN");
    const result = await client.query<{ status: string; client_id: string; doer_id: string | null; amount_raw: string; client_wallet: string; doer_wallet: string | null }>(
      `SELECT j.status,j.client_id,j.doer_id,j.amount_raw::text,c.wallet_address AS client_wallet,d.wallet_address AS doer_wallet
       FROM jobs j JOIN users c ON c.id=j.client_id LEFT JOIN users d ON d.id=j.doer_id WHERE j.id=$1 FOR UPDATE OF j`,
      [jobId],
    );
    const job = result.rows[0];
    if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
    assertSettlementAllowed(job, actorId, cause, outcome);
    const recipient = outcome === "pay_doer" ? job.doer_wallet! : job.client_wallet;
    await client.query("INSERT INTO job_settlements (job_id,outcome,recipient,amount_raw) VALUES ($1,$2,$3,$4)", [
      jobId,
      outcome,
      recipient.toLowerCase(),
      job.amount_raw,
    ]);
    await client.query("UPDATE jobs SET status='settlement_pending',updated_at=now() WHERE id=$1", [jobId]);
    await appendEvent(client, jobId, actorId, cause === "client_acceptance" ? "job.accepted" : cause === "client_cancellation" ? "job.cancellation_requested" : "job.dispute_resolved", { outcome });
    if (ownsTransaction) await client.query("COMMIT");
    return { jobId, status: "settlement_pending", outcome };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

export const teamJobsRouter = Router();
teamJobsRouter.post("/auth/login", rateLimit([{ scope: "team-password", limit: 5, windowSeconds: 60, identity: requestIdentity.clientIp }]), requireAuth, requireTeam, asyncRoute(async (request, response) => {
  const input = z.object({ password: z.string().min(1).max(512) }).parse(request.body);
  assertTeamPassword(input.password);
  setTeamSessionCookie(response);
  response.json({ data: { authenticated: true, expiresIn: 8 * 60 * 60 } });
}));
teamJobsRouter.get("/auth/status", requireAuth, requireTeam, requireTeamPassword, (_request, response) => {
  response.json({ data: { authenticated: true } });
});
teamJobsRouter.post("/auth/logout", requireAuth, requireTeam, (_request, response) => {
  clearTeamSessionCookie(response);
  response.status(204).end();
});
teamJobsRouter.use(requireAuth, requireTeam, requireTeamPassword);

teamJobsRouter.get("/disputes", asyncRoute(async (_request, response) => {
  const result = await db.query(
    `${jobSelect} LEFT JOIN job_disputes jd ON jd.job_id=j.id
     WHERE j.status='disputed' OR (j.status='settlement_pending' AND s.status='pending' AND s.error IS NOT NULL AND s.payout_signed_tx IS NULL AND (s.lease_until IS NULL OR s.lease_until<now()))
     ORDER BY COALESCE(jd.created_at,s.updated_at) ASC LIMIT 100`,
  );
  response.json({ data: result.rows.map((job: JobRow) => ({ ...presentJob(job), reviewType: job.status === "disputed" ? "dispute" : "settlement_failure" })) });
}));

teamJobsRouter.get("/disputes/:jobId", asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.jobId);
  const jobResult = await db.query<JobRow>(`${jobSelect} WHERE j.id=$1 AND (j.status='disputed' OR (j.status='settlement_pending' AND s.status='pending' AND s.error IS NOT NULL AND s.payout_signed_tx IS NULL AND (s.lease_until IS NULL OR s.lease_until<now())))`, [id]);
  const job = jobResult.rows[0];
  if (!job) throw new ApiError(404, "review_case_not_found", "This active review case does not exist.");
  const reviewType = job.status === "disputed" ? "dispute" : "settlement_failure";
  const [disputeResult, submissions, revisions, events] = await Promise.all([
    db.query<{ id: string; opened_by: string; reason_ciphertext: string; created_at: Date }>(
      "SELECT id,opened_by,reason_ciphertext,created_at FROM job_disputes WHERE job_id=$1", [id]),
    db.query<{ id: string; revision: number; payload_ciphertext: string; created_at: Date }>(
      "SELECT id,revision,payload_ciphertext,created_at FROM job_submissions WHERE job_id=$1 ORDER BY revision", [id]),
    db.query<{ id: string; submission_id: string; feedback_ciphertext: string; created_at: Date; revision: number }>(
      `SELECT r.id,r.submission_id,r.feedback_ciphertext,r.created_at,s.revision
       FROM job_revisions r JOIN job_submissions s ON s.id=r.submission_id WHERE r.job_id=$1 ORDER BY r.created_at`, [id]),
    db.query("SELECT event_type,details,created_at FROM job_events WHERE job_id=$1 ORDER BY id", [id]),
  ]);
  const dispute = disputeResult.rows[0];
  const settlementReason = reviewType === "settlement_failure" ? `Payout could not be completed: ${job.settlement_error}` : null;
  response.json({ data: {
    job: presentJob(job),
    reviewType,
    dispute: dispute ? { id: dispute.id, openedBy: dispute.opened_by, reason: decryptPayload(dispute.reason_ciphertext, `dispute:${id}`), createdAt: dispute.created_at } : { id: null, openedBy: null, reason: settlementReason, createdAt: job.created_at },
    submissions: submissions.rows.map(({ payload_ciphertext, revision, ...row }) => ({ ...row, revision, ...JSON.parse(decryptPayload(payload_ciphertext, `submission:${id}:${revision}`)) })),
    revisions: revisions.rows.map(({ feedback_ciphertext, revision, ...row }) => ({ ...row, revision, feedback: decryptPayload(feedback_ciphertext, `revision:${id}:${revision}`) })),
    events: events.rows,
  } });
}));

teamJobsRouter.post("/disputes/:jobId/resolve", asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.jobId);
  const input = z.object({ outcome: z.enum(["pay_doer", "refund_client"]), note: z.string().trim().min(1).max(10_000) }).parse(request.body);
  const client = await db.connect();
  let result: { jobId: string; status: string; outcome: string };
  try {
    await client.query("BEGIN");
    const dispute = await client.query<{ id: string }>("SELECT id FROM job_disputes WHERE job_id=$1 AND resolution IS NULL FOR UPDATE", [id]);
    if (dispute.rowCount) {
      result = await createSettlement(id, request.auth!.userId, "team_dispute_resolution", input.outcome, client);
      await client.query(
        `UPDATE job_disputes SET resolution=$2,resolution_note_ciphertext=$3,resolved_by=$4,resolved_at=now() WHERE job_id=$1`,
        [id, input.outcome, encryptPayload(input.note, `resolution:${id}`), request.auth!.userId],
      );
    } else {
      const failed = await client.query<{ client_wallet: string; doer_wallet: string | null }>(
        `SELECT c.wallet_address AS client_wallet,d.wallet_address AS doer_wallet FROM jobs j
         JOIN users c ON c.id=j.client_id LEFT JOIN users d ON d.id=j.doer_id
         JOIN job_settlements s ON s.job_id=j.id
         WHERE j.id=$1 AND j.status='settlement_pending' AND s.status='pending' AND s.error IS NOT NULL AND s.payout_signed_tx IS NULL
           AND (s.lease_until IS NULL OR s.lease_until<now())
         FOR UPDATE OF j,s`, [id],
      );
      if (!failed.rowCount) throw new ApiError(409, "review_case_resolved", "This review case is no longer available.");
      const recipient = input.outcome === "pay_doer" ? failed.rows[0].doer_wallet : failed.rows[0].client_wallet;
      if (!recipient) throw new ApiError(409, "worker_missing", "This job has no worker to pay.");
      await client.query("UPDATE job_settlements SET outcome=$2,recipient=$3,error=NULL,lease_until=NULL,attempts=0,updated_at=now() WHERE job_id=$1", [id, input.outcome, recipient]);
      await client.query("INSERT INTO job_settlement_reviews(job_id,reviewer_id,outcome,recipient,note_ciphertext) VALUES($1,$2,$3,$4,$5)", [id, request.auth!.userId, input.outcome, recipient, encryptPayload(input.note, `settlement-review:${id}`)]);
      await appendEvent(client, id, request.auth!.userId, "job.settlement_failure_reviewed", { outcome: input.outcome, recipient });
      result = { jobId: id, status: "settlement_pending", outcome: input.outcome };
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  response.status(202).json({ data: result });
  void processSettlement(id).catch((error) => console.error(`Settlement ${id} failed to start:`, error));
}));

