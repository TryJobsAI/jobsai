import { createHmac, randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("job events are queued and delivered as signed webhooks to the job's participants", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Webhook integration test needs a disposable database with 'test' in its name.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }, { deliverWebhooks }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"), import("../src/webhooks.js"),
  ]);
  await migrate();
  const wallets = [0, 1, 2].map(() => `0x${randomBytes(20).toString("hex")}`);
  const sessions = wallets.map(() => randomBytes(32).toString("base64url"));
  const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2),($3) RETURNING id", wallets);
  const userIds = users.rows.map((row) => row.id);
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
    if (!address || typeof address === "string") throw new Error("Webhook integration API did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, token: string, method = "GET", body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
    }
    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const receiver = (status: number) => (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("ok", { status });
    }) as unknown as typeof fetch;
    const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
    const queued = async (endpointId: string) => (await db.query<{ event_type: string; status: string; attempts: number }>(
      "SELECT event_type,status,attempts FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY created_at,event_type", [endpointId])).rows;

    expect((await call("/v1/webhooks", clientSession, "POST", { url: "http://hooks.example.com/jobsai" })).status).toBe(400);
    expect((await call("/v1/webhooks", clientSession, "POST", { url: "https://169.254.169.254/latest" })).status).toBe(400);
    const clientHook = await call("/v1/webhooks", clientSession, "POST", { url: "https://hooks.example.com/jobsai", description: "Ops channel" });
    expect(clientHook.status).toBe(201);
    expect(clientHook.body.data).toMatchObject({ allEvents: true, active: true, deliveredCount: 0 });
    const clientSecret = clientHook.body.data.secret as string;
    expect(clientSecret).toStartWith("whsec_");
    const listed = await call("/v1/webhooks", clientSession);
    expect(listed.body.data).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(clientSecret);
    expect(listed.body.eventTypes).toContain("job.paid");
    const doerHook = await call("/v1/webhooks", doerSession, "POST", { url: "https://agents.example.com/hook", events: ["job.assigned"] });
    expect((await call(`/v1/webhooks/${clientHook.body.data.id}`, strangerSession, "PATCH", { active: false })).status).toBe(404);
    expect((await call(`/v1/webhooks/${clientHook.body.data.id}/deliveries`, strangerSession)).status).toBe(404);

    const created = await call("/v1/jobs", clientSession, "POST", { title: "Write release notes", description: "Summarise the release.", acceptanceCriteria: ["Under 200 words"], category: "writing", asset: "eth", amount: "0.01" });
    const jobId = created.body.data.id as string;
    jobIds.push(jobId);
    // Seed a verified deposit; this test never broadcasts chain transactions.
    await db.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [jobId, `0x${randomBytes(32).toString("hex")}`]);
    expect((await call(`/v1/jobs/${jobId}/claim`, doerSession, "POST", {})).status).toBe(200);
    expect((await call(`/v1/jobs/${jobId}/submissions`, doerSession, "POST", { summary: "Done.", deliverable: "Release 2.1 adds proposals.", evidence: [] })).status).toBe(201);

    expect((await queued(clientHook.body.data.id)).map((row) => row.event_type)).toEqual(["job.created", "job.assigned", "job.submitted"]);
    expect((await queued(doerHook.body.data.id)).map((row) => row.event_type)).toEqual(["job.assigned"]);

    // Private resolution is refused before any request leaves the server, and the delivery is retried later.
    const blocked = await deliverWebhooks({ fetcher: receiver(200), lookup: async () => [{ address: "10.0.0.7", family: 4 }] });
    expect(blocked.every((item) => item.status === "pending" && item.error?.includes("public internet addresses"))).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await deliverWebhooks({ fetcher: receiver(200), lookup: publicDns })).toEqual([]);

    await db.query("UPDATE webhook_deliveries SET next_attempt_at=now() WHERE endpoint_id=ANY($1::uuid[])", [[clientHook.body.data.id, doerHook.body.data.id]]);
    const delivered = await deliverWebhooks({ fetcher: receiver(200), lookup: publicDns, now: () => new Date("2026-11-03T12:00:00Z") });
    expect(delivered).toHaveLength(4);
    expect(delivered.every((item) => item.status === "delivered" && item.responseStatus === 200)).toBe(true);
    const submittedEvent = sent.find((item) => item.headers["jobsai-event-type"] === "job.submitted")!;
    expect(submittedEvent.url).toBe("https://hooks.example.com/jobsai");
    const timestamp = Math.floor(new Date("2026-11-03T12:00:00Z").getTime() / 1000);
    expect(submittedEvent.headers["jobsai-signature"]).toBe(`t=${timestamp},v1=${createHmac("sha256", clientSecret).update(`${timestamp}.${submittedEvent.body}`).digest("hex")}`);
    const payload = JSON.parse(submittedEvent.body);
    expect(payload).toMatchObject({ id: submittedEvent.headers["jobsai-event-id"], type: "job.submitted", data: { job: { id: jobId, status: "submitted", amount: "0.01", asset: "ETH", clientWallet: wallets[0], doerWallet: wallets[1] } } });
    expect(payload.data.details).toEqual({ submissionId: expect.any(String), revision: 1 });

    // Failed deliveries back off, and a paused endpoint stops receiving new events.
    expect((await call(`/v1/jobs/${jobId}/revisions`, clientSession, "POST", { feedback: "Shorter please." })).status).toBe(200);
    const failed = await deliverWebhooks({ fetcher: receiver(500), lookup: publicDns });
    expect(failed).toEqual([expect.objectContaining({ status: "pending", responseStatus: 500, error: "Endpoint responded with HTTP 500." })]);
    expect(await deliverWebhooks({ fetcher: receiver(200), lookup: publicDns })).toEqual([]);
    const history = await call(`/v1/webhooks/${clientHook.body.data.id}/deliveries`, clientSession);
    expect(history.body.data[0]).toMatchObject({ eventType: "job.revision_requested", status: "pending", attempts: 1, responseStatus: 500, jobId });
    expect((await call(`/v1/webhooks/${clientHook.body.data.id}`, clientSession, "PATCH", { active: false })).body.data.active).toBe(false);
    expect((await call(`/v1/jobs/${jobId}/disputes`, clientSession, "POST", { reason: "The notes miss the pricing change." })).status).toBeLessThan(300);
    expect((await queued(clientHook.body.data.id)).map((row) => row.event_type)).not.toContain("job.disputed");

    const rotated = await call(`/v1/webhooks/${clientHook.body.data.id}/rotate-secret`, clientSession, "POST", {});
    expect(rotated.body.data.secret).not.toBe(clientSecret);
    expect((await call(`/v1/webhooks/${doerHook.body.data.id}`, doerSession, "DELETE")).status).toBe(204);
    expect((await call("/v1/webhooks", doerSession)).body.data).toEqual([]);
  } finally {
    server.close();
    await db.query("DELETE FROM webhook_endpoints WHERE owner_id=ANY($1::uuid[])", [userIds]);
    if (jobIds.length) {
      await db.query("DELETE FROM job_disputes WHERE job_id=ANY($1::uuid[])", [jobIds]).catch(() => {});
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
