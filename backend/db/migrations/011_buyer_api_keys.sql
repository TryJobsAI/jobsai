CREATE TABLE buyer_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_prefix text NOT NULL CHECK (char_length(token_prefix) BETWEEN 12 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX buyer_api_keys_one_active_per_user_idx ON buyer_api_keys(user_id) WHERE revoked_at IS NULL;
CREATE INDEX buyer_api_keys_user_idx ON buyer_api_keys(user_id,created_at DESC);
