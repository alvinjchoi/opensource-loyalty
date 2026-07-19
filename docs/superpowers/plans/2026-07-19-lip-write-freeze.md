# LIP Write-Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-memory write-freeze flag to the reference LIP server — set at startup (`ServerOptions.writeFrozen` / `LIP_WRITE_FREEZE`) and toggled at runtime via an admin endpoint — that returns a stable `503 write_frozen` for `/lip/v1` writes while keeping reads and health available.

**Architecture:** A `let writeFrozen` closure variable inside `startReferenceServer`. A guard in the `/lip/v1` dispatch rejects writes when set; `/health` reflects it; a `POST/GET /admin/api/v1/maintenance` admin pair reads/sets it. The CLI threads a `--write-freeze` flag and `LIP_WRITE_FREEZE` env through.

**Tech Stack:** TypeScript, Node ≥ 20.19, Vitest; `packages/server`, `packages/cli`.

## Global Constraints

- Node.js `>=20.19.0`; TypeScript strict; ESM (`.js` import specifiers in source).
- The freeze uses the existing `protocolPermission(path)` split — it freezes every `protocol:write` path (including `orders/evaluate`, deliberately); reads pass.
- Frozen writes return `503` `application/problem+json` via `problem(503, "Write operations are temporarily frozen", "write_frozen", ...)` with a `Retry-After` header. `code: "write_frozen"` is the stable, unchanging problem type.
- The admin toggle follows the existing admin-write pattern (`isAdminWriteAuthorized` + the CSRF path used by `members/cancel`); the status read follows `isAdminAuthorized` (like `snapshot`).
- In-memory only; no persistence store. `/lip/v1` scope only (never admin/`/cloud`).

---

### Task 1: Server freeze flag + guard + startup option + health

**Files:**
- Modify: `packages/server/src/server.ts` (`ServerOptions`, the `writeFrozen` closure var, the dispatch guard, the `/health` handler)
- Test: `tests/unit/server.test.ts`

**Interfaces:**
- Produces (consumed by Task 2-3): `ServerOptions.writeFrozen?: boolean`; a closure-scoped `let writeFrozen: boolean` inside `startReferenceServer` initialized from `options.writeFrozen ?? false` (Task 2 reassigns it).

- [ ] **Step 1: Write the failing test** in `tests/unit/server.test.ts` (model server construction on the existing tests):

```ts
it("freezes protocol writes at startup while allowing reads and health", async () => {
  const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
    apiKey: "freeze-test-key",
    writeFrozen: true
  });
  try {
    // a write is rejected with a stable 503 problem + Retry-After
    const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
      method: "POST",
      headers: { authorization: "Bearer freeze-test-key", "content-type": "application/json" },
      body: JSON.stringify(makeEnroll("freeze-write-key"))
    });
    expect(enroll.status).toBe(503);
    expect(enroll.headers.get("content-type")).toContain("application/problem+json");
    expect(enroll.headers.get("retry-after")).toBeTruthy();
    expect((await enroll.json()).code).toBe("write_frozen");

    // a read still works
    const program = await fetch(`${running.url}/lip/v1/programs/get`, {
      method: "POST",
      headers: { authorization: "Bearer freeze-test-key", "content-type": "application/json" },
      body: JSON.stringify({ context: makeContext("freeze-read-key"), program_id: "demo-foodservice" })
    });
    expect(program.status).toBe(200);

    // health reflects the freeze
    const health = await (await fetch(`${running.url}/health`)).json();
    expect(health).toMatchObject({ status: "ok", write_frozen: true });
  } finally {
    await running.close();
  }
});

it("defaults to unfrozen (writes allowed, health write_frozen false)", async () => {
  const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), { apiKey: "unfrozen-key" });
  try {
    const health = await (await fetch(`${running.url}/health`)).json();
    expect(health.write_frozen).toBe(false);
    const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
      method: "POST",
      headers: { authorization: "Bearer unfrozen-key", "content-type": "application/json" },
      body: JSON.stringify(makeEnroll("unfrozen-write-key"))
    });
    expect(enroll.status).toBe(201);
  } finally {
    await running.close();
  }
});
```

Confirm `makeEnroll`/`makeContext`/`makeProgram` are imported in the file (they are used by existing tests) and that a successful enroll returns `201` (per the route table). Adjust the program id if `makeProgram()` differs from `demo-foodservice`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/server.test.ts -t "freezes protocol writes"`
Expected: FAIL — `writeFrozen` option ignored; enroll returns 201, health has no `write_frozen`.

- [ ] **Step 3: Implement**

(a) In `ServerOptions` (server.ts:72), add after `apiKey`:
```ts
  writeFrozen?: boolean;
```

(b) Near the top of `startReferenceServer` (where other per-server state like `adminSessions` is declared), add:
```ts
  let writeFrozen = options.writeFrozen ?? false;
```

(c) In the `/health` handler (server.ts, the `GET /health` block), add the field:
```ts
        sendJson(response, 200, {
          status: "ok",
          protocol_version: "1.0",
          profile: "foodservice/1.0",
          write_frozen: writeFrozen
        });
