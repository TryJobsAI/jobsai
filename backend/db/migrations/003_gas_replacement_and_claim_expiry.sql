ALTER TABLE job_settlements ADD COLUMN gas_broadcast_at timestamptz;

CREATE TABLE job_settlement_gas_attempts (
  job_id uuid NOT NULL REFERENCES job_settlements(job_id) ON DELETE CASCADE,
  tx_hash text NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[a-f0-9]{64}$'),
  signed_tx text NOT NULL,
  nonce bigint NOT NULL,
  broadcast_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, tx_hash)
);
CREATE INDEX job_settlement_gas_attempts_history_idx ON job_settlement_gas_attempts(job_id, created_at DESC);

INSERT INTO job_settlement_gas_attempts(job_id,tx_hash,signed_tx,nonce,broadcast_at,created_at)
SELECT job_id,gas_tx_hash,gas_signed_tx,gas_nonce,updated_at,updated_at
FROM job_settlements
WHERE gas_tx_hash IS NOT NULL AND gas_signed_tx IS NOT NULL AND gas_nonce IS NOT NULL
ON CONFLICT (tx_hash) DO NOTHING;

UPDATE job_settlements SET gas_broadcast_at=updated_at
WHERE gas_signed_tx IS NOT NULL AND gas_broadcast_at IS NULL;
