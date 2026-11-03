import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Router } from "express";
import { formatUnits } from "viem";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { decryptPayload, encryptPayload } from "./crypto.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";

export const webhooksRouter = Router();
const uuid = z.string().uuid();
const MAX_ENDPOINTS_PER_USER = 5;
const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_SECONDS = [30, 120, 600, 3_600, 21_600];

export const webhookEventTypes = [
  "job.created", "job.funded", "job.assigned", "job.released", "job.submitted", "job.revision_requested",
  "job.accepted", "job.disputed", "job.dispute_resolved", "job.cancelled", "job.paid", "job.refunded",
  "proposal.received", "proposal.accepted", "invitation.received", "invitation.accepted", "invitation.declined",
] as const;

const webhookUrl = z.string().trim().max(500).url().refine((value) => assertWebhookUrlShape(value) === null, {
  message: "Use a public https:// URL on port 443 without a username or password.",
});
export const webhookInputSchema = z.object({
  url: webhookUrl,
  description: z.string().trim().min(1).max(120).nullish(),
  events: z.array(z.enum(webhookEventTypes)).max(webhookEventTypes.length).default([])
    .refine((events) => new Set(events).size === events.length, "List each event once."),
}).strict();

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export function assertWebhookUrlShape(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "invalid_url"; }
  if (url.protocol !== "https:") return "https_required";
  if (url.username || url.password) return "credentials_not_allowed";
  if (url.port && url.port !== "443") return "port_not_allowed";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "private_host";
  if (isIP(host) && isPrivateAddress(host)) return "private_host";
  return null;
}

export function isPrivateAddress(address: string): boolean {
  const lowered = address.toLowerCase();
  const mapped = lowered.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (isIP(lowered) === 4) {
    const [a, b] = lowered.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(lowered) === 6)
    return lowered === "::" || lowered === "::1" || /^f[cd]/.test(lowered) || /^fe[89ab]/.test(lowered) || lowered.startsWith("ff");
  return true;
}

// Checked again before every delivery so a hostname cannot later be pointed at JobsAI's own network.
export async function assertPublicWebhookTarget(value: string, lookup: Lookup = defaultLookup) {
  const shape = assertWebhookUrlShape(value);
  if (shape) throw new ApiError(400, "webhook_url_not_allowed", "Use a public https:// URL on port 443.");
  const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host).catch(() => []);
  if (!addresses.length) throw new ApiError(400, "webhook_host_unresolved", "This webhook host could not be resolved.");
  if (addresses.some((entry) => isPrivateAddress(entry.address)))
    throw new ApiError(400, "webhook_url_not_allowed", "Webhook URLs must resolve to public internet addresses.");
}

export function signWebhookPayload(secret: string, timestamp: number, body: string) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;
const secretContext = (endpointId: string) => `webhook:${endpointId}`;

type EndpointRow = { id: string; url: string; description: string | null; events: string[]; active: boolean; created_at: Date; delivered: number; failed: number; last_delivery_at: Date | null };
const endpointSelect = `SELECT e.id,e.url,e.description,e.events,e.active,e.created_at,
    (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.status='delivered') AS delivered,
    (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.status='failed') AS failed,
    (SELECT max(d.created_at) FROM webhook_deliveries d WHERE d.endpoint_id=e.id) AS last_delivery_at
  FROM webhook_endpoints e`;
const presentEndpoint = (row: EndpointRow) => ({
  id: row.id, url: row.url, description: row.description, events: row.events, allEvents: row.events.length === 0, active: row.active,
  createdAt: row.created_at, deliveredCount: row.delivered, failedCount: row.failed, lastDeliveryAt: row.last_delivery_at,
});

webhooksRouter.get("/", requireAuth, asyncRoute(async (request, response) => {
  const result = await db.query<EndpointRow>(`${endpointSelect} WHERE e.owner_id=$1 ORDER BY e.created_at`, [request.auth!.userId]);
  response.json({ data: result.rows.map(presentEndpoint), eventTypes: webhookEventTypes });
}));

