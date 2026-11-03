import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { userTagSchema } from "./user-tags.js";

export async function requireAdmin(request: Request, _response: Response, next: NextFunction) {
  try {
    const result = await db.query<{ is_admin: boolean }>("SELECT is_admin FROM users WHERE id=$1", [request.auth!.userId]);
    if (!result.rows[0]?.is_admin) throw new ApiError(403, "admin_required", "This JobsAI account does not have admin access.");
    next();
  } catch (error) { next(error); }
}

export const adminRouter = Router();
adminRouter.use(requireAuth);
adminRouter.get("/me", asyncRoute(async (request, response) => {
  const result = await db.query<{ is_admin: boolean; user_tag: string | null }>(
    "SELECT is_admin,user_tag FROM users WHERE id=$1", [request.auth!.userId],
  );
  response.json({ data: { isAdmin: result.rows[0]?.is_admin ?? false, userTag: result.rows[0]?.user_tag ?? null } });
}));
adminRouter.use(requireAdmin);

adminRouter.get("/users", asyncRoute(async (_request, response) => {
  const result = await db.query<{ user_tag: string; wallet_address: string; created_at: Date }>(
    "SELECT user_tag,wallet_address,created_at FROM users WHERE is_admin ORDER BY created_at ASC",
  );
  response.json({ data: result.rows.map((row) => ({ userTag: row.user_tag, walletAddress: row.wallet_address, createdAt: row.created_at })) });
}));

adminRouter.post("/users", asyncRoute(async (request, response) => {
  const { userTag } = z.object({ userTag: userTagSchema }).strict().parse(request.body);
  const result = await db.query<{ user_tag: string; wallet_address: string; created_at: Date }>(
    "UPDATE users SET is_admin=true,updated_at=now() WHERE user_tag=$1 RETURNING user_tag,wallet_address,created_at", [userTag],
  );
  if (!result.rowCount) throw new ApiError(404, "user_tag_not_found", "No JobsAI account has that usertag.");
  response.status(201).json({ data: { userTag: result.rows[0].user_tag, walletAddress: result.rows[0].wallet_address, createdAt: result.rows[0].created_at } });
}));

adminRouter.delete("/users/:tag", asyncRoute(async (request, response) => {
  const userTag = userTagSchema.parse(request.params.tag);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('jobsai:admin-roles'))");
    const target = await client.query<{ id: string; is_admin: boolean }>("SELECT id,is_admin FROM users WHERE user_tag=$1 FOR UPDATE", [userTag]);
    if (!target.rowCount) throw new ApiError(404, "user_tag_not_found", "No JobsAI account has that usertag.");
    if (!target.rows[0].is_admin) throw new ApiError(409, "not_an_admin", "That account is not an admin.");
    if (target.rows[0].id === request.auth!.userId) throw new ApiError(409, "cannot_remove_self", "You cannot remove your own admin access here.");
    const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE is_admin");
    if (count.rows[0].count <= 1) throw new ApiError(409, "last_admin", "At least one admin account must remain.");
    await client.query("UPDATE users SET is_admin=false,updated_at=now() WHERE id=$1", [target.rows[0].id]);
    await client.query("COMMIT");
    response.status(204).end();
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}));
