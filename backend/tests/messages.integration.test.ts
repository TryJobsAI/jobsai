import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1";
const dbTest = enabled ? test : test.skip;

dbTest("direct messages are limited to approved worker and buyer conversations and only participants can read them", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Integration tests require a database name containing 'test'.");
  const [{ app }, { db }, { migrate }, { hashSessionToken }] = await Promise.all([
    import("../src/app.js"), import("../src/db/index.js"), import("../src/db/migrate.js"), import("../src/auth.js"),
  ]);
  await migrate();
  const wallets = Array.from({ length: 4 }, () => `0x${randomBytes(20).toString("hex")}`);
  const tags = Array.from({ length: 4 }, (_, index) => `dm-${index}-${randomBytes(3).toString("hex")}`);
  const tokens = Array.from({ length: 4 }, () => randomBytes(32).toString("base64url"));
  const userIds: string[] = [];
  let server: ReturnType<typeof app.listen> | undefined;
  try {
    const users = await db.query<{ id: string }>("INSERT INTO users(wallet_address,user_tag) VALUES($1,$5),($2,$6),($3,$7),($4,$8) RETURNING id", [...wallets, ...tags]);
    userIds.push(...users.rows.map((row) => row.id));
    for (let index = 0; index < userIds.length; index++)
      await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashSessionToken(tokens[index]), userIds[index]]);
    await db.query(
      `INSERT INTO worker_profiles(user_id,slug,full_name,country,time_zone,work_hours,email,phone,rate_tiers,status)
       VALUES($1,$3,'Approved worker','Ghana','Africa/Accra','Weekdays','dm@example.com','+233201234567',
              '[{"name":"Standard","scope":"General work","asset":"eth","amount":"0.01"}]'::jsonb,'approved'),
             ($2,$4,'Pending worker','Ghana','Africa/Accra','Weekdays','pending@example.com','+233201234567',
              '[{"name":"Standard","scope":"General work","asset":"eth","amount":"0.01"}]'::jsonb,'pending_review')`,
      [userIds[1], userIds[3], `approved-${randomBytes(4).toString("hex")}`, `pending-${randomBytes(4).toString("hex")}`],
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test API did not bind a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function call(path: string, token: string, method = "GET", body?: unknown) {
      const result = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: result.status, body: await result.json() as any };
    }

    const opened = await call("/v1/messages/conversations", tokens[0], "POST", { recipientUserTag: tags[1], asRole: "buyer" });
    expect(opened.status).toBe(200);
    const id = opened.body.data.conversationId;
    expect((await call("/v1/messages/conversations", tokens[0], "POST", { recipientUserTag: tags[3], asRole: "buyer" })).body.error.code).toBe("dm_worker_not_verified");
    expect((await call("/v1/messages/conversations", tokens[3], "POST", { recipientUserTag: tags[0], asRole: "worker" })).body.error.code).toBe("dm_worker_approval_required");

    const sent = await call(`/v1/messages/conversations/${id}/messages`, tokens[0], "POST", { body: "Could you share your availability?" });
    expect(sent.status).toBe(201);
    const stored = await db.query<{ body_ciphertext: string; body_digest: string }>("SELECT body_ciphertext,body_digest FROM direct_messages WHERE conversation_id=$1", [id]);
    expect(stored.rows[0].body_ciphertext).not.toContain("Could you share your availability?");
    expect(stored.rows[0].body_digest).toMatch(/^[a-f0-9]{64}$/);
    const unread = await call("/v1/messages/conversations", tokens[1]);
    expect(unread.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id, unreadCount: 1 })]));
    const workerMessages = await call(`/v1/messages/conversations/${id}/messages`, tokens[1]);
    expect(workerMessages.body.data).toEqual([expect.objectContaining({ body: "Could you share your availability?", sentByMe: false })]);

    const workerSent = await call(`/v1/messages/conversations/${id}/messages`, tokens[1], "POST", { body: "Yes, I am available this week." });
    expect(workerSent.status).toBe(201);
    const buyerMessages = await call(`/v1/messages/conversations/${id}/messages`, tokens[0]);
    expect(buyerMessages.body.data.at(-1)).toMatchObject({ body: "Yes, I am available this week.", sentByMe: false });
    expect((await call("/v1/messages/conversations", tokens[1])).body.data[0].unreadCount).toBe(0);
    expect((await call(`/v1/messages/conversations/${id}/messages`, tokens[2])).status).toBe(404);
    expect((await call(`/v1/messages/conversations/${id}/messages`, tokens[2], "POST", { body: "intrusion" })).status).toBe(404);
    expect((await call(`/v1/messages/conversations/${id}/messages`, tokens[0], "POST", { body: "   " })).status).toBe(400);
  } finally {
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections?.(); });
    if (userIds.length) {
      await db.query("DELETE FROM direct_conversations WHERE buyer_id=ANY($1::uuid[]) OR worker_id=ANY($1::uuid[])", [userIds]);
      await db.query("DELETE FROM worker_profiles WHERE user_id=ANY($1::uuid[])", [userIds]);
      await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
      await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    }
    await db.end();
  }
});
