import { timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { createSession, issueNonce, requireAuth, revokeSession } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { jobsRouter, teamJobsRouter } from "./jobs.js";
import { ApiError, asyncRoute, errorHandler } from "./http.js";
import { reconcileSettlements } from "./settlement.js";
import { DOCUMENT_CONTENT_TYPES, IMAGE_CONTENT_TYPES, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, uploadJobSourceDocument, uploadSubmissionImage } from "./media.js";
import { assertCanSubmit } from "./lifecycle.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";
import { agentRuntimeRouter, agentsRouter, requireAgentRuntime } from "./agents.js";
import { handleMcpRequest } from "./mcp.js";
import { invitationsRouter } from "./invitations.js";
import { proposalsRouter } from "./proposals.js";
import { servicesRouter } from "./services.js";
import { webhooksRouter } from "./webhooks.js";
import { MAX_SPEECH_AUDIO_BYTES, transcribeSpeech } from "./speech.js";
import { adminRouter } from "./admin.js";
import { workerApplicationsAdminRouter, workerProfilesRouter } from "./worker-profiles.js";
import { buyerJobsRouter, buyerKeysRouter } from "./buyer-api.js";
import { userTagsRouter } from "./user-tags.js";

const app = express();
app.set("trust proxy", config.TRUST_PROXY);
app.use(express.json({ limit: "256kb" }));
app.use("/v1", rateLimit([{ scope: "api", limit: config.NODE_ENV === "test" ? 10_000 : 240, windowSeconds: 60, identity: requestIdentity.clientIp }]));

app.get("/health", (_request, response) => response.json({ status: "ok", gitSha: process.env.GIT_SHA ?? "unknown" }));
app.get("/health/ready", asyncRoute(async (_request, response) => {
  await db.query("SELECT 1");
  response.json({ status: "ready" });
}));

const authRouter = Router();
authRouter.post("/nonce", rateLimit([
  { scope: "auth-nonce-ip", limit: 20, windowSeconds: 60, identity: requestIdentity.clientIp },
  { scope: "auth-nonce-ip-wallet", limit: 5, windowSeconds: 600, identity: requestIdentity.walletFromBodyAndIp },
]), asyncRoute(async (request, response) => {
  const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(request.body?.address);
  response.json({ data: await issueNonce(address) });
}));
authRouter.post("/verify", rateLimit([
  { scope: "auth-verify-ip", limit: 30, windowSeconds: 60, identity: requestIdentity.clientIp },
  { scope: "auth-verify-ip-wallet", limit: 10, windowSeconds: 600, identity: requestIdentity.walletFromBodyAndIp },
]), asyncRoute(async (request, response) => {
  const input = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), nonce: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(request.body);
  response.json({ data: await createSession({ ...input, signature: input.signature as `0x${string}` }) });
}));
authRouter.post("/logout", requireAuth, asyncRoute(async (request, response) => {
  await revokeSession(request);
  response.status(204).end();
}));
authRouter.get("/me", requireAuth, (request, response) => response.json({ data: request.auth }));

const cronRouter = Router();
cronRouter.post("/settle", asyncRoute(async (request, response) => {
  const supplied = request.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(config.CRON_SECRET);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(401, "cron_unauthorized", "A valid cron bearer token is required.");
  await reconcileSettlements();
  response.status(202).json({ data: { status: "reconciliation_started" } });
}));

