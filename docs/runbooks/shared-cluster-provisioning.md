# Shared LIP cluster: deployment + tenant provisioning runbook (PLA-417)

This runbook stands up ONE regional Postgres-backed LIP cluster that serves
every brand, and onboards brands onto it. A brand is a `tenant_id` — a row
scope inside the shared database — never a per-brand deployment.

## Architecture at a glance

- **Deployable unit:** the `apps/cloud` host (`node apps/cloud/dist/cli.js`).
  It is the only multi-tenant runner in the repo: the control plane owns
  organizations → projects → environments (each environment gets a generated
  `tenant_id` and a `program_id`), a claim-safe worker processes provisioning
  jobs, and `LocalDataPlaneProvisioner` boots one row-scoped LIP runtime per
  tenant inside the same process. The single-tenant reference server
  (`packages/server/src/cli.ts`) cannot serve multiple brands from one
  process, so it is not the unit here.
- **One database.** Control-plane tables (`lip_cloud_*`) and every tenant's
  engine rows (`lip_engine_*`, keyed by `tenant_id` + `program_id`) share the
  one managed Postgres.
- **One service instance — a hard constraint.** `docs/postgres.md`: run at
  most one platform instance per tenant until PLA-428/429 land (Admin
  extension stores cache per-process revisions; webhook journals assume a
  single dispatcher). `render.yaml` pins `numInstances: 1` and the attached
  disk prevents scale-out. Do not raise the instance count.
