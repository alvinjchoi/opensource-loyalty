# Regional data-plane attach adapter: design (issue #4)

Unblocks #8 (conformance against a Cloud-provisioned tenant).

## Problem

The Cloud control plane can only provision data planes with
`LocalDataPlaneProvisioner`, which runs LIP runtimes in-process on localhost
ports — not publicly reachable, not on managed infrastructure. There is no way
to take an environment to `ready` against a real, TLS-reachable regional LIP
host, so the Acme-style cutover and the #8 conformance run have no target.

## Decisions

1. **Vendor-neutral attach/register adapter**, not an auto-provisioner. The
   operator stands up a LIP host by any means (Docker/Render/Fly/k8s); the
   control plane binds and validates it. The public protocol repo stays free of
   any single cloud vendor's API. A future auto-provisioner can slot in behind
   the same environment lifecycle.
2. **Separate attach endpoint.** Create the environment (`pending`), then
   `POST /cloud/v1/environments/{id}/attach` binds a running host. Separating
   "create the logical environment" from "bind a host" supports re-attach on
   key rotation or host migration.
3. **Do not persist the merchant key.** Validate it in-memory on attach; store
   only `api_url` + a key fingerprint. This keeps the open-source control plane
   out of the secret-vault business (no KMS/secret-store design) and, because
   the key must not be durably stored, forces attach to be **synchronous** — an
   async job would persist the key in its durable payload.
4. **Full validation before `ready`:** reachability/TLS, discovery, auth
   positive, auth negative, program match (see below). Directly delivers the
   #4 acceptance criteria and mirrors `lip doctor`.

## Design

### New endpoint — `POST /cloud/v1/environments/{id}/attach`

- **Auth:** the same control-plane authentication as other `/cloud/v1`
  mutations (operator Cloud credentials); no new auth scheme.
- **Body:** `{ "endpoint_url": string, "api_key": string }`.
- **Synchronous:** the handler runs the full validation in-memory, then updates
  the environment. No provisioning job is enqueued (the key must not be
  persisted in a durable job payload).
- **Success → 200** with the updated environment: `status: "ready"`, `api_url`,
  `admin_url`, `api_key_fingerprint`.
- **Validation failure → 422** with a machine-readable failed-check code; the
  environment is set to `failed` with `status_message = <check code>` (re-attach
  is allowed from `failed`, so this is recoverable). A previously `ready`
  environment whose re-attach fails likewise moves to `failed`.
- **Re-attach:** allowed when the environment is `pending`, `ready`, or
  `failed`; re-validates and rebinds (supports key rotation / host migration).
  Not allowed for `suspended`.

### `RemoteEnvironmentAttacher` (new, single responsibility)

A focused service that validates a remote LIP host and returns either a binding
or a typed failure. Pure HTTP + logic; takes an injectable `fetch` for tests.
Against `endpoint_url`, all of the following MUST pass:

1. **Reachability / TLS** — `GET {url}/health` returns `{ status: "ok" }`.
   `endpoint_url` MUST be `https://` unless the host is `localhost`/`127.0.0.1`
   (the test/local exception). Failure codes: `not_tls`, `health_unreachable`.
2. **Discovery** — `GET {url}/.well-known/lip` is a valid LIP discovery
   document and its protocol/profile versions match the control plane's
   expected values (`1.0` / `foodservice/1.0`). Failure: `discovery_invalid`.
3. **Auth positive** — `GET {url}/lip/v1/capabilities` with
   `Authorization: Bearer <api_key>` returns 200. Failure: `auth_rejected`.
4. **Auth negative** — the same request with a freshly generated random bogus
   key returns 401. Proves auth is enforced. Failure: `auth_not_enforced`.
5. **Program match** — `POST {url}/lip/v1/programs/get` `{ program_id }` (with
   the real key) returns the environment's `program_id`. Failure:
   `program_mismatch`.

On success it returns `{ api_url, admin_url, api_key_fingerprint }` where
`admin_url = ${api_url}/admin/` and `api_key_fingerprint` is
`<first 11 chars>…<last 4>` of the key (never the full secret).

> The #4 acceptance line "rejects other tenants' keys" is delivered here as
> auth-enforcement (a bogus key is rejected). Full cross-tenant isolation —
> tenant A's valid key rejected by tenant B's host — is a property of the host
> and is covered by the #8 conformance run, not the attacher (which does not
> hold another tenant's key).

### Data model + repository

- Add `api_key_fingerprint?: string` to `CloudEnvironment` (`types.ts`).
- Add to the `CloudRepository` interface:
  `attachEnvironment(environmentId, binding): Promise<CloudEnvironment>` where
  `binding = { api_url, admin_url, api_key_fingerprint, status, status_message? }`,
  implemented in both `memory-repository.ts` and `postgres-repository.ts`. It
  updates the environment row (status, urls, fingerprint, `updated_at`) and
  returns the updated record. (Postgres: an `ALTER TABLE ... ADD COLUMN
  api_key_fingerprint` migration; the column is nullable.)

### Boundaries

- `apps/cloud/src/remote-attach.ts` — the `RemoteEnvironmentAttacher` service
  and its typed result/error. One responsibility, unit-testable with an
  injected `fetch`.
- `apps/cloud/src/server.ts` — the attach route handler: parse + validate the
  body, look up the environment, call the attacher, persist via
  `attachEnvironment`, map failures to 422 with the check code.
- The async `CloudProvisioningWorker` and `LocalDataPlaneProvisioner` are
  **untouched** — they remain the in-process/local path. Attach is a separate
  synchronous control-plane operation, consistent with decision 3.

## Testing

- **Unit (`remote-attach.test.ts`)** with an injected `fetch` stub:
  all-checks-pass → binding with the correct fingerprint; each failing check
  returns its specific code (`not_tls` for an `http://` non-localhost url,
  `health_unreachable`, `discovery_invalid`, `auth_rejected` when the real key
  is 401, `auth_not_enforced` when a bogus key is accepted, `program_mismatch`
  when the host serves a different program); assert the fingerprint never
  contains the full key.
- **Integration (extend `cloud.test.ts`)** against a real
  `startReferenceServer`: create an environment, attach with the correct key →
  `ready` + `api_url` + fingerprint; attach with a wrong key → 422
  `auth_rejected`, environment not `ready`; re-attach after rotating the host
  key → rebinds and stays `ready`.

## Acceptance criteria

- Creating an environment through `/cloud/v1` and then attaching a running,
  TLS-reachable LIP host takes the environment to `ready` with its `api_url`.
- The attached merchant key authenticates `/lip/v1/*` and a bogus key is
  rejected (verified during attach).
- The environment record stores only the URL and a key fingerprint — never the
  full key.
- `npm run verify` green (new unit + integration tests included).

## Out of scope (YAGNI / follow-ups)

- Detach / teardown endpoint.
- Auto-provisioning against a specific provider (Render/Fly/k8s) — the
  environment lifecycle stays open for it.
- Persisting or rotating the merchant key (the #5 handoff stays out-of-band).
- Wiring the #8 conformance run (this design unblocks it: point `lip doctor` /
  `lip test` at the attached `api_url`).

## Docs

- `docs/cloud.md`: document the attach flow, the five validation checks, and
  the local-provisioner vs. remote-attach paths.
