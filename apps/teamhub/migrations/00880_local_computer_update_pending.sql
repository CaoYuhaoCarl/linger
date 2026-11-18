-- +goose Up
-- update_pending_since is when the Agent Service first observed the Computer
-- behind this deployment's Computer release; it clears once the Computer runs
-- it. A Computer still behind two hourly update offers later needs a
-- reinstall. Existing rows stay NULL until their next observation.
ALTER TABLE local_computers ADD COLUMN update_pending_since timestamp with time zone;

-- +goose Down
ALTER TABLE local_computers DROP COLUMN update_pending_since;
