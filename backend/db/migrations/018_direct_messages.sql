CREATE TABLE direct_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, worker_id),
  CHECK (buyer_id <> worker_id)
);
CREATE INDEX direct_conversations_buyer_idx ON direct_conversations (buyer_id, updated_at DESC);
CREATE INDEX direct_conversations_worker_idx ON direct_conversations (worker_id, updated_at DESC);

CREATE TABLE direct_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body_ciphertext text NOT NULL CHECK (char_length(body_ciphertext) BETWEEN 1 AND 30_000),
  body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX direct_messages_history_idx ON direct_messages (conversation_id, id DESC);

CREATE TABLE direct_conversation_reads (
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
