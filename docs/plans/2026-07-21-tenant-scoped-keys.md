# PLA-416: tenant-scoped LIP API keys + auth middleware with rotation

Status: implemented on `alvin/pla-416-tenant-scoped-lip-api-keys-auth-middleware-with-rotation`.

## Gap analysis (what existed vs. what this issue adds)

### Already existed — reused, not rebuilt

| Capability | Where | Notes |
| --- | --- | --- |
| Tenant-scoped API keys (sha256-hashed secrets, roles/permissions, `expires_at`, `revoked_at`, `last_used_at`, audit trail) | `packages/server/src/access-control.ts` | `createApiKey` / `revokeApiKey` / `authenticate`; `authenticate` already rejects expired and inactive keys and stamps `last_used_at`. The schema already has the TTL field (`expires_at`) — no schema change was needed for rotation overlap windows. |
| Location scoping + subset-of-creator enforcement | same | PLA-415 phase 2 (`allowed_location_ids`, `assertWithinPrincipalScope`). |
| Auth middleware on both surfaces | `packages/server/src/server.ts` | `bearerPrincipal` resolves static root key → root principal, else `access.authenticate(secret)`. `protocolAuthorized` enforces `protocol:read`/`protocol:write` on every `/lip/v1/*` route; `isAdminAuthorized` / `isAdminWriteAuthorized` (permission-aware) guard `/admin/api/v1/*`. `hasPermission` requires `principal.tenant_id === tenant.tenant_id`, and each tenant's access store is keyed per tenant, so a key can never authenticate against another tenant's runtime. A cross-tenant unit test already existed (`tests/unit/access-control.test.ts` "does not authenticate an API key against another tenant"). |
| Admin key management endpoints | `packages/server/src/server.ts` | `PUT /admin/api/v1/access/users`, `POST /admin/api/v1/access/api-keys` (accepts `expires_at`), `POST /admin/api/v1/access/api-keys/revoke`, all requiring `access:manage`. |
| Per-subscription webhook signing secrets + rotation | `packages/server/src/webhooks.ts` | Every subscription carries its own secret; `upsertSubscription` enforces ≥16 chars; `rotateSecret` + admin route `POST /admin/api/v1/webhooks/subscription/rotate-secret` already exist. There is no protocol-level shared webhook secret. |
| Cloud control-plane key hygiene | `apps/cloud/src/cli.ts`, `apps/cloud/src/server.ts` | `LIP_CLOUD_API_KEY` already required ≥16 chars in both the CLI env validation and `createCloudServer`. |
| Per-runtime static key generation | `apps/cloud/src/data-plane-provisioner.ts` | `LocalDataPlaneProvisioner` generates a 32-byte `lip_sk_*` root key per environment and persists it 0600 in `<env>.credentials.json`. Tenant-scoped *in effect* (one runtime = one tenant) but root-equivalent, file-delivered, and unrotatable — the PLA-417 runbook marks it interim. |

### Gaps this issue closes

1. **No rotation path for tenant API keys.** Only create + revoke existed — a
   compromised or aging key forced a flag-day swap (the PLA-371 lesson).
2. **Cloud merchant credential is the raw root key.** Read manually off the
   service disk (`render ssh` + `cat`), no API retrieval, no rotation, and it
   bypasses roles/audit entirely.
3. **Weak static key allowed in Postgres/cloud mode.** `packages/server/src/cli.ts`
   defaulted `LIP_API_KEY` to `lip-dev-key` even when `LIP_DATABASE_URL` was
   set; `createReferenceServer` only required ≥8 chars.
4. **Provisioned tenants inherit host-level webhook env config.**
   `createDemoPlatform` / `createPostgresProtocolPlatform` fall back to
   `LIP_WEBHOOK_URL` / `LIP_WEBHOOK_SECRET` when no `webhooks` option is
   passed, and the provisioner passed none — so a `LIP_WEBHOOK_SECRET` on the
   shared cloud host would have seeded EVERY tenant runtime with the same
   signing secret. Also, `webhookSubscriptionsFromEnv` accepted secrets of any
   length (constructor-seeded subscriptions bypass the ≥16 upsert check).

## Decisions

- **D1 — Rotation via overlap on `expires_at` (no new schema).**
  `AccessControlService.rotateApiKey({ key_id, overlap_seconds?, expires_at? })`
  mints a replacement key inheriting the old key's name, role, and location
  scope, and stamps the old key `expires_at = min(existing, now + overlap)`.
  Overlap defaults to 24 h, bounded to 0…7 days (0 = immediate cutover, still
  no flag day for the caller because the response carries the replacement
  secret). Expiry enforcement already lives in `authenticate`; early kill
  remains the existing revoke endpoint. Audited as
  `access.api_key.rotated` (old, metadata `replacement_key_id`,
  `overlap_expires_at`) + `access.api_key.created` (new, metadata
  `rotated_from`). Exposed as `POST /admin/api/v1/access/api-keys/rotate`
  (guarded by `access:manage`, like the other access routes).
- **D2 — Merchant credential = owner-role access-control key; root key
  deprecated.** At provision (and on restore of a v1 file) the provisioner
  bootstraps an owner API key named `cloud-merchant` through the tenant's own
  `AccessControlService` (so it is hashed, audited, role-scoped, rotatable)
  and writes credentials file **v2**: `version: 2`, `merchant_api_key`,
  `merchant_api_key_id`, plus the old root `api_key` retained as
  `api_key` + `"api_key_deprecated": true` note for backward compatibility.
  v1 files keep working: restore honours their root key and upgrades them to
  v2 in place. Rotation surface:
  `POST /cloud/v1/environments/{id}/credentials/rotate` on the control plane
  (authorized like `attach` — org owner/admin via `requireRole`), wired to
  `LocalDataPlaneProvisioner.rotateCredentials(environmentId)`, plus a
  `rotate-credentials` verb on `npm run cloud:provision`. The endpoint returns
  the fresh merchant key, so it doubles as the sanctioned retrieval path —
  operators call rotate once after provisioning instead of `render ssh` +
  `cat`, and never hand out the root key.
- **D3 — Static-key hygiene at the Postgres boundary.** New exported
  `assertStrongApiKey(key)` (≥16 chars and not `lip-dev-key`); enforced by
  `packages/server/src/cli.ts` whenever `LIP_DATABASE_URL` is set and by the
  provisioner for every runtime key. Local SQLite dev keeps the frictionless
  `lip-dev-key` default on purpose.
- **D4 — Webhook signing is per-tenant by construction; close the env leak.**
  The provisioner now passes `webhooks: []` so tenant runtimes never inherit
  host-level `LIP_WEBHOOK_URL`/`LIP_WEBHOOK_SECRET`; subscriptions are created
  per tenant through each runtime's admin API with their own ≥16-char secret
  and rotated via the existing `rotate-secret` route.
  `webhookSubscriptionsFromEnv` now rejects secrets shorter than 16 chars.
  No new signing machinery was added — proven by tests instead.

## Out of scope / follow-ups

- Encrypting credentials files at rest and moving them off local disk
  (PLAN.md milestone: "Encrypted environment credentials … and suspension").
- Retiring the runtime root key entirely (removing `options.apiKey`): blocked
  until all consumers migrate to merchant keys; the credentials file marks it
  deprecated in the meantime.
- Per-tenant public hostnames / gateway routing (runbook constraint table).
- Automated scheduled rotation; this issue ships the manual/operator surface.
