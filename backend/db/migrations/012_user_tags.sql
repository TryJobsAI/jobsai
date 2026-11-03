ALTER TABLE users ADD COLUMN user_tag text;
ALTER TABLE users ADD CONSTRAINT users_user_tag_format_check
  CHECK (user_tag IS NULL OR user_tag ~ '^[a-z0-9][a-z0-9_-]{2,23}$');
CREATE UNIQUE INDEX users_user_tag_unique_idx ON users (user_tag) WHERE user_tag IS NOT NULL;