- **Auth model (PLA-416).** Two keys are in play:
  - `LIP_CLOUD_API_KEY` — one shared trusted-gateway key for all
    control-plane management calls, paired with an `X-LIP-Cloud-Subject`
    header. Server-side only, never in a browser or app. **WARNING:** any
    holder of this one key can pick any subject and thereby mint any
    tenant's merchant key — see the constraints table.
  - Per-environment **merchant keys** (`lip_sk_...`) — owner-role,
    tenant-scoped access-control keys bootstrapped at provision time
    (audited, only valid on their own tenant's runtime; the runtime stores
    only a hash, but the control-plane host keeps a **plaintext copy in the
    environment's credentials file** — see the constraints table).
    Retrieved and rotated through the control plane (step 4c); the replaced
    key stays valid for a bounded overlap window (default 24 h) so BFFs swap
    without downtime. Each runtime also holds a root key in its credentials
    file — deprecated, never handed out, kept only for backward
    compatibility with pre-v2 consumers.

## 1. Create the shared Postgres

### Variant A — Render managed Postgres (default; what `render.yaml` does)

Nothing manual: the blueprint's `databases:` block creates
`lip-shared-postgres` (Postgres 17, database `loyalty`, empty `ipAllowList`
so it is private-network only) and injects its connection string into the
service. Skip to step 2.

### Variant B — Neon

1. Neon console → **New project** → Postgres 17, region matching the Render
   region (e.g. AWS `us-west-2` for Render Oregon). Database `loyalty`, role
   `loyalty`.
2. Copy the **direct (unpooled)** connection string. Do not use the
   `-pooler` endpoint: the engine manages its own `pg` pool and uses
   advisory locks (`withLease` takes session-scoped locks that break under
   transaction pooling).
3. Project → **Settings → Compute**: disable autosuspend (scale-to-zero) for
   production; cold starts would stall checkout-path loyalty calls.
4. Project → **Settings → Storage**: set history retention to at least 7
   days — this is your point-in-time-recovery window.
5. Delete the `databases:` block from `render.yaml` (or leave it unused) and
   set both `LIP_CLOUD_DATABASE_URL` and `LIP_CLOUD_DATA_PLANE_DATABASE_URL`
   on the service to the Neon URL in the Render dashboard (mark them as
   secret files/env in dashboard; they contain credentials).

## 2. Deploy the service from the blueprint

1. Render dashboard → **New → Blueprint** → select this repo and branch →
   it reads `render.yaml`.
2. Fill the `sync: false` secrets when prompted:
   - `LIP_CLOUD_API_KEY`: ≥ 16 random characters (e.g. `openssl rand -base64 24`).
     Store it in the team password manager.
   - `LIP_CLOUD_ALLOWED_ORIGINS`: the Business Manager origin(s), e.g.
     `https://dashboard.craveup.com`.
3. Apply. The deploy runs `preDeployCommand: node apps/cloud/dist/migrate-cli.js`
   before going live; confirm the deploy log contains
   `{"event":"shared_cluster_migrations_applied","shared_database":true,...}`.
   The command is advisory-locked and idempotent — reruns are no-ops.
4. Verify health:

   ```bash
   curl -s https://<service>.onrender.com/health
   # {"status":"ok","service":"lip-cloud-control-plane"}
   ```

## 3. Seed program definitions

Provisioning a tenant fails unless `<program_id>.json` exists in
`LIP_CLOUD_PROGRAM_DIR` (`/data/programs`). Per brand, author the program
JSON (see `deploy/acme-sandbox/acme-program.json` for a template) and place
it on the disk:

```bash
render ssh lip-shared-data-plane
mkdir -p /data/programs
cat > /data/programs/demo-rewards.json <<'EOF'
{ "program_id": "demo-rewards", ... }
EOF
```

The file's `program_id` must equal its filename stem, or provisioning
rejects it.

## 4. Onboard a brand (tenant + program + API key)

Trigger: a Business Manager org toggles loyalty on. The craveup-turborepo
control-plane worker (or an operator) then runs ONE of the following against
the deployed control plane. Both paths use only the existing `/cloud/v1`
surface.

### 4a. One command (wraps the API)

```bash
LIP_CLOUD_API_KEY=<shared key> npm run cloud:provision -- \
  --cloud-url https://<service>.onrender.com \
  --subject org_<business_manager_org_id> \
  --org-slug demo-restaurants --org-name "Demo Restaurants" \
  --project-slug loyalty --project-name "Loyalty" \
  --env-slug production --env-name "Production" \
  --kind production --region render-oregon \
  --program-id demo-rewards
```

Prints `{"event":"tenant_provisioned", "tenant_id":"tenant_...", "status":"ready",
"api_url":"http://lip-shared-data-plane:13210...", ...}` and exits non-zero on
failure or timeout. Re-running with the same slugs is idempotent (reuses the
org/project/environment); reusing an environment slug with a different
`--program-id` is rejected. `--region` must be listed in the service's
`LIP_CLOUD_REGIONS`.

### 4b. Raw API calls (what the command does)

```bash
H=(-H "Authorization: Bearer $LIP_CLOUD_API_KEY" \
   -H "X-LIP-Cloud-Subject: org_..." -H "Content-Type: application/json")
BASE=https://<service>.onrender.com

curl "${H[@]}" -X POST $BASE/cloud/v1/organizations \
  -d '{"name":"Demo Restaurants","slug":"demo-restaurants"}'
curl "${H[@]}" -X POST $BASE/cloud/v1/organizations/<organization_id>/projects \
  -d '{"name":"Loyalty","slug":"loyalty"}'
curl "${H[@]}" -X POST $BASE/cloud/v1/projects/<project_id>/environments \
  -d '{"name":"Production","slug":"production","kind":"production",
       "region":"render-oregon","program_id":"demo-rewards"}'
# poll until status == "ready" (worker polls every 5s):
curl "${H[@]}" $BASE/cloud/v1/projects/<project_id>/environments
```

The environment response carries the generated `tenant_id` and, once ready,
`api_url`/`admin_url` on the private-network host
(`lip-shared-data-plane:<port>`).

### 4c. Retrieve or rotate the merchant API key (via the control plane)

Rotation doubles as retrieval — mint the credential the moment you need it
instead of reading files off the disk:

```bash
LIP_CLOUD_API_KEY=<shared key> npm run cloud:provision -- rotate-credentials \
  --cloud-url https://<service>.onrender.com \
  --subject org_<business_manager_org_id> \
  --environment <environment_id>
# {"event":"tenant_credentials_rotated","merchant_api_key":"lip_sk_...",
#  "replaced_api_key_expires_at":"...", ...}
```

(Equivalent raw call: `POST $BASE/cloud/v1/environments/<environment_id>/credentials/rotate`
with the same auth headers as 4b; optional JSON body
`{"overlap_seconds": <0..604800>}`. Requires org owner/admin; audited
cloud-side as `cloud.environment.credentials_rotated` and tenant-side as
actor `cloud:<subject>`.)

Copy `merchant_api_key` into the consuming BFF's secrets (`LIP_URL` +
`LIP_API_KEY` on the Express API's Render service) and into the password
manager. **Every run expires the previously issued merchant key** after the
overlap window (default 24 h; the response's `replaced_api_key_expires_at`
tells you exactly when) — so treat re-runs as real rotations, not free
retrievals, and swap the BFF before the window closes. For an emergency
cutover (leaked key), pass `--overlap-seconds 0` (or `{"overlap_seconds": 0}`
on the raw call): the replaced key dies immediately. Never hand out the root
`api_key` from the credentials file — it is deprecated and no API returns it.

Tenants can also self-serve rotation of any key they created on their own
runtime: `POST /admin/api/v1/access/api-keys/rotate` with
`{"key_id": "key_...", "overlap_seconds": 86400}` (0 = immediate cutover),
and revoke early via `POST /admin/api/v1/access/api-keys/revoke`. The
replacement inherits the rotated key's expiry (an explicit `expires_at` may
shorten it, never extend it), so time-boxed keys stay time-boxed across
rotations. If a tenant self-rotates the merchant key, the next control-plane
`rotate-credentials` run recovers automatically by rotating the live
`cloud-merchant` lineage (or minting a fresh one if none is left).

