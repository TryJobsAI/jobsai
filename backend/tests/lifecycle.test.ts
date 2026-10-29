import { describe, expect, test } from "bun:test";
import {
  assertActiveClaimCapacity, assertCanCancelFundedJob, assertCanDispute, assertCanRequestRevision, assertCanSubmit, assertCanUnclaim, assertClaimable,
  assertDisputed, assertJobClient, assertNewWorkAvailable, assertParticipants, assertSettlementAllowed,
} from "../src/lifecycle.js";

function expectCode(run: () => unknown, status: number, code: string) {
  try { run(); } catch (error) { expect(error).toMatchObject({ status, code }); return; }
  throw new Error(`Expected ${code}`);
}

describe("job lifecycle rules", () => {
  test("funded ready jobs can only be cancelled by their client and always refund", () => {
    const ready = { client_id: "client", status: "ready", doer_id: null, doer_wallet: null };
    expect(() => assertCanCancelFundedJob(ready, "client")).not.toThrow();
    expectCode(() => assertCanCancelFundedJob(ready, "other"), 403, "client_only");
    for (const status of ["in_progress", "submitted", "disputed", "completed", "settlement_pending"])
      expectCode(() => assertCanCancelFundedJob({ ...ready, status }, "client"), 409, "job_not_cancellable");
    expect(() => assertSettlementAllowed(ready, "client", "client_cancellation", "refund_client")).not.toThrow();
    expectCode(() => assertSettlementAllowed(ready, "client", "client_cancellation", "pay_doer"), 409, "invalid_cancellation_outcome");
  });

  test("the pause blocks new work without blocking refunds, acceptance, disputes, or settlement decisions", () => {
    expect(() => assertNewWorkAvailable(false)).not.toThrow();
    expectCode(() => assertNewWorkAvailable(true), 503, "new_work_paused");
    const ready = { client_id: "client", status: "ready", doer_id: null, doer_wallet: null };
    expect(() => assertCanCancelFundedJob(ready, "client")).not.toThrow();
    expect(() => assertCanDispute({ client_id: "client", doer_id: "doer", status: "submitted" }, "client")).not.toThrow();
    expect(() => assertSettlementAllowed({ client_id: "client", doer_id: "doer", doer_wallet: "0xdoer", status: "submitted" }, "client", "client_acceptance", "pay_doer")).not.toThrow();
    expect(() => assertSettlementAllowed({ client_id: "client", doer_id: "doer", doer_wallet: "0xdoer", status: "disputed" }, "team", "team_dispute_resolution", "refund_client")).not.toThrow();
  });

  test("wallet claim capacity blocks additional active jobs at the configured limit", () => {
    expect(() => assertActiveClaimCapacity(0, 2)).not.toThrow();
    expect(() => assertActiveClaimCapacity(1, 2)).not.toThrow();
    expectCode(() => assertActiveClaimCapacity(2, 2), 409, "active_claim_limit");
    expectCode(() => assertActiveClaimCapacity(4, 2), 409, "active_claim_limit");
  });

  test("funding actions belong to client and claiming requires a ready, unexpired job", () => {
    expect(() => assertJobClient("0xAbC", "0xaBc")).not.toThrow();
    expectCode(() => assertJobClient("client", "other"), 403, "client_only");
    const job = { client_id: "client", status: "ready", deadline_at: new Date("2030-01-02") };
    expect(() => assertClaimable(job, "doer", new Date("2030-01-01"))).not.toThrow();
    expectCode(() => assertClaimable(job, "client"), 403, "client_cannot_claim");
    expectCode(() => assertClaimable({ ...job, status: "awaiting_funding" }, "doer"), 409, "job_not_claimable");
    expectCode(() => assertClaimable({ ...job, deadline_at: new Date("2020-01-01") }, "doer"), 409, "job_deadline_passed");
  });

  test("assigned doers may submit and revise repeatedly; other states and users are rejected", () => {
    for (const status of ["in_progress", "revision_requested"]) expect(() => assertCanSubmit({ doer_id: "doer", status }, "doer")).not.toThrow();
    expectCode(() => assertCanSubmit({ doer_id: "other", status: "in_progress" }, "doer"), 403, "doer_only");
    expectCode(() => assertCanSubmit({ doer_id: "doer", status: "disputed" }, "doer"), 409, "job_not_submittable");
    const submitted = { client_id: "client", status: "submitted", active_submission_id: "sub-2" };
    expect(() => assertCanRequestRevision(submitted, "client")).not.toThrow();
    expectCode(() => assertCanRequestRevision(submitted, "doer"), 403, "client_only");
    expectCode(() => assertCanRequestRevision({ ...submitted, active_submission_id: null }, "client"), 409, "job_not_reviewable");
  });

  test("a doer may unclaim only before submitting work", () => {
    expect(() => assertCanUnclaim({ doer_id: "doer", status: "in_progress", has_submissions: false }, "doer")).not.toThrow();
    expectCode(() => assertCanUnclaim({ doer_id: "other", status: "in_progress", has_submissions: false }, "doer"), 403, "doer_only");
    expectCode(() => assertCanUnclaim({ doer_id: "doer", status: "submitted", has_submissions: true }, "doer"), 409, "job_not_unclaimable");
    expectCode(() => assertCanUnclaim({ doer_id: "doer", status: "disputed", has_submissions: false }, "doer"), 409, "job_not_unclaimable");
  });

  test("participant access, dispute lock, and both settlement decisions are guarded", () => {
    const job = { client_id: "client", doer_id: "doer", status: "submitted" };
    expect(() => assertParticipants(job, "client")).not.toThrow();
    expectCode(() => assertParticipants(job, "stranger"), 403, "job_forbidden");
    expect(() => assertCanDispute(job, "doer")).not.toThrow();
    expectCode(() => assertCanDispute({ ...job, status: "completed" }, "client"), 409, "job_not_disputable");
    expect(() => assertDisputed("disputed")).not.toThrow();
    expectCode(() => assertDisputed("submitted"), 409, "job_not_disputed");
    const submitted = { ...job, doer_wallet: "0xdoer" };
    expect(() => assertSettlementAllowed(submitted, "client", "client_acceptance", "pay_doer")).not.toThrow();
    expectCode(() => assertSettlementAllowed(submitted, "doer", "client_acceptance", "pay_doer"), 403, "client_only");
    expectCode(() => assertSettlementAllowed({ ...submitted, status: "ready" }, "client", "client_acceptance", "pay_doer"), 409, "job_not_accepting");
    const disputed = { ...submitted, status: "disputed" };
    expect(() => assertSettlementAllowed(disputed, "team", "team_dispute_resolution", "pay_doer")).not.toThrow();
    expect(() => assertSettlementAllowed(disputed, "team", "team_dispute_resolution", "refund_client")).not.toThrow();
    expectCode(() => assertSettlementAllowed({ ...disputed, doer_id: null, doer_wallet: null }, "team", "team_dispute_resolution", "pay_doer"), 409, "doer_missing");
  });
});
