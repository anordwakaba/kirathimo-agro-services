BEGIN;

CREATE TABLE IF NOT EXISTS banking_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    agent_number TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (business_id, code)
);

CREATE TABLE IF NOT EXISTS banking_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    provider_id UUID NOT NULL REFERENCES banking_providers(id) ON DELETE RESTRICT,
    transaction_id TEXT NOT NULL,
    transaction_type TEXT NOT NULL
        CHECK (transaction_type IN ('deposit', 'withdrawal')),
    customer_name TEXT,
    customer_phone TEXT,
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    commission NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (commission >= 0),
    status TEXT NOT NULL DEFAULT 'completed'
        CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
    notes TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (business_id, provider_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS banking_float_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    provider_id UUID NOT NULL REFERENCES banking_providers(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL
        CHECK (entry_type IN ('opening', 'deposit', 'withdrawal', 'adjustment')),
    amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    reference TEXT,
    notes TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS banking_daily_closings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    closing_date DATE NOT NULL,
    total_deposits NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_withdrawals NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_commission NUMERIC(14,2) NOT NULL DEFAULT 0,
    expected_cash NUMERIC(14,2) NOT NULL DEFAULT 0,
    actual_cash NUMERIC(14,2),
    difference NUMERIC(14,2),
    notes TEXT,
    closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (business_id, closing_date)
);

CREATE INDEX IF NOT EXISTS idx_banking_providers_business
    ON banking_providers(business_id);

CREATE INDEX IF NOT EXISTS idx_banking_transactions_business
    ON banking_transactions(business_id);

CREATE INDEX IF NOT EXISTS idx_banking_transactions_provider
    ON banking_transactions(provider_id);

CREATE INDEX IF NOT EXISTS idx_banking_transactions_created_at
    ON banking_transactions(created_at);

CREATE INDEX IF NOT EXISTS idx_banking_float_business
    ON banking_float_entries(business_id);

CREATE INDEX IF NOT EXISTS idx_banking_closing_business_date
    ON banking_daily_closings(business_id, closing_date);

COMMIT;
