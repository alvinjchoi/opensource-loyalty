CREATE TABLE IF NOT EXISTS lip_cloud_customers (
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, customer_id),
  CHECK (status <> 'deleted' OR (deleted_at IS NOT NULL AND profile = '{}'::jsonb))
);

CREATE TABLE IF NOT EXISTS lip_cloud_customer_identities (
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('clerk', 'auth0', 'oidc')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL,
  disabled_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, issuer, subject),
  FOREIGN KEY (tenant_id, customer_id)
    REFERENCES lip_cloud_customers (tenant_id, customer_id) ON DELETE RESTRICT,
  CHECK (active OR disabled_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS lip_cloud_customer_identities_customer_idx
  ON lip_cloud_customer_identities (tenant_id, customer_id, created_at);

CREATE TABLE IF NOT EXISTS lip_cloud_customer_consents (
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('granted', 'denied', 'withdrawn')),
  policy_version TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, customer_id, purpose),
  FOREIGN KEY (tenant_id, customer_id)
    REFERENCES lip_cloud_customers (tenant_id, customer_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS lip_cloud_customer_loyalty_memberships (
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, customer_id, program_id),
  UNIQUE (tenant_id, program_id, member_id),
  FOREIGN KEY (tenant_id, customer_id)
    REFERENCES lip_cloud_customers (tenant_id, customer_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS lip_cloud_customer_loyalty_member_idx
  ON lip_cloud_customer_loyalty_memberships (tenant_id, program_id, member_id);
