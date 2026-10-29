import { ApiError } from "./http.js";

type ClaimableJob = { client_id: string; status: string; deadline_at: Date | null };
type SubmissionJob = { doer_id: string | null; status: string };
type UnclaimableJob = { doer_id: string | null; status: string; has_submissions: boolean };
type ReviewJob = { client_id: string; status: string; active_submission_id: string | null };
type DisputableJob = { client_id: string; doer_id: string | null; status: string };
type SettlementJob = {
  client_id: string;
  doer_id: string | null;
  doer_wallet: string | null;
  status: string;
};

export function assertNewWorkAvailable(paused: boolean) {
  if (paused)
    throw new ApiError(503, "new_work_paused", "Creating jobs, funding them, and claiming work are temporarily paused.");
}

export function assertActiveClaimCapacity(activeClaims: number, maxActiveClaims: number) {
  if (!Number.isInteger(activeClaims) || activeClaims < 0 || !Number.isInteger(maxActiveClaims) || maxActiveClaims < 1)
    throw new Error("Claim capacity values must be non-negative integers with a positive limit.");
  if (activeClaims >= maxActiveClaims)
    throw new ApiError(409, "active_claim_limit", `You already have ${activeClaims} active claimed jobs. Complete or unclaim one before claiming more.`);
}

export function assertCanCancelFundedJob(job: { client_id: string; status: string }, actorId: string) {
  if (job.client_id !== actorId)
    throw new ApiError(403, "client_only", "Only the client can cancel this job.");
  if (job.status !== "ready")
    throw new ApiError(409, "job_not_cancellable", "A funded job can only be cancelled before a worker claims it.");
}

export function assertJobClient(clientWallet: string, actorWallet: string) {
  if (clientWallet.toLowerCase() !== actorWallet.toLowerCase())
    throw new ApiError(403, "client_only", "Only the job client can perform this action.");
}

export function assertClaimable(job: ClaimableJob, actorId: string, now = new Date()) {
  if (job.client_id === actorId)
    throw new ApiError(403, "client_cannot_claim", "The client cannot claim their own job.");
  if (job.status !== "ready")
    throw new ApiError(409, "job_not_claimable", "This job is no longer ready to claim.");
  if (job.deadline_at && job.deadline_at <= now)
    throw new ApiError(409, "job_deadline_passed", "This job's deadline has passed.");
}

export function assertCanUnclaim(job: UnclaimableJob, actorId: string) {
  if (job.doer_id !== actorId)
    throw new ApiError(403, "doer_only", "Only the doer who claimed this job can unclaim it.");
  if (job.status !== "in_progress" || job.has_submissions)
    throw new ApiError(409, "job_not_unclaimable", "A job can only be unclaimed before any work is submitted.");
}

export function assertCanSubmit(job: SubmissionJob, actorId: string) {
  if (job.doer_id !== actorId)
    throw new ApiError(403, "doer_only", "Only the doer who claimed this job can submit work.");
  if (!["in_progress", "revision_requested"].includes(job.status))
    throw new ApiError(409, "job_not_submittable", "This job is not accepting a submission.");
}

export function assertParticipants(job: { client_id: string; doer_id: string | null }, actorId: string) {
  if (![job.client_id, job.doer_id].includes(actorId))
    throw new ApiError(403, "job_forbidden", "Only the job participants can view this information.");
}

export function assertCanRequestRevision(job: ReviewJob, actorId: string) {
  if (job.client_id !== actorId)
    throw new ApiError(403, "client_only", "Only the client can request changes.");
  if (job.status !== "submitted" || !job.active_submission_id)
    throw new ApiError(409, "job_not_reviewable", "Only a submitted job can be sent back for changes.");
}

export function assertCanDispute(job: DisputableJob, actorId: string) {
  assertParticipants(job, actorId);
  if (!["in_progress", "submitted", "revision_requested"].includes(job.status))
    throw new ApiError(409, "job_not_disputable", "This job cannot be disputed in its current state.");
}

export function assertDisputed(status: string) {
  if (status !== "disputed")
    throw new ApiError(409, "job_not_disputed", "Only a disputed job can be resolved.");
}

export function assertSettlementAllowed(
  job: SettlementJob,
  actorId: string,
  cause: "client_acceptance" | "client_cancellation" | "team_dispute_resolution",
  outcome: "pay_doer" | "refund_client",
) {
  if (cause === "client_acceptance") {
    if (job.client_id !== actorId) throw new ApiError(403, "client_only", "Only the client can accept work.");
    if (job.status !== "submitted") throw new ApiError(409, "job_not_accepting", "Only a submitted job can be accepted.");
  } else if (cause === "client_cancellation") {
    if (job.client_id !== actorId) throw new ApiError(403, "client_only", "Only the client can cancel this job.");
    if (job.status !== "ready") throw new ApiError(409, "job_not_cancellable", "A funded job can only be cancelled before a worker claims it.");
    if (outcome !== "refund_client") throw new ApiError(409, "invalid_cancellation_outcome", "Cancelling a job must refund the client.");
  } else {
    assertDisputed(job.status);
  }
  if (outcome === "pay_doer" && (!job.doer_id || !job.doer_wallet))
    throw new ApiError(409, "doer_missing", "This job has no assigned doer to pay.");
}
