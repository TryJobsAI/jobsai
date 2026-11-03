import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { db } from "./db/index.js";
import { ApiError, asyncRoute } from "./http.js";
import { rateLimit, requestIdentity } from "./rate-limit.js";
import { userTagLookupSchema } from "./user-tags.js";
import { decryptPayload, encryptPayload, payloadDigest } from "./crypto.js";

export const messagesRouter = Router();
const startSchema = z.object({ recipientUserTag: userTagLookupSchema, asRole: z.enum(["buyer", "worker"]) }).strict();
const messageSchema = z.object({ body: z.string().trim().min(1).max(5_000) }).strict();
const conversationId = z.string().uuid();

messagesRouter.get("/conversations", requireAuth, rateLimit([
  { scope: "dm-list-user", limit: 120, windowSeconds: 60, identity: requestIdentity.authenticatedUser },
]), asyncRoute(async (request, response) => {
  const userId = request.auth!.userId;
  const result = await db.query<{
    id: string; other_user_tag: string | null; other_name: string | null; other_is_worker: boolean;
    last_body_ciphertext: string | null; last_sender_id: string | null; last_message_id: string | null; last_message_at: Date | null;
    unread_count: string; updated_at: Date;
  }>(
    `SELECT c.id,
            other_user.user_tag AS other_user_tag,
            CASE WHEN c.buyer_id=$1 THEN wp.full_name ELSE NULL END AS other_name,
            (c.worker_id<>$1) AS other_is_worker,
            last.body_ciphertext AS last_body_ciphertext,last.sender_id AS last_sender_id,last.id::text AS last_message_id,last.created_at AS last_message_at,
            (SELECT count(*)::text FROM direct_messages unseen
              WHERE unseen.conversation_id=c.id AND unseen.sender_id<>$1
                AND unseen.created_at>COALESCE(read.last_read_at,c.created_at)) AS unread_count,
            c.updated_at
       FROM direct_conversations c
       LEFT JOIN users other_user ON other_user.id=CASE WHEN c.buyer_id=$1 THEN c.worker_id ELSE c.buyer_id END
       LEFT JOIN worker_profiles wp ON wp.user_id=c.worker_id
       LEFT JOIN direct_conversation_reads read ON read.conversation_id=c.id AND read.user_id=$1
       LEFT JOIN LATERAL (SELECT id,body_ciphertext,sender_id,created_at FROM direct_messages
            WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last ON true
      WHERE c.buyer_id=$1 OR c.worker_id=$1
      ORDER BY COALESCE(last.created_at,c.updated_at) DESC LIMIT 100`, [userId],
  );
  response.json({ data: result.rows.map((row) => ({
    id: row.id,
    counterpart: { userTag: row.other_user_tag, name: row.other_name, role: row.other_is_worker ? "worker" : "buyer" },
    lastMessage: row.last_body_ciphertext && row.last_message_id ? {
      body: decryptPayload(row.last_body_ciphertext, `direct-message:${row.id}`),
      sentByMe: row.last_sender_id === userId, createdAt: row.last_message_at,
    } : null,
    unreadCount: Number(row.unread_count),
    updatedAt: row.updated_at,
  })) });
}));

messagesRouter.post("/conversations", requireAuth, rateLimit([
  { scope: "dm-start-user", limit: 20, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser },
]), asyncRoute(async (request, response) => {
  const input = startSchema.parse(request.body);
  const currentUserId = request.auth!.userId;
  const found = await db.query<{ id: string; profile_status: string | null }>(
    `SELECT u.id,wp.status AS profile_status FROM users u
       LEFT JOIN worker_profiles wp ON wp.user_id=u.id WHERE u.user_tag=$1`, [input.recipientUserTag],
  );
  const recipient = found.rows[0];
  if (!recipient) throw new ApiError(404, "dm_recipient_not_found", "No JobsAI account uses that usertag.");
  if (recipient.id === currentUserId) throw new ApiError(400, "dm_self_conversation", "You cannot start a conversation with yourself.");

  let buyerId: string;
  let workerId: string;
  if (input.asRole === "buyer") {
    if (recipient.profile_status !== "approved")
      throw new ApiError(403, "dm_worker_not_verified", "You can start a conversation as a buyer only with a JobsAI approved worker.");
    buyerId = currentUserId;
    workerId = recipient.id;
  } else {
    const profile = await db.query("SELECT 1 FROM worker_profiles WHERE user_id=$1 AND status='approved'", [currentUserId]);
    if (!profile.rowCount) throw new ApiError(403, "dm_worker_approval_required", "Only JobsAI approved workers can start a conversation as a worker.");
    buyerId = recipient.id;
    workerId = currentUserId;
  }

  const conversation = await db.query<{ id: string }>(
    `INSERT INTO direct_conversations(buyer_id,worker_id,created_by) VALUES($1,$2,$3)
     ON CONFLICT(buyer_id,worker_id) DO UPDATE SET updated_at=direct_conversations.updated_at
     RETURNING id`, [buyerId, workerId, currentUserId],
  );
  response.status(200).json({ data: { conversationId: conversation.rows[0].id } });
}));

