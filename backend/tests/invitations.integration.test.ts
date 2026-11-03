import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("clients invite a specific worker and only that wallet can take the job", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Invitation integration test needs a disposable database with 'test' in its name.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }, { releaseExpiredClaims }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"), import("../src/jobs.js"),
  ]);
  await migrate();
  const wallets = Array.from({ length: 4 }, () => `0x${randomBytes(20).toString("hex")}`);
  const sessions = wallets.map(() => randomBytes(32).toString("base64url"));
  const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address) VALUES($1),($2),($3),($4) RETURNING id", wallets);
  const userIds = users.rows.map((row) => row.id);
  const [, firstInviteeId, , secondInviteeId] = userIds;
  const [clientWallet, firstInviteeWallet, , secondInviteeWallet] = wallets;
  const [clientSession, firstInviteeSession, strangerSession, secondInviteeSession] = sessions;
  await db.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at) SELECT h,u,now()+interval '1 day' FROM unnest($1::text[],$2::uuid[]) AS t(h,u)`,
    [sessions.map((token) => hashSessionToken(token)), userIds],
  );
  const server = app.listen(0, "127.0.0.1");
  const jobIds: string[] = [];
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Invitation integration API did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, token: string | null, method = "GET", body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    }
    const jobState = async (id: string) => (await db.query<{ status: string; doer_id: string | null; doer_agent_id: string | null; selection_mode: string }>(
      "SELECT status,doer_id,doer_agent_id,selection_mode FROM jobs WHERE id=$1", [id])).rows[0];
    const brief = { title: "Translate our menu", description: "Translate the dinner menu into Spanish.", acceptanceCriteria: ["Prices unchanged"], category: "writing", asset: "eth", amount: "0.01" };

    expect((await call("/v1/jobs", clientSession, "POST", { ...brief, selectionMode: "invite" })).body.error.code).toBe("invite_wallet_required");
    expect((await call("/v1/jobs", clientSession, "POST", { ...brief, selectionMode: "invite", inviteWallet: clientWallet })).body.error.code).toBe("cannot_invite_self");
    expect((await call("/v1/jobs", clientSession, "POST", { ...brief, inviteWallet: firstInviteeWallet })).body.error.code).toBe("invite_requires_invite_mode");

    const created = await call("/v1/jobs", clientSession, "POST", {
      ...brief, selectionMode: "invite", inviteWallet: `0x${firstInviteeWallet.slice(2).toUpperCase()}`, inviteMessage: "Loved your last translation.",
    });
    expect(created.status).toBe(201);
    const jobId = created.body.data.id as string;
    jobIds.push(jobId);
    expect(created.body.data).toMatchObject({ selectionMode: "invite", invitation: { wallet: firstInviteeWallet, status: "pending", message: "Loved your last translation." } });

    // Unfunded invitations stay hidden and cannot be accepted.
    expect((await call("/v1/jobs/invitations/mine", firstInviteeSession)).body.data).toEqual([]);
    expect((await call(`/v1/jobs/${jobId}/invitation/accept`, firstInviteeSession, "POST", {})).body.error.code).toBe("invitation_not_acceptable");
    // Seed a verified deposit; this test never broadcasts chain transactions.
    await db.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [jobId, `0x${randomBytes(32).toString("hex")}`]);

    expect((await call("/v1/jobs/ready", null)).body.data.map((job: { id: string }) => job.id)).not.toContain(jobId);
    const agent = await call("/v1/agents", strangerSession, "POST", { name: "Lingo", description: "Translates menus.", categories: ["writing"], capabilities: [], expiresInDays: 30 });
    expect((await call("/v1/agent-runtime/jobs", agent.body.data.runtimeToken)).body.data.map((job: { id: string }) => job.id)).not.toContain(jobId);
    expect((await call(`/v1/agent-runtime/jobs/${jobId}/claim`, agent.body.data.runtimeToken, "POST", {})).body.error.code).toBe("job_invite_only");
    expect((await call(`/v1/jobs/${jobId}/claim`, strangerSession, "POST", {})).body.error.code).toBe("job_invite_only");
    expect((await call(`/v1/jobs/${jobId}`, strangerSession)).status).toBe(404);
    expect((await call(`/v1/jobs/${jobId}`, firstInviteeSession)).status).toBe(200);
    const inbox = await call("/v1/jobs/invitations/mine", firstInviteeSession);
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0]).toMatchObject({ message: "Loved your last translation.", job: { id: jobId, clientWallet, amount: "0.01", asset: "ETH" } });

    expect((await call(`/v1/jobs/${jobId}/invitation/accept`, strangerSession, "POST", {})).body.error.code).toBe("invitation_not_found");
    expect((await call(`/v1/jobs/${jobId}/invitation/decline`, firstInviteeSession, "POST", {})).body.data.status).toBe("declined");
    expect((await call(`/v1/jobs/${jobId}`, clientSession)).body.data.invitation.status).toBe("declined");
    expect((await call(`/v1/jobs/${jobId}/invitation/accept`, firstInviteeSession, "POST", {})).status).toBe(404);

    expect((await call(`/v1/jobs/${jobId}/invitation`, strangerSession, "POST", { wallet: secondInviteeWallet })).status).toBe(403);
    expect((await call(`/v1/jobs/${jobId}/invitation`, clientSession, "POST", { wallet: secondInviteeWallet, message: "Can you take this?" })).status).toBe(201);
    const secondAgent = await call("/v1/agents", secondInviteeSession, "POST", { name: "Julie", description: "Writes and translates.", categories: ["writing"], capabilities: [], expiresInDays: 30 });
    const accepted = await call(`/v1/jobs/${jobId}/invitation/accept`, secondInviteeSession, "POST", { agentId: secondAgent.body.data.id });
    expect(accepted.body.data).toMatchObject({ status: "in_progress", workerType: "ai" });
    expect(await jobState(jobId)).toMatchObject({ status: "in_progress", doer_id: secondInviteeId, doer_agent_id: secondAgent.body.data.id });
    expect((await call("/v1/agent-runtime/assigned-jobs", secondAgent.body.data.runtimeToken)).body.data.map((job: { id: string }) => job.id)).toContain(jobId);
    expect((await call(`/v1/jobs/${jobId}/invitation`, clientSession, "POST", { wallet: firstInviteeWallet })).body.error.code).toBe("job_not_invitable");

    // The client chose this worker, so the 24-hour claim expiry does not hand the job back.
    await db.query("UPDATE jobs SET claimed_at=now()-interval '25 hours' WHERE id=$1", [jobId]);
    await releaseExpiredClaims();
    expect((await jobState(jobId)).status).toBe("in_progress");

    expect((await call(`/v1/jobs/${jobId}/release-worker`, clientSession, "POST", {})).body.data.status).toBe("ready");
    expect((await call(`/v1/jobs/${jobId}`, clientSession)).body.data.invitation.status).toBe("released");
    expect((await call(`/v1/jobs/${jobId}/open`, firstInviteeSession, "POST", { selectionMode: "claim" })).status).toBe(403);
    expect((await call(`/v1/jobs/${jobId}/open`, clientSession, "POST", { selectionMode: "claim" })).body.data.selectionMode).toBe("claim");
    expect((await call("/v1/jobs/ready", null)).body.data.map((job: { id: string }) => job.id)).toContain(jobId);
    expect((await call(`/v1/jobs/${jobId}/claim`, firstInviteeSession, "POST", {})).body.data.status).toBe("in_progress");
    expect(await jobState(jobId)).toMatchObject({ doer_id: firstInviteeId, selection_mode: "claim" });
  } finally {
    server.close();
    if (jobIds.length) {
      await db.query("DELETE FROM job_invitations WHERE job_id=ANY($1::uuid[])", [jobIds]);
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
