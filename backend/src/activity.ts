import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { db } from "./db/index.js";
import { asyncRoute } from "./http.js";

export const activityRouter = Router();

const eventLabels: Record<string, string> = {
  "job.funded": "Job funded",
  "job.funding_balance_verified": "Job funding confirmed",
  "job.opened_to_workers": "Job opened to workers",
  "job.claimed": "A worker claimed the job",
  "job.assigned": "A worker was assigned to the job",
  "job.unclaimed": "The worker released the job",
  "job.released": "The worker was released from the job",
  "job.submitted": "Work submitted for review",
  "job.revision_requested": "A revision was requested",
  "job.disputed": "A dispute was opened",
  "job.dispute_resolved": "The dispute was resolved",
  "job.accepted": "Work accepted",
  "job.settled": "Payment completed",
  "job.paid": "Payment completed",
  "job.cancellation_requested": "Job cancellation requested",
  "job.cancelled": "Job cancelled",
  "job.refunded": "Job refunded",
  "job.worker_released_by_client": "Worker released from the job",
  "job.worker_invited": "A worker invitation was sent",
  "job.invitation_accepted": "A worker accepted the invitation",
  "job.invitation_declined": "A worker declined the invitation",
  "job.proposal_submitted": "A worker sent a proposal",
  "job.proposal_updated": "A worker updated their proposal",
  "job.proposal_accepted": "A proposal was accepted",
};

activityRouter.get("/", requireAuth, asyncRoute(async (request, response) => {
  const limit = z.coerce.number().int().min(1).max(100).default(30).parse(request.query.limit);
  const before = request.query.before === undefined
    ? null
    : z.string().regex(/^\d{1,19}$/).parse(request.query.before);
  const userId = request.auth!.userId;
  const [events, unread] = await Promise.all([
    db.query<{
      event_id: string; job_id: string; job_title: string; event_type: string;
      created_at: Date; actor_user_tag: string | null; agent_name: string | null; read_at: Date | null; is_client: boolean;
    }>(
      `SELECT e.id::text AS event_id,e.job_id,j.title AS job_title,e.event_type,e.created_at,
              (j.client_id=$1) AS is_client,
              actor.user_tag AS actor_user_tag,e.details->>'agentName' AS agent_name,r.read_at
         FROM job_events e JOIN jobs j ON j.id=e.job_id
         LEFT JOIN users actor ON actor.id=e.actor_id
         LEFT JOIN job_event_reads r ON r.event_id=e.id AND r.user_id=$1
        WHERE (j.client_id=$1 OR j.doer_id=$1)
          AND (e.actor_id IS NULL OR e.actor_id<>$1)
          AND e.event_type=ANY($2::text[])
          AND ($3::bigint IS NULL OR e.id<$3::bigint)
        ORDER BY e.id DESC LIMIT $4`,
      [userId, Object.keys(eventLabels), before, limit],
    ),
    db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM job_events e JOIN jobs j ON j.id=e.job_id
        LEFT JOIN job_event_reads r ON r.event_id=e.id AND r.user_id=$1
       WHERE (j.client_id=$1 OR j.doer_id=$1)
         AND (e.actor_id IS NULL OR e.actor_id<>$1)
         AND e.event_type=ANY($2::text[]) AND r.event_id IS NULL`,
      [userId, Object.keys(eventLabels)],
    ),
  ]);
  const data = events.rows.map((row) => ({
    eventId: row.event_id,
    jobId: row.job_id,
    jobTitle: row.job_title,
    eventType: row.event_type,
    label: eventLabels[row.event_type] ?? "Job updated",
    createdAt: row.created_at,
    actor: row.agent_name ? `AI worker ${row.agent_name}` : row.actor_user_tag ? `@${row.actor_user_tag}` : null,
    tab: row.is_client ? "my-work" : "jobs",
    read: row.read_at !== null,
  }));
  response.json({ data, unreadCount: Number(unread.rows[0]?.count ?? 0), nextCursor: data.length === limit ? data.at(-1)?.eventId : null });
}));

activityRouter.post("/read", requireAuth, asyncRoute(async (request, response) => {
  const { eventIds } = z.object({ eventIds: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(100) }).parse(request.body);
  const result = await db.query(
    `INSERT INTO job_event_reads(user_id,event_id)
     SELECT $1,e.id FROM job_events e JOIN jobs j ON j.id=e.job_id
      WHERE e.id=ANY($2::bigint[]) AND (j.client_id=$1 OR j.doer_id=$1)
        AND (e.actor_id IS NULL OR e.actor_id<>$1)
     ON CONFLICT(user_id,event_id) DO NOTHING`,
    [request.auth!.userId, eventIds],
  );
  response.json({ data: { markedRead: result.rowCount ?? 0 } });
}));

activityRouter.post("/read-all", requireAuth, asyncRoute(async (request, response) => {
  const result = await db.query(
    `INSERT INTO job_event_reads(user_id,event_id)
     SELECT $1,e.id FROM job_events e JOIN jobs j ON j.id=e.job_id
      WHERE (j.client_id=$1 OR j.doer_id=$1)
        AND (e.actor_id IS NULL OR e.actor_id<>$1)
        AND e.event_type=ANY($2::text[])
        AND NOT EXISTS(SELECT 1 FROM job_event_reads r WHERE r.user_id=$1 AND r.event_id=e.id)
     ON CONFLICT(user_id,event_id) DO NOTHING`,
    [request.auth!.userId, Object.keys(eventLabels)],
  );
  response.json({ data: { markedRead: result.rowCount ?? 0 } });
}));
