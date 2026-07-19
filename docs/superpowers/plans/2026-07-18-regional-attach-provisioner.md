# Regional Attach Provisioner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vendor-neutral `POST /cloud/v1/environments/{id}/attach` endpoint that binds an externally-provisioned, TLS-reachable LIP host to a Cloud environment after full validation, storing only a key fingerprint.

**Architecture:** A new `RemoteEnvironmentAttacher` service validates a remote host (health/TLS, discovery, auth positive/negative, program match) with an injectable `fetch`. The `CloudControlPlane` service gains an `attachEnvironment` method that calls the attacher, then persists the binding via a new `CloudRepository.attachEnvironment`. The existing async provisioning worker and `LocalDataPlaneProvisioner` are untouched — attach is synchronous so the merchant key is never persisted.

**Tech Stack:** TypeScript, Node ≥ 20.19, Vitest, npm workspaces; `apps/cloud` (private control-plane app).

## Global Constraints

- Node.js `>=20.19.0`; TypeScript; ESM (`.js` import specifiers in source).
- The merchant `api_key` MUST NOT be persisted anywhere (no DB column, no file, no job payload). Only `api_key_fingerprint` (`<first 11 chars>…<last 4>`) is stored.
- Attach is synchronous (in the request handler); do NOT enqueue a provisioning job for it.
- `endpoint_url` MUST be `https://` unless the host is `localhost`/`127.0.0.1`.
- Follow existing `apps/cloud` patterns: `pathId(path, /regex/)` routing, `controlPlane.<method>(actor, id, input)`, `requireRole(principal, project.organization_id, managementRoles)`, `sendJson(response, status, { data }, headers)`, `CloudError(status, code, message)`.
- Immutability: repositories clone on read/write (follow `clone(...)` usage in `memory-repository.ts`).

---

### Task 1: `RemoteEnvironmentAttacher` service + unit tests

**Files:**
- Create: `apps/cloud/src/remote-attach.ts`
- Test: `apps/cloud/src/remote-attach.test.ts`

**Interfaces:**
- Produces (consumed by Task 3):
  ```ts
  export type AttachFailureCode =
    | "not_tls" | "health_unreachable" | "discovery_invalid"
    | "auth_rejected" | "auth_not_enforced" | "program_mismatch";
  export interface AttachBinding { api_url: string; admin_url: string; api_key_fingerprint: string; }
  export type AttachResult = { ok: true; binding: AttachBinding } | { ok: false; code: AttachFailureCode; message: string };
  export interface RemoteEnvironmentAttacherOptions { fetch?: typeof globalThis.fetch; }
  export class RemoteEnvironmentAttacher {
    constructor(options?: RemoteEnvironmentAttacherOptions);
    validate(input: { endpoint_url: string; api_key: string; program_id: string }): Promise<AttachResult>;
  }
  export function apiKeyFingerprint(key: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { RemoteEnvironmentAttacher, apiKeyFingerprint } from "./remote-attach.js";

// A stub fetch that routes by URL + method + auth header.
function stubFetch(handlers: (url: string, init: RequestInit) => Response | undefined): typeof globalThis.fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const res = handlers(String(input), init);
    return res ?? new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

const GOOD = "lip_sk_realkey_abcdefghijklmnop";
function bearer(init: RequestInit): string | undefined {
  const h = new Headers(init.headers); const v = h.get("authorization");
  return v?.startsWith("Bearer ") ? v.slice(7) : undefined;
}
// Full happy-path host: health ok, discovery valid, real key 200 / bogus 401, program matches.
function happyHost(url: string, init: RequestInit): Response | undefined {
  if (url.endsWith("/health")) return Response.json({ status: "ok" });
  if (url.endsWith("/.well-known/lip")) return Response.json({ protocol_version: "1.0", profile: "foodservice/1.0" });
  if (url.endsWith("/lip/v1/capabilities")) return new Response(null, { status: bearer(init) === GOOD ? 200 : 401 });
  if (url.endsWith("/lip/v1/programs/get")) return Response.json({ program: { program_id: "demo-rewards" } });
  return undefined;
}

describe("RemoteEnvironmentAttacher", () => {
  const attacher = (h: Parameters<typeof stubFetch>[0]) =>
    new RemoteEnvironmentAttacher({ fetch: stubFetch(h) });

  it("returns a binding when every check passes", async () => {
    const r = await attacher(happyHost).validate({ endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toEqual({ ok: true, binding: {
      api_url: "https://lip.example.com",
      admin_url: "https://lip.example.com/admin/",
      api_key_fingerprint: apiKeyFingerprint(GOOD)
    }});
  });

  it("rejects a non-TLS non-localhost url with not_tls", async () => {
    const r = await attacher(happyHost).validate({ endpoint_url: "http://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "not_tls" });
  });

  it("allows http on localhost", async () => {
    const r = await attacher(happyHost).validate({ endpoint_url: "http://127.0.0.1:13210", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: true });
  });

  it("reports health_unreachable when /health is not ok", async () => {
    const r = await attacher((u) => u.endsWith("/health") ? new Response(null, { status: 503 }) : happyHost(u, {})).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "health_unreachable" });
  });

  it("reports discovery_invalid on a version mismatch", async () => {
    const r = await attacher((u, i) => u.endsWith("/.well-known/lip") ? Response.json({ protocol_version: "9.9", profile: "x" }) : happyHost(u, i)).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "discovery_invalid" });
  });

  it("reports auth_rejected when the real key is refused", async () => {
    const r = await attacher((u) => u.endsWith("/lip/v1/capabilities") ? new Response(null, { status: 401 }) : happyHost(u, {})).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "auth_rejected" });
  });

  it("reports auth_not_enforced when a bogus key is accepted", async () => {
    const r = await attacher((u) => u.endsWith("/lip/v1/capabilities") ? new Response(null, { status: 200 }) : happyHost(u, {})).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "auth_not_enforced" });
  });

  it("reports program_mismatch when the host serves another program", async () => {
    const r = await attacher((u, i) => u.endsWith("/lip/v1/programs/get") ? Response.json({ program: { program_id: "other" } }) : happyHost(u, i)).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "program_mismatch" });
  });

  it("fingerprint never contains the full key", () => {
    const fp = apiKeyFingerprint(GOOD);
    expect(fp).not.toContain(GOOD);
    expect(fp).toContain("…");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/cloud/src/remote-attach.test.ts`
