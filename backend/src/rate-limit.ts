import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { db } from "./db/index.js";

type RateLimitRule = {
  scope: string;
  limit: number;
  windowSeconds: number;
  identity: (request: Request) => string | undefined;
};

let lastCleanupAt = 0;

const clientIp = (request: Request) => request.ip || request.socket.remoteAddress || "unknown";

export const requestIdentity = {
  clientIp,
  walletFromBody: (request: Request) => {
    const address = request.body?.address;
    return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)
      ? address.toLowerCase()
      : undefined;
  },
  authenticatedUser: (request: Request) => request.auth?.userId,
};

export function rateLimit(rules: RateLimitRule[]): RequestHandler {
  return (request, response, next) => {
    void (async () => {
      try {
        if (Date.now() - lastCleanupAt > 60_000) {
          lastCleanupAt = Date.now();
          await db.query("DELETE FROM request_rate_limits WHERE updated_at < now() - interval '1 hour'");
          await db.query("DELETE FROM auth_nonces WHERE expires_at<now() OR consumed_at<now()-interval '1 day'");
        }

        for (const rule of rules) {
          const identity = rule.identity(request);
          if (!identity) continue;
          const key = createHash("sha256").update(`${rule.scope}:${identity}`).digest("hex");
          const result = await db.query<{ request_count: number; reset_at: Date }>(
            `INSERT INTO request_rate_limits (rate_key,window_started_at,request_count,updated_at)
             VALUES ($1,now(),1,now())
             ON CONFLICT (rate_key) DO UPDATE SET
               request_count=CASE
                 WHEN request_rate_limits.window_started_at <= now() - ($2::int * interval '1 second') THEN 1
                 ELSE request_rate_limits.request_count + 1
               END,
               window_started_at=CASE
                 WHEN request_rate_limits.window_started_at <= now() - ($2::int * interval '1 second') THEN now()
                 ELSE request_rate_limits.window_started_at
               END,
               updated_at=now()
             RETURNING request_count,window_started_at + ($2::int * interval '1 second') AS reset_at`,
            [key, rule.windowSeconds],
          );
          const row = result.rows[0];
          if (Number(row.request_count) > rule.limit) {
            const retryAfter = Math.max(1, Math.ceil((new Date(row.reset_at).getTime() - Date.now()) / 1000));
            response.setHeader("Retry-After", String(retryAfter));
            response.status(429).json({
              error: { code: "rate_limited", message: "Too many requests. Please wait and try again." },
            });
            return;
          }
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}