messagesRouter.get("/conversations/:id/messages", requireAuth, rateLimit([
  { scope: "dm-read-user", limit: 240, windowSeconds: 60, identity: requestIdentity.authenticatedUser },
]), asyncRoute(async (request, response) => {
  const id = conversationId.parse(request.params.id);
  const userId = request.auth!.userId;
  const allowed = await db.query("SELECT 1 FROM direct_conversations WHERE id=$1 AND (buyer_id=$2 OR worker_id=$2)", [id, userId]);
  if (!allowed.rowCount) throw new ApiError(404, "dm_conversation_not_found", "This conversation does not exist.");
  await db.query(
    `INSERT INTO direct_conversation_reads(conversation_id,user_id,last_read_at) VALUES($1,$2,now())
     ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_at=now()`, [id, userId],
  );
  const messages = await db.query<{ id: string; sender_id: string; sender_tag: string | null; body_ciphertext: string; created_at: Date }>(
    `SELECT message.id::text AS id,message.sender_id,u.user_tag AS sender_tag,message.body_ciphertext,message.created_at
       FROM (SELECT * FROM direct_messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 100) message
       JOIN users u ON u.id=message.sender_id ORDER BY message.id ASC`, [id],
  );
  response.json({ data: messages.rows.map((message) => ({
    id: message.id, senderUserTag: message.sender_tag, sentByMe: message.sender_id === userId,
    body: decryptPayload(message.body_ciphertext, `direct-message:${id}`), createdAt: message.created_at,
  })) });
}));

messagesRouter.post("/conversations/:id/messages", requireAuth, rateLimit([
  { scope: "dm-send-user", limit: 60, windowSeconds: 3_600, identity: requestIdentity.authenticatedUser },
]), asyncRoute(async (request, response) => {
  const id = conversationId.parse(request.params.id);
  const { body } = messageSchema.parse(request.body);
  const userId = request.auth!.userId;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const allowed = await client.query<{ worker_id: string; verified: boolean }>(
      `SELECT c.worker_id,EXISTS(SELECT 1 FROM worker_profiles wp WHERE wp.user_id=c.worker_id AND wp.status='approved') AS verified
         FROM direct_conversations c WHERE c.id=$1 AND (c.buyer_id=$2 OR c.worker_id=$2) FOR UPDATE`, [id, userId],
    );
    if (!allowed.rowCount) throw new ApiError(404, "dm_conversation_not_found", "This conversation does not exist.");
    if (!allowed.rows[0].verified) throw new ApiError(403, "dm_worker_approval_required", "Messaging is paused until the worker profile is approved again.");
    const inserted = await client.query<{ id: string; sender_user_tag: string | null; created_at: Date }>(
      `INSERT INTO direct_messages(conversation_id,sender_id,body_ciphertext,body_digest) VALUES($1,$2,$3,$4)
       RETURNING id::text AS id,(SELECT user_tag FROM users WHERE id=$2) AS sender_user_tag,created_at`,
      [id, userId, encryptPayload(body, `direct-message:${id}`), payloadDigest(body)],
    );
    await client.query("UPDATE direct_conversations SET updated_at=$2 WHERE id=$1", [id, inserted.rows[0].created_at]);
    await client.query(
      `INSERT INTO direct_conversation_reads(conversation_id,user_id,last_read_at) VALUES($1,$2,$3)
       ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at`,
      [id, userId, inserted.rows[0].created_at],
    );
    await client.query("COMMIT");
    response.status(201).json({ data: { id: inserted.rows[0].id, senderUserTag: inserted.rows[0].sender_user_tag, sentByMe: true, body, createdAt: inserted.rows[0].created_at } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}));
