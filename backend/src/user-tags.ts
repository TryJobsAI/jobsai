import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";

export const userTagsRouter = Router();

export const userTagSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{2,23}$/, "Use 3–24 lowercase letters, numbers, underscores, or hyphens.")
  .refine((tag) => !new Set(["admin", "api", "buyer", "jobs", "jobsai", "profile", "support", "team", "worker"]).has(tag), {
    message: "That usertag is reserved.",
  });

userTagsRouter.get("/me", requireAuth, asyncRoute(async (request, response) => {
  const result = await db.query<{ user_tag: string | null }>("SELECT user_tag FROM users WHERE id=$1", [request.auth!.userId]);
  response.json({ data: { userTag: result.rows[0]?.user_tag ?? null } });
}));

userTagsRouter.put("/me", requireAuth, rateLimit([
  { scope: "user-tag-set-user", limit: 5, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser },
]), asyncRoute(async (request, response) => {
  const userTag = userTagSchema.parse(request.body?.userTag);
  const existing = await db.query<{ user_tag: string | null }>("SELECT user_tag FROM users WHERE id=$1", [request.auth!.userId]);
  const currentTag = existing.rows[0]?.user_tag;
  if (currentTag) {
    if (currentTag !== userTag) throw new ApiError(409, "user_tag_locked", "A wallet can have one usertag, and it cannot be changed.");
    response.json({ data: { userTag: currentTag } });
    return;
  }
  try {
    const claimed = await db.query<{ user_tag: string }>(
      "UPDATE users SET user_tag=$2,updated_at=now() WHERE id=$1 AND user_tag IS NULL RETURNING user_tag",
      [request.auth!.userId, userTag],
    );
    if (claimed.rowCount) {
      response.status(201).json({ data: { userTag: claimed.rows[0].user_tag } });
      return;
    }
    const raced = await db.query<{ user_tag: string | null }>("SELECT user_tag FROM users WHERE id=$1", [request.auth!.userId]);
    if (raced.rows[0]?.user_tag === userTag) { response.json({ data: { userTag } }); return; }
    throw new ApiError(409, "user_tag_locked", "A wallet can have one usertag, and it cannot be changed.");
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new ApiError(409, "user_tag_unavailable", "That usertag is already in use. Choose another one.");
    throw error;
  }
}));

userTagsRouter.get("/:tag", asyncRoute(async (request, response) => {
  const userTag = userTagSchema.parse(request.params.tag);
  const result = await db.query<{ user_tag: string; worker_profile_slug: string | null }>(
    `SELECT u.user_tag,wp.slug AS worker_profile_slug
       FROM users u LEFT JOIN worker_profiles wp ON wp.user_id=u.id AND wp.status='approved' AND wp.public_profile
      WHERE u.user_tag=$1`, [userTag],
  );
  const identity = result.rows[0];
  if (!identity) throw new ApiError(404, "user_tag_not_found", "This JobsAI profile does not exist.");
  response.json({ data: { userTag: identity.user_tag, workerProfileSlug: identity.worker_profile_slug } });
}));
