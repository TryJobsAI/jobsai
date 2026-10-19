const DEFAULT_API_URL = "https://jobsai-api.onrender.com";
const API_PREFIX = "/api/jobsai";
const AUTH_ROUTES = new Set([
  "/v1/auth/nonce",
  "/v1/auth/verify",
  "/v1/auth/logout",
  "/v1/auth/me",
]);
const MAX_BODY_BYTES = 256 * 1024;

function json(status, code, message) {
  return Response.json({ error: { code, message } }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function proxyJobsAI(request) {
  const method = request.method.toUpperCase();
  if (!["GET", "POST"].includes(method)) return json(405, "method_not_allowed", "This method is not available.");

  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith(`${API_PREFIX}/`)) return json(404, "not_found", "This endpoint does not exist.");
  const apiPath = incoming.pathname.slice(API_PREFIX.length);
  if (!(AUTH_ROUTES.has(apiPath) || apiPath === "/v1/jobs" || apiPath.startsWith("/v1/jobs/")))
    return json(404, "not_found", "This endpoint does not exist.");

  const declaredSize = Number(request.headers.get("content-length") || 0);
  if (declaredSize > MAX_BODY_BYTES) return json(413, "request_too_large", "The request is too large.");
  const body = method === "POST" ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > MAX_BODY_BYTES) return json(413, "request_too_large", "The request is too large.");

  let base;
  try {
    base = new URL(process.env.JOBSAI_API_URL || DEFAULT_API_URL);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password)
      throw new Error("Invalid API URL");
  } catch {
    return json(500, "api_configuration_error", "The JobsAI API URL is invalid.");
  }

  const target = new URL(`${apiPath}${incoming.search}`, base.origin);
  const headers = new Headers({ accept: "application/json" });
  const authorization = request.headers.get("authorization");
  const contentType = request.headers.get("content-type");
  if (authorization) headers.set("authorization", authorization);
  if (contentType && method === "POST") headers.set("content-type", contentType);

  try {
    const upstream = await fetch(target, { method, headers, body });
    const responseHeaders = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    });
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) responseHeaders.set("Retry-After", retryAfter);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return json(502, "jobsai_api_unavailable", "JobsAI could not reach the API. Please try again.");
  }
}
