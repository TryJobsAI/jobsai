import { Router } from "express";
import { formatUnits } from "viem";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { amountSchema, assertMinimumJobAmount, jobCategories, parseJobAmount } from "./job-input.js";
import { createJobRecord } from "./jobs.js";
import { assertNewWorkAvailable } from "./lifecycle.js";

export const servicesRouter = Router();
const uuid = z.string().uuid();
const MAX_ACTIVE_SERVICES_PER_PROVIDER = 20;

export const serviceInputSchema = z.object({
  name: z.string().trim().min(3).max(80),
  summary: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5_000),
  category: z.enum(jobCategories),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  asset: z.enum(["eth", "usdg"]),
  amount: amountSchema,
  deliveryDays: z.number().int().min(1).max(30),
  agentId: z.string().uuid().nullish(),
}).strict();

export const serviceOrderSchema = z.object({
  details: z.string().trim().max(5_000).default(""),
}).strict();

type ServiceRow = {
  id: string; provider_id: string; provider_wallet: string; agent_id: string | null; agent_name: string | null;
  name: string; summary: string; description: string; category: string; acceptance_criteria: string[];
  asset: "eth" | "usdg"; amount_raw: string; delivery_days: number; active: boolean; created_at: Date;
  completed_jobs: number;
};

const serviceSelect = `SELECT sv.*,u.wallet_address AS provider_wallet,a.name AS agent_name,
    (SELECT count(*)::int FROM jobs j WHERE j.service_id=sv.id AND j.status='completed') AS completed_jobs
  FROM services sv JOIN users u ON u.id=sv.provider_id LEFT JOIN ai_agents a ON a.id=sv.agent_id`;

export function presentService(service: ServiceRow) {
  return {
    id: service.id,
    providerWallet: service.provider_wallet,
    agent: service.agent_id ? { id: service.agent_id, name: service.agent_name } : null,
    workerType: service.agent_id ? "ai" : "human",
    name: service.name,
    summary: service.summary,
    description: service.description,
    category: service.category,
    acceptanceCriteria: service.acceptance_criteria,
    asset: service.asset.toUpperCase(),
    amount: formatUnits(BigInt(service.amount_raw), service.asset === "eth" ? 18 : config.USDG_DECIMALS),
    amountRaw: service.amount_raw,
    deliveryDays: service.delivery_days,
    active: service.active,
    completedJobs: service.completed_jobs,
    createdAt: service.created_at,
  };
}

export function serviceOrderDescription(serviceDescription: string, details: string) {
  return details ? `${serviceDescription}\n\nOrder details from the client:\n${details}` : serviceDescription;
}

servicesRouter.get("/", asyncRoute(async (request, response) => {
  const category = z.enum(jobCategories).optional().parse(request.query.category || undefined);
  const result = await db.query<ServiceRow>(
    `${serviceSelect} WHERE sv.active AND (a.id IS NULL OR a.active) AND ($1::text IS NULL OR sv.category=$1)
     ORDER BY sv.created_at DESC LIMIT 60`,
    [category ?? null],
  );
  response.json({ data: result.rows.map(presentService) });
}));

servicesRouter.get("/mine", requireAuth, asyncRoute(async (request, response) => {
  const result = await db.query<ServiceRow>(`${serviceSelect} WHERE sv.provider_id=$1 ORDER BY sv.created_at DESC LIMIT 100`, [request.auth!.userId]);
  response.json({ data: result.rows.map(presentService) });
}));

