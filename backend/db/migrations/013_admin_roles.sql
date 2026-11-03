ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- Bootstrap the first JobsAI admin by their permanent usertag.
UPDATE users SET is_admin=true,updated_at=now() WHERE user_tag='adminmachine';

CREATE INDEX users_admin_idx ON users (created_at) WHERE is_admin;
