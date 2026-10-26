import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "bun:test";

const enabled = process.env.GITHUB_ACTIONS === "true" && process.env.JOBSAI_DB_INTEGRATION === "1";
const dbRouteTest = enabled ? test : test.skip;

dbRouteTest("PostgreSQL job routes enforce claim limits and create client refund settlements", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test"))
    throw new Error("Integration tests require a database name containing 'test'.");

  const [{ app }, { db }, { migrate }, { hashSessionToken }] = await Promise.all([
    import("../src/app.js"),
    import("../src/db/index.js"),
    import("../src/db/migrate.js"),
    import("../src/auth.js"),
  ]);
  await migrate();

  const clientWallet = `0x${randomBytes(20).toString("hex")}`;
  const doerWallet = `0x${randomBytes(20).toString("hex")}`;
  const disputeDoerWallet = `0x${randomBytes(20).toString("hex")}`;
  const teamWallet = process.env.TEAM_WALLET_ADDRESSES?.split(",")[0]?.trim().toLowerCase();
  if (!teamWallet) throw new Error("Integration tests require an authorized team wallet.");
  const clientToken = randomBytes(32).toString("base64url");
  const doerToken = randomBytes(32).toString("base64url");
  const disputeDoerToken = randomBytes(32).toString("base64url");
  const teamToken = randomBytes(32).toString("base64url");
  const jobIds: string[] = [];
  const nonceWallets: string[] = [];
  let userIds: string[] = [];
  let idsByWallet = new Map<string, string>();
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test API did not bind a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string; wallet_address: string }>(
        "INSERT INTO users (wallet_address) VALUES ($1),($2),($3),($4) RETURNING id,wallet_address",
        [clientWallet, doerWallet, disputeDoerWallet, teamWallet],
      );
      userIds = inserted.rows.map((row) => row.id);
      idsByWallet = new Map(inserted.rows.map((row) => [row.wallet_address, row.id]));
      await client.query(
        `INSERT INTO sessions (token_hash,user_id,expires_at)
         VALUES ($1,$2,now()+interval '1 day'),($3,$4,now()+interval '1 day'),
                ($5,$6,now()+interval '1 day'),($7,$8,now()+interval '1 day')`,
        [hashSessionToken(clientToken), idsByWallet.get(clientWallet), hashSessionToken(doerToken), idsByWallet.get(doerWallet),
          hashSessionToken(disputeDoerToken), idsByWallet.get(disputeDoerWallet), hashSessionToken(teamToken), idsByWallet.get(teamWallet)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    async function request(path: string, token: string, body: unknown, cookie?: string) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: response.status === 204 ? null : await response.json() as any, headers: response.headers };
    }

    async function get(path: string, token: string, cookie?: string) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) } });
      return { status: response.status, body: await response.json() as any };
    }

    async function createFundedReadyJob(title: string) {
      const created = await request("/v1/jobs", clientToken, {
        title,
        description: "Database route integration fixture.",
        acceptanceCriteria: ["Route state persists in PostgreSQL."],
        asset: "eth",
        amount: "0.01",
      });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;
      jobIds.push(id);
      // Seed a previously verified deposit; the route test never broadcasts chain transactions.
      await db.query("UPDATE jobs SET status='ready',funding_tx_hash=$2,funded_at=now() WHERE id=$1", [
        id,
        `0x${randomBytes(32).toString("hex")}`,
      ]);
      return id;
    }

    const [first, second, third, fourth, cancellation, disputed, payoutFailure] = await Promise.all([
      createFundedReadyJob("Claim cap one"),
      createFundedReadyJob("Claim cap two"),
      createFundedReadyJob("Concurrent claim three"),
      createFundedReadyJob("Concurrent claim four"),
      createFundedReadyJob("Refund before claim"),
      createFundedReadyJob("Dispute route lifecycle"),
      createFundedReadyJob("Recover failed payout"),
    ]);

    expect((await request(`/v1/jobs/${first}/claim`, doerToken, {})).status).toBe(200);

    const concurrentClaims = await Promise.all([
      request(`/v1/jobs/${second}/claim`, doerToken, {}),
      request(`/v1/jobs/${third}/claim`, doerToken, {}),
    ]);
    expect(concurrentClaims.filter((result) => result.status === 200)).toHaveLength(1);
    expect(concurrentClaims.filter((result) => result.status === 409)).toHaveLength(1);
    expect(concurrentClaims.find((result) => result.status === 409)?.body.error.code).toBe("active_claim_limit");
    const overLimitClaim = await request(`/v1/jobs/${fourth}/claim`, doerToken, {});
    expect(overLimitClaim.status).toBe(409);
    expect(overLimitClaim.body.error.code).toBe("active_claim_limit");

    const doerCancel = await request(`/v1/jobs/${cancellation}/cancel`, doerToken, {});
    expect(doerCancel.status).toBe(403);
    expect(doerCancel.body.error.code).toBe("client_only");

    const cancelled = await request(`/v1/jobs/${cancellation}/cancel`, clientToken, {});
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.data).toMatchObject({ jobId: cancellation, status: "settlement_pending", outcome: "refund_client" });

    const [job, settlement] = await Promise.all([
      db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [cancellation]),
      db.query<{ outcome: string; recipient: string; amount_raw: string }>(
        "SELECT outcome,recipient,amount_raw::text FROM job_settlements WHERE job_id=$1", [cancellation],
      ),
    ]);
    expect(job.rows[0].status).toBe("settlement_pending");
    expect(settlement.rows[0]).toMatchObject({ outcome: "refund_client", recipient: clientWallet, amount_raw: "10000000000000000" });

    const claimedCancel = await request(`/v1/jobs/${first}/cancel`, clientToken, {});
    expect(claimedCancel.status).toBe(409);
    expect(claimedCancel.body.error.code).toBe("job_not_cancellable");

    expect((await request(`/v1/jobs/${disputed}/claim`, disputeDoerToken, {})).status).toBe(200);
    expect((await request(`/v1/jobs/${payoutFailure}/claim`, doerToken, {})).status).toBe(200);
    await db.query(
      `INSERT INTO job_settlements(job_id,outcome,recipient,amount_raw,status,error)
       VALUES($1,'pay_doer',$2,10000000000000000,'pending','recipient rejected during gas estimation')`,
      [payoutFailure, doerWallet],
    );
    await db.query("UPDATE jobs SET status='settlement_pending' WHERE id=$1", [payoutFailure]);
    const submitted = await request(`/v1/jobs/${disputed}/submissions`, disputeDoerToken, {
      summary: "Completed the requested design work.",
      deliverable: "https://example.com/deliverable",
      evidence: ["https://example.com/evidence.png"],
    });
    expect(submitted.status).toBe(201);
    const revision = await request(`/v1/jobs/${disputed}/revisions`, clientToken, {
      feedback: "Please include the editable source file with the final image.",
    });
    expect(revision.status).toBe(200);
    expect(revision.body.data.status).toBe("revision_requested");
    const revisedSubmission = await request(`/v1/jobs/${disputed}/submissions`, disputeDoerToken, {
      summary: "Added the editable source file.",
      deliverable: "https://example.com/final-deliverable",
      evidence: ["https://example.com/source.zip"],
    });
    expect(revisedSubmission.status).toBe(201);
    expect(revisedSubmission.body.data.revision).toBe(2);
    const opened = await request(`/v1/jobs/${disputed}/disputes`, clientToken, { reason: "The delivery does not meet the agreed criteria." });
    expect(opened.status).toBe(201);
    expect(opened.body.data).toMatchObject({ jobId: disputed, status: "disputed" });

    const wrongPassword = await request("/v1/team/auth/login", teamToken, { password: "incorrect-team-password" });
    expect(wrongPassword.status).toBe(401);
    const teamLogin = await request("/v1/team/auth/login", teamToken, { password: process.env.JOBSAI_TEAM_PASSWORD });
    expect(teamLogin.status).toBe(200);
    const teamCookie = teamLogin.headers.get("set-cookie")?.split(";", 1)[0];
    expect(teamCookie).toStartWith("jobsai_team_session=");

    const noPassword = await get(`/v1/team/disputes/${disputed}`, teamToken);
    expect(noPassword.status).toBe(401);
    expect(noPassword.body.error.code).toBe("team_password_required");
    const nonTeamReview = await get(`/v1/team/disputes/${disputed}`, clientToken, teamCookie);
    expect(nonTeamReview.status).toBe(403);
    const review = await get(`/v1/team/disputes/${disputed}`, teamToken, teamCookie);
    expect(review.status).toBe(200);
    expect(review.body.data.dispute.reason).toBe("The delivery does not meet the agreed criteria.");
    expect(review.body.data.submissions).toHaveLength(2);
    expect(review.body.data.submissions[0]).toMatchObject({ summary: "Completed the requested design work.", revision: 1 });
    expect(review.body.data.submissions[1]).toMatchObject({ summary: "Added the editable source file.", revision: 2 });
    expect(review.body.data.revisions).toHaveLength(1);
    expect(review.body.data.revisions[0]).toMatchObject({ revision: 1, feedback: "Please include the editable source file with the final image." });
    expect(review.body.data.events.map((event: { event_type: string }) => event.event_type)).toEqual(
      expect.arrayContaining(["job.claimed", "job.submitted", "job.disputed"]),
    );

    const queue = await get("/v1/team/disputes", teamToken, teamCookie);
    expect(queue.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: payoutFailure, reviewType: "settlement_failure" })]));
    const failedPayoutReview = await get(`/v1/team/disputes/${payoutFailure}`, teamToken, teamCookie);
    expect(failedPayoutReview.body.data).toMatchObject({
      reviewType: "settlement_failure",
      dispute: { reason: expect.stringContaining("recipient rejected during gas estimation") },
    });
    const payoutDecision = await request(`/v1/team/disputes/${payoutFailure}/resolve`, teamToken, {
      outcome: "refund_client", note: "The submitted recipient cannot receive the transfer; return the job principal to the client.",
    }, teamCookie);
    expect(payoutDecision.status).toBe(202);
    const recovery = await db.query<{ outcome: string; recipient: string; error: string | null }>(
      "SELECT outcome,recipient,error FROM job_settlements WHERE job_id=$1", [payoutFailure],
    );
    expect(recovery.rows[0]).toMatchObject({ outcome: "refund_client", recipient: clientWallet, error: null });

    const resolved = await request(`/v1/team/disputes/${disputed}/resolve`, teamToken, {
      outcome: "pay_doer",
      note: "The submitted evidence satisfies the agreed acceptance criteria.",
    }, teamCookie);
    expect(resolved.status).toBe(202);
    expect(resolved.body.data).toMatchObject({ jobId: disputed, status: "settlement_pending", outcome: "pay_doer" });
    const [disputeRow, doerSettlement] = await Promise.all([
      db.query<{ resolution: string; resolved_by: string }>("SELECT resolution,resolved_by FROM job_disputes WHERE job_id=$1", [disputed]),
      db.query<{ outcome: string; recipient: string }>("SELECT outcome,recipient FROM job_settlements WHERE job_id=$1", [disputed]),
    ]);
    expect(disputeRow.rows[0]).toMatchObject({ resolution: "pay_doer", resolved_by: idsByWallet.get(teamWallet) });
    expect(doerSettlement.rows[0]).toMatchObject({ outcome: "pay_doer", recipient: disputeDoerWallet });

    const logout = await request("/v1/team/auth/logout", teamToken, {});
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await get("/v1/team/auth/status", teamToken)).status).toBe(401);

    const nonceBurst = await Promise.all(Array.from({ length: 300 }, async () => {
      const wallet = `0x${randomBytes(20).toString("hex")}`;
      nonceWallets.push(wallet);
      const response = await fetch(`${baseUrl}/v1/auth/nonce`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: wallet }),
      });
      return response.status;
    }));
    expect(nonceBurst.filter((status) => status === 200)).toHaveLength(20);
    expect(nonceBurst.filter((status) => status === 429)).toHaveLength(280);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    });
    if (jobIds.length) {
      await db.query("DELETE FROM job_settlement_reviews WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_settlements WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_events WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_disputes WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_revisions WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("UPDATE jobs SET active_submission_id=NULL WHERE id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_submissions WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_escrow_wallets WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [jobIds]);
    }
    if (nonceWallets.length) await db.query("DELETE FROM auth_nonces WHERE wallet_address=ANY($1::text[])", [nonceWallets]);
    if (userIds.length) {
      await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
      await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    }
    await db.end();
  }
});
