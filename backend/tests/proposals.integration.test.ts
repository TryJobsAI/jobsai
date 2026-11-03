import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("clients choose a worker from proposals and the chosen worker gets the job", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Proposal integration test needs a disposable database with 'test' in its name.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }, { releaseExpiredClaims }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"), import("../src/jobs.js"),
  ]);
  await migrate();
  const wallets = Array.from({ length: 4 }, () => `0x${randomBytes(20).toString("hex")}`);
  const sessions = wallets.map(() => randomBytes(32).toString("base64url"));
  const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2),($3),($4) RETURNING id", wallets);
  const userIds = users.rows.map((row) => row.id);
  const [clientId, humanId] = userIds;
  const [clientSession, humanSession, agentOwnerSession, strangerSession] = sessions;
  await db.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at) SELECT h,u,now()+interval '1 day' FROM unnest($1::text[],$2::uuid[]) AS t(h,u)`,
    [sessions.map((token) => hashSessionToken(token)), userIds],
  );
  await db.query(
    `INSERT INTO worker_profiles(user_id,slug,full_name,country,time_zone,work_hours,email,phone,rate_tiers,status)
     VALUES($1,$2,'Human Proposer','Ghana','Africa/Accra','Weekdays','human@example.com','+233201234567',
       '[{"name":"Standard","scope":"Writing work","asset":"eth","amount":"0.01"}]'::jsonb,'pending_review')`,
    [humanId, `human-proposer-${randomBytes(4).toString("hex")}`],
  );
  const server = app.listen(0, "127.0.0.1");
  const jobIds: string[] = [];
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Proposal integration API did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, token: string | null, method = "GET", body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    }
    const jobState = async (id: string) => (await db.query<{ status: string; doer_id: string | null; doer_agent_id: string | null }>(
      "SELECT status,doer_id,doer_agent_id FROM jobs WHERE id=$1", [id])).rows[0];

    const created = await call("/v1/jobs", clientSession, "POST", {
      title: "Rewrite our pricing page", description: "Rewrite the pricing page copy for clarity.", acceptanceCriteria: ["Under 400 words"],
      category: "writing", asset: "eth", amount: "0.01", selectionMode: "proposals",
    });
    expect(created.status).toBe(201);
    const jobId = created.body.data.id as string;
    jobIds.push(jobId);
    expect(created.body.data).toMatchObject({ selectionMode: "proposals", proposalCount: 0 });
    // Seed a verified deposit; this test never broadcasts chain transactions.
    await db.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [jobId, `0x${randomBytes(32).toString("hex")}`]);

    expect((await call(`/v1/jobs/${jobId}/claim`, humanSession, "POST", {})).body.error.code).toBe("job_requires_proposal");
    expect((await call(`/v1/jobs/${jobId}/proposals`, clientSession, "POST", { pitch: "I can do this myself quite well." })).body.error.code).toBe("client_cannot_propose");
    expect((await call(`/v1/jobs/${jobId}/proposals`, humanSession, "POST", { pitch: "Too short" })).status).toBe(400);

    const pitch = "I write SaaS pricing pages and will keep it under 400 words.";
    const first = await call(`/v1/jobs/${jobId}/proposals`, humanSession, "POST", { pitch, deliveryDays: 2 });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ workerType: "human", status: "pending", deliveryDays: 2, completedJobs: 0 });
    const resent = await call(`/v1/jobs/${jobId}/proposals`, humanSession, "POST", { pitch: `${pitch} Two drafts included.`, deliveryDays: 3 });
    expect(resent.status).toBe(200);
    expect(resent.body.data).toMatchObject({ id: first.body.data.id, deliveryDays: 3 });

    const agent = await call("/v1/agents", agentOwnerSession, "POST", { name: "Julie", description: "Writes sourced articles.", categories: ["writing"], capabilities: [], expiresInDays: 30 });
    const runtimeToken = agent.body.data.runtimeToken as string;
    const claimList = await call("/v1/agent-runtime/jobs", runtimeToken);
    expect(claimList.body.data.map((job: { id: string }) => job.id)).not.toContain(jobId);
    const proposalList = await call("/v1/agent-runtime/jobs?selection=proposals", runtimeToken);
    expect(proposalList.body.data.map((job: { id: string }) => job.id)).toContain(jobId);
    expect((await call(`/v1/agent-runtime/jobs/${jobId}/claim`, runtimeToken, "POST", {})).body.error.code).toBe("job_requires_proposal");
    const agentProposal = await call(`/v1/agent-runtime/jobs/${jobId}/proposals`, runtimeToken, "POST", { pitch: "Julie drafts the page from your current copy in one pass.", deliveryDays: 1 });
    expect(agentProposal.status).toBe(201);
    expect(agentProposal.body.data).toMatchObject({ workerType: "ai", agent: { id: agent.body.data.id, name: "Julie" } });
    expect((await call("/v1/agent-runtime/proposals", runtimeToken)).body.data.map((item: { id: string }) => item.id)).toEqual([agentProposal.body.data.id]);

    const seenByClient = await call(`/v1/jobs/${jobId}/proposals`, clientSession);
    expect(seenByClient.body.data).toHaveLength(2);
    expect((await call(`/v1/jobs/${jobId}/proposals`, humanSession)).body.data.map((item: { id: string }) => item.id)).toEqual([first.body.data.id]);
    expect((await call(`/v1/jobs/${jobId}/proposals`, strangerSession)).body.data).toEqual([]);
    expect((await call("/v1/jobs/ready", null)).body.data.find((job: { id: string }) => job.id === jobId)).toMatchObject({ proposalCount: 2 });

    expect((await call(`/v1/jobs/${jobId}/proposals/${first.body.data.id}/withdraw`, humanSession, "POST", {})).body.data.status).toBe("withdrawn");
    expect((await call(`/v1/jobs/${jobId}/proposals/${first.body.data.id}/accept`, clientSession, "POST", {})).body.error.code).toBe("proposal_not_pending");
    expect((await call(`/v1/jobs/${jobId}/proposals`, humanSession, "POST", { pitch, deliveryDays: 2 })).body.data.status).toBe("pending");

    expect((await call(`/v1/jobs/${jobId}/proposals/${agentProposal.body.data.id}/accept`, strangerSession, "POST", {})).status).toBe(403);
    const accepted = await call(`/v1/jobs/${jobId}/proposals/${agentProposal.body.data.id}/accept`, clientSession, "POST", {});
    expect(accepted.status).toBe(200);
    expect(await jobState(jobId)).toMatchObject({ status: "in_progress", doer_agent_id: agent.body.data.id });
    expect((await call("/v1/agent-runtime/assigned-jobs", runtimeToken)).body.data.map((job: { id: string }) => job.id)).toContain(jobId);
    expect((await call(`/v1/jobs/${jobId}/proposals/${first.body.data.id}/accept`, clientSession, "POST", {})).body.error.code).toBe("job_not_accepting_proposals");
    expect((await call(`/v1/jobs/${jobId}/proposals`, strangerSession, "POST", { pitch })).body.error.code).toBe("job_not_accepting_proposals");

    // The client picked this worker, so the 24-hour claim expiry does not hand the job back.
    await db.query("UPDATE jobs SET claimed_at=now()-interval '25 hours' WHERE id=$1", [jobId]);
    await releaseExpiredClaims();
    expect((await jobState(jobId)).status).toBe("in_progress");

    expect((await call(`/v1/agent-runtime/jobs/${jobId}/unclaim`, runtimeToken, "POST", {})).body.data.status).toBe("ready");
    const afterRelease = await call(`/v1/jobs/${jobId}/proposals`, clientSession);
    expect(afterRelease.body.data.find((item: { id: string }) => item.id === agentProposal.body.data.id).status).toBe("released");
    expect((await call(`/v1/agent-runtime/jobs/${jobId}/proposals`, runtimeToken, "POST", { pitch: "Julie would like another go at this job." })).body.error.code).toBe("proposal_closed");

    const runnerUp = await call(`/v1/jobs/${jobId}/proposals/${first.body.data.id}/accept`, clientSession, "POST", {});
    expect(runnerUp.status).toBe(200);
    expect(await jobState(jobId)).toEqual({ status: "in_progress", doer_id: humanId, doer_agent_id: null });

    const claimJob = await call("/v1/jobs", clientSession, "POST", { title: "Quick claim job", description: "Anyone can claim this.", acceptanceCriteria: ["Done"], category: "writing", asset: "eth", amount: "0.01" });
    jobIds.push(claimJob.body.data.id);
    expect(claimJob.body.data.selectionMode).toBe("claim");
    await db.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [claimJob.body.data.id, `0x${randomBytes(32).toString("hex")}`]);
    expect((await call(`/v1/jobs/${claimJob.body.data.id}/proposals`, humanSession, "POST", { pitch })).body.error.code).toBe("job_not_accepting_proposals");
  } finally {
    server.close();
    if (jobIds.length) {
      await db.query("DELETE FROM job_proposals WHERE job_id=ANY($1::uuid[])", [jobIds]);
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
