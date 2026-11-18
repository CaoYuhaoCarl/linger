-- +goose Up
-- connected_at is when the Computer's current connection said hello, so a
-- Computer that connected moments ago and has not sent its model library yet
-- reads as checking rather than not reported. Rows connected before this
-- column existed stay NULL until their next hello.
ALTER TABLE local_computers ADD COLUMN connected_at timestamp with time zone;

-- local_models_snapshot_summary keeps the few facts the Computer lists and
-- readiness need from a stored snapshot, so listing many Computers never
-- reads a snapshot (up to 4 MB each). It is the only definition of the
-- summary: the backfill below and every stored snapshot use it. host is the
-- host the row keeps (the snapshot's own, or the last one a snapshot carried).
-- +goose StatementBegin
CREATE FUNCTION local_models_snapshot_summary(snapshot jsonb, host jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT jsonb_build_object(
  'available', COALESCE((snapshot->>'available')::boolean, false),
  'reason', snapshot->'reason'->>'code',
  'counts', (
    SELECT jsonb_build_object(
      'loaded', count(*) FILTER (WHERE model->>'state' = 'loaded'),
      'on_disk', count(*) FILTER (WHERE model->>'state' IN ('idle', 'loading', 'loaded')),
      'working', count(*) FILTER (WHERE model->>'state' IN ('downloading', 'loading')))
    FROM jsonb_array_elements(COALESCE(snapshot->'models', '[]'::jsonb)) AS model),
  'usable', (
    SELECT count(*)
    FROM jsonb_array_elements(COALESCE(snapshot->'models', '[]'::jsonb)) AS model
    WHERE model->>'state' <> 'absent'
       OR COALESCE((model->'availability'->>'downloadable')::boolean, false)),
  'unavailable_code', (
    SELECT model->'availability'->'reason'->>'code'
    FROM jsonb_array_elements(COALESCE(snapshot->'models', '[]'::jsonb)) AS model
    WHERE model->'availability'->'reason'->>'code' IS NOT NULL
    GROUP BY 1
    ORDER BY count(*) DESC, 1
    LIMIT 1),
  'memory', (
    SELECT CASE
      WHEN count(*) FILTER (WHERE pool->>'kind' = 'gpu') > 0 THEN jsonb_build_object(
        'kind', 'gpu',
        'used_bytes', sum((pool->>'used_bytes')::bigint) FILTER (WHERE pool->>'kind' = 'gpu'),
        'total_bytes', sum((pool->>'total_bytes')::bigint) FILTER (WHERE pool->>'kind' = 'gpu'))
      WHEN count(*) FILTER (WHERE pool->>'kind' = 'unified') > 0 THEN jsonb_build_object(
        'kind', 'unified',
        'used_bytes', sum((pool->>'used_bytes')::bigint) FILTER (WHERE pool->>'kind' = 'unified'),
        'total_bytes', sum((pool->>'total_bytes')::bigint) FILTER (WHERE pool->>'kind' = 'unified'))
    END
    FROM jsonb_array_elements(COALESCE(snapshot->'pools', '[]'::jsonb)) AS pool),
  'host', CASE WHEN host IS NULL THEN NULL ELSE jsonb_build_object(
    'platform', host->>'platform',
    'arch', host->>'arch',
    'gpus', jsonb_array_length(COALESCE(host->'gpus', '[]'::jsonb))) END)
$$;
-- +goose StatementEnd

ALTER TABLE local_computer_model_snapshots ADD COLUMN summary jsonb;
UPDATE local_computer_model_snapshots SET summary = local_models_snapshot_summary(snapshot, host);
ALTER TABLE local_computer_model_snapshots
    ALTER COLUMN summary SET NOT NULL,
    ADD CONSTRAINT local_computer_model_snapshots_summary_check CHECK (jsonb_typeof(summary) = 'object');

-- +goose Down
ALTER TABLE local_computer_model_snapshots DROP COLUMN summary;
DROP FUNCTION local_models_snapshot_summary(jsonb, jsonb);
ALTER TABLE local_computers DROP COLUMN connected_at;
