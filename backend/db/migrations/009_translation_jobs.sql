ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_category_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_category_check
  CHECK (category IN ('writing','translation','image_generation','research','design','coding','data','other'));
ALTER TABLE jobs ADD COLUMN source_file_required boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN source_file_url text;
