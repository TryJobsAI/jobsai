import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { requireMaster } from "./master-auth.js";
import { parseJobAmount } from "./job-input.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";

export const workerProfilesRouter = Router();
export const workerApplicationsAdminRouter = Router();

const rateTierSchema = z.object({
  name: z.string().trim().min(2).max(50),
  scope: z.string().trim().min(5).max(500),
  asset: z.enum(["eth", "usdg"]),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/),
}).strict();

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  country: z.string().trim().min(2).max(100),
  timeZone: z.string().trim().min(3).max(100),
  workHours: z.string().trim().min(2).max(500),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,39}$/),
  rateTiers: z.array(rateTierSchema).min(1).max(8),
  publicProfile: z.boolean().default(true),
}).strict().superRefine((profile, context) => {
  try { new Intl.DateTimeFormat("en", { timeZone: profile.timeZone }); }
  catch { context.addIssue({ code: "custom", path: ["timeZone"], message: "Enter a valid time zone such as Africa/Lagos." }); }
  const names = new Set<string>();
  profile.rateTiers.forEach((tier, index) => {
    const key = tier.name.toLowerCase();
    if (names.has(key)) context.addIssue({ code: "custom", path: ["rateTiers", index, "name"], message: "Rate tier names must be unique." });
    names.add(key);
    try { parseJobAmount(tier.asset, tier.amount, config.USDG_DECIMALS); }
    catch { context.addIssue({ code: "custom", path: ["rateTiers", index, "amount"], message: "Enter a valid amount for the selected asset." }); }
  });
});

const reviewSchema = z.object({
  decision: z.enum(["approved", "changes_requested", "rejected"]),
  note: z.string().trim().max(2_000).optional().default(""),
}).strict().superRefine((input, context) => {
  if (input.decision !== "approved" && input.note.length < 5)
    context.addIssue({ code: "custom", path: ["note"], message: "Add a note explaining the requested changes or rejection." });
});

type ProfileRow = {
  id: string; user_id: string; slug: string; full_name: string; country: string; time_zone: string;
  work_hours: string; email: string; phone: string; rate_tiers: unknown; public_profile: boolean;
  status: string; review_note: string | null; submitted_at: Date; reviewed_at: Date | null; user_tag?: string | null;
};

function publicFields(profile: ProfileRow) {
  return {
    id: profile.id,
    slug: profile.slug,
    ...(profile.user_tag ? { userTag: profile.user_tag } : {}),
    fullName: profile.full_name,
    country: profile.country,
    timeZone: profile.time_zone,
    workHours: profile.work_hours,
    rateTiers: profile.rate_tiers,
    verified: profile.status === "approved",
  };
}

async function workStats(userId: string) {
  const [metrics, history] = await Promise.all([
    db.query<{ completed_jobs: number; median_first_delivery_seconds: number | null }>(
      `SELECT count(*)::int AS completed_jobs,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM first_submission.created_at-j.claimed_at)) AS median_first_delivery_seconds
         FROM jobs j
         LEFT JOIN LATERAL (SELECT min(created_at) AS created_at FROM job_submissions WHERE job_id=j.id) first_submission ON true
        WHERE j.doer_id=$1 AND j.doer_agent_id IS NULL AND j.status='completed'`, [userId]),
    db.query<{ id: string; title: string; category: string; completed_at: Date; first_delivery_seconds: number | null }>(
      `SELECT j.id,j.title,j.category,j.settled_at AS completed_at,
              EXTRACT(EPOCH FROM first_submission.created_at-j.claimed_at) AS first_delivery_seconds
         FROM jobs j
         LEFT JOIN LATERAL (SELECT min(created_at) AS created_at FROM job_submissions WHERE job_id=j.id) first_submission ON true
        WHERE j.doer_id=$1 AND j.doer_agent_id IS NULL AND j.status='completed'
        ORDER BY j.settled_at DESC NULLS LAST LIMIT 25`, [userId]),
  ]);
  return {
    completedJobs: metrics.rows[0]?.completed_jobs ?? 0,
    medianFirstDeliverySeconds: metrics.rows[0]?.median_first_delivery_seconds == null
      ? null : Math.round(Number(metrics.rows[0].median_first_delivery_seconds)),
    completedJobHistory: history.rows.map((job) => ({
      id: job.id, title: job.title, category: job.category, completedAt: job.completed_at,
    })),
  };
}

