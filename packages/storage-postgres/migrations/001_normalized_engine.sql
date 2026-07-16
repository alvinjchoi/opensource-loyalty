CREATE TABLE IF NOT EXISTS lip_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lip_engine_states (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  program_fingerprint TEXT NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, program_id)
);

CREATE TABLE IF NOT EXISTS lip_engine_members (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, member_id),
  FOREIGN KEY (tenant_id, program_id)
    REFERENCES lip_engine_states (tenant_id, program_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lip_engine_identities (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, program_id, identity_key),
  FOREIGN KEY (tenant_id, program_id, member_id)
    REFERENCES lip_engine_members (tenant_id, program_id, member_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lip_engine_balances (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  balance_key TEXT NOT NULL,
  amount BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, program_id, balance_key),
  FOREIGN KEY (tenant_id, program_id)
    REFERENCES lip_engine_states (tenant_id, program_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lip_engine_reservations (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, reservation_id),
  FOREIGN KEY (tenant_id, program_id, member_id)
    REFERENCES lip_engine_members (tenant_id, program_id, member_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS lip_engine_reservations_member_status_idx
  ON lip_engine_reservations (tenant_id, program_id, member_id, status);

CREATE TABLE IF NOT EXISTS lip_engine_ledger (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  order_id TEXT,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, entry_id),
  FOREIGN KEY (tenant_id, program_id, member_id)
    REFERENCES lip_engine_members (tenant_id, program_id, member_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS lip_engine_ledger_member_time_idx
  ON lip_engine_ledger (tenant_id, program_id, member_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lip_engine_ledger_order_idx
  ON lip_engine_ledger (tenant_id, program_id, order_id)
  WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lip_engine_balance_lots (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  remaining BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, entry_id),
  FOREIGN KEY (tenant_id, program_id, entry_id)
    REFERENCES lip_engine_ledger (tenant_id, program_id, entry_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS lip_engine_balance_lots_expiration_idx
  ON lip_engine_balance_lots (tenant_id, program_id, expires_at)
  WHERE remaining > 0;

CREATE TABLE IF NOT EXISTS lip_engine_lot_consumptions (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  consumption_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, consumption_id),
  FOREIGN KEY (tenant_id, program_id)
    REFERENCES lip_engine_states (tenant_id, program_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lip_engine_idempotency (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, operation_key),
  FOREIGN KEY (tenant_id, program_id)
    REFERENCES lip_engine_states (tenant_id, program_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lip_engine_accruals (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, order_id),
  FOREIGN KEY (tenant_id, program_id)
    REFERENCES lip_engine_states (tenant_id, program_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lip_engine_adjustments (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  adjustment_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, adjustment_id),
  FOREIGN KEY (tenant_id, program_id)
    REFERENCES lip_engine_states (tenant_id, program_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lip_engine_redemptions (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  redemption_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, redemption_id),
  FOREIGN KEY (tenant_id, program_id)
    REFERENCES lip_engine_states (tenant_id, program_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lip_engine_issued_rewards (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  issued_reward_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  reward_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, program_id, issued_reward_id),
  FOREIGN KEY (tenant_id, program_id, member_id)
    REFERENCES lip_engine_members (tenant_id, program_id, member_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS lip_engine_issued_rewards_member_status_idx
  ON lip_engine_issued_rewards (tenant_id, program_id, member_id, status);

CREATE TABLE IF NOT EXISTS lip_platform_state (
  tenant_id TEXT NOT NULL,
  state_key TEXT NOT NULL,
  value JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, state_key)
);
