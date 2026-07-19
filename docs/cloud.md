# Loyalty Interchange Cloud control plane

Loyalty Interchange Cloud is the managed-service layer around the open protocol
and engine. It is intentionally separate from `/lip/v1`: the protocol remains
portable and self-hostable, while the control plane manages organizations,
projects, environments, plans, subscriptions, provisioning, and usage limits.

## Product boundary

The durable business model is managed operations, not protocol lock-in:

- **Open source:** protocol, engine, SDKs, CLI, MCP, Admin UI, SQLite/Postgres
  storage, Docker deployment, and conformance tooling.
- **Cloud:** one-click environments, upgrades, backups, monitoring, regional
  operation, usage billing, managed messaging, and support.
- **Enterprise:** SSO/SCIM, dedicated infrastructure, private networking,
  contractual SLAs, data residency, and migration assistance.

Customers can leave Cloud and run the same LIP data plane themselves. Cloud
revenue comes from removing operational work and risk.

## Current vertical slice

The `@loyalty-interchange/cloud` workspace includes:

- tenant-safe organizations, issuer/subject identities, invitations, and
  membership management;
- projects and development, staging, or production environments;
- generated `tenant_id` and configured `program_id` data-plane scopes;
- queued provisioning records for each environment;
- a claim-safe provisioning worker with retries and a provider interface;
- Free, Pro, and Business plan definitions;
- one subscription per organization;
- idempotent monthly usage events and counters;
- hard quota enforcement under a transaction lock;
- an authenticated management API with direct OIDC or trusted-gateway modes;
- a provider boundary for Stripe or another billing system.

The control plane does not yet collect payment; new organizations use the
`manual` billing provider on the Free plan. New environments remain `pending`
until a provisioning adapter processes their job. A local adapter ships today
(see below); regional infrastructure adapters remain future work.

## Local data-plane provisioner

Setting `LIP_CLOUD_PROGRAM_DIR` starts a provisioning worker with
`LocalDataPlaneProvisioner`, which runs one LIP data-plane runtime per
environment inside the control-plane process. Each `create` job:

1. loads `<program_id>.json` from the program directory;
2. starts an isolated runtime — per-environment SQLite under
   `LIP_CLOUD_DATA_DIR` (default `.lip-cloud`), or tenant-scoped Postgres when
   `LIP_CLOUD_DATA_PLANE_DATABASE_URL` is set;
3. allocates a **stable port** from `LIP_CLOUD_DATA_PLANE_BASE_PORT` (default
   `13210`) recorded in `<data-dir>/ports.json`;
4. generates (or reuses) a merchant API key and writes a `0600` credentials
   file (`<data-dir>/<environment_id>.credentials.json`); and
5. marks the environment `ready` with its reachable `api_url` and `admin_url`.

On control-plane startup the provisioner calls `restore()` and relaunches every
credentialed environment on the same port and API key so BFF `LIP_URL` values
survive restarts. Only `create` operations are supported; credentials remain
files rather than an encrypted secret store. Regional adapters still replace
this for production.

## Start locally

Start Postgres and the Cloud API:

```bash
LIP_CLOUD_API_KEY="replace-with-at-least-16-characters" \
docker compose --profile cloud up --build
```

The management API listens on `http://127.0.0.1:3220`. From source:

```bash
LIP_CLOUD_DATABASE_URL="postgres://loyalty:password@localhost:5432/loyalty" \
LIP_CLOUD_API_KEY="replace-with-at-least-16-characters" \
npm run cloud:dev
```

Configuration:

- `LIP_CLOUD_DATABASE_URL` (falls back to `LIP_DATABASE_URL`)
- `LIP_CLOUD_API_KEY`
- `LIP_CLOUD_OIDC_ISSUER`, `LIP_CLOUD_OIDC_AUDIENCE`, and optional
  `LIP_CLOUD_OIDC_JWKS_URI` for direct JWT validation instead of the shared key
- `LIP_CLOUD_HOST` and `LIP_CLOUD_PORT`
- `LIP_CLOUD_REGIONS`, comma-separated
- `LIP_CLOUD_DEFAULT_PLAN`
- `LIP_CLOUD_ALLOWED_ORIGINS`, comma-separated

## Authentication boundary

Production can validate OIDC access tokens directly. Configure
`LIP_CLOUD_OIDC_ISSUER` and `LIP_CLOUD_OIDC_AUDIENCE` together; signature,
issuer, audience, expiry, allowed algorithm, and subject are validated against
the provider JWKS. Invitation acceptance only uses the email claim when
`email_verified` is true.

For local development or a private identity-aware gateway, configure
`LIP_CLOUD_API_KEY`. The gateway authenticates the request and forwards:

```http
Authorization: Bearer <LIP_CLOUD_API_KEY>
X-LIP-Cloud-Subject: <stable identity provider subject>
X-LIP-Cloud-Email: <optional normalized email>
```

The shared API key authenticates the trusted gateway; the stable subject drives
organization membership authorization. Do not expose the shared key directly
to browsers or mobile applications.

## API

All successful payloads use `{ "data": ... }`; errors use RFC 9457 problem
details.

- `GET /cloud/v1/plans`
- `GET|POST /cloud/v1/organizations`
- `GET /cloud/v1/organizations/{organization_id}`
- `GET|POST /cloud/v1/organizations/{organization_id}/projects`
- `GET|PATCH /cloud/v1/organizations/{organization_id}/members`
- `POST /cloud/v1/organizations/{organization_id}/invitations`
- `POST /cloud/v1/invitations/accept`
- `GET|POST /cloud/v1/projects/{project_id}/environments`
- `POST /cloud/v1/environments/{environment_id}/usage-events`
- `GET /cloud/v1/environments/{environment_id}/usage`

Example:

```bash
curl -X POST http://127.0.0.1:3220/cloud/v1/organizations \
  -H "Authorization: Bearer $LIP_CLOUD_API_KEY" \
  -H "X-LIP-Cloud-Subject: user_123" \
  -H "X-LIP-Cloud-Email: owner@example.com" \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo Restaurants","slug":"demo-restaurants"}'
```

## Isolation and metering

Every project belongs to one organization, every environment belongs to one
project, and each environment receives a unique `tenant_id`. Repository queries
resolve ownership before writes. Usage writes:

1. lock the environment, metric, and month;
2. verify the environment belongs to the expected organization;
3. deduplicate by environment, metric, and idempotency key;
4. enforce the plan hard limit;
5. insert the immutable event and update its monthly counter atomically.

Charging by monthly active members and transactions is represented directly;
points issued are not a billing metric.

## Next production steps

1. Replace the local provisioner with regional adapters that create durable
   data-plane runtimes (stable hosts, restarts, suspend/delete/upgrade jobs)
   through the existing claim-safe worker.
2. Implement the Stripe adapter behind `CloudBillingProvider`, including signed
   webhook handling.
3. Add encrypted environment credentials and API-key rotation.
4. Aggregate runtime usage into the control plane automatically.
5. Add backups, restore, region migration, and suspension workflows.