Expected: FAIL — module `./remote-attach.js` not found.

- [ ] **Step 3: Implement `remote-attach.ts`**

```ts
const EXPECTED_PROTOCOL = "1.0";
const EXPECTED_PROFILE = "foodservice/1.0";

export type AttachFailureCode =
  | "not_tls" | "health_unreachable" | "discovery_invalid"
  | "auth_rejected" | "auth_not_enforced" | "program_mismatch";

export interface AttachBinding {
  api_url: string;
  admin_url: string;
  api_key_fingerprint: string;
}
export type AttachResult =
  | { ok: true; binding: AttachBinding }
  | { ok: false; code: AttachFailureCode; message: string };

export interface RemoteEnvironmentAttacherOptions {
  fetch?: typeof globalThis.fetch;
}

export function apiKeyFingerprint(key: string): string {
  if (key.length <= 8) return "…";
  return `${key.slice(0, 11)}…${key.slice(-4)}`;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export class RemoteEnvironmentAttacher {
  private readonly fetchImpl: typeof globalThis.fetch;
  public constructor(options: RemoteEnvironmentAttacherOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async validate(input: {
    endpoint_url: string;
    api_key: string;
    program_id: string;
  }): Promise<AttachResult> {
    let base: URL;
    try {
      base = new URL(input.endpoint_url);
    } catch {
      return { ok: false, code: "health_unreachable", message: "endpoint_url is not a valid URL" };
    }
    if (base.protocol !== "https:" && !isLocalHost(base.hostname)) {
      return { ok: false, code: "not_tls", message: "endpoint_url must use https for a non-localhost host" };
    }
    const apiUrl = input.endpoint_url.replace(/\/+$/, "");
    const at = (p: string) => `${apiUrl}${p}`;

    // 1. health
    const health = await this.safe(() => this.fetchImpl(at("/health")));
    if (!health || !health.ok) return { ok: false, code: "health_unreachable", message: "GET /health did not return ok" };
    const healthBody = await this.json(health);
    if (!healthBody || (healthBody as { status?: unknown }).status !== "ok") {
      return { ok: false, code: "health_unreachable", message: "/health did not report status ok" };
    }

    // 2. discovery
    const disc = await this.safe(() => this.fetchImpl(at("/.well-known/lip")));
    const discBody = disc && disc.ok ? await this.json(disc) : undefined;
    const d = discBody as { protocol_version?: unknown; profile?: unknown } | undefined;
    if (!d || d.protocol_version !== EXPECTED_PROTOCOL || d.profile !== EXPECTED_PROFILE) {
      return { ok: false, code: "discovery_invalid", message: "discovery document missing or version mismatch" };
    }

    // 3. auth positive
    const authed = await this.safe(() => this.fetchImpl(at("/lip/v1/capabilities"), {
      headers: { authorization: `Bearer ${input.api_key}` }
    }));
    if (!authed || authed.status !== 200) return { ok: false, code: "auth_rejected", message: "api_key did not authenticate" };

    // 4. auth negative
    const bogus = `lip_sk_bogus_${Math.abs(hashString(input.api_key + apiUrl)).toString(36)}`;
    const denied = await this.safe(() => this.fetchImpl(at("/lip/v1/capabilities"), {
      headers: { authorization: `Bearer ${bogus}` }
    }));
    if (!denied || denied.status !== 401) return { ok: false, code: "auth_not_enforced", message: "host accepted an unknown key" };

    // 5. program match
    const prog = await this.safe(() => this.fetchImpl(at("/lip/v1/programs/get"), {
      method: "POST",
      headers: { authorization: `Bearer ${input.api_key}`, "content-type": "application/json" },
      body: JSON.stringify({ program_id: input.program_id })
    }));
    const progBody = prog && prog.ok ? await this.json(prog) : undefined;
    const servedId = (progBody as { program?: { program_id?: unknown } } | undefined)?.program?.program_id;
    if (servedId !== input.program_id) return { ok: false, code: "program_mismatch", message: "host serves a different program" };

    return {
      ok: true,
      binding: { api_url: apiUrl, admin_url: `${apiUrl}/admin/`, api_key_fingerprint: apiKeyFingerprint(input.api_key) }
    };
  }

  private async safe(run: () => Promise<Response>): Promise<Response | undefined> {
    try { return await run(); } catch { return undefined; }
  }
  private async json(res: Response): Promise<unknown> {
    try { return await res.json(); } catch { return undefined; }
  }
}

function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) { h = (h << 5) - h + value.charCodeAt(i); h |= 0; }
  return h;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/cloud/src/remote-attach.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/src/remote-attach.ts apps/cloud/src/remote-attach.test.ts
git commit -m "feat(cloud): RemoteEnvironmentAttacher validates a remote LIP host"
```

