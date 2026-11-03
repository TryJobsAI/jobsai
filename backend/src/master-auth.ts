import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { ApiError, asyncRoute } from "./http.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";

const MASTER_SESSION_COOKIE = "jobsai_master_session";
const MASTER_SESSION_SECONDS = 8 * 60 * 60;
const MASTER_PASSWORD_MIN_LENGTH = 32;

function passwordMatches(candidate: string, secret: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(secret));
}

function createMasterSession(secret = config.MASTER_PASSWORD, now = Date.now()) {
  if (!secret || secret.length < MASTER_PASSWORD_MIN_LENGTH)
    throw new ApiError(503, "master_password_unconfigured", "Set MASTER_PASSWORD to a secret with at least 32 characters.");
  const expiresAt = Math.floor(now / 1000) + MASTER_SESSION_SECONDS;
  const payload = `${expiresAt}.${randomBytes(32).toString("base64url")}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function validMasterSession(token: string | undefined, secret = config.MASTER_PASSWORD, now = Date.now()) {
  if (!secret || !token) return false;
  const [expiresAtText, nonce, signature, ...rest] = token.split(".");
  if (!expiresAtText || !nonce || !signature || rest.length) return false;
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  const expected = createHmac("sha256", secret).update(`${expiresAtText}.${nonce}`).digest();
  const supplied = Buffer.from(signature, "base64url");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function masterCookie(request: Request) {
  const prefix = `${MASTER_SESSION_COOKIE}=`;
  return request.header("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

export function requireMaster(request: Request, _response: Response, next: NextFunction) {
  if (!config.MASTER_PASSWORD || config.MASTER_PASSWORD.length < MASTER_PASSWORD_MIN_LENGTH) {
    next(new ApiError(503, "master_password_unconfigured", "Set MASTER_PASSWORD to a secret with at least 32 characters."));
    return;
  }
  if (!validMasterSession(masterCookie(request))) {
    next(new ApiError(401, "master_password_required", "Enter the JobsAI master password to continue."));
    return;
  }
  next();
}

export const masterRouter = Router();
masterRouter.post("/login", rateLimit([
  { scope: "master-login-ip", limit: 10, windowSeconds: 900, identity: requestIdentity.clientIp },
]), asyncRoute(async (request, response) => {
  const password = z.object({ password: z.string().min(1).max(512) }).strict().parse(request.body).password;
  const secret = config.MASTER_PASSWORD;
  if (!secret || secret.length < MASTER_PASSWORD_MIN_LENGTH)
    throw new ApiError(503, "master_password_unconfigured", "Set MASTER_PASSWORD to a secret with at least 32 characters.");
  if (!passwordMatches(password, secret)) throw new ApiError(401, "invalid_master_password", "The master password is incorrect.");
  const secure = config.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${MASTER_SESSION_COOKIE}=${createMasterSession()}; Path=/api/jobsai/v1/master; Max-Age=${MASTER_SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure}`);
  response.json({ data: { authenticated: true } });
}));
masterRouter.get("/status", requireMaster, (_request, response) => response.json({ data: { authenticated: true } }));
masterRouter.post("/logout", (_request, response) => {
  const secure = config.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${MASTER_SESSION_COOKIE}=; Path=/api/jobsai/v1/master; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
  response.status(204).end();
});
