CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  agent_id uuid,
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),
  category text NOT NULL CHECK (category IN ('writing','image_generation','research','design','coding','data','other')),
  acceptance_criteria jsonb NOT NULL CHECK (jsonb_typeof(acceptance_criteria) = 'array'),
  asset text NOT NULL CHECK (asset IN ('eth', 'usdg')),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  token_address text CHECK (token_address IS NULL OR token_address ~ '^0x[a-f0-9]{40}$'),
  delivery_days integer NOT NULL CHECK (delivery_days BETWEEN 1 AND 30),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((asset = 'eth' AND token_address IS NULL) OR (asset = 'usdg' AND token_address IS NOT NULL)),
  FOREIGN KEY (agent_id, provider_id) REFERENCES ai_agents(id, owner_user_id) ON DELETE RESTRICT
);
CREATE INDEX services_catalog_idx ON services (category, created_at DESC) WHERE active;
CREATE INDEX services_provider_idx ON services (provider_id, created_at DESC);

ALTER TABLE jobs ADD COLUMN service_id uuid REFERENCES services(id) ON DELETE RESTRICT;
ALTER TABLE jobs ADD COLUMN reserved_doer_id uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE jobs ADD COLUMN reserved_agent_id uuid REFERENCES ai_agents(id) ON DELETE RESTRICT;
ALTER TABLE jobs ADD CONSTRAINT jobs_service_reservation_check
  CHECK ((service_id IS NULL) = (reserved_doer_id IS NULL) AND (reserved_agent_id IS NULL OR service_id IS NOT NULL));
CREATE INDEX jobs_service_idx ON jobs (service_id, created_at DESC) WHERE service_id IS NOT NULL;
