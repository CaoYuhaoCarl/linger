-- +goose Up
-- The latest runner.computer_profile each Local Computer reported: install
-- kind, accelerators, local-models mode and last self-update attempt, the
-- facts local-models readiness needs before the localmodels tool runs. An
-- offline Computer keeps its last profile. A removed Computer's row is
-- deleted in the transaction that removes it; the foreign key covers a
-- Computer row that is deleted outright.
CREATE TABLE local_computer_profiles (
    computer_id text PRIMARY KEY REFERENCES local_computers(computer_id) ON DELETE CASCADE,
    profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
    observed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- +goose Down
DROP TABLE local_computer_profiles;
