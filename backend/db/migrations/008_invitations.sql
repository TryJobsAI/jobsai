ALTER TABLE jobs DROP CONSTRAINT jobs_selection_mode_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_selection_mode_check CHECK (selection_mode IN ('claim', 'proposals', 'invite'));

CREATE TABLE job_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invitee_wallet text NOT NULL CHECK (invitee_wallet ~ '^0x[a-f0-9]{40}$'),
  message text CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'released')),
  accepted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  agent_id uuid REFERENCES ai_agents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);
CREATE UNIQUE INDEX job_invitations_open_idx ON job_invitations (job_id) WHERE status IN ('pending', 'accepted');
CREATE INDEX job_invitations_invitee_idx ON job_invitations (invitee_wallet, created_at DESC) WHERE status = 'pending';