### 4d. Create the tenant's first webhook subscription

Tenant runtimes start with **zero** webhook subscriptions — without this step
nothing is ever delivered. Two ways to wire the first one:

- **At provision time** — add webhook flags to the 4a command (also works on
  an idempotent re-run against an already-ready environment):

  ```bash
  LIP_CLOUD_API_KEY=<shared key> npm run cloud:provision -- \
    ... same flags as 4a ... \
    --webhook-url https://bff.example.com/hooks/loyalty \
    --webhook-secret <at least 16 random characters>
  ```

  This mints the merchant key via 4c and upserts a subscription with the
  stable id `webhook_onboarding` through the runtime's admin API, so re-runs
  update rather than duplicate. The output's `credentials.merchant_api_key`
  is the credential for the BFF — store it as in 4c. Note the minting side
  effect: any previously issued merchant key enters its overlap window. Run
  it from a machine that can reach the tenant runtime (private network, like
  4e).

- **Manually via the runtime admin API** (with the merchant key from 4c):

  ```bash
  curl -X PUT http://lip-shared-data-plane:<port>/admin/api/v1/webhooks/subscription \
    -H "Authorization: Bearer $LIP_API_KEY" -H "Content-Type: application/json" \
    -d '{"url":"https://bff.example.com/hooks/loyalty","secret":"<>=16 chars>"}'
  ```

Confirm with `GET /admin/api/v1/webhooks/health` (`subscription_count` >= 1).

### 4e. Verify before routing traffic

```bash
npm run lip -- doctor http://lip-shared-data-plane:<port> --api-key "$LIP_API_KEY"
npm run lip -- cloud-verify http://lip-shared-data-plane:<port> \
  --api-key "$LIP_API_KEY" --program-id demo-rewards
```

(Run from a machine on the private network, e.g. a Render job or the BFF
host; the tenant ports are not public.)

### 4f. Migrating an existing brand's state in

Follow `MIGRATION.md` end to end. The Postgres import target uses the
provisioned tenant:

```bash
LIP_DATABASE_URL='<shared postgres url>' LIP_TENANT_ID='<tenant_id>' \
npm run lip -- state import --program ./demo-rewards.json --input ./archive.json
```

## 5. Backups and point-in-time recovery

- **Render Postgres:** paid instances take daily backups and support
  point-in-time recovery from continuous WAL archiving. Dashboard →
  database → **Recovery** → pick a timestamp → Render provisions a new
  instance from that point. Then update the service's two database env vars
  to the recovered instance and redeploy. Always freeze writes first (below).
- **Neon:** restore = create a branch at a timestamp (**Restore** tab or
  `neon branches create --parent-timestamp ...`) inside the history-retention
  window, then repoint the service env vars at the new branch's endpoint.
- **The service disk is state too.** `/data` holds program JSONs and the
  per-environment credentials files. Render disks take daily snapshots;
  restore from the disk's **Snapshots** tab. Additionally keep programs in
  git and merchant keys in the password manager.
- **Lost or corrupted credentials file — the real recovery path:**
  1. If the runtime is still running (file lost while the service stayed
     up), `rotate-credentials` (4c) recovers on its own: the control plane
     rotates the tenant's live `cloud-merchant` lineage (or mints a fresh
     owner key if none survives) and rewrites the file.
  2. If the service restarted without the file, `restore()` skips that
     environment (there is nothing to restore from) — the runtime is down,
     not just the credential. Re-run provisioning for the same slugs (4a is
     idempotent); the provisioner reuses the persisted port and tenant
     database, re-adopts the existing merchant lineage from the tenant's
     access state instead of minting a parallel key, and writes a fresh
     credentials file. Then run `rotate-credentials` (4c) to hand the new
     merchant key to the BFF.
  3. If the data plane itself is unrecoverable, fall back to the
     re-provision (4a) or external-host attach path
     (`POST /cloud/v1/environments/{id}/attach`, `docs/cloud.md`) and
     migrate state per 4f.
  A weak, tampered, or unreadable credentials file no longer aborts startup
  for the other tenants: `restore()` logs
  `cloud_environment_restore_failed` for that environment and continues.
