CREATE TABLE job_event_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES job_events(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX job_event_reads_event_idx ON job_event_reads (event_id);
