import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("worker profiles require review, publish safely, expose completed work metrics, and invalidate approval on edits", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Worker profile integration test needs a disposable database with 'test' in its name.");
  if (!process.env.MASTER_PASSWORD || process.env.MASTER_PASSWORD.length < 32) throw new Error("Set a 32-character MASTER_PASSWORD for the worker profile integration test.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"),
  ]);
  await migrate();
  const workerWallet = `0x${randomBytes(20).toString("hex")}`;
  const clientWallet = `0x${randomBytes(20).toString("hex")}`;
  const workerToken = randomBytes(32).toString("base64url");
  const outsiderToken = randomBytes(32).toString("base64url");
  const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2) RETURNING id", [workerWallet, clientWallet]);
  const workerId = users.rows[0].id;
  const clientId = users.rows[1].id;
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day'),($3,$4,now()+interval '1 day')", [hashSessionToken(workerToken),workerId,hashSessionToken(outsiderToken),clientId]);
  const claimedAt = new Date(Date.now() - 60_000);
  const completed = await db.query<{ id: string }>(
    `INSERT INTO jobs(client_id,doer_id,title,description,acceptance_criteria,asset,amount_raw,category,status,claimed_at,settled_at)
     VALUES($1,$2,'Reviewed spreadsheet','Remove duplicate rows.','["No duplicate rows"]','eth','10000000000000000','data','completed',$3,now()) RETURNING id`,
    [clientId,workerId,claimedAt],
  );
  const jobId = completed.rows[0].id;
  await db.query(
    "INSERT INTO job_submissions(job_id,submitted_by,revision,payload_ciphertext,payload_digest,created_at) VALUES($1,$2,1,'ciphertext','digest',$3)",
    [jobId,workerId,new Date(claimedAt.getTime() + 12_000)],
  );

  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Worker profile API did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, options: { token?: string; cookie?: string; method?: string; body?: unknown } = {}) {
      const result = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      return { status: result.status, body: result.status === 204 ? null : await result.json() as any, cookie: result.headers.get("set-cookie") };
    }
    const application = {
      fullName: "Morgan Worker", country: "Ghana", timeZone: "Africa/Accra", workHours: "Weekdays, 09:00–17:00 GMT",
      email: "morgan@example.com", phone: "+233 20 123 4567", publicProfile: true,
      rateTiers: [
        { name: "Standard", scope: "One data cleanup task", asset: "usdg", amount: "15" },
        { name: "Extended", scope: "A larger multi-sheet data task", asset: "eth", amount: "0.02" },
      ],
    };

    expect((await call("/v1/workers/me")).status).toBe(401);
    expect((await call("/v1/workers/morgan-worker-not-yet-public")).status).toBe(404);
    expect((await call("/v1/workers/me", { token: workerToken, method: "PUT", body: { ...application, timeZone: "Mars/Olympus" } })).status).toBe(400);
    const submitted = await call("/v1/workers/me", { token: workerToken, method: "PUT", body: application });
    expect(submitted.status).toBe(200);
    const profile = submitted.body.data;
    expect(profile).toMatchObject({ fullName: "Morgan Worker", status: "pending_review", publicProfile: true, completedJobs: 1, medianFirstDeliverySeconds: 12 });
    expect(profile.rateTiers).toHaveLength(2);
    expect((await call(`/v1/workers/${profile.slug}`)).status).toBe(404);
    expect((await call("/v1/master/worker-applications")).status).toBe(401);
    expect((await call("/v1/master/login", { method: "POST", body: { password: "incorrect-password" } })).status).toBe(401);

    const login = await call("/v1/master/login", { method: "POST", body: { password: process.env.MASTER_PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.cookie).toContain("jobsai_master_session=");
    const masterCookie = login.cookie!.split(";")[0];
    const queue = await call("/v1/master/worker-applications", { cookie: masterCookie });
    expect(queue.status).toBe(200);
    expect(queue.body.data[0]).toMatchObject({ id: profile.id, email: application.email, phone: application.phone });

    const changes = await call(`/v1/master/worker-applications/${profile.id}/review`, { cookie: masterCookie, method: "POST", body: { decision: "changes_requested", note: "Clarify your listed work hours." } });
    expect(changes.status).toBe(200);
    expect((await call(`/v1/workers/${profile.slug}`)).status).toBe(404);
    const resubmitted = await call("/v1/workers/me", { token: workerToken, method: "PUT", body: application });
    expect(resubmitted.body.data.status).toBe("pending_review");
    const approved = await call(`/v1/master/worker-applications/${profile.id}/review`, { cookie: masterCookie, method: "POST", body: { decision: "approved" } });
    expect(approved.status).toBe(200);

    const publicProfile = await call(`/v1/workers/${profile.slug}`);
    expect(publicProfile.status).toBe(200);
    expect(publicProfile.body.data).toMatchObject({ slug: profile.slug, fullName: "Morgan Worker", verified: true, completedJobs: 1, medianFirstDeliverySeconds: 12 });
    expect(publicProfile.body.data.completedJobHistory[0]).toMatchObject({ id: jobId, title: "Reviewed spreadsheet", category: "data" });
    expect(publicProfile.body.data).not.toHaveProperty("email");
    expect(publicProfile.body.data).not.toHaveProperty("phone");

    const edited = await call("/v1/workers/me", { token: workerToken, method: "PUT", body: { ...application, country: "Kenya" } });
    expect(edited.body.data.status).toBe("pending_review");
    expect((await call(`/v1/workers/${profile.slug}`)).status).toBe(404);
    expect((await call(`/v1/master/worker-applications/${profile.id}/review`, { cookie: masterCookie, method: "POST", body: { decision: "approved" } })).status).toBe(200);
  } finally {
    server.close();
    await db.query("DELETE FROM worker_profile_reviews WHERE profile_id IN (SELECT id FROM worker_profiles WHERE user_id=$1)", [workerId]);
    await db.query("DELETE FROM worker_profiles WHERE user_id=$1", [workerId]);
    await db.query("DELETE FROM job_submissions WHERE job_id=$1", [jobId]);
    await db.query("DELETE FROM jobs WHERE id=$1", [jobId]);
    await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[workerId,clientId]]);
  }
});
