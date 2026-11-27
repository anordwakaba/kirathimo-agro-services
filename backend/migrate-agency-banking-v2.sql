BEGIN;

ALTER TABLE banking_float_entries
ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'in';

ALTER TABLE banking_float_entries
DROP CONSTRAINT IF EXISTS banking_float_entries_direction_check;

ALTER TABLE banking_float_entries
ADD CONSTRAINT banking_float_entries_direction_check
CHECK (direction IN ('in', 'out'));

COMMIT;
