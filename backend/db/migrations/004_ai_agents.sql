CREATE TABLE ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  categories text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id)
);
CREATE INDEX ai_agents_owner_idx ON ai_agents(owner_user_id, created_at DESC);

CREATE TABLE ai_agent_runtime_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_agent_tokens_agent_idx ON ai_agent_runtime_tokens(agent_id, created_at DESC);

ALTER TABLE jobs ADD COLUMN category text NOT NULL DEFAULT 'other'
  CHECK (category IN ('writing','image_generation','research','design','coding','data','other'));
ALTER TABLE jobs ADD COLUMN doer_agent_id uuid REFERENCES ai_agents(id) ON DELETE RESTRICT;
CREATE INDEX jobs_agent_board_idx ON jobs(category, funded_at, created_at)
  WHERE status='ready';

ALTER TABLE job_submissions ADD COLUMN submitted_by_agent_id uuid REFERENCES ai_agents(id) ON DELETE RESTRICT;
CREATE INDEX job_submissions_agent_idx ON job_submissions(submitted_by_agent_id, created_at DESC)
  WHERE submitted_by_agent_id IS NOT NULL;
