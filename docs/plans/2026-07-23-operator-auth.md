# Per-operator control-plane auth (PLA-442)

Retires the shared `LIP_CLOUD_API_KEY` + caller-chosen `X-LIP-Cloud-Subject`
header as the identity mechanism for `/cloud/v1`. Since PLA-416 added
`POST /cloud/v1/environments/{id}/credentials/rotate`, one leaked gateway key
plus a known operator subject equals remote exfiltration of every tenant's
owner-role merchant key. This change makes the acting subject come from a
**verified credential** in every mode.

## Design

### 1. Per-operator API keys (core mechanism)

- New control-plane records: `lip_cloud_operators` and
  `lip_cloud_operator_api_keys` (migration `005_operators.sql`; twin in the
  in-memory repository).
  - Operator: `{ operator_id, subject (unique), email?, role:
    "platform-admin" | "org-scoped", organization_ids? (org-scoped only),
    active, created_at, updated_at }`.
  - Key: `lip_ok_<32-byte base64url>` secret, **sha256-hashed at rest**,
    stored `prefix` for display, `expires_at`, `last_used_at`, `revoked_at` —
    mirroring `packages/server/src/access-control.ts` (same mint/hash/prefix
    shape, same rotation semantics: bounded overlap 0..604800 s defaulting to
    24 h, replacement inherits expiry, an explicit `expires_at` may shorten
    but never extend, rotation audit entries land as an atomic pair).
- Auth middleware: `Authorization: Bearer lip_ok_...` resolves the operator;
  the acting subject IS the operator record's subject
  (`issuer: "urn:lip:operator"`). `X-LIP-Cloud-Subject` is **never** identity
  under operator auth — it is kept only as an optional on-behalf-of
  annotation copied into audit metadata.
- Authorization: platform-admin operators are unrestricted; org-scoped
  operators resolve a virtual **admin** membership for orgs in their scope
  and 404 elsewhere. Credentials-rotate therefore requires platform-admin or
  org-scope over that environment's org (managementRoles check unchanged).
- Operator lifecycle endpoints (platform-admin only, except bootstrap):
  `POST/GET /cloud/v1/operators`, `PATCH /cloud/v1/operators/{id}`,
  `POST /cloud/v1/operators/{id}/keys`, `.../keys/rotate`, `.../keys/revoke`.

### 2. OIDC bearer mode (config-gated, unchanged deps)

`LIP_CLOUD_OIDC_ISSUER`/`AUDIENCE`(/`JWKS_URI`) already existed via
`@loyalty-interchange/identity` (`jose`) — no new dependency. Delta: after
verification, the verified `sub` is looked up in the operators table; when an
**active operator record exists** the principal carries that operator's
role/scope (the future Clerk/Business-Manager path, PLA-420).

### 3. Bootstrap + migration path

- The shared `LIP_CLOUD_API_KEY` remains accepted during migration, but:
  - it may create an operator **only** as bootstrap (first operator, must be
    platform-admin); afterwards `POST /cloud/v1/operators` under the shared
    key is 403 `operator_bootstrap_exhausted`;
  - every non-bootstrap use logs a `cloud_shared_key_used` deprecation
    warning, and boot logs `cloud_shared_key_deprecated` when the var is set;
  - `LIP_CLOUD_SHARED_KEY_DISABLED=true` rejects the shared key outright
    (401 `shared_key_disabled`) — set it once operators exist.
- CLI verb: `npm run cloud:operator -- create ...` (uses
  `LIP_CLOUD_OPERATOR_KEY`, falling back to `LIP_CLOUD_API_KEY` for
  bootstrap).

### 4. Clients

`provisionTenant` / `rotateTenantCredentials` / `cloud:provision` accept an
operator key (`LIP_CLOUD_OPERATOR_KEY` preferred over the legacy
`LIP_CLOUD_API_KEY`, which still works during bootstrap). With an operator
key, `--subject` becomes optional (identity comes from the key; a provided
subject is only an on-behalf-of annotation). Cloud-side audit entries record
the verified `operator_id` in metadata.

## Recorded deviations from the issue sketch

1. **OIDC subjects without an operator record stay valid as plain org
   members.** The issue says the verified sub "maps to an operator record
   (must exist + active)". `/cloud/v1` OIDC mode also serves invitation-based
   org members (dashboard users) today; requiring an operator record for
   every token would break that surface and its tests. Implemented reading:
   operator *powers* require an existing active operator record; a verified
   non-operator sub keeps exactly the membership-based access it had. The
   security property (no operator privileges without a pre-registered
   operator) holds.
2. **Operator lifecycle audit lives in a new `lip_cloud_operator_audit`
   table**, not `lip_cloud_audit_log`, because the existing audit table has a
   NOT NULL FK to organizations and operator events are platform-level.
3. **Org-scoped operators act as virtual `admin`, not `owner`**, inside their
   orgs — owner remains reserved for the org's own membership records
   (owner-protected member updates stay meaningful).
4. **`authenticator` XOR `apiKey` stays forbidden as before; "neither" is now
   allowed** when an operator directory is wired (operator-keys-only mode —
   the target end state).
5. **Platform-admin lockout guard:** the last active platform-admin operator
   cannot be deactivated (409 `operator_lockout`) so the control plane cannot
   strand itself once the shared key is disabled.
