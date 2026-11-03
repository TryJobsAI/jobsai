import { randomBytes } from "node:crypto";
import express from "express";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("buyer API keys are private, scoped, and only mark funding after escrow balance meets the job amount", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Buyer API integration test needs a disposable database with 'test' in its name.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }, { createBuyerJobsRouter }, { errorHandler }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"),
    import("../src/auth.js"), import("../src/buyer-api.js"), import("../src/http.js"),
  ]);
  await migrate();
  const wallets = [`0x${randomBytes(20).toString("hex")}`, `0x${randomBytes(20).toString("hex")}`];
  const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2) RETURNING id", wallets);
  const userIds = users.rows.map(row => row.id);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day'),($3,$4,now()+interval '1 day')", [hashSessionToken(tokens[0]),userIds[0],hashSessionToken(tokens[1]),userIds[1]]);
  const appServer = app.listen(0, "127.0.0.1");
  let buyerServer: ReturnType<typeof express.application.listen> | undefined;
  const createdJobIds: string[] = [];
  try {
    await new Promise<void>(resolve => appServer.once("listening", resolve));
    const appAddress = appServer.address();
    if (!appAddress || typeof appAddress === "string") throw new Error("JobsAI API did not bind.");
    const appBase = `http://127.0.0.1:${appAddress.port}`;
    async function call(base: string, path: string, options: { token?: string; apiKey?: string; method?: string; body?: unknown } = {}) {
      const response = await fetch(`${base}${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
    }
    const generated = await call(appBase, "/v1/buyer/keys", { token: tokens[0], method: "POST", body: {} });
    expect(generated.status).toBe(201);
    const key = generated.body.data.apiKey as string;
    expect(key.startsWith("jsai_buyer_")).toBe(true);
    const listed = await call(appBase, "/v1/buyer/keys", { token: tokens[0] });
    expect(listed.body.data.prefix).toBe(generated.body.data.prefix);
    expect(JSON.stringify(listed.body)).not.toContain(key);

    let observedBalance = 999_999n;
    const buyerApp = express();
    buyerApp.use(express.json());
    buyerApp.use("/v1/buyer/jobs", createBuyerJobsRouter(async () => observedBalance, async () => 123n));
    buyerApp.use(errorHandler);
    buyerServer = buyerApp.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => buyerServer!.once("listening", resolve));
    const buyerAddress = buyerServer.address();
    if (!buyerAddress || typeof buyerAddress === "string") throw new Error("Buyer API did not bind.");
    const buyerBase = `http://127.0.0.1:${buyerAddress.port}`;

    expect((await call(buyerBase, "/v1/buyer/jobs")).status).toBe(401);
    const created = await call(buyerBase, "/v1/buyer/jobs", { apiKey: key, method: "POST", body: {
      title: "Review a mobile landing page", description: "Review one supplied landing page on a phone and report layout issues.",
      acceptanceCriteria: ["List issues with screenshots or clear locations", "Include a short summary"],
      category: "design", asset: "usdg", amount: "1", selectionMode: "claim",
    } });
    expect(created.status).toBe(201);
    const job = created.body.data;
    createdJobIds.push(job.id);
    expect(job).toMatchObject({ status: "awaiting_funding", escrowAddress: expect.any(String), amountRaw: "1000000" });

    const otherKey = await call(appBase, "/v1/buyer/keys", { token: tokens[1], method: "POST", body: {} });
    expect((await call(buyerBase, `/v1/buyer/jobs/${job.id}`, { apiKey: otherKey.body.data.apiKey })).status).toBe(404);
    const below = await call(buyerBase, `/v1/buyer/jobs/${job.id}/funding-status`, { apiKey: key, method: "POST", body: {} });
    expect(below.body.data).toMatchObject({ status: "awaiting_funding", balanceSufficient: false, fundingVerified: false });
    expect((await db.query("SELECT status FROM jobs WHERE id=$1", [job.id])).rows[0].status).toBe("awaiting_funding");

    observedBalance = 1_000_000n;
    const sufficient = await call(buyerBase, `/v1/buyer/jobs/${job.id}/funding-status`, { apiKey: key, method: "POST", body: {} });
    expect(sufficient.body.data).toMatchObject({ status: "ready", balanceSufficient: true, fundingVerified: true, observedBalance: "1" });
    expect((await db.query("SELECT status,funding_block FROM jobs WHERE id=$1", [job.id])).rows[0]).toMatchObject({ status: "ready", funding_block: "123" });
    const events = await db.query("SELECT event_type FROM job_events WHERE job_id=$1", [job.id]);
    expect(events.rows.some(row => row.event_type === "job.funding_balance_verified")).toBe(true);

    const revoked = await call(appBase, "/v1/buyer/keys/revoke", { token: tokens[0], method: "POST", body: {} });
    expect(revoked.body.data.revoked).toBe(true);
    expect((await call(buyerBase, "/v1/buyer/jobs", { apiKey: key })).status).toBe(401);
  } finally {
    if (buyerServer) await new Promise<void>(resolve => buyerServer!.close(() => resolve()));
    await new Promise<void>(resolve => appServer.close(() => resolve()));
    if (createdJobIds.length) {
      await db.query("DELETE FROM job_events WHERE job_id=ANY($1::uuid[])", [createdJobIds]);
      await db.query("DELETE FROM job_escrow_wallets WHERE job_id=ANY($1::uuid[])", [createdJobIds]);
      await db.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [createdJobIds]);
    }
    await db.query("DELETE FROM buyer_api_keys WHERE user_id=ANY($1::uuid[])", [userIds]);
    await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  }
});