---

### Task 2: `api_key_fingerprint` field + `CloudRepository.attachEnvironment`

**Files:**
- Modify: `apps/cloud/src/types.ts` (add field to `CloudEnvironment`; add method to `CloudRepository`)
- Modify: `apps/cloud/src/memory-repository.ts` (implement)
- Modify: `apps/cloud/src/postgres-repository.ts` (implement + migration + row mapping)
- Test: `apps/cloud/src/memory-repository` covered via the Task 3 integration test; add a focused memory-repo unit test here.
- Test file: `apps/cloud/src/attach-repository.test.ts`

**Interfaces:**
- Produces (consumed by Task 3):
  ```ts
  // on CloudRepository:
  attachEnvironment(environmentId: string, binding: {
    api_url: string; admin_url?: string; api_key_fingerprint?: string;
    status: ProvisioningStatus; status_message?: string;
  }): Promise<CloudEnvironment>;
  // on CloudEnvironment:
  api_key_fingerprint?: string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { MemoryCloudRepository } from "./memory-repository.js";
import type { CloudEnvironment } from "./types.js";

function pendingEnv(): CloudEnvironment {
  return {
    environment_id: "env_1", project_id: "proj_1", slug: "prod", name: "Prod",
    kind: "production", region: "us-east-1", tenant_id: "tenant_1", program_id: "demo-rewards",
    status: "pending", created_at: "2026-07-18T00:00:00.000Z", updated_at: "2026-07-18T00:00:00.000Z"
  };
}

describe("attachEnvironment", () => {
  it("updates status, urls, and fingerprint; clears status_message on ready", async () => {
    const repo = new MemoryCloudRepository();
    await repo.createEnvironment(pendingEnv(), { /* audit */ } as never);
    const updated = await repo.attachEnvironment("env_1", {
      api_url: "https://lip.example.com", admin_url: "https://lip.example.com/admin/",
      api_key_fingerprint: "lip_sk_abcd…wxyz", status: "ready"
    });
    expect(updated).toMatchObject({
      status: "ready", api_url: "https://lip.example.com",
      admin_url: "https://lip.example.com/admin/", api_key_fingerprint: "lip_sk_abcd…wxyz"
    });
    expect(updated.status_message).toBeUndefined();
    // full key never stored
    expect(JSON.stringify(updated)).not.toContain("secret");
  });

  it("records failure status + message", async () => {
    const repo = new MemoryCloudRepository();
    await repo.createEnvironment(pendingEnv(), { /* audit */ } as never);
    const updated = await repo.attachEnvironment("env_1", {
      api_url: "https://lip.example.com", status: "failed", status_message: "auth_rejected"
    });
    expect(updated).toMatchObject({ status: "failed", status_message: "auth_rejected" });
  });
});
```