```

(d) In the `/lip/v1` dispatch, immediately AFTER the `protocolAuthorized` 401 check (server.ts:1578-1582) and BEFORE `enforceRateLimit()`, add:
```ts
      if (writeFrozen && protocolPermission(path) === "protocol:write") {
        response.setHeader("retry-after", "30");
        sendJson(
          response,
          503,
          problem(503, "Write operations are temporarily frozen", "write_frozen",
            "The provider is in a maintenance window; retry after it closes"),
          "application/problem+json"
        );
        return;
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/server.test.ts`
Expected: PASS (both new tests; existing server tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts tests/unit/server.test.ts
git commit -m "feat(server): write-freeze flag rejects /lip/v1 writes with 503"
```

---

### Task 2: Runtime admin toggle — `/admin/api/v1/maintenance`

**Files:**
- Modify: `packages/server/src/server.ts` (register `allowedMethods`, add GET + POST handlers)
- Test: `tests/unit/server.test.ts`

**Interfaces:**
- Consumes: the `let writeFrozen` closure var (Task 1); `isAdminAuthorized`, `isAdminWriteAuthorized`, `adminSessions`, `problem`, `sendJson`, `readBody` (all already in `server.ts`); the admin audit recorder used by other admin writes.

- [ ] **Step 1: Write the failing test** in `tests/unit/server.test.ts` — use an admin-enabled server (mirror the existing admin tests' setup that passes `admin: { ... }` and an api key). With an authorized Bearer admin key:

```ts
it("toggles the write-freeze via the admin maintenance endpoint", async () => {
  // build an admin-enabled server the way the other admin tests do (admin: { storage, access, ... })
  // ... (mirror an existing admin test's `startReferenceServer(engine, { apiKey, admin: {...} })`)
  const authed = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  // starts unfrozen: status read reflects it
  const before = await (await fetch(`${running.url}/admin/api/v1/maintenance`, { headers: authed })).json();
  expect(before).toMatchObject({ write_frozen: false });

  // freeze
  const set = await fetch(`${running.url}/admin/api/v1/maintenance`, {
    method: "POST", headers: authed, body: JSON.stringify({ write_frozen: true })
  });
  expect(set.status).toBe(200);
  expect((await set.json())).toMatchObject({ write_frozen: true });

  // a write is now frozen
  const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
    method: "POST", headers: authed, body: JSON.stringify(makeEnroll("toggle-write-key"))
  });
  expect(enroll.status).toBe(503);

  // unfreeze → write works
  await fetch(`${running.url}/admin/api/v1/maintenance`, {
    method: "POST", headers: authed, body: JSON.stringify({ write_frozen: false })
  });
  const enroll2 = await fetch(`${running.url}/lip/v1/members/enroll`, {
    method: "POST", headers: authed, body: JSON.stringify(makeEnroll("toggle-write-key-2"))
  });
  expect(enroll2.status).toBe(201);
});

it("rejects a maintenance write without admin authorization", async () => {
  // unauthenticated POST → 401, and the flag is unchanged (a subsequent write still succeeds)
  const res = await fetch(`${running.url}/admin/api/v1/maintenance`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ write_frozen: true })
  });
  expect([401, 403]).toContain(res.status);
});
```

Read an existing admin test in `server.test.ts` (e.g. the snapshot or members/cancel test) and copy its exact admin-server construction, api key, and how it authorizes admin requests (Bearer root key vs session+CSRF). If admin writes in tests use a Bearer root key (no CSRF needed for `actor_type: root`), use that; otherwise perform the session+CSRF handshake as those tests do.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/server.test.ts -t "maintenance"`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Implement**

(a) In the `allowedMethods` admin registrations (server.ts:~687-704, inside `if (adminEnabled)`), add:
```ts
      allowedMethods.set("/admin/api/v1/maintenance", ["GET", "POST"]);
```

(b) Add the handlers alongside the other admin routes (e.g. near `members/cancel`). GET (status, admin:read):
```ts
      if (adminEnabled && method === "GET" && path === "/admin/api/v1/maintenance") {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        sendJson(response, 200, { write_frozen: writeFrozen });
        return;
      }
```
POST (toggle, admin:write + CSRF like `members/cancel`):
```ts
      if (adminEnabled && method === "POST" && path === "/admin/api/v1/maintenance") {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        if (!isAdminWriteAuthorized(request, options, adminSessions)) {
          sendJson(response, 403, problem(403, "Forbidden", "csrf_failed", "Admin writes require a valid CSRF token"), "application/problem+json");
          return;
        }
        const body = await readBody(request);
        const values = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
        if (typeof values["write_frozen"] !== "boolean") {
          throw new TransportError(422, "validation_failed", "Request validation failed", "write_frozen (boolean) is required");
        }
        writeFrozen = values["write_frozen"];
        const principal = bearerPrincipal(request, options) ?? adminPrincipal(request, options, adminSessions);
        if (principal) {
          try {
            options.admin?.access?.recordAudit(principal, "maintenance.write_freeze.changed", "server", undefined, { write_frozen: writeFrozen });
          } catch { /* audit must not change the response */ }
        }
        sendJson(response, 200, { write_frozen: writeFrozen });
        return;
      }
```

Confirm `TransportError`, `bearerPrincipal`, `adminPrincipal`, and `recordAudit`'s signature against `server.ts` (all are used by neighboring admin handlers, e.g. `members/cancel`); match them exactly. If `recordAudit`'s parameter order differs, mirror an existing call verbatim.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts tests/unit/server.test.ts
git commit -m "feat(server): POST/GET /admin/api/v1/maintenance toggles write-freeze"
```

---

### Task 3: CLI flag/env + docs

**Files:**
- Modify: `packages/cli/src/mock.ts` (thread `writeFrozen` through `MockOptions` → `startReferenceServer`)
- Modify: `packages/cli/src/cli.ts` (add `--write-freeze` to the serve/mock commands; read `LIP_WRITE_FREEZE`)
- Modify: `docs/reference-platform.md`
- Test: `tests/unit/cli.test.ts` (a focused check that the option/env sets the freeze)

**Interfaces:**
- Consumes: `ServerOptions.writeFrozen` (Task 1); the admin endpoint (Task 2, for docs).

- [ ] **Step 1: Write the failing test** — the simplest reliable check: `MockOptions.writeFrozen` propagates so a served instance is frozen. In `tests/unit/cli.test.ts` (or wherever mock/serve is tested), start `startMockServer({ apiKey, writeFrozen: true, ... })` and assert `GET /health` reports `write_frozen: true`. If `cli.test.ts` prefers spawning the built CLI, add: build the CLI, spawn `node packages/cli/dist/cli.js serve --write-freeze --port 0 ...` is impractical (port), so prefer the programmatic `startMockServer` route for this assertion; mirror how the file already exercises `startMockServer`/serve. Confirm the file's existing style before writing.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/cli.test.ts -t "write-freeze"` (or the mock test name)
Expected: FAIL — `MockOptions` has no `writeFrozen`; health reports `false`.

- [ ] **Step 3: Implement**

(a) In `packages/cli/src/mock.ts`: add `writeFrozen?: boolean;` to `MockOptions`, and in `startMockServer` pass it to `startReferenceServer`'s options:
```ts
    ...(options.writeFrozen ? { writeFrozen: true } : {}),
```
(place it beside the other conditional spreads in the `startReferenceServer({ ... })` call).

(b) In `packages/cli/src/cli.ts`, on the serve/mock command (`addMockCommand`), add:
```ts
    .option("--write-freeze", "start with /lip/v1 writes frozen (maintenance mode)")
```
and when building the `MockOptions`, set:
```ts
      writeFrozen: options.writeFreeze || process.env.LIP_WRITE_FREEZE === "true" || process.env.LIP_WRITE_FREEZE === "1",
```
Match the file's existing option-reading style (how `--no-seed`/`--reset`/booleans are read and how env vars are consulted elsewhere).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Document in `docs/reference-platform.md`**

Add a "Maintenance / write-freeze" section: `lip serve --write-freeze` and `LIP_WRITE_FREEZE=true`; the runtime `POST /admin/api/v1/maintenance {"write_frozen": true|false}` (admin key) and `GET` for status; that frozen `/lip/v1` writes return `503` `application/problem+json` `{ code: "write_frozen" }` with `Retry-After`, while reads and `/health` (which shows `write_frozen`) stay available. Vendor-neutral.

- [ ] **Step 6: Full verification + commit**

Run: `npm run verify`
Expected: green (new tests included).

```bash
git add packages/cli/src/mock.ts packages/cli/src/cli.ts docs/reference-platform.md tests/unit/cli.test.ts
git commit -m "feat(cli): lip serve --write-freeze / LIP_WRITE_FREEZE; document maintenance mode"
```

---

## Self-Review

**Spec coverage:**
- In-memory flag + startup option → Task 1. ✓
- Guard on `protocol:write` (incl. evaluate) with `503 write_frozen` + Retry-After → Task 1. ✓
- Reads + health available; health reflects flag → Task 1. ✓
- Runtime admin toggle (POST) + status (GET), admin auth → Task 2. ✓
- CLI flag + env → Task 3. ✓
- Docs → Task 3. ✓
- Out of scope (persistence, per-env Cloud exposure, admin/cloud freeze) → no task adds them. ✓

**Placeholder scan:** No TBD/TODO; code steps are complete. "Confirm against file" notes (admin-server test construction, `recordAudit`/`TransportError`/`bearerPrincipal` signatures, CLI option-reading style, `makeProgram` id) are concrete verification instructions with fallbacks, not missing logic.

**Type consistency:** `ServerOptions.writeFrozen` (Task 1) is read by the CLI (Task 3) and the guard/health/admin handlers all read the same `writeFrozen` closure var; Task 2's POST handler is the only writer. `problem(...)`, `sendJson(...)`, `isAdminAuthorized`/`isAdminWriteAuthorized`, and `protocolPermission` are existing `server.ts` symbols used as-is.
