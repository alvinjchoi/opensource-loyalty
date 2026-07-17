CREATE TABLE IF NOT EXISTS lip_cloud_organizations (
  organization_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (slug = lower(slug)),
  CHECK (char_length(name) BETWEEN 2 AND 120)
);

CREATE TABLE IF NOT EXISTS lip_cloud_organization_memberships (
  organization_id TEXT NOT NULL REFERENCES lip_cloud_organizations (organization_id)
    ON DELETE CASCADE,
  subject TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'billing', 'viewer')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, subject)
);

CREATE INDEX IF NOT EXISTS lip_cloud_memberships_subject_idx
  ON lip_cloud_organization_memberships (subject, active);

CREATE TABLE IF NOT EXISTS lip_cloud_projects (
  project_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES lip_cloud_organizations (organization_id)
    ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, slug),
  CHECK (slug = lower(slug)),
  CHECK (char_length(name) BETWEEN 2 AND 120)
);

CREATE INDEX IF NOT EXISTS lip_cloud_projects_organization_idx
  ON lip_cloud_projects (organization_id, created_at);

CREATE TABLE IF NOT EXISTS lip_cloud_environments (
  environment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES lip_cloud_projects (project_id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('development', 'staging', 'production')),
  region TEXT NOT NULL,
  tenant_id TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'provisioning', 'ready', 'failed', 'suspended')
  ),
  status_message TEXT,
  api_url TEXT,
  admin_url TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, slug),
  UNIQUE (tenant_id, program_id),
  CHECK (slug = lower(slug)),
  CHECK (char_length(name) BETWEEN 2 AND 120)
);

CREATE INDEX IF NOT EXISTS lip_cloud_environments_project_idx
  ON lip_cloud_environments (project_id, created_at);
CREATE INDEX IF NOT EXISTS lip_cloud_environments_status_idx
  ON lip_cloud_environments (region, status, updated_at);

CREATE TABLE IF NOT EXISTS lip_cloud_plans (
  plan_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  monthly_price_minor BIGINT NOT NULL CHECK (monthly_price_minor >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  included_usage JSONB NOT NULL,
  hard_limits JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO lip_cloud_plans (
  plan_id, name, monthly_price_minor, currency, included_usage, hard_limits
)
VALUES
  (
    'free',
    'Free',
    0,
    'USD',
    '{"monthly_active_members":100,"loyalty_transactions":1000,"messages":100}'::jsonb,
    '{"monthly_active_members":100,"loyalty_transactions":1000,"messages":100}'::jsonb
  ),
  (
    'pro',
    'Pro',
    9900,
    'USD',
    '{"monthly_active_members":5000,"loyalty_transactions":50000,"messages":10000}'::jsonb,
    '{"monthly_active_members":10000,"loyalty_transactions":100000,"messages":25000}'::jsonb
  ),
  (
    'business',
    'Business',
    39900,
    'USD',
    '{"monthly_active_members":25000,"loyalty_transactions":250000,"messages":100000}'::jsonb,
    '{"monthly_active_members":100000,"loyalty_transactions":1000000,"messages":500000}'::jsonb
  )
ON CONFLICT (plan_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS lip_cloud_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE REFERENCES lip_cloud_organizations (organization_id)
    ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES lip_cloud_plans (plan_id),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
  billing_provider TEXT NOT NULL CHECK (billing_provider IN ('manual', 'stripe')),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (current_period_end > current_period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS lip_cloud_subscriptions_provider_idx
  ON lip_cloud_subscriptions (billing_provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lip_cloud_audit_log (
  audit_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES lip_cloud_organizations (organization_id)
    ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata JSONB,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS lip_cloud_audit_log_organization_time_idx
  ON lip_cloud_audit_log (organization_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS lip_cloud_usage_events (
  usage_event_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES lip_cloud_organizations (organization_id)
    ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES lip_cloud_environments (environment_id)
    ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (
    metric IN ('monthly_active_members', 'loyalty_transactions', 'messages')
  ),
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment_id, metric, idempotency_key)
);

CREATE INDEX IF NOT EXISTS lip_cloud_usage_events_billing_idx
  ON lip_cloud_usage_events (organization_id, metric, occurred_at);

CREATE TABLE IF NOT EXISTS lip_cloud_usage_counters (
  environment_id TEXT NOT NULL REFERENCES lip_cloud_environments (environment_id)
    ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (
    metric IN ('monthly_active_members', 'loyalty_transactions', 'messages')
  ),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, metric, period_start),
  CHECK (period_end > period_start)
);

CREATE TABLE IF NOT EXISTS lip_cloud_provisioning_jobs (
  provisioning_job_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES lip_cloud_environments (environment_id)
    ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'upgrade', 'suspend', 'delete')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL,
  claimed_by TEXT,
  claimed_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS lip_cloud_provisioning_jobs_claim_idx
  ON lip_cloud_provisioning_jobs (status, available_at)
  WHERE status IN ('pending', 'running');