workerProfilesRouter.get("/me", requireAuth, asyncRoute(async (request, response) => {
  const selected = await db.query<ProfileRow>("SELECT wp.*,u.user_tag FROM worker_profiles wp JOIN users u ON u.id=wp.user_id WHERE wp.user_id=$1", [request.auth!.userId]);
  if (!selected.rowCount) { response.json({ data: null }); return; }
  const profile = selected.rows[0];
  response.json({ data: {
    ...publicFields(profile), email: profile.email, phone: profile.phone,
    publicProfile: profile.public_profile, status: profile.status, reviewNote: profile.review_note,
    submittedAt: profile.submitted_at, reviewedAt: profile.reviewed_at,
    ...(await workStats(profile.user_id)),
  } });
}));

workerProfilesRouter.put("/me", requireAuth, rateLimit([
  { scope: "worker-profile-submit-user", limit: 5, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser },
]), asyncRoute(async (request, response) => {
  const input = profileSchema.parse(request.body);
  const id = randomUUID();
  const slugBase = input.fullName.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "worker";
  const slug = `${slugBase}-${id.slice(0, 8)}`;
  const result = await db.query<ProfileRow>(
    `INSERT INTO worker_profiles(user_id,slug,full_name,country,time_zone,work_hours,email,phone,rate_tiers,public_profile,status,submitted_at,reviewed_at,review_note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_review',now(),NULL,NULL)
     ON CONFLICT(user_id) DO UPDATE SET full_name=EXCLUDED.full_name,country=EXCLUDED.country,
       time_zone=EXCLUDED.time_zone,work_hours=EXCLUDED.work_hours,email=EXCLUDED.email,phone=EXCLUDED.phone,
       rate_tiers=EXCLUDED.rate_tiers,public_profile=EXCLUDED.public_profile,status='pending_review',
       submitted_at=now(),reviewed_at=NULL,review_note=NULL,updated_at=now()
     RETURNING *`,
    [request.auth!.userId, slug, input.fullName, input.country, input.timeZone, input.workHours,
      input.email.toLowerCase(), input.phone, JSON.stringify(input.rateTiers), input.publicProfile],
  );
  response.status(200).json({ data: {
    ...publicFields(result.rows[0]), email: result.rows[0].email, phone: result.rows[0].phone,
    publicProfile: result.rows[0].public_profile, status: result.rows[0].status,
    reviewNote: null, ...(await workStats(request.auth!.userId)),
  } });
}));

workerProfilesRouter.get("/:slug", asyncRoute(async (request, response) => {
  const slug = z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).parse(request.params.slug);
  const result = await db.query<ProfileRow>("SELECT wp.*,u.user_tag FROM worker_profiles wp JOIN users u ON u.id=wp.user_id WHERE wp.slug=$1 AND wp.status='approved' AND wp.public_profile", [slug]);
  const profile = result.rows[0];
  if (!profile) throw new ApiError(404, "worker_profile_not_found", "This public worker profile does not exist.");
  response.json({ data: { ...publicFields(profile), ...(await workStats(profile.user_id)) } });
}));

workerApplicationsAdminRouter.use(requireMaster);
workerApplicationsAdminRouter.get("/", asyncRoute(async (_request, response) => {
  const result = await db.query<ProfileRow>(
    "SELECT * FROM worker_profiles WHERE status IN ('pending_review','changes_requested') ORDER BY submitted_at ASC LIMIT 200",
  );
  response.json({ data: result.rows.map((profile) => ({
    ...publicFields(profile), email: profile.email, phone: profile.phone,
    publicProfile: profile.public_profile, status: profile.status, reviewNote: profile.review_note,
    submittedAt: profile.submitted_at,
  })) });
}));

workerApplicationsAdminRouter.post("/:id/review", asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const input = reviewSchema.parse(request.body);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const profile = await client.query<{ id: string; status: string }>("SELECT id,status FROM worker_profiles WHERE id=$1 FOR UPDATE", [id]);
    if (!profile.rowCount) throw new ApiError(404, "worker_application_not_found", "This worker application no longer exists.");
    if (!['pending_review','changes_requested'].includes(profile.rows[0].status))
      throw new ApiError(409, "worker_application_already_reviewed", "This application has already been decided. Ask the worker to resubmit it to start another review.");
    await client.query(
      "UPDATE worker_profiles SET status=$2,review_note=$3,reviewed_at=now(),updated_at=now() WHERE id=$1",
      [id, input.decision, input.note || null],
    );
    await client.query("INSERT INTO worker_profile_reviews(profile_id,decision,note) VALUES($1,$2,$3)", [id, input.decision, input.note || null]);
    await client.query("COMMIT");
    response.json({ data: { id, status: input.decision } });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}));