Note: confirm `MemoryCloudRepository`'s exported name and its `createEnvironment(environment, audit)` signature at the top of `memory-repository.ts` before running; the audit arg is required by the interface — pass a minimal object cast as shown, or a real `CloudAuditEntry` if the memory repo validates it.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/cloud/src/attach-repository.test.ts`
Expected: FAIL — `attachEnvironment` is not a function.

- [ ] **Step 3: Add the field + interface method** in `apps/cloud/src/types.ts`

In `CloudEnvironment`, after `admin_url?: string;` add:
```ts
  api_key_fingerprint?: string;
```
In `CloudRepository` (after `environmentsForProject(...)`) add:
```ts
  attachEnvironment(
    environmentId: string,
    binding: {
      api_url: string;
      admin_url?: string;
      api_key_fingerprint?: string;
      status: ProvisioningStatus;
      status_message?: string;
    }
  ): Promise<CloudEnvironment>;
```

- [ ] **Step 4: Implement in `memory-repository.ts`**

```ts
  public async attachEnvironment(
    environmentId: string,
    binding: {
      api_url: string; admin_url?: string; api_key_fingerprint?: string;
      status: ProvisioningStatus; status_message?: string;
    }
  ): Promise<CloudEnvironment> {
    const existing = this.environments.get(environmentId);
    if (!existing) throw new Error(`Environment ${environmentId} was not found`);
    const updated: CloudEnvironment = {
      ...existing,
      status: binding.status,
      api_url: binding.api_url,
      updated_at: this.now().toISOString()
    };
    if (binding.admin_url) updated.admin_url = binding.admin_url; else delete updated.admin_url;
    if (binding.api_key_fingerprint) updated.api_key_fingerprint = binding.api_key_fingerprint;
    if (binding.status_message) updated.status_message = binding.status_message; else delete updated.status_message;
    this.environments.set(environmentId, clone(updated));
    return clone(updated);
  }
```
Confirm the memory repo has a clock (`this.now()`); if it uses a different name or a fixed timestamp helper, match it (grep `now(` / `clock` in the file). Import `ProvisioningStatus` if not already.

- [ ] **Step 5: Implement in `postgres-repository.ts`**

(a) **Migration** — find where cloud migrations are registered (search `lip_cloud_schema_migrations` and the migration list/array near it). Add a new migration that runs:
```sql
ALTER TABLE lip_cloud_environments ADD COLUMN IF NOT EXISTS api_key_fingerprint TEXT;
```
Follow the exact registration shape the file uses (id/name + SQL). If migrations are a plain ordered array of SQL strings, append this as the next entry.

(b) **Row mapping** — in the function that maps a DB row to `CloudEnvironment` (near line 119, where `api_url` is mapped), add:
```ts
    ...(row["api_key_fingerprint"] ? { api_key_fingerprint: String(row["api_key_fingerprint"]) } : {}),
```

(c) **Method** — model it on the existing env update (~line 923):
```ts
  public async attachEnvironment(
    environmentId: string,
    binding: {
      api_url: string; admin_url?: string; api_key_fingerprint?: string;
      status: ProvisioningStatus; status_message?: string;
    }
  ): Promise<CloudEnvironment> {
    const result = await this.pool.query(`
      UPDATE lip_cloud_environments
      SET status = $2,
          status_message = $3,
          api_url = $4,
          admin_url = $5,
          api_key_fingerprint = $6,
          updated_at = now()
      WHERE environment_id = $1
      RETURNING *
    `, [
      environmentId, binding.status, binding.status_message ?? null,
      binding.api_url, binding.admin_url ?? null, binding.api_key_fingerprint ?? null
    ]);
    const row = result.rows[0];
    if (!row) throw new Error(`Environment ${environmentId} was not found`);
    return this.mapEnvironment(row); // use whatever the file's row→CloudEnvironment mapper is called
  }
```
Confirm the pool/client accessor name (`this.pool` vs `this.client` vs a `withClient` helper) and the row-mapper function name against the file; match them.

