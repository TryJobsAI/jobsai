import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("AI coding agents find, claim, and submit JobsAI work through the MCP endpoint", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("MCP integration test needs a disposable database with 'test' in its name.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"),
  ]);
  await migrate();
  const wallets = [0, 1].map(() => `0x${randomBytes(20).toString("hex")}`);
  const sessions = wallets.map(() => randomBytes(32).toString("base64url"));
  const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2) RETURNING id", wallets);
  const userIds = users.rows.map((row) => row.id);
  const [clientSession, ownerSession] = sessions;
  await db.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at) SELECT h,u,now()+interval '1 day' FROM unnest($1::text[],$2::uuid[]) AS t(h,u)`,
    [sessions.map((token) => hashSessionToken(token)), userIds],
  );
  const server = app.listen(0, "127.0.0.1");
  const jobIds: string[] = [];
  const clients: Client[] = [];
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP integration API did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, token: string, method = "GET", body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    }
    async function fundedJob(title: string, selectionMode: "claim" | "proposals") {
      const created = await call("/v1/jobs", clientSession, "POST", { title, description: "Write a 300-word product update.", acceptanceCriteria: ["Under 300 words"], category: "writing", asset: "eth", amount: "0.01", selectionMode });
      jobIds.push(created.body.data.id);
      // Seed a verified deposit; this test never broadcasts chain transactions.
      await db.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [created.body.data.id, `0x${randomBytes(32).toString("hex")}`]);
      return created.body.data.id as string;
    }
    async function connect(token: string) {
      const client = new Client({ name: "jobsai-test", version: "1.0.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client;
    }
    const parse = (result: any) => JSON.parse(result.content[0].text);

    const unauthenticated = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(unauthenticated.status).toBe(401);
    expect((await fetch(`${baseUrl}/mcp`)).status).toBe(405);

    const agent = await call("/v1/agents", ownerSession, "POST", { name: "Julie", description: "Writes product updates.", categories: ["writing"], capabilities: [], expiresInDays: 30 });
    const mcp = await connect(agent.body.data.runtimeToken);
    expect(mcp.getServerVersion()?.name).toBe("jobsai");
    expect(mcp.getInstructions()).toContain("list_assigned_jobs");
    const tools = (await mcp.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["check_submission", "claim_job", "find_jobs", "get_profile", "list_assigned_jobs", "list_my_proposals", "send_proposal", "submit_work", "unclaim_job"]);
    expect(tools.find((tool) => tool.name === "find_jobs")?.annotations?.readOnlyHint).toBe(true);
    expect((await mcp.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(["work_a_job"]);

    expect(parse(await mcp.callTool({ name: "get_profile", arguments: {} }))).toMatchObject({ name: "Julie", categories: ["writing"], ownerWallet: wallets[1] });
    const claimJobId = await fundedJob("Product update for October", "claim");
    const proposalJobId = await fundedJob("Launch announcement", "proposals");
    expect(parse(await mcp.callTool({ name: "find_jobs", arguments: {} })).map((job: { id: string }) => job.id)).toContain(claimJobId);
    expect(parse(await mcp.callTool({ name: "find_jobs", arguments: { selection: "proposals" } })).map((job: { id: string }) => job.id)).toContain(proposalJobId);

    const refused = await mcp.callTool({ name: "claim_job", arguments: { jobId: proposalJobId } });
    expect(refused.isError).toBe(true);
    expect((refused.content as any)[0].text).toContain("job_requires_proposal");
    expect(parse(await mcp.callTool({ name: "send_proposal", arguments: { jobId: proposalJobId, pitch: "Julie writes launch posts in your brand voice.", deliveryDays: 1 } }))).toMatchObject({ status: "pending", workerType: "ai" });
    expect(parse(await mcp.callTool({ name: "list_my_proposals", arguments: {} }))).toHaveLength(1);

    expect(parse(await mcp.callTool({ name: "claim_job", arguments: { jobId: claimJobId } }))).toMatchObject({ status: "in_progress", workerType: "ai" });
    expect(parse(await mcp.callTool({ name: "list_assigned_jobs", arguments: {} })).map((job: { id: string }) => job.id)).toEqual([claimJobId]);
    const submitted = parse(await mcp.callTool({ name: "submit_work", arguments: { jobId: claimJobId, summary: "Wrote the October update.", deliverable: "October brought three new features…", evidence: [] } }));
    expect(submitted).toMatchObject({ jobId: claimJobId, revision: 1, submittedByAgent: { name: "Julie" } });
    expect((await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [claimJobId])).rows[0].status).toBe("submitted");

    // Rotating the connection key cuts off MCP access along with the rest of the runtime API.
    const rotated = await call(`/v1/agents/${agent.body.data.id}/runtime-token`, ownerSession, "POST", { expiresInDays: 30 });
    await expect(connect(agent.body.data.runtimeToken)).rejects.toThrow();
    expect((await (await connect(rotated.body.data.runtimeToken)).listTools()).tools).toHaveLength(9);
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    server.close();
    if (jobIds.length) {
      await db.query("DELETE FROM job_proposals WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("UPDATE jobs SET active_submission_id=NULL WHERE id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_submissions WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_events WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_escrow_wallets WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [jobIds]);
    }
    await db.query("DELETE FROM ai_agent_runtime_tokens WHERE agent_id IN (SELECT id FROM ai_agents WHERE owner_user_id=ANY($1::uuid[]))", [userIds]);
    await db.query("DELETE FROM ai_agents WHERE owner_user_id=ANY($1::uuid[])", [userIds]);
    await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
    await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  }
});
