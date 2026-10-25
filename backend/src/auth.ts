import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createSiweMessage } from "viem/siwe";
import { verifyMessage } from "viem";
import { db } from "./db/index.js";
import { config, teamWallets } from "./config.js";
import { ApiError } from "./http.js";

const SESSION_DAYS = 7;
const TEAM_SESSION_SECONDS = 8 * 60 * 60;
const TEAM_SESSION_COOKIE = "jobsai_team_session";
const TEAM_PASSWORD_MIN_LENGTH = 32;
export const canonicalWalletAddress = (address: string) => address.toLowerCase();
export const hashSessionToken = (token: string, pepper = config.AUTH_TOKEN_PEPPER) =>
  createHash("sha256").update(`${pepper}:${token}`).digest("hex");
export const bearerToken = (authorization: string | undefined) => authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
export const isTeamWallet = (address: string, wallets = teamWallets) => wallets.has(address.toLowerCase());

export function teamPasswordsMatch(candidate: string, secret: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(secret));
}

export function createTeamSessionToken(secret = config.JOBSAI_TEAM_PASSWORD, now = Date.now()) {
  if (!secret || secret.length < TEAM_PASSWORD_MIN_LENGTH)
    throw new ApiError(503, "team_password_unconfigured", "Set JOBSAI_TEAM_PASSWORD to a secret with at least 32 characters.");
  const expiresAt = Math.floor(now / 1000) + TEAM_SESSION_SECONDS;
  const payload = `${expiresAt}.${randomBytes(32).toString("base64url")}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function isValidTeamSessionToken(token: string | undefined, secret = config.JOBSAI_TEAM_PASSWORD, now = Date.now()) {
  if (!secret || !token) return false;
  const [expiresAtText, nonce, signature, ...rest] = token.split(".");
  if (!expiresAtText || !nonce || !signature || rest.length) return false;
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  const payload = `${expiresAtText}.${nonce}`;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function teamSessionCookie(request: Request) {
  const header = request.header("cookie") || "";
  const entry = header.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${TEAM_SESSION_COOKIE}=`));
  return entry?.slice(TEAM_SESSION_COOKIE.length + 1);
}

export function requireTeamPassword(request: Request, _response: Response, next: NextFunction) {
  if (!config.JOBSAI_TEAM_PASSWORD || config.JOBSAI_TEAM_PASSWORD.length < TEAM_PASSWORD_MIN_LENGTH) {
    next(new ApiError(503, "team_password_unconfigured", "Set JOBSAI_TEAM_PASSWORD to a secret with at least 32 characters."));
    return;
  }
  if (!isValidTeamSessionToken(teamSessionCookie(request))) {
    next(new ApiError(401, "team_password_required", "Enter the JobsAI team password to continue."));
    return;
  }
  next();
}

export function setTeamSessionCookie(response: Response) {
  const token = createTeamSessionToken();
  const secure = config.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${TEAM_SESSION_COOKIE}=${token}; Path=/api/jobsai/v1/team; Max-Age=${TEAM_SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure}`);
}

export function clearTeamSessionCookie(response: Response) {
  const secure = config.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${TEAM_SESSION_COOKIE}=; Path=/api/jobsai/v1/team; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
}

export function assertTeamPassword(password: string) {
  const secret = config.JOBSAI_TEAM_PASSWORD;
  if (!secret || secret.length < TEAM_PASSWORD_MIN_LENGTH)
    throw new ApiError(503, "team_password_unconfigured", "Set JOBSAI_TEAM_PASSWORD to a secret with at least 32 characters.");
  if (!teamPasswordsMatch(password, secret)) throw new ApiError(401, "invalid_team_password", "The team password is incorrect.");
}

function signInMessage(address: string, nonce: string, issuedAt: Date, expiresAt: Date) {
  return createSiweMessage({
    domain: config.AUTH_DOMAIN,
    address: address as `0x${string}`,
    statement: "Sign in to JobsAI.",
    uri: config.AUTH_URI,
    version: "1",
    chainId: config.RH_CHAIN_ID,
    nonce,
    issuedAt,
    expirationTime: expiresAt,
  });
}

export async function issueNonce(address: string) {
  const walletAddress = canonicalWalletAddress(address);
  const nonce = randomBytes(24).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
  await db.query(
    "INSERT INTO auth_nonces (nonce, wallet_address, issued_at, expires_at) VALUES ($1,$2,$3,$4)",
    [nonce, walletAddress, issuedAt, expiresAt],
  );
  return {
    walletAddress,
    nonce,
    message: signInMessage(walletAddress, nonce, issuedAt, expiresAt),
    expiresAt,
  };
}

export async function createSession(input: {
  address: string;
  nonce: string;
  signature: `0x${string}`;
}) {
  const walletAddress = canonicalWalletAddress(input.address);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const nonce = await client.query<{ issued_at: Date; expires_at: Date }>(
      "SELECT issued_at, expires_at FROM auth_nonces WHERE wallet_address=$1 AND nonce=$2 AND consumed_at IS NULL FOR UPDATE",
      [walletAddress, input.nonce],
    );
    const challenge = nonce.rows[0];
    if (!challenge || challenge.expires_at <= new Date())
      throw new ApiError(401, "invalid_nonce", "This sign-in request expired. Request a new nonce.");
    const valid = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message: signInMessage(walletAddress, input.nonce, challenge.issued_at, challenge.expires_at),
      signature: input.signature,
    });
    if (!valid) throw new ApiError(401, "invalid_signature", "The signature does not match this wallet.");

    await client.query("UPDATE auth_nonces SET consumed_at=now() WHERE nonce=$1", [input.nonce]);
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (wallet_address) VALUES ($1)
       ON CONFLICT (wallet_address) DO UPDATE SET updated_at=now() RETURNING id`,
      [walletAddress],
    );
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await client.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [
      hashSessionToken(token),
      user.rows[0].id,
      expiresAt,
    ]);
    await client.query("COMMIT");
    return { token, expiresAt, userId: user.rows[0].id, walletAddress };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; walletAddress: string };
    }
  }
}

export async function requireAuth(request: Request, _response: Response, next: NextFunction) {
  try {
    const bearer = bearerToken(request.header("authorization"));
    if (!bearer) throw new ApiError(401, "unauthenticated", "A bearer session token is required.");
    const result = await db.query<{ user_id: string; wallet_address: string }>(
      `SELECT s.user_id,u.wallet_address FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,
      [hashSessionToken(bearer)],
    );
    if (!result.rowCount) throw new ApiError(401, "invalid_session", "This session is invalid or expired.");
    request.auth = { userId: result.rows[0].user_id, walletAddress: result.rows[0].wallet_address };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireTeam(request: Request, _response: Response, next: NextFunction) {
  if (!request.auth || !isTeamWallet(request.auth.walletAddress)) {
    next(new ApiError(403, "team_only", "Only an authorized JobsAI team wallet can perform this action."));
    return;
  }
  next();
}

export async function revokeSession(request: Request) {
  const bearer = bearerToken(request.header("authorization"));
  if (bearer) await db.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [hashSessionToken(bearer)]);
}