- [ ] **Step 6: Run tests**

Run: `npx vitest run apps/cloud/src/attach-repository.test.ts`
Expected: PASS. Then `npx vitest run apps/cloud` to confirm no other cloud test regressed.

- [ ] **Step 7: Commit**

```bash
git add apps/cloud/src/types.ts apps/cloud/src/memory-repository.ts apps/cloud/src/postgres-repository.ts apps/cloud/src/attach-repository.test.ts
git commit -m "feat(cloud): CloudRepository.attachEnvironment + api_key_fingerprint field"
```

---

### Task 3: Service `attachEnvironment` + `/attach` route + integration test + docs

**Files:**
- Modify: `apps/cloud/src/service.ts` (inject attacher; add `attachEnvironment` method)
- Modify: `apps/cloud/src/server.ts` (add the `/attach` route)
- Modify: `apps/cloud/src/cloud.test.ts` (integration test)
- Modify: `docs/cloud.md` (document the attach flow)

**Interfaces:**
- Consumes: `RemoteEnvironmentAttacher`, `AttachResult` (Task 1); `CloudRepository.attachEnvironment` (Task 2); existing `requiredEnvironment`, `requiredProject`, `requireRole`, `managementRoles`, `CloudError`, `pathId`, `readBody`, `requiredString`, `sendJson`.

- [ ] **Step 1: Write the failing integration test** in `apps/cloud/src/cloud.test.ts`

Model it on the file's existing environment-creation flow (find the test that POSTs `/cloud/v1/projects/{id}/environments`). It must: start a real reference server (`startReferenceServer` from `@loyalty-interchange/server`) seeded with a program whose id matches the environment's `program_id`, using a known api key; create an org → project → environment through the control-plane HTTP API (or service) as the existing tests do; then:

```ts
// attach with the correct key → ready + fingerprint, no full key stored
const attach = await fetch(`${cloudUrl}/cloud/v1/environments/${environmentId}/attach`, {
  method: "POST",
  headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
  body: JSON.stringify({ endpoint_url: lipServer.url, api_key: lipApiKey })
});
expect(attach.status).toBe(200);
const attachedEnv = (await attach.json()).data;
expect(attachedEnv.status).toBe("ready");
expect(attachedEnv.api_url).toBe(lipServer.url.replace(/\/+$/, ""));
expect(attachedEnv.api_key_fingerprint).toContain("…");
expect(JSON.stringify(attachedEnv)).not.toContain(lipApiKey);

// attach with a wrong key → 422 auth_rejected, not ready
const bad = await fetch(`${cloudUrl}/cloud/v1/environments/${environmentId}/attach`, {
  method: "POST",
  headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
  body: JSON.stringify({ endpoint_url: lipServer.url, api_key: "lip_sk_wrong" })
});
expect(bad.status).toBe(422);
expect((await bad.json()).error?.code ?? (await bad.clone().json()).code).toBe("auth_rejected");
```

Confirm against the file: how the control-plane test server is started and its base URL; the operator credential/role setup (the operator must hold a `managementRoles` role on the org); the program id used to seed the LIP server must equal the environment's `program_id`; and the exact error-envelope shape returned by `sendJson` for a `CloudError` (adjust the error-code assertion to match, e.g. `.error.code` vs `.code`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/cloud/src/cloud.test.ts -t "attach"`
Expected: FAIL — 404 (no `/attach` route) or method-missing.

- [ ] **Step 3: Add the service method** in `apps/cloud/src/service.ts`

