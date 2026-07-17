ALTER TABLE lip_cloud_organization_memberships
  ADD COLUMN IF NOT EXISTS issuer TEXT;

UPDATE lip_cloud_organization_memberships
SET issuer = 'urn:lip:trusted-gateway'
WHERE issuer IS NULL;

ALTER TABLE lip_cloud_organization_memberships
  ALTER COLUMN issuer SET NOT NULL;

ALTER TABLE lip_cloud_organization_memberships
  DROP CONSTRAINT IF EXISTS lip_cloud_organization_memberships_pkey;

ALTER TABLE lip_cloud_organization_memberships
  ADD PRIMARY KEY (organization_id, issuer, subject);

DROP INDEX IF EXISTS lip_cloud_memberships_subject_idx;
CREATE INDEX lip_cloud_memberships_subject_idx
  ON lip_cloud_organization_memberships (issuer, subject, active);

CREATE TABLE IF NOT EXISTS lip_cloud_organization_invitations (
  invitation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES lip_cloud_organizations (organization_id)
    ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'developer', 'billing', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS lip_cloud_invitations_active_email_idx
  ON lip_cloud_organization_invitations (organization_id, lower(email))
  WHERE accepted_at IS NULL;