webhooksRouter.post("/", requireAuth, rateLimit([{ scope: "webhook-create-user", limit: 20, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser }]), asyncRoute(async (request, response) => {
  const input = webhookInputSchema.parse(request.body);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`webhooks:${request.auth!.userId}`]);
    const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM webhook_endpoints WHERE owner_id=$1", [request.auth!.userId]);
    if (count.rows[0].count >= MAX_ENDPOINTS_PER_USER)
      throw new ApiError(409, "webhook_limit", `You can register up to ${MAX_ENDPOINTS_PER_USER} webhook endpoints. Delete one before adding another.`);
    const id = (await client.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
    const secret = newSecret();
    await client.query("INSERT INTO webhook_endpoints (id,owner_id,url,description,events,secret_ciphertext) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, request.auth!.userId, input.url, input.description ?? null, input.events, encryptPayload(secret, secretContext(id))]);
    const created = await client.query<EndpointRow>(`${endpointSelect} WHERE e.id=$1`, [id]);
    await client.query("COMMIT");
    response.status(201).json({ data: { ...presentEndpoint(created.rows[0]), secret } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));

async function ownedEndpoint(id: string, ownerId: string) {
  const result = await db.query<EndpointRow & { secret_ciphertext: string }>(`${endpointSelect.replace("SELECT e.id,", "SELECT e.secret_ciphertext,e.id,")} WHERE e.id=$1 AND e.owner_id=$2`, [id, ownerId]);
  if (!result.rowCount) throw new ApiError(404, "webhook_not_found", "This webhook endpoint does not exist.");
  return result.rows[0];
}

webhooksRouter.patch("/:id", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  const input = z.object({ active: z.boolean().optional(), events: webhookInputSchema.shape.events.optional(), description: webhookInputSchema.shape.description })
    .strict().refine((value) => Object.keys(value).length > 0, "Send at least one field to update.").parse(request.body);
  await ownedEndpoint(id, request.auth!.userId);
  await db.query(
    `UPDATE webhook_endpoints SET active=COALESCE($2,active),events=COALESCE($3,events),
            description=CASE WHEN $5::boolean THEN $4 ELSE description END,updated_at=now() WHERE id=$1`,
    [id, input.active ?? null, input.events ?? null, input.description ?? null, "description" in input]);
  response.json({ data: presentEndpoint(await ownedEndpoint(id, request.auth!.userId)) });
}));

webhooksRouter.delete("/:id", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  const deleted = await db.query("DELETE FROM webhook_endpoints WHERE id=$1 AND owner_id=$2", [id, request.auth!.userId]);
  if (!deleted.rowCount) throw new ApiError(404, "webhook_not_found", "This webhook endpoint does not exist.");
  response.status(204).end();
}));

webhooksRouter.post("/:id/rotate-secret", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  await ownedEndpoint(id, request.auth!.userId);
  const secret = newSecret();
  await db.query("UPDATE webhook_endpoints SET secret_ciphertext=$2,updated_at=now() WHERE id=$1", [id, encryptPayload(secret, secretContext(id))]);
  response.json({ data: { id, secret } });
}));

webhooksRouter.get("/:id/deliveries", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  await ownedEndpoint(id, request.auth!.userId);
  const result = await db.query(
    `SELECT d.id,d.event_type AS "eventType",d.status,d.attempts,d.last_response_status AS "responseStatus",d.last_error AS error,
            d.created_at AS "createdAt",d.delivered_at AS "deliveredAt",CASE WHEN d.status='pending' THEN d.next_attempt_at END AS "nextAttemptAt",ev.job_id AS "jobId"
       FROM webhook_deliveries d LEFT JOIN job_events ev ON ev.id=d.job_event_id
      WHERE d.endpoint_id=$1 ORDER BY d.created_at DESC LIMIT 50`, [id]);
  response.json({ data: result.rows });
}));

webhooksRouter.post("/:id/test", requireAuth, rateLimit([{ scope: "webhook-test-user", limit: 20, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser }]), asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  await ownedEndpoint(id, request.auth!.userId);
  const inserted = await db.query<{ id: string }>("INSERT INTO webhook_deliveries (endpoint_id,event_type) VALUES ($1,'webhook.test') RETURNING id", [id]);
  const [result] = await deliverWebhooks({ deliveryIds: [inserted.rows[0].id] });
  response.json({ data: result ?? { id: inserted.rows[0].id, status: "pending" } });
}));

type DueDelivery = {
  id: string; endpoint_id: string; event_type: string; attempts: number; created_at: Date; url: string; secret_ciphertext: string;
  event_created_at: Date | null; event_details: Record<string, unknown> | null; job_id: string | null; title: string | null; status: string | null;
  category: string | null; asset: "eth" | "usdg" | null; amount_raw: string | null; selection_mode: string | null; client_wallet: string | null; doer_wallet: string | null;
};

