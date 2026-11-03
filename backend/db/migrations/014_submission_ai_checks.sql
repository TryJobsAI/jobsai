CREATE TABLE job_submission_ai_checks (
  submission_id uuid PRIMARY KEY REFERENCES job_submissions(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  model text NOT NULL,
  result_ciphertext text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (status <> 'done' OR result_ciphertext IS NOT NULL)
);
CREATE INDEX job_submission_ai_checks_job_idx ON job_submission_ai_checks (job_id);