servicesRouter.post("/", requireAuth, asyncRoute(async (request, response) => {
  const input = serviceInputSchema.parse(request.body);
  if (input.asset === "usdg" && !config.USDG_TOKEN_ADDRESS)
    throw new ApiError(503, "usdg_unconfigured", "USDG services are not enabled until USDG_TOKEN_ADDRESS is configured.");
  const amount = parseJobAmount(input.asset, input.amount, config.USDG_DECIMALS);
  assertMinimumJobAmount(amount, parseJobAmount(input.asset, input.asset === "eth" ? config.MIN_JOB_ETH_AMOUNT : config.MIN_JOB_USDG_AMOUNT, config.USDG_DECIMALS), input.asset);
  const providerId = request.auth!.userId;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`services:create:${providerId}`]);
    if (input.agentId) {
      const agent = await client.query<{ active: boolean; categories: string[] }>(
        "SELECT active,categories FROM ai_agents WHERE id=$1 AND owner_user_id=$2", [input.agentId, providerId]);
      if (!agent.rowCount) throw new ApiError(404, "agent_not_found", "Choose one of your own AI workers.");
      if (!agent.rows[0].active) throw new ApiError(409, "agent_inactive", "Activate this AI worker before listing a service for it.");
      if (!agent.rows[0].categories.includes(input.category))
        throw new ApiError(409, "agent_category_mismatch", "This AI worker is not registered for the service's category.");
    }
    const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM services WHERE provider_id=$1 AND active", [providerId]);
    if (Number(count.rows[0].count) >= MAX_ACTIVE_SERVICES_PER_PROVIDER)
      throw new ApiError(409, "service_limit", `You can list up to ${MAX_ACTIVE_SERVICES_PER_PROVIDER} active services. Pause one before adding another.`);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO services (provider_id,agent_id,name,summary,description,category,acceptance_criteria,asset,amount_raw,token_address,delivery_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [providerId, input.agentId ?? null, input.name, input.summary, input.description, input.category, JSON.stringify(input.acceptanceCriteria),
        input.asset, amount.toString(), input.asset === "usdg" ? config.USDG_TOKEN_ADDRESS!.toLowerCase() : null, input.deliveryDays],
    );
    const created = await client.query<ServiceRow>(`${serviceSelect} WHERE sv.id=$1`, [inserted.rows[0].id]);
    await client.query("COMMIT");
    response.status(201).json({ data: presentService(created.rows[0]) });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));

servicesRouter.patch("/:id", requireAuth, asyncRoute(async (request, response) => {
  const id = uuid.parse(request.params.id);
  const { active } = z.object({ active: z.boolean() }).strict().parse(request.body);
  const updated = await db.query("UPDATE services SET active=$3,updated_at=now() WHERE id=$1 AND provider_id=$2 RETURNING id", [id, request.auth!.userId, active]);
  if (!updated.rowCount) throw new ApiError(404, "service_not_found", "This service does not exist.");
  const service = await db.query<ServiceRow>(`${serviceSelect} WHERE sv.id=$1`, [id]);
  response.json({ data: presentService(service.rows[0]) });
}));

servicesRouter.post("/:id/order", requireAuth, asyncRoute(async (request, response) => {
  assertNewWorkAvailable(config.PAUSE_NEW_WORK);
  const id = uuid.parse(request.params.id);
  const { details } = serviceOrderSchema.parse(request.body ?? {});
  const result = await db.query<ServiceRow & { agent_active: boolean | null }>(
    `${serviceSelect.replace("a.name AS agent_name", "a.name AS agent_name,a.active AS agent_active")} WHERE sv.id=$1`, [id]);
  const service = result.rows[0];
  if (!service || !service.active || service.agent_active === false)
    throw new ApiError(404, "service_not_found", "This service is not available to order.");
  if (service.provider_id === request.auth!.userId)
    throw new ApiError(409, "cannot_order_own_service", "You cannot order your own service.");
  if (service.asset === "usdg" && !config.USDG_TOKEN_ADDRESS)
    throw new ApiError(503, "usdg_unconfigured", "USDG services are not enabled until USDG_TOKEN_ADDRESS is configured.");
  const created = await createJobRecord(request.auth!.userId, {
    title: service.name,
    description: serviceOrderDescription(service.description, details),
    acceptanceCriteria: service.acceptance_criteria,
    category: service.category,
    asset: service.asset,
    amountRaw: BigInt(service.amount_raw),
    deadlineAt: null,
    service: { id: service.id, providerId: service.provider_id, agentId: service.agent_id },
  });
  response.status(201).json({ data: created });
}));
