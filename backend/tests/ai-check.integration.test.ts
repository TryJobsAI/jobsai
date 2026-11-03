import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("participants get a cached, encrypted AI check of each submission", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("AI check integration test needs a disposable database with 'test' in its name.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }, { aiCheckForSubmission }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"), import("../src/ai-check.js"),
  ]);
  await migrate();
  const wallets = [0, 1, 2].map(() => `0x${randomBytes(20).toString("hex")}`);
  const sessions = wallets.map(() => randomBytes(32).toString("base64url"));
  const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2),($3) RETURNING id", wallets);
  const userIds = users.rows.map((row) => row.id);
  await db.query(
    `INSERT INTO worker_profiles(user_id,slug,full_name,country,time_zone,work_hours,email,phone,rate_tiers,status)
     VALUES($1,$2,'CI Worker','United States','UTC','Flexible','worker@example.com','+12025550123',
       '[{"name":"Standard","scope":"Standard writing work","asset":"eth","amount":"0.01"}]'::jsonb,'pending_review')`,
    [userIds[1], `ai-check-worker-${randomBytes(4).toString("hex")}`],
  );
  const [clientSession, doerSession, strangerSession] = sessions;
  await db.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at) SELECT h,u,now()+interval '1 day' FROM unnest($1::text[],$2::uuid[]) AS t(h,u)`,
    [sessions.map((token) => hashSessionToken(token)), userIds],
  );
  const server = app.listen(0, "127.0.0.1");
  const jobIds: string[] = [];
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("AI check integration API did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, token: string, method = "GET", body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    }
    let modelCalls = 0;
    const reply = (status: number) => (async () => {
      modelCalls++;
      const content = { summary: "One price looks changed.", results: [
        { index: 0, status: "met", reason: "Both dishes are translated.", evidence: "Pollo asado — $14" },
        { index: 1, status: "not_met", reason: "The soup price differs from the original.", evidence: "Sopa de tomate — $9" },
      ] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status });
    }) as unknown as typeof fetch;

    const created = await call("/v1/jobs", clientSession, "POST", {
      title: "Translate our menu", description: "Translate the dinner menu into Spanish. Soup is $8.", acceptanceCriteria: ["Every dish is translated", "Prices stay unchanged"],
      category: "writing", asset: "eth", amount: "0.01",
    });
    const jobId = created.body.data.id as string;
    jobIds.push(jobId);
    // Seed a verified deposit; this test never broadcasts chain transactions.
    await db.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [jobId, `0x${randomBytes(32).toString("hex")}`]);
    expect((await call(`/v1/jobs/${jobId}/claim`, doerSession, "POST", {})).status).toBe(200);
    expect((await call(`/v1/jobs/${jobId}/ai-check`, doerSession)).body.error.code).toBe("submission_not_found");
    const submitted = await call(`/v1/jobs/${jobId}/submissions`, doerSession, "POST", { summary: "Translated the menu.", deliverable: "Sopa de tomate — $9\nPollo asado — $14", evidence: [] });
    expect(submitted.status).toBe(201);

    expect((await call(`/v1/jobs/${jobId}/ai-check`, strangerSession)).status).toBe(403);
    expect((await call(`/v1/jobs/${jobId}/ai-check`, doerSession)).body.error.code).toBe("ai_check_unconfigured");

    await expect(aiCheckForSubmission(jobId, null, { apiKey: "test", fetcher: reply(500) })).rejects.toMatchObject({ code: "ai_check_unavailable" });
    expect((await db.query<{ status: string }>("SELECT status FROM job_submission_ai_checks WHERE job_id=$1", [jobId])).rows[0].status).toBe("failed");

    const checked = await aiCheckForSubmission(jobId, null, { apiKey: "test", fetcher: reply(200) });
    expect(checked).toMatchObject({ status: "done", revision: 1, verdict: "needs_attention", metCount: 1, total: 2 });
    expect(checked.status === "done" && checked.criteria[1]).toMatchObject({ status: "not_met", evidence: "Sopa de tomate — $9" });
    const stored = await db.query<{ result_ciphertext: string }>("SELECT result_ciphertext FROM job_submission_ai_checks WHERE job_id=$1", [jobId]);
    expect(stored.rows[0].result_ciphertext).not.toContain("Sopa");

    // Cached results are served without another model call, even where no model key is configured.
    await aiCheckForSubmission(jobId, null, { apiKey: "test", fetcher: reply(200) });
    expect(modelCalls).toBe(2);
    const cached = await call(`/v1/jobs/${jobId}/ai-check`, clientSession);
    expect(cached.status).toBe(200);
    expect(cached.body.data).toMatchObject({ status: "done", submissionId: submitted.body.data.id, verdict: "needs_attention" });

    // A second submission gets its own check; a fresh "running" claim stops duplicate model calls.
    expect((await call(`/v1/jobs/${jobId}/revisions`, clientSession, "POST", { feedback: "Fix the soup price." })).status).toBe(200);
    const second = await call(`/v1/jobs/${jobId}/submissions`, doerSession, "POST", { summary: "Fixed the price.", deliverable: "Sopa de tomate — $8\nPollo asado — $14", evidence: [] });
    await db.query("INSERT INTO job_submission_ai_checks (submission_id,job_id,status,model) VALUES ($1,$2,'running','m')", [second.body.data.id, jobId]);
    expect(await aiCheckForSubmission(jobId, null, { apiKey: "test", fetcher: reply(200) })).toEqual({ status: "running", submissionId: second.body.data.id, revision: 2 });
    expect(modelCalls).toBe(2);
    expect((await call(`/v1/jobs/${jobId}/ai-check?submissionId=${submitted.body.data.id}`, clientSession)).body.data.revision).toBe(1);
  } finally {
    server.close();
    if (jobIds.length) {
      await db.query("DELETE FROM job_submission_ai_checks WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_revisions WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("UPDATE jobs SET active_submission_id=NULL WHERE id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_submissions WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_events WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_escrow_wallets WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [jobIds]);
    }
    await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
    await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  }
});
