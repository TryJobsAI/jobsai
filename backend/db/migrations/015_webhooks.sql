CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  url text NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 500),
  description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 120),
  events text[] NOT NULL DEFAULT '{}',
  secret_ciphertext text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_owner_idx ON webhook_endpoints (owner_id) WHERE active;

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  job_event_id bigint REFERENCES job_events(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_response_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (endpoint_id, job_event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

-- Maps internal job history to the public webhook event names. Unlisted internal events are not delivered.
CREATE FUNCTION webhook_event_type(internal_type text, details jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE internal_type
    WHEN 'job.created' THEN 'job.created'
    WHEN 'job.service_ordered' THEN 'job.created'
    WHEN 'job.funded' THEN 'job.funded'
    WHEN 'job.funding_balance_verified' THEN 'job.funded'
    WHEN 'job.claimed' THEN 'job.assigned'
    WHEN 'job.unclaimed' THEN 'job.released'
    WHEN 'job.worker_released_by_client' THEN 'job.released'
    WHEN 'job.claim_expired' THEN 'job.released'
    WHEN 'job.submitted' THEN 'job.submitted'
    WHEN 'job.revision_requested' THEN 'job.revision_requested'
    WHEN 'job.accepted' THEN 'job.accepted'
    WHEN 'job.disputed' THEN 'job.disputed'
    WHEN 'job.dispute_resolved' THEN 'job.dispute_resolved'
    WHEN 'job.cancellation_requested' THEN 'job.cancelled'
    WHEN 'job.settled' THEN CASE WHEN details->>'outcome' = 'pay_doer' THEN 'job.paid' ELSE 'job.refunded' END
    WHEN 'job.proposal_submitted' THEN 'proposal.received'
    WHEN 'job.proposal_updated' THEN 'proposal.received'
    WHEN 'job.proposal_accepted' THEN 'proposal.accepted'
    WHEN 'job.worker_invited' THEN 'invitation.received'
    WHEN 'job.invitation_accepted' THEN 'invitation.accepted'
    WHEN 'job.invitation_declined' THEN 'invitation.declined'
  END
$$;

-- Queues deliveries in the same transaction as the job event, for the job's client, current worker, the actor, and an invited wallet.
CREATE FUNCTION enqueue_job_webhooks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  public_type text := webhook_event_type(NEW.event_type, NEW.details);
BEGIN
  IF public_type IS NULL THEN RETURN NEW; END IF;
  INSERT INTO webhook_deliveries (endpoint_id, job_event_id, event_type)
  SELECT e.id, NEW.id, public_type
    FROM webhook_endpoints e
   WHERE e.active
     AND (cardinality(e.events) = 0 OR public_type = ANY(e.events))
     AND e.owner_id IN (
       SELECT j.client_id FROM jobs j WHERE j.id = NEW.job_id
       UNION SELECT j.doer_id FROM jobs j WHERE j.id = NEW.job_id AND j.doer_id IS NOT NULL
       UNION SELECT NEW.actor_id WHERE NEW.actor_id IS NOT NULL
       UNION SELECT u.id FROM users u WHERE public_type = 'invitation.received' AND u.wallet_address = NEW.details->>'wallet'
     )
  ON CONFLICT (endpoint_id, job_event_id) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER job_events_webhooks AFTER INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION enqueue_job_webhooks();
