import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("wallet owners can register scoped AI workers for writing and image generation", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Agent integration test needs a disposable database with 'test' in its name.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }, { hashAgentRuntimeToken }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"), import("../src/agents.js"),
  ]);
  await migrate();
  const ownerWallet = `0x${randomBytes(20).toString("hex")}`;
  const clientWallet = `0x${randomBytes(20).toString("hex")}`;
  const ownerSession = randomBytes(32).toString("base64url");
  const clientSession = randomBytes(32).toString("base64url");
  const userRows = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2) RETURNING id", [ownerWallet, clientWallet]);
  const ownerId = userRows.rows[0].id;
  const clientId = userRows.rows[1].id;
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day'),($3,$4,now()+interval '1 day')", [hashSessionToken(ownerSession), ownerId, hashSessionToken(clientSession), clientId]);
  const server = app.listen(0, "127.0.0.1");
  const agentIds: string[] = [];
  const jobIds: string[] = [];
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Agent integration API did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, token: string, method = "GET", body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
    }
    const createdAgent = await call("/v1/agents", ownerSession, "POST", { name: "Julie", description: "Writes sourced articles and social threads.", categories: ["writing"], expiresInDays: 30 });
    expect(createdAgent.status).toBe(201);
    const agent = createdAgent.body.data;
    agentIds.push(agent.id);
    const agentId = agent.id as string;
    const firstToken = agent.runtimeToken as string;
    expect(firstToken).toMatch(/^jsai_agent_/);
    expect(createdAgent.body.tokenWarning).toContain("shown only once");
    expect((await db.query("SELECT 1 FROM ai_agent_runtime_tokens WHERE token_hash=$1", [hashAgentRuntimeToken(firstToken)])).rowCount).toBe(1);
    expect((await call("/v1/agents", ownerSession)).body.data[0]).not.toHaveProperty("runtimeToken");
    const createdJohn = await call("/v1/agents", ownerSession, "POST", { name: "John", description: "Creates original image assets with Recraft.", categories: ["image_generation"], expiresInDays: 30 });
    expect(createdJohn.status).toBe(201);
    const john = createdJohn.body.data;
    agentIds.push(john.id);

    async function createFundedJob(title: string, category: string, clientToken = clientSession) {
      const created = await call("/v1/jobs", clientToken, "POST", { title, description: "Complete the writing task and cite public sources.", acceptanceCriteria: ["Include cited sources."], category, asset: "eth", amount: "0.01" });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;
      jobIds.push(id);
      await db.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [id, `0x${randomBytes(32).toString("hex")}`]);
      return id;
    }

    const writingJob = await createFundedJob("Write an article", "writing");
    const codingJob = await createFundedJob("Write code", "coding");
    const ownJob = await createFundedJob("Owner’s article", "writing", ownerSession);
    const overflowJob = await createFundedJob("Another article", "writing");
    const humanJob = await createFundedJob("Human-written article", "writing");
    const imageJob = await createFundedJob("Create a product image", "image_generation");
    const baseHeaders = `Bearer ${firstToken}`;
    const profile = await call("/v1/agent-runtime/profile", firstToken);
    expect(profile.body.data).toMatchObject({ id: agentId, name: "Julie", categories: ["writing"], ownerWallet });
    const listed = await call("/v1/agent-runtime/jobs", firstToken);
    expect(listed.body.data.map((item: { id: string }) => item.id)).toContain(writingJob);
    expect(listed.body.data.map((item: { id: string }) => item.id)).not.toContain(codingJob);
    expect(listed.body.data.map((item: { id: string }) => item.id)).not.toContain(ownJob);
    expect((await call("/v1/agent-runtime/jobs", john.runtimeToken)).body.data.map((item: { id: string }) => item.id)).toContain(imageJob);
    expect((await call(`/v1/agent-runtime/jobs/${writingJob}/claim`, john.runtimeToken, "POST", {})).status).toBe(403);

    expect((await call(`/v1/jobs/${humanJob}/claim`, ownerSession, "POST", {})).status).toBe(200);
    const claim = await call(`/v1/agent-runtime/jobs/${writingJob}/claim`, firstToken, "POST", {});
    expect(claim.status).toBe(200);
    expect(claim.body.data).toMatchObject({ workerType: "ai", agent: { id: agentId, name: "Julie" }, payoutWallet: ownerWallet });
    expect((await db.query("SELECT doer_id,doer_agent_id FROM jobs WHERE id=$1", [writingJob])).rows[0]).toEqual({ doer_id: ownerId, doer_agent_id: agentId });
    expect((await call(`/v1/agent-runtime/jobs/${codingJob}/claim`, firstToken, "POST", {})).status).toBe(403);
    expect((await call(`/v1/agent-runtime/jobs/${ownJob}/claim`, firstToken, "POST", {})).status).toBe(409);
    const overLimit = await call(`/v1/agent-runtime/jobs/${overflowJob}/claim`, firstToken, "POST", {});
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.error.code).toBe("active_claim_limit");
    expect((await call(`/v1/jobs/${writingJob}/submissions`, ownerSession, "POST", { summary: "manual", deliverable: "not allowed", evidence: [] })).status).toBe(403);
    const firstSubmission = await call(`/v1/agent-runtime/jobs/${writingJob}/submissions`, firstToken, "POST", { summary: "First draft", deliverable: "First article", evidence: ["https://example.com/source"] });
    expect(firstSubmission.status).toBe(201);
    expect(firstSubmission.body.data.submittedByAgent).toMatchObject({ id: agentId, name: "Julie" });
    const revisionRequest = await call(`/v1/jobs/${writingJob}/revisions`, clientSession, "POST", { feedback: "Add two practical examples." });
    expect(revisionRequest.status).toBe(200);
    const assigned = await call("/v1/agent-runtime/assigned-jobs", firstToken);
    expect(assigned.body.data[0]).toMatchObject({ id: writingJob, status: "revision_requested", revisionFeedback: "Add two practical examples." });

    const rotated = await call(`/v1/agents/${agentId}/runtime-token`, ownerSession, "POST", { expiresInDays: 30 });
    expect(rotated.status).toBe(201);
    expect((await call("/v1/agent-runtime/profile", firstToken)).status).toBe(401);
    const secondToken = rotated.body.data.runtimeToken as string;
    const revisionSubmission = await call(`/v1/agent-runtime/jobs/${writingJob}/submissions`, secondToken, "POST", { summary: "Revised draft", deliverable: "The revised article includes examples.", evidence: ["https://example.com/source"] });
    expect(revisionSubmission.status).toBe(201);
    const history = await call(`/v1/jobs/${writingJob}/submissions`, clientSession);
    expect(history.body.data).toHaveLength(2);
    expect(history.body.data.map((item: any) => item.submittedByAgent?.name)).toEqual(["Julie", "Julie"]);
    expect((await call("/v1/jobs/mine", ownerSession)).body.data.find((job: any) => job.id === writingJob)).toMatchObject({ workerType: "ai", doerAgent: { name: "Julie" } });

    await call(`/v1/jobs/${humanJob}/unclaim`, ownerSession, "POST", {});
    const takeoverJob = await createFundedJob("Article to take over", "writing");
    expect((await call(`/v1/agent-runtime/jobs/${takeoverJob}/claim`, secondToken, "POST", {})).status).toBe(200);
    expect((await call(`/v1/agent-runtime/jobs/${takeoverJob}/submissions`, secondToken, "POST", { summary: "Agent draft", deliverable: "Draft article", evidence: [] })).status).toBe(201);
    expect((await call(`/v1/jobs/${takeoverJob}/revisions`, clientSession, "POST", { feedback: "Add a conclusion." })).status).toBe(200);
    expect((await call(`/v1/jobs/${takeoverJob}/take-over-agent`, ownerSession, "POST", {})).status).toBe(200);
    const humanRevision = await call(`/v1/jobs/${takeoverJob}/submissions`, ownerSession, "POST", { summary: "Human revision", deliverable: "Completed article with a conclusion.", evidence: [] });
    expect(humanRevision.status).toBe(201);
    expect(humanRevision.body.data.revision).toBe(2);

    // The CI wallet claim limit is two; free the earlier lifecycle fixtures before exercising John.
    await db.query("UPDATE jobs SET status='cancelled',doer_id=NULL,doer_agent_id=NULL WHERE id=ANY($1::uuid[])", [[writingJob,takeoverJob]]);
    expect((await call(`/v1/agent-runtime/jobs/${imageJob}/claim`, john.runtimeToken, "POST", {})).status).toBe(200);
    expect((await call(`/v1/agent-runtime/jobs/${imageJob}/submissions`, john.runtimeToken, "POST", { summary: "Generated image", deliverable: "missing image", evidence: [] })).status).toBe(400);
    const imageSubmission = await call(`/v1/agent-runtime/jobs/${imageJob}/submissions`, john.runtimeToken, "POST", { summary: "Generated original image", deliverable: "https://res.cloudinary.com/jobsai/image/upload/sample.webp", evidence: ["https://res.cloudinary.com/jobsai/image/upload/sample.webp"] });
    expect(imageSubmission.status).toBe(201);
    expect(imageSubmission.body.data.submittedByAgent).toMatchObject({ id: john.id, name: "John" });
  } finally {
    server.close();
    if (jobIds.length) {
      await db.query("DELETE FROM job_events WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_revisions WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("UPDATE jobs SET active_submission_id=NULL WHERE id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_submissions WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_escrow_wallets WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [jobIds]);
    }
    if (agentIds.length) await db.query("DELETE FROM ai_agents WHERE id=ANY($1::uuid[])", [agentIds]);
    await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerId,clientId]]);
  }
});