app.use("/v1/auth", authRouter);
app.post(
  "/v1/jobs/:id/source-file",
  requireAuth,
  rateLimit([
    { scope: "job-source-upload-user", limit: 10, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser },
    { scope: "job-source-upload-ip", limit: 30, windowSeconds: 3_600, identity: requestIdentity.clientIp },
  ]),
  express.raw({ type: [...DOCUMENT_CONTENT_TYPES], limit: MAX_DOCUMENT_BYTES }),
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    if (!Buffer.isBuffer(request.body)) throw new ApiError(415, "unsupported_document_type", "Use a PDF, DOCX, Markdown, or plain text document.");
    const selected = await db.query<{ status: string; source_file_required: boolean }>(
      "SELECT status,source_file_required FROM jobs WHERE id=$1 AND client_id=$2 AND category='translation'",
      [id, request.auth!.userId],
    );
    const job = selected.rows[0];
    if (!job) throw new ApiError(404, "job_not_found", "This translation job does not exist.");
    if (!job.source_file_required) throw new ApiError(409, "source_file_not_requested", "This job was created without a required source document.");
    if (job.status !== "awaiting_funding") throw new ApiError(409, "source_file_locked", "The source document can only be added before the job is funded.");
    const uploaded = await uploadJobSourceDocument(request.body, request.header("content-type")?.split(";")[0].trim().toLowerCase() || "", id, request.header("x-jobsai-file-name"));
    const saved = await db.query(
      "UPDATE jobs SET source_file_url=$2,updated_at=now() WHERE id=$1 AND client_id=$3 AND status='awaiting_funding' AND source_file_required RETURNING id",
      [id, uploaded.url, request.auth!.userId],
    );
    if (!saved.rowCount) throw new ApiError(409, "source_file_locked", "The job changed while its source document was uploading. Please refresh and try again.");
    response.status(201).json({ data: uploaded });
  }),
);
app.post(
  "/v1/media/images",
  requireAuth,
  express.raw({ type: [...IMAGE_CONTENT_TYPES], limit: MAX_IMAGE_BYTES }),
  asyncRoute(async (request, response) => {
    if (!Buffer.isBuffer(request.body)) throw new ApiError(415, "unsupported_image_type", "Upload a JPEG, PNG, WebP, or GIF image. Video files are not accepted.");
    const jobId = z.string().uuid().parse(request.query.jobId);
    const job = await db.query<{ doer_id: string | null; status: string }>("SELECT doer_id,status FROM jobs WHERE id=$1", [jobId]);
    if (!job.rowCount) throw new ApiError(404, "job_not_found", "This job does not exist.");
    assertCanSubmit(job.rows[0], request.auth!.userId);
    const result = await uploadSubmissionImage(request.body, request.header("content-type")?.split(";")[0].trim().toLowerCase() || "", jobId);
    response.status(201).json({ data: result });
  }),
);
app.post(
  "/v1/speech/transcribe",
  requireAuth,
  rateLimit([
    { scope: "speech-transcription-user", limit: 10, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser },
    { scope: "speech-transcription-ip", limit: 30, windowSeconds: 3_600, identity: requestIdentity.clientIp },
  ]),
  express.raw({ type: "*/*", limit: MAX_SPEECH_AUDIO_BYTES }),
  asyncRoute(async (request, response) => {
    if (!Buffer.isBuffer(request.body)) throw new ApiError(400, "audio_required", "Record a short voice brief before requesting a transcript.");
    const result = await transcribeSpeech(request.body, request.header("content-type") || "");
    response.json({ data: result });
  }),
);
app.use("/v1/jobs", proposalsRouter);
app.use("/v1/jobs", invitationsRouter);
app.use("/v1/jobs", jobsRouter);
app.use("/v1/services", servicesRouter);
app.use("/v1/webhooks", webhooksRouter);
app.use("/v1/agents", agentsRouter);
app.use("/v1/agent-runtime", agentRuntimeRouter);
app.use("/v1/team", teamJobsRouter);
app.use("/v1/workers", workerProfilesRouter);
app.use("/v1/user-tags", userTagsRouter);
app.use("/v1/admin", adminRouter);
app.use("/v1/admin/worker-applications", workerApplicationsAdminRouter);
app.use("/v1/buyer/keys", buyerKeysRouter);
app.use("/v1/buyer/jobs", buyerJobsRouter);
// Remote MCP endpoint for AI coding agents, authenticated with an AI worker's runtime token.
app.post("/mcp", rateLimit([{ scope: "mcp", limit: 120, windowSeconds: 60, identity: requestIdentity.clientIp }]), requireAgentRuntime, handleMcpRequest);
app.all("/mcp", (_request, response) => {
  response.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "This JobsAI MCP endpoint is stateless. Send JSON-RPC requests with POST." }, id: null });
});
app.use("/v1/cron", cronRouter);
app.use((_request, _response, next) => next(new ApiError(404, "not_found", "This endpoint does not exist.")));
app.use(errorHandler);

export { app };
