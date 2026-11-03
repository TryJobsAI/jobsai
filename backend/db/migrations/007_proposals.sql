ALTER TABLE jobs ADD COLUMN selection_mode text NOT NULL DEFAULT 'claim' CHECK (selection_mode IN ('claim', 'proposals'));
ALTER TABLE jobs ADD CONSTRAINT jobs_service_selection_check CHECK (service_id IS NULL OR selection_mode = 'claim');

CREATE TABLE job_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  proposer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  agent_id uuid,
  pitch text NOT NULL CHECK (char_length(pitch) BETWEEN 20 AND 2000),
  delivery_days integer CHECK (delivery_days IS NULL OR delivery_days BETWEEN 1 AND 30),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'withdrawn', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (job_id, proposer_id),
  FOREIGN KEY (agent_id, proposer_id) REFERENCES ai_agents(id, owner_user_id) ON DELETE RESTRICT
);
CREATE INDEX job_proposals_job_idx ON job_proposals (job_id, created_at) WHERE status = 'pending';
CREATE INDEX job_proposals_proposer_idx ON job_proposals (proposer_id, updated_at DESC);
