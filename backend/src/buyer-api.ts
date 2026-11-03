import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { erc20Abi, formatUnits } from "viem";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { decryptPayload, encryptPayload, payloadDigest } from "./crypto.js";
import { createSettlement, createJobRecord, appendEvent } from "./jobs.js";
import { publicClient } from "./escrow.js";
import { ApiError, asyncRoute } from "./http.js";
import { assertCanDispute, assertCanRequestRevision, assertNewWorkAvailable } from "./lifecycle.js";
import { assertMinimumJobAmount, createJobInputSchema, parseDeadline, parseJobAmount } from "./job-input.js";
import { processSettlement } from "./settlement.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";
import { DOCUMENT_CONTENT_TYPES, MAX_DOCUMENT_BYTES, uploadJobSourceDocument } from "./media.js";

export const buyerKeysRouter = Router();

type BuyerApiIdentity = { userId: string; walletAddress: string; keyId: string };
declare global {
  namespace Express {
    interface Request { buyerApi?: BuyerApiIdentity }
  }
}

export function newBuyerApiKey() {
  return `jsai_buyer_${randomBytes(32).toString("base64url")}`;
}

export function hashBuyerApiKey(token: string) {
  return createHash("sha256").update(`${config.AUTH_TOKEN_PEPPER}:${token}`).digest("hex");
}

buyerKeysRouter.use(requireAuth);
buyerKeysRouter.get("/", asyncRoute(async (request, response) => {
  const result = await db.query<{ id: string; token_prefix: string; created_at: Date; last_used_at: Date | null }>(
    "SELECT id,token_prefix,created_at,last_used_at FROM buyer_api_keys WHERE user_id=$1 AND revoked_at IS NULL",
    [request.auth!.userId],
  );
  response.json({ data: result.rows[0] ? {
    id: result.rows[0].id, prefix: result.rows[0].token_prefix,
    createdAt: result.rows[0].created_at, lastUsedAt: result.rows[0].last_used_at,
  } : null });
}));

buyerKeysRouter.post("/", rateLimit([
  { scope: "buyer-api-key-rotate", limit: 5, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser },
]), asyncRoute(async (request, response) => {
  const token = newBuyerApiKey();
  const id = randomUUID();
  const tokenPrefix = `${token.slice(0, 11)}${token.slice(11, 19)}`;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`buyer-api-key:${request.auth!.userId}`]);
    await client.query("UPDATE buyer_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND revoked_at IS NULL", [request.auth!.userId]);
    const inserted = await client.query<{ id: string; created_at: Date }>(
      "INSERT INTO buyer_api_keys(user_id,token_hash,token_prefix) VALUES($1,$2,$3) RETURNING id,created_at",
      [request.auth!.userId, hashBuyerApiKey(token), tokenPrefix],
    );
    await client.query("COMMIT");
    response.status(201).json({ data: { id: inserted.rows[0].id, apiKey: token, prefix: tokenPrefix, createdAt: inserted.rows[0].created_at }, tokenWarning: "Copy this key now. It is shown only once. Generating a new key revokes the previous key." });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}));

buyerKeysRouter.post("/revoke", rateLimit([
  { scope: "buyer-api-key-revoke", limit: 10, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser },
]), asyncRoute(async (request, response) => {
  const result = await db.query("UPDATE buyer_api_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL RETURNING id", [request.auth!.userId]);
  response.json({ data: { revoked: (result.rowCount ?? 0) > 0 } });
}));

