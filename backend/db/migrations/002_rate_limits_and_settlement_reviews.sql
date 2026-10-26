CREATE TABLE request_rate_limits (
  rate_key text PRIMARY KEY CHECK (rate_key ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_rate_limits_updated_idx ON request_rate_limits (updated_at);

CREATE TABLE job_settlement_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  reviewer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('pay_doer','refund_client')),
  recipient text NOT NULL CHECK (recipient ~ '^0x[a-f0-9]{40}$'),
  note_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_settlement_reviews_history_idx ON job_settlement_reviews (job_id, created_at);