Add `attacher` to `CloudControlPlaneOptions` and the constructor:
```ts
// options interface:
  attacher?: RemoteEnvironmentAttacher;
// constructor body (with the other assignments):
  this.attacher = options.attacher ?? new RemoteEnvironmentAttacher();
// field:
  private readonly attacher: RemoteEnvironmentAttacher;
```
Add the method (near `recordUsage`):
```ts
  public async attachEnvironment(
    principal: CloudPrincipal,
    environmentId: string,
    input: { endpoint_url: string; api_key: string }
  ): Promise<CloudEnvironment> {
    const environment = await this.requiredEnvironment(environmentId);
    const project = await this.requiredProject(environment.project_id);
    await this.requireRole(principal, project.organization_id, managementRoles);
    if (environment.status === "suspended") {
      throw new CloudError(409, "environment_suspended", "A suspended environment cannot be attached");
    }
    const result = await this.attacher.validate({
      endpoint_url: input.endpoint_url.trim(),
      api_key: input.api_key,
      program_id: environment.program_id
    });
    if (!result.ok) {
      await this.repository.attachEnvironment(environmentId, {
        api_url: input.endpoint_url.trim(),
        status: "failed",
        status_message: result.code
      });
      throw new CloudError(422, result.code, result.message);
    }
    return this.repository.attachEnvironment(environmentId, {
      api_url: result.binding.api_url,
      admin_url: result.binding.admin_url,
      api_key_fingerprint: result.binding.api_key_fingerprint,
      status: "ready"
    });
  }
```
Import `RemoteEnvironmentAttacher` at the top. Confirm `requiredEnvironment`/`requiredProject`/`requireRole`/`managementRoles`/`CloudError` are the exact names in the file.

- [ ] **Step 4: Add the route** in `apps/cloud/src/server.ts` (near the other `/cloud/v1/environments/{id}/...` routes)

```ts
      const environmentAttachId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/attach$/
      );
      if (environmentAttachId && method === "POST") {
        const body = await readBody(request);
        const environment = await controlPlane.attachEnvironment(actor, environmentAttachId, {
          endpoint_url: requiredString(body, "endpoint_url"),
          api_key: requiredString(body, "api_key")
        });
        sendJson(response, 200, { data: environment }, headers);
        return;
      }
```

- [ ] **Step 5: Run the integration test + full cloud suite**

Run: `npx vitest run apps/cloud/src/cloud.test.ts` then `npx vitest run apps/cloud`
Expected: PASS (attach ready + fingerprint; wrong key → 422 auth_rejected).

- [ ] **Step 6: Document in `docs/cloud.md`**

Add an "Attaching a data-plane host" section: `POST /cloud/v1/environments/{id}/attach` with `{ endpoint_url, api_key }`; the five validation checks; that only a key fingerprint is stored (never the key); that re-attach is allowed to rebind on rotation/migration; and that this is the remote counterpart to the in-process local provisioner. Keep prose vendor-neutral (no specific cloud provider).

- [ ] **Step 7: Full verification + commit**

Run: `npm run verify`
Expected: green (new tests included).

```bash
git add apps/cloud/src/service.ts apps/cloud/src/server.ts apps/cloud/src/cloud.test.ts docs/cloud.md
git commit -m "feat(cloud): POST /cloud/v1/environments/{id}/attach binds a remote LIP host"
```

---

## Self-Review

**Spec coverage:**
- Vendor-neutral attach (no cloud-provider API) → Tasks 1+3 (HTTP validation only). ✓
- Separate attach endpoint → Task 3 route. ✓
- Synchronous, key never persisted → Task 3 service (no job), Task 2 (only fingerprint column). ✓
- Full validation (health/TLS, discovery, auth ±, program) → Task 1. ✓
- `api_key_fingerprint` field + repo method (memory + postgres + migration) → Task 2. ✓
- Failure → `failed` + code, 422 → Task 3 service. ✓
- Re-attach allowed (pending/ready/failed; not suspended) → Task 3 service guard. ✓
- Integration test + docs → Task 3. ✓
- Existing worker / `LocalDataPlaneProvisioner` untouched → not modified by any task. ✓
- Out of scope (detach, auto-provision, key persistence, #8 wiring) → no task adds them. ✓

**Placeholder scan:** No TBD/TODO. Each code step is complete. Several steps carry "confirm the exact name against the file" verification notes (memory-repo clock, postgres pool/mapper names, migration registration shape, error-envelope shape) — these are concrete verification instructions with a stated fallback, required because those exact identifiers weren't read during planning; they are not placeholders for missing logic.

**Type consistency:** `RemoteEnvironmentAttacher.validate` / `AttachResult` / `apiKeyFingerprint` defined in Task 1 are consumed by name in Task 3. `CloudRepository.attachEnvironment(environmentId, binding)` signature is identical in Task 2's interface, memory impl, postgres impl, and Task 3's service calls. `CloudEnvironment.api_key_fingerprint?` added in Task 2, asserted in Tasks 2+3 tests. `ProvisioningStatus` values (`pending`/`ready`/`failed`/`suspended`) match `types.ts:3`.