async function requireBuyerApiKey(request: Request, _response: Response, next: NextFunction) {
  try {
    const token = request.header("authorization")?.match(/^Bearer\s+(jsai_buyer_[A-Za-z0-9_-]+)$/)?.[1];
    if (!token) throw new ApiError(401, "buyer_api_unauthenticated", "A JobsAI buyer API key is required.");
    const result = await db.query<{ key_id: string; user_id: string; wallet_address: string }>(
      `SELECT k.id AS key_id,k.user_id,u.wallet_address
         FROM buyer_api_keys k JOIN users u ON u.id=k.user_id
        WHERE k.token_hash=$1 AND k.revoked_at IS NULL`, [hashBuyerApiKey(token)],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(401, "buyer_api_invalid", "This buyer API key is invalid or has been revoked.");
    await db.query("UPDATE buyer_api_keys SET last_used_at=now() WHERE id=$1", [row.key_id]);
    request.buyerApi = { userId: row.user_id, walletAddress: row.wallet_address, keyId: row.key_id };
    next();
  } catch (error) { next(error); }
}

type BalanceTerms = { asset: "eth" | "usdg"; token_address: string | null; escrow_address: string };
export type EscrowBalanceReader = (terms: BalanceTerms) => Promise<bigint>;
export type BlockNumberReader = () => Promise<bigint>;
export async function readEscrowBalance(terms: BalanceTerms) {
  if (terms.asset === "eth") return publicClient.getBalance({ address: terms.escrow_address as `0x${string}` });
  if (!terms.token_address) throw new ApiError(503, "usdg_unconfigured", "USDG jobs are not enabled until USDG_TOKEN_ADDRESS is configured.");
  return publicClient.readContract({ address: terms.token_address as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [terms.escrow_address as `0x${string}`] });
}

type BuyerJob = {
  id: string; client_id: string; title: string; description: string; acceptance_criteria: string[];
  category: string; asset: "eth" | "usdg"; amount_raw: string; token_address: string | null;
  status: string; deadline_at: Date | null; funding_tx_hash: string | null; funding_block: string | null;
  escrow_address: string; created_at: Date; funded_at: Date | null; claimed_at: Date | null;
  submitted_at: Date | null; settled_at: Date | null; doer_wallet: string | null; doer_agent_name: string | null;
  revision_count: number; source_file_required: boolean; source_file_url: string | null;
};

const buyerJobSelect = `SELECT j.id,j.client_id,j.title,j.description,j.acceptance_criteria,j.category,j.asset,j.amount_raw::text,
       j.token_address,j.status,j.deadline_at,j.funding_tx_hash,j.funding_block::text,j.created_at,j.funded_at,j.claimed_at,
       j.submitted_at,j.settled_at,j.revision_count,j.source_file_required,j.source_file_url,ew.address AS escrow_address,
       d.wallet_address AS doer_wallet,a.name AS doer_agent_name
  FROM jobs j JOIN job_escrow_wallets ew ON ew.job_id=j.id
  LEFT JOIN users d ON d.id=j.doer_id LEFT JOIN ai_agents a ON a.id=j.doer_agent_id`;

function buyerJobView(job: BuyerJob) {
  return {
    id: job.id, title: job.title, description: job.description, acceptanceCriteria: job.acceptance_criteria,
    category: job.category, asset: job.asset.toUpperCase(), amount: formatUnits(BigInt(job.amount_raw), job.asset === "eth" ? 18 : config.USDG_DECIMALS),
    amountRaw: job.amount_raw, tokenAddress: job.token_address, status: job.status,
    escrowAddress: job.escrow_address, fundingTransaction: job.funding_tx_hash, fundingBlock: job.funding_block,
    deadlineAt: job.deadline_at, createdAt: job.created_at, fundedAt: job.funded_at,
    claimedAt: job.claimed_at, submittedAt: job.submitted_at, settledAt: job.settled_at,
    worker: job.doer_wallet ? { wallet: job.doer_wallet, ...(job.doer_agent_name ? { agentName: job.doer_agent_name } : {}) } : null,
    revisionCount: job.revision_count,
    sourceFile: job.source_file_required ? { required: true, url: job.source_file_url } : { required: false, url: null },
  };
}

async function getOwnedBuyerJob(id: string, userId: string) {
  const result = await db.query<BuyerJob>(`${buyerJobSelect} WHERE j.id=$1 AND j.client_id=$2`, [id, userId]);
  if (!result.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
  return result.rows[0];
}

export function createBuyerJobsRouter(balanceReader: EscrowBalanceReader = readEscrowBalance, blockNumberReader: BlockNumberReader = () => publicClient.getBlockNumber()) {
  const router = Router();
  router.use(requireBuyerApiKey);
  router.use(rateLimit([
    { scope: "buyer-api-key", limit: 300, windowSeconds: 60, identity: requestIdentity.buyerApiUser },
  ]));

  router.get("/", asyncRoute(async (request, response) => {
    const results = await db.query<BuyerJob>(`${buyerJobSelect} WHERE j.client_id=$1 ORDER BY j.created_at DESC LIMIT 100`, [request.buyerApi!.userId]);
    response.json({ data: results.rows.map(buyerJobView) });
  }));

  router.post("/", rateLimit([
    { scope: "buyer-api-job-create", limit: 20, windowSeconds: 3_600, identity: requestIdentity.buyerApiUser },
  ]), asyncRoute(async (request, response) => {
    assertNewWorkAvailable(config.PAUSE_NEW_WORK);
    const input = createJobInputSchema.parse(request.body);
    if (input.asset === "usdg" && !config.USDG_TOKEN_ADDRESS)
      throw new ApiError(503, "usdg_unconfigured", "USDG jobs are not enabled until USDG_TOKEN_ADDRESS is configured.");
    const amount = parseJobAmount(input.asset, input.amount, config.USDG_DECIMALS);
    const minimum = parseJobAmount(input.asset, input.asset === "eth" ? config.MIN_JOB_ETH_AMOUNT : config.MIN_JOB_USDG_AMOUNT, config.USDG_DECIMALS);
    assertMinimumJobAmount(amount, minimum, input.asset);
    if (input.selectionMode === "invite" && !input.inviteWallet)
      throw new ApiError(400, "invite_wallet_required", "Enter the wallet address of the worker you want to invite.");
    if (input.inviteWallet && input.selectionMode !== "invite")
      throw new ApiError(400, "invite_requires_invite_mode", "Choose invite mode to send this job to a specific wallet.");
    if (input.inviteWallet === request.buyerApi!.walletAddress.toLowerCase())
      throw new ApiError(400, "cannot_invite_self", "You cannot invite your own wallet to your job.");
    const job = await createJobRecord(request.buyerApi!.userId, {
      title: input.title, description: input.description, acceptanceCriteria: input.acceptanceCriteria,
      category: input.category, asset: input.asset, amountRaw: amount,
      deadlineAt: parseDeadline(request.body?.deadlineAt), selectionMode: input.selectionMode,
      sourceFileRequired: input.sourceFileRequired,
      invitation: input.inviteWallet ? { wallet: input.inviteWallet, message: input.inviteMessage ?? null } : undefined,
    });
    response.status(201).json({ data: {
      id: job.id, title: job.title, status: job.status, asset: job.asset, amount: job.amount,
      amountRaw: job.amountRaw, tokenAddress: job.tokenAddress, escrowAddress: job.escrowAddress,
      fundingStatusUrl: `/v1/buyer/jobs/${job.id}/funding-status`,
    } });
  }));

  router.get("/:id", asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    response.json({ data: buyerJobView(await getOwnedBuyerJob(id, request.buyerApi!.userId)) });
  }));

  router.post("/:id/funding-status", asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    let job = await getOwnedBuyerJob(id, request.buyerApi!.userId);
    const balance = await balanceReader({ asset: job.asset, token_address: job.token_address, escrow_address: job.escrow_address });
    const required = BigInt(job.amount_raw);
    const balanceSufficient = balance >= required;
    if (job.status === "awaiting_funding" && balanceSufficient) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1 AND client_id=$2 FOR UPDATE", [id, request.buyerApi!.userId]);
        if (!locked.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
        if (locked.rows[0].status === "awaiting_funding") {
          const block = await blockNumberReader().catch(() => null);
          await client.query("UPDATE jobs SET status='ready',funded_at=now(),funding_block=$2,updated_at=now() WHERE id=$1", [id, block?.toString() ?? null]);
          await appendEvent(client, id, request.buyerApi!.userId, "job.funding_balance_verified", {
            asset: job.asset, escrowAddress: job.escrow_address, requiredAmountRaw: job.amount_raw,
            observedBalanceRaw: balance.toString(), ...(block === null ? {} : { blockNumber: block.toString() }),
          });
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
      finally { client.release(); }
      job = await getOwnedBuyerJob(id, request.buyerApi!.userId);
    }
    response.json({ data: {
      jobId: id, status: job.status, asset: job.asset.toUpperCase(), escrowAddress: job.escrow_address,
      requiredAmount: formatUnits(required, job.asset === "eth" ? 18 : config.USDG_DECIMALS),
      observedBalance: formatUnits(balance, job.asset === "eth" ? 18 : config.USDG_DECIMALS),
      balanceSufficient, fundingVerified: balanceSufficient && job.status !== "awaiting_funding",
    } });
  }));

  router.post("/:id/source-file", express.raw({ type: [...DOCUMENT_CONTENT_TYPES], limit: MAX_DOCUMENT_BYTES }), asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    if (!Buffer.isBuffer(request.body)) throw new ApiError(415, "unsupported_document_type", "Use a PDF, DOCX, Markdown, text, or CSV file.");
    const selected = await db.query<{ status: string; source_file_required: boolean; category: string }>(
      "SELECT status,source_file_required,category FROM jobs WHERE id=$1 AND client_id=$2 AND category IN ('translation','data')",
      [id, request.buyerApi!.userId],
    );
    const job = selected.rows[0];
    if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
    if (!job.source_file_required) throw new ApiError(409, "source_file_not_requested", "This job was created without a required source document.");
    if (job.category === "data" && request.header("content-type")?.split(";")[0].trim().toLowerCase() !== "text/csv")
      throw new ApiError(415, "unsupported_dataset_type", "Data jobs need a CSV spreadsheet.");
    if (job.status !== "awaiting_funding") throw new ApiError(409, "source_file_locked", "The source document can only be added before the job is funded.");
    const uploaded = await uploadJobSourceDocument(request.body, request.header("content-type")?.split(";")[0].trim().toLowerCase() || "", id, request.header("x-jobsai-file-name"));
    const saved = await db.query("UPDATE jobs SET source_file_url=$2,updated_at=now() WHERE id=$1 AND client_id=$3 AND status='awaiting_funding' AND source_file_required RETURNING id", [id,uploaded.url,request.buyerApi!.userId]);
    if (!saved.rowCount) throw new ApiError(409, "source_file_locked", "The job changed while its source document was uploading. Refresh and try again.");
    response.status(201).json({ data: uploaded });
  }));

  router.get("/:id/submissions", asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    await getOwnedBuyerJob(id, request.buyerApi!.userId);
    const rows = await db.query<{ id: string; revision: number; payload_ciphertext: string; created_at: Date }>(
      "SELECT id,revision,payload_ciphertext,created_at FROM job_submissions WHERE job_id=$1 ORDER BY revision", [id],
    );
    response.json({ data: rows.rows.map((row) => ({ id: row.id, revision: row.revision, ...JSON.parse(decryptPayload(row.payload_ciphertext, `submission:${id}:${row.revision}`)), createdAt: row.created_at })) });
  }));

  router.post("/:id/revisions", asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const feedback = z.string().trim().min(1).max(10_000).parse(request.body?.feedback);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ client_id: string; status: string; active_submission_id: string | null }>("SELECT client_id,status,active_submission_id FROM jobs WHERE id=$1 AND client_id=$2 FOR UPDATE", [id,request.buyerApi!.userId]);
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      assertCanRequestRevision(job, request.buyerApi!.userId);
      const previous = await client.query<{ revision: number }>("SELECT revision FROM job_submissions WHERE id=$1", [job.active_submission_id]);
      const revision = previous.rows[0].revision;
      await client.query("INSERT INTO job_revisions(job_id,submission_id,requested_by,feedback_ciphertext,feedback_digest) VALUES($1,$2,$3,$4,$5)", [id,job.active_submission_id,request.buyerApi!.userId,encryptPayload(feedback,`revision:${id}:${revision}`),payloadDigest(feedback)]);
      await client.query("UPDATE jobs SET status='revision_requested',revision_count=revision_count+1,updated_at=now() WHERE id=$1", [id]);
      await appendEvent(client,id,request.buyerApi!.userId,"job.revision_requested",{ submissionId: job.active_submission_id,revision });
      await client.query("COMMIT");
      response.json({ data: { jobId: id,status: "revision_requested" } });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }));

  router.post("/:id/accept", asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await createSettlement(id,request.buyerApi!.userId,"client_acceptance","pay_doer");
    response.status(202).json({ data: result });
    void processSettlement(id).catch((error) => console.error(`Buyer API settlement ${id} failed to start:`,error));
  }));

  router.post("/:id/disputes", asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const reason = z.string().trim().min(1).max(10_000).parse(request.body?.reason);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ client_id: string; doer_id: string | null; status: string }>("SELECT client_id,doer_id,status FROM jobs WHERE id=$1 AND client_id=$2 FOR UPDATE", [id,request.buyerApi!.userId]);
      const job = selected.rows[0];
      if (!job) throw new ApiError(404, "job_not_found", "This job does not exist.");
      assertCanDispute(job,request.buyerApi!.userId);
      await client.query("INSERT INTO job_disputes(job_id,opened_by,reason_ciphertext,reason_digest) VALUES($1,$2,$3,$4)",[id,request.buyerApi!.userId,encryptPayload(reason,`dispute:${id}`),payloadDigest(reason)]);
      await client.query("UPDATE jobs SET status='disputed',updated_at=now() WHERE id=$1",[id]);
      await appendEvent(client,id,request.buyerApi!.userId,"job.disputed");
      await client.query("COMMIT");
      response.status(201).json({ data: { jobId:id,status:"disputed" } });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }));

  router.post("/:id/cancel", asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await createSettlement(id,request.buyerApi!.userId,"client_cancellation","refund_client");
    response.status(202).json({ data: result });
    void processSettlement(id).catch((error) => console.error(`Buyer API refund ${id} failed to start:`,error));
  }));

  return router;
}

export const buyerJobsRouter = createBuyerJobsRouter();
