import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("providers list fixed-price services and funded orders go straight to the provider", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Service integration test needs a disposable database with 'test' in its name.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }, { assignFundedServiceOrder, releaseExpiredClaims }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"), import("../src/jobs.js"),
  ]);
  await migrate();
  const providerWallet = `0x${randomBytes(20).toString("hex")}`;
  const clientWallet = `0x${randomBytes(20).toString("hex")}`;
  const providerSession = randomBytes(32).toString("base64url");
  const clientSession = randomBytes(32).toString("base64url");
  const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2) RETURNING id", [providerWallet, clientWallet]);
  const [providerId, clientId] = users.rows.map((row) => row.id);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day'),($3,$4,now()+interval '1 day')",
    [hashSessionToken(providerSession), providerId, hashSessionToken(clientSession), clientId]);
  const server = app.listen(0, "127.0.0.1");
  const jobIds: string[] = [];
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Service integration API did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, token: string | null, method = "GET", body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    }
    async function fundAndAssign(jobId: string) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // Seed a verified deposit; this test never broadcasts chain transactions.
        await client.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [jobId, `0x${randomBytes(32).toString("hex")}`]);
        const status = await assignFundedServiceOrder(client, jobId);
        await client.query("COMMIT");
        return status;
      } finally { client.release(); }
    }

    const agent = await call("/v1/agents", providerSession, "POST", { name: "Julie", description: "Writes sourced articles.", categories: ["writing"], capabilities: [], expiresInDays: 30 });
    expect(agent.status).toBe(201);
    const agentId = agent.body.data.id as string;
    const runtimeToken = agent.body.data.runtimeToken as string;

    const service = { name: "Blog post rewrite", summary: "I tighten one blog post for clarity.", description: "Send one blog post up to 1,500 words and I will rewrite it for clarity.", category: "writing", acceptanceCriteria: ["Under 1,500 words", "Delivered as a Google Doc"], asset: "eth", amount: "0.01", deliveryDays: 3 };
    const human = await call("/v1/services", providerSession, "POST", service);
    expect(human.status).toBe(201);
    expect(human.body.data).toMatchObject({ name: "Blog post rewrite", workerType: "human", deliveryDays: 3, amount: "0.01", asset: "ETH", completedJobs: 0 });
    const ai = await call("/v1/services", providerSession, "POST", { ...service, name: "AI article draft", agentId });
    expect(ai.status).toBe(201);
    expect(ai.body.data.agent).toMatchObject({ id: agentId, name: "Julie" });
    expect((await call("/v1/services", providerSession, "POST", { ...service, category: "design", agentId })).body.error.code).toBe("agent_category_mismatch");
    expect((await call("/v1/services", providerSession, "POST", { ...service, amount: "0.0000001" })).body.error.code).toBe("amount_below_minimum");

    const catalog = await call("/v1/services?category=writing", null);
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([human.body.data.id, ai.body.data.id]));
    expect((await call(`/v1/services/${human.body.data.id}/order`, providerSession, "POST", {})).body.error.code).toBe("cannot_order_own_service");

    const order = await call(`/v1/services/${human.body.data.id}/order`, clientSession, "POST", { details: "Post is about home composting." });
    expect(order.status).toBe(201);
    jobIds.push(order.body.data.id);
    expect(order.body.data).toMatchObject({ status: "awaiting_funding", serviceId: human.body.data.id, title: "Blog post rewrite", amount: "0.01" });
    expect(order.body.data.description).toContain("Order details from the client:\nPost is about home composting.");
    expect(await fundAndAssign(order.body.data.id)).toBe("in_progress");
    const assigned = await db.query<{ doer_id: string; doer_agent_id: string | null; days: number }>(
      "SELECT doer_id,doer_agent_id,round(extract(epoch FROM deadline_at-claimed_at)/86400)::int AS days FROM jobs WHERE id=$1", [order.body.data.id]);
    expect(assigned.rows[0]).toEqual({ doer_id: providerId, doer_agent_id: null, days: 3 });

    await db.query("UPDATE jobs SET claimed_at=now()-interval '25 hours' WHERE id=$1", [order.body.data.id]);
    await releaseExpiredClaims();
    expect((await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [order.body.data.id])).rows[0].status).toBe("in_progress");

    const aiOrder = await call(`/v1/services/${ai.body.data.id}/order`, clientSession, "POST", {});
    expect(aiOrder.status).toBe(201);
    jobIds.push(aiOrder.body.data.id);
    expect(await fundAndAssign(aiOrder.body.data.id)).toBe("in_progress");
    const agentJobs = await call("/v1/agent-runtime/assigned-jobs", runtimeToken);
    expect(agentJobs.body.data.map((job: { id: string }) => job.id)).toContain(aiOrder.body.data.id);

    expect((await call(`/v1/services/${human.body.data.id}`, clientSession, "PATCH", { active: false })).status).toBe(404);
    const paused = await call(`/v1/services/${human.body.data.id}`, providerSession, "PATCH", { active: false });
    expect(paused.body.data.active).toBe(false);
    expect((await call("/v1/services", null)).body.data.map((item: { id: string }) => item.id)).not.toContain(human.body.data.id);
    expect((await call(`/v1/services/${human.body.data.id}/order`, clientSession, "POST", {})).status).toBe(404);
    const mine = await call("/v1/services/mine", providerSession);
    expect(mine.body.data).toHaveLength(2);
  } finally {
    server.close();
    if (jobIds.length) {
      await db.query("DELETE FROM job_events WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_escrow_wallets WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [jobIds]);
    }
    await db.query("DELETE FROM services WHERE provider_id=$1", [providerId]);
    await db.query("DELETE FROM ai_agents WHERE owner_user_id=$1", [providerId]);
    await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[providerId, clientId]]);
  }
});