- **Restore drill:** after any restore, run step 4e verification plus a
  known-member balance spot check (`cloud-verify --expect-member ...`)
  before unfreezing.

### Write-freeze cutover guard

The data-plane write freeze (shipped per `MIGRATION.md` / issue #6 — env
`LIP_WRITE_FREEZE`, the flag this platform provides for what the cutover
checklist calls the loyalty write freeze) refuses every `/lip/v1` write with
a stable `503 {"code":"write_frozen"}` + `Retry-After` while reads and
`/health` stay up:

- **Per-tenant, at runtime (the path that works on the shared cluster):**

  ```bash
  curl -X POST http://lip-shared-data-plane:<port>/admin/api/v1/maintenance \
    -H "Authorization: Bearer $LIP_API_KEY" -H "Content-Type: application/json" \
    -d '{"write_frozen": true}'   # false to unfreeze
  ```

- **At startup** (`LIP_WRITE_FREEZE=true` / `lip serve --write-freeze`) —
  applies to standalone hosts; the in-process tenant runtimes do not read it,
  so on the shared cluster use the runtime toggle per tenant.
- The flag is in-memory: a service restart unfreezes. Re-check
  `GET /health` (`write_frozen` field) after any deploy during a cutover.

## 6. Observability

Monitor per layer:

| Signal | Where | Alert on |
| --- | --- | --- |
| Control-plane liveness | `GET /health` on the public URL (Render health check uses it) | non-200; Render "server failed health check" notification |
| Tenant runtime liveness + freeze state | `GET http://lip-shared-data-plane:<port>/health` per tenant (reports `status`, `write_frozen`) | non-200, or `write_frozen: true` outside a planned window |
| Webhook delivery health | `GET /admin/api/v1/webhooks/health` per tenant (merchant key; returns delivery counts, `success_rate`, `healthy`) | `healthy: false` or falling `success_rate` |
| Request metrics | `GET /metrics` per tenant runtime (authenticated, Prometheus text) | error-rate/latency regressions |
| Provisioning | service logs: `cloud_environment_provisioned` / `cloud_environment_restored` / `cloud_environment_restore_failed` events; environments stuck `pending`/`failed` in `/cloud/v1/projects/{id}/environments` | any `cloud_environment_restore_failed` (that tenant is down until fixed); job `attempts >= 5` (worker gives up) |
| Database | Render/Neon dashboard: storage, connections, CPU | > 80% storage, connection saturation |

Render dashboard → service → **Settings → Notifications**: enable deploy
failure + health-check alerts to the engineering Slack. Stream logs (Render
**Log Streams**) to the team's sink for retention.

## 7. Constraints and follow-ups

| Constraint | Tracking |
| --- | --- |
| One platform instance per tenant → `numInstances: 1`, no horizontal scaling of the shared host | PLA-428 / PLA-429 |
| **WARNING — single shared control-plane key:** `LIP_CLOUD_API_KEY` plus a caller-chosen `X-LIP-Cloud-Subject` header is the entire management auth. Anyone holding the one shared key can present any subject and therefore mint **any tenant's merchant key** via 4c. Treat the key as a root credential: server-side only, rotate on any suspicion, audit `cloud.environment.credentials_rotated` events for unexpected subjects. Merchant keys are tenant-scoped + rotatable since PLA-416, but per-operator control-plane auth is a tracked follow-up | follow-up: per-operator control-plane credentials |
| Tenant runtimes are private-network only (one public port per Render service) | follow-up: per-tenant public hostnames or gateway routing |
| Credentials files still hold the merchant key (and deprecated root key) in **plaintext on disk** (`0600`, atomic writes; rotation shipped, encryption at rest pending) | listed in `docs/cloud.md` "Next production steps" |

## Owner actions checklist (dashboard-only steps)

1. Render: **New → Blueprint** on this repo/branch; approve the plan.
2. Render: set `LIP_CLOUD_API_KEY` and `LIP_CLOUD_ALLOWED_ORIGINS` when
   prompted; save the key to the password manager.
3. (Neon variant only) Create the Neon project, disable autosuspend, set
   history retention, paste both database URLs into the service env.
4. Render: enable failure/health notifications; optionally add a log stream.
5. Seed `/data/programs/<program_id>.json` via `render ssh` per brand.
6. Per onboarded brand: run `rotate-credentials` (step 4c) to mint the
   merchant key, set `LIP_URL` + `LIP_API_KEY` on the BFF service, store the
   key in the password manager.
7. Per onboarded brand: create the first webhook subscription (step 4d) —
   without it the tenant delivers no webhooks.
