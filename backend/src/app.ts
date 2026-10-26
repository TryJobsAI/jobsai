import { timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { createSession, issueNonce, requireAuth, revokeSession } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { jobsRouter, teamJobsRouter } from "./jobs.js";
import { ApiError, asyncRoute, errorHandler } from "./http.js";
import { reconcileSettlements } from "./settlement.js";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES, uploadSubmissionImage } from "./media.js";
import { assertCanSubmit } from "./lifecycle.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";

const app = express();
app.set("trust proxy", config.TRUST_PROXY);
app.use(express.json({ limit: "256kb" }));
app.use("/v1", rateLimit([{ scope: "api", limit: 240, windowSeconds: 60, identity: requestIdentity.clientIp }]));

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/health/ready", asyncRoute(async (_request, response) => {
  await db.query("SELECT 1");
  response.json({ status: "ready" });
}));

const authRouter = Router();
authRouter.post("/nonce", rateLimit([
  { scope: "auth-nonce-ip", limit: 20, windowSeconds: 60, identity: requestIdentity.clientIp },
  { scope: "auth-nonce-wallet", limit: 5, windowSeconds: 600, identity: requestIdentity.walletFromBody },
]), asyncRoute(async (request, response) => {
  const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(request.body?.address);
  response.json({ data: await issueNonce(address) });
}));
authRouter.post("/verify", rateLimit([
  { scope: "auth-verify-ip", limit: 30, windowSeconds: 60, identity: requestIdentity.clientIp },
  { scope: "auth-verify-wallet", limit: 10, windowSeconds: 600, identity: requestIdentity.walletFromBody },
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
app.use("/v1/jobs", jobsRouter);
app.use("/v1/team", teamJobsRouter);
app.use("/v1/cron", cronRouter);
app.use((_request, _response, next) => next(new ApiError(404, "not_found", "This endpoint does not exist.")));
app.use(errorHandler);

export { app };
