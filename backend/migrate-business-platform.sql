BEGIN;

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  business_type TEXT NOT NULL DEFAULT 'Agro Services',
  currency TEXT NOT NULL DEFAULT 'KES',
  timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  phone TEXT,
  email TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  v_business_id UUID;
BEGIN
  SELECT id
  INTO v_business_id
  FROM businesses
  ORDER BY created_at
  LIMIT 1;

  IF v_business_id IS NULL THEN
    INSERT INTO businesses (
      name,
      slug,
      business_type,
      currency,
      timezone
    )
    VALUES (
      'Kirathimo Agro Services',
      'kirathimo-agro-services',
      'Agro Services',
      'KES',
      'Africa/Nairobi'
    )
    RETURNING id INTO v_business_id;

    RAISE NOTICE 'Created business: %', v_business_id;
  ELSE
    RAISE NOTICE 'Using existing business: %', v_business_id;
  END IF;

  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS business_id UUID;

  ALTER TABLE items
    ADD COLUMN IF NOT EXISTS business_id UUID;

  ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS business_id UUID;

  ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS business_id UUID;

  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;

  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

  ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;

  ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS token_hash TEXT;

  ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

  ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

  ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS created_by UUID;

  UPDATE users
  SET business_id = v_business_id
  WHERE business_id IS NULL;

  UPDATE items
  SET business_id = v_business_id
  WHERE business_id IS NULL;

  UPDATE transactions
  SET business_id = v_business_id
  WHERE business_id IS NULL;

  UPDATE invitations
  SET business_id = v_business_id
  WHERE business_id IS NULL;

  UPDATE users
  SET
    permissions = to_jsonb(ARRAY[
      'dashboard.view',
      'sales.create',
      'sales.view',
      'purchases.create',
      'purchases.view',
      'inventory.view',
      'inventory.manage',
      'reports.view',
      'banking.create',
      'banking.view',
      'customers.view',
      'customers.manage',
      'finance.view',
      'team.manage',
      'settings.manage'
    ]),
    is_active = TRUE,
    updated_at = NOW()
  WHERE role = 'owner';

  UPDATE users
  SET permissions = to_jsonb(ARRAY[
    'dashboard.view',
    'sales.create',
    'sales.view',
    'inventory.view',
    'reports.view'
  ])
  WHERE role = 'worker'
    AND cardinality(permissions) = 0;

  ALTER TABLE users
    ALTER COLUMN business_id SET NOT NULL;

  ALTER TABLE items
    ALTER COLUMN business_id SET NOT NULL;

  ALTER TABLE transactions
    ALTER COLUMN business_id SET NOT NULL;

  ALTER TABLE invitations
    ALTER COLUMN business_id SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_business_id_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_business_id_fkey
      FOREIGN KEY (business_id)
      REFERENCES businesses(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'items_business_id_fkey'
  ) THEN
    ALTER TABLE items
      ADD CONSTRAINT items_business_id_fkey
      FOREIGN KEY (business_id)
      REFERENCES businesses(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'transactions_business_id_fkey'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_business_id_fkey
      FOREIGN KEY (business_id)
      REFERENCES businesses(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invitations_business_id_fkey'
  ) THEN
    ALTER TABLE invitations
      ADD CONSTRAINT invitations_business_id_fkey
      FOREIGN KEY (business_id)
      REFERENCES businesses(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL
    REFERENCES businesses(id)
    ON DELETE CASCADE,
  user_id UUID
    REFERENCES users(id)
    ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_business_id
  ON users(business_id);

CREATE INDEX IF NOT EXISTS idx_items_business_id
  ON items(business_id);

CREATE INDEX IF NOT EXISTS idx_transactions_business_id
  ON transactions(business_id);

CREATE INDEX IF NOT EXISTS idx_invitations_business_id
  ON invitations(business_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_business_id_created_at
  ON audit_logs(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_business_active
  ON users(business_id, is_active);

COMMIT;

SELECT
  (SELECT COUNT(*) FROM businesses) AS businesses,
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(*) FROM items) AS items,
  (SELECT COUNT(*) FROM transactions) AS transactions,
  (SELECT COUNT(*) FROM audit_logs) AS audit_logs;
