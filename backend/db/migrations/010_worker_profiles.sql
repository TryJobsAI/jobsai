CREATE TABLE worker_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 100),
  country text NOT NULL CHECK (char_length(country) BETWEEN 2 AND 100),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 3 AND 100),
  work_hours text NOT NULL CHECK (char_length(work_hours) BETWEEN 2 AND 500),
  email text NOT NULL CHECK (char_length(email) <= 254),
  phone text NOT NULL CHECK (char_length(phone) BETWEEN 7 AND 40),
  rate_tiers jsonb NOT NULL CHECK (jsonb_typeof(rate_tiers) = 'array' AND jsonb_array_length(rate_tiers) BETWEEN 1 AND 8),
  public_profile boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','changes_requested','rejected')),
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_profiles_review_queue_idx ON worker_profiles(submitted_at) WHERE status='pending_review';
CREATE INDEX worker_profiles_public_idx ON worker_profiles(slug) WHERE status='approved' AND public_profile;

CREATE TABLE worker_profile_reviews (
  id bigserial PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES worker_profiles(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved','changes_requested','rejected')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_profile_reviews_profile_idx ON worker_profile_reviews(profile_id, created_at DESC);