const PUBLIC_DETAIL_KEYS = ["transactionHash", "payoutTransaction", "outcome", "revision", "submissionId", "proposalId", "invitationId", "workerType", "agentId", "agentName", "via", "selectionMode"];

export function webhookPayload(delivery: DueDelivery) {
  const details = Object.fromEntries(Object.entries(delivery.event_details ?? {}).filter(([key]) => PUBLIC_DETAIL_KEYS.includes(key)));
  return {
    id: delivery.id,
    type: delivery.event_type,
    createdAt: (delivery.event_created_at ?? delivery.created_at).toISOString(),
    data: delivery.job_id ? {
      job: {
        id: delivery.job_id,
        title: delivery.title,
        status: delivery.status,
        category: delivery.category,
        asset: delivery.asset!.toUpperCase(),
        amount: formatUnits(BigInt(delivery.amount_raw!), delivery.asset === "eth" ? 18 : config.USDG_DECIMALS),
        amountRaw: delivery.amount_raw,
        selectionMode: delivery.selection_mode,
        clientWallet: delivery.client_wallet,
        doerWallet: delivery.doer_wallet,
      },
      details,
    } : { message: "This is a test event from JobsAI. Your endpoint is reachable and verifying signatures." },
  };
}

type DeliverOptions = { fetcher?: typeof fetch; lookup?: Lookup; now?: () => Date; deliveryIds?: string[]; limit?: number };

// Leases due deliveries so parallel workers never send the same one twice, then signs and sends each.
export async function deliverWebhooks({ fetcher = fetch, lookup = defaultLookup, now = () => new Date(), deliveryIds, limit = 25 }: DeliverOptions = {}) {
  const due = await db.query<DueDelivery>(
    `WITH leased AS (
       UPDATE webhook_deliveries d SET next_attempt_at=now()+interval '2 minutes'
        WHERE d.id IN (
          SELECT id FROM webhook_deliveries WHERE status='pending' AND ($1::uuid[] IS NOT NULL AND id=ANY($1) OR $1::uuid[] IS NULL AND next_attempt_at<=now())
          ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING d.*)
     SELECT l.id,l.endpoint_id,l.event_type,l.attempts,l.created_at,e.url,e.secret_ciphertext,
            ev.created_at AS event_created_at,ev.details AS event_details,j.id AS job_id,j.title,j.status,j.category,j.asset,j.amount_raw::text,
            j.selection_mode,c.wallet_address AS client_wallet,dw.wallet_address AS doer_wallet
       FROM leased l JOIN webhook_endpoints e ON e.id=l.endpoint_id
       LEFT JOIN job_events ev ON ev.id=l.job_event_id LEFT JOIN jobs j ON j.id=ev.job_id
       LEFT JOIN users c ON c.id=j.client_id LEFT JOIN users dw ON dw.id=j.doer_id`,
    [deliveryIds ?? null, limit],
  );
  const results: Array<{ id: string; status: string; responseStatus: number | null; error: string | null }> = [];
  for (const delivery of due.rows) {
    const body = JSON.stringify(webhookPayload(delivery));
    const timestamp = Math.floor(now().getTime() / 1000);
    let responseStatus: number | null = null, error: string | null = null;
    try {
      await assertPublicWebhookTarget(delivery.url, lookup);
      const response = await fetcher(delivery.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": "JobsAI-Webhooks/1.0",
          "jobsai-event-id": delivery.id,
          "jobsai-event-type": delivery.event_type,
          "jobsai-signature": signWebhookPayload(decryptPayload(delivery.secret_ciphertext, secretContext(delivery.endpoint_id)), timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      responseStatus = response.status;
      await response.body?.cancel();
      if (response.status < 200 || response.status >= 300) error = `Endpoint responded with HTTP ${response.status}.`;
    } catch (caught) {
      error = caught instanceof ApiError ? caught.message : caught instanceof Error && caught.name === "TimeoutError" ? "Endpoint did not respond within 10 seconds." : "Endpoint could not be reached.";
    }
    const attempts = delivery.attempts + 1;
    const status = !error ? "delivered" : attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await db.query(
      `UPDATE webhook_deliveries SET status=$2,attempts=$3,last_response_status=$4,last_error=$5,
              delivered_at=CASE WHEN $2='delivered' THEN now() END,next_attempt_at=now()+($6::int*interval '1 second') WHERE id=$1`,
      [delivery.id, status, attempts, responseStatus, error, RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)]],
    );
    results.push({ id: delivery.id, status, responseStatus, error });
  }
  return results;
}
