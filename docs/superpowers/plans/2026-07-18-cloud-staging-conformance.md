# Cloud Staging Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `runCloudVerification` core (doctor + baseline conformance + optional known-member and member-count checks), expose it as a `lip cloud-verify` command, and prove the full #4 attach → conformance path with a CI test.

**Architecture:** `runCloudVerification` reuses the existing `runDoctor` / `runBaselineConformance` (both return `DiagnosticReport`) and adds two optional checks via HTTP. The CLI command wraps it; a top-level integration test drives it through the #4 attach flow against a real ephemeral reference server.

**Tech Stack:** TypeScript, Node ≥ 20.19, Vitest, npm workspaces; `packages/cli` (depends on `@loyalty-interchange/server`), `apps/cloud`, top-level `tests/`.

## Global Constraints

- Node.js `>=20.19.0`; TypeScript strict; ESM (`.js` import specifiers in source).
- Reuse `runDoctor` and `runBaselineConformance` from `packages/cli/src/diagnostics.ts` (both `(ConnectionOptions) => Promise<DiagnosticReport>`; `ConnectionOptions = { baseUrl: string; apiKey: string }`; `DiagnosticReport = { ok: boolean; baseUrl: string; checks: DiagnosticCheck[] }`). Do NOT reimplement them.
- `report.ok` is the AND of every section that ran; the CLI sets a non-zero exit code when `ok` is false.
- The member lookup is `POST /lip/v1/members/lookup` with body `{ context, program_id, identity }`; the response is `{ context, member, balances: Balance[] }` and `Balance.available` is an integer.
- No secret is printed in reports beyond what `formatReport` already does (it does not print keys).

---

### Task 1: `runCloudVerification` core + unit test

**Files:**
- Create: `packages/cli/src/cloud-verify.ts`
- Test: `tests/unit/cloud-verify.test.ts`
- Modify: `packages/cli/src/index.ts` (export the new symbols, if the package uses an index barrel; confirm and match its export style)

**Interfaces:**
- Produces (consumed by Tasks 2-3):
  ```ts
  import type { IdentityReference } from "@loyalty-interchange/protocol";
  import type { DiagnosticReport } from "./diagnostics.js";
  export interface CloudVerificationExpectations {
    programId?: string;
    expectMember?: { identity: IdentityReference; available: number };
    expectMembers?: number;
  }
  export interface MemberBalanceCheck { ok: boolean; expected: number; actual: number | null }
  export interface MemberCountCheck { ok: boolean; expected: number; actual: number | null }
  export interface CloudVerificationReport {
    doctor: DiagnosticReport;
    conformance: DiagnosticReport;
    knownMember?: MemberBalanceCheck;
    memberCount?: MemberCountCheck;
    ok: boolean;
  }
  export function runCloudVerification(
    connection: { baseUrl: string; apiKey: string },
    expectations?: CloudVerificationExpectations
  ): Promise<CloudVerificationReport>;
  ```

- [ ] **Step 1: Write the failing test** (`tests/unit/cloud-verify.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { startReferenceServer } from "@loyalty-interchange/server";
import { makeProgram } from "../fixtures.js";
import { runCloudVerification } from "@loyalty-interchange/cli"; // adjust to the package's real export path

// Enroll one member with a known balance so the checks have something real to read.
async function seededServer() {
  const engine = new LoyaltyEngine(makeProgram());
  const ctx = (key: string) => ({
    protocol_version: "1.0" as const, profile: "foodservice/1.0" as const,
    request_id: `req-${key}`, idempotency_key: key,
    occurred_at: "2026-07-18T00:00:00.000Z", source: { system: "seed" }
  });
  engine.enroll({ context: ctx("seed-enroll"), program_id: "demo-foodservice",
    identity: { type: "token", value: "known-guest" }, member_id: "member-001" });
  const server = await startReferenceServer(engine, { apiKey: "verify-test-key", port: 0 });
  return { server, apiKey: "verify-test-key" };
}

describe("runCloudVerification", () => {
  it("passes doctor + conformance with no expectations", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const r = await runCloudVerification({ baseUrl: server.url, apiKey });
      expect(r.doctor.ok).toBe(true);
      expect(r.conformance.ok).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.knownMember).toBeUndefined();
    } finally { await server.close(); }
  });

  it("verifies a known member's available balance", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const r = await runCloudVerification({ baseUrl: server.url, apiKey }, {
        programId: "demo-foodservice",
        expectMember: { identity: { type: "token", value: "known-guest" }, available: 0 }
      });
      expect(r.knownMember).toMatchObject({ ok: true, expected: 0, actual: 0 });
      expect(r.ok).toBe(true);
    } finally { await server.close(); }
  });

  it("fails when the known member's balance differs", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const r = await runCloudVerification({ baseUrl: server.url, apiKey }, {
        programId: "demo-foodservice",
        expectMember: { identity: { type: "token", value: "known-guest" }, available: 999 }
      });
      expect(r.knownMember).toMatchObject({ ok: false, expected: 999, actual: 0 });
      expect(r.ok).toBe(false);
    } finally { await server.close(); }
  });

  it("verifies the member count via the admin snapshot", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const r = await runCloudVerification({ baseUrl: server.url, apiKey }, { expectMembers: 1 });
      expect(r.memberCount).toMatchObject({ ok: true, expected: 1, actual: 1 });
      expect(r.ok).toBe(true);
    } finally { await server.close(); }
  });
});
```

Confirm before running: the import path for `runCloudVerification` (match how `tests/unit/cli.test.ts` imports CLI symbols — package name vs. a `src` path), and that `makeProgram()` yields program id `demo-foodservice` (grep `tests/fixtures.ts`); adjust the ids if different. If a freshly-enrolled member's primary `available` is not `0`, set the expectation to the actual seed value.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/cloud-verify.test.ts`
Expected: FAIL — `runCloudVerification` not exported.

- [ ] **Step 3: Implement `packages/cli/src/cloud-verify.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { IdentityReference } from "@loyalty-interchange/protocol";
import { runBaselineConformance, runDoctor, type DiagnosticReport } from "./diagnostics.js";

export interface CloudVerificationExpectations {
  programId?: string;
  expectMember?: { identity: IdentityReference; available: number };
  expectMembers?: number;
}
export interface MemberBalanceCheck { ok: boolean; expected: number; actual: number | null }
export interface MemberCountCheck { ok: boolean; expected: number; actual: number | null }
export interface CloudVerificationReport {
  doctor: DiagnosticReport;
  conformance: DiagnosticReport;
  knownMember?: MemberBalanceCheck;
  memberCount?: MemberCountCheck;
  ok: boolean;
}

function context(): unknown {
  return {
    protocol_version: "1.0",
    profile: "foodservice/1.0",
    request_id: randomUUID(),
    idempotency_key: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: { system: "lip-cloud-verify" }
  };
}

async function lookupAvailable(
  connection: { baseUrl: string; apiKey: string },
  programId: string,
  identity: IdentityReference
): Promise<number | null> {
  const base = connection.baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/lip/v1/members/lookup`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ context: context(), program_id: programId, identity })
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { balances?: Array<{ available?: number }> };
  const balance = body.balances?.[0];
  return typeof balance?.available === "number" ? balance.available : null;
}

async function snapshotMemberCount(
  connection: { baseUrl: string; apiKey: string }
): Promise<number | null> {
  const base = connection.baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/admin/api/v1/snapshot`, {
    headers: { authorization: `Bearer ${connection.apiKey}` }
  });
  if (!res.ok) return null;
  const snap = (await res.json()) as { members?: unknown };
  return Array.isArray(snap.members) ? snap.members.length : null;
}

export async function runCloudVerification(
  connection: { baseUrl: string; apiKey: string },
  expectations: CloudVerificationExpectations = {}
): Promise<CloudVerificationReport> {
  const doctor = await runDoctor(connection);
  const conformance = await runBaselineConformance(connection);

  let knownMember: MemberBalanceCheck | undefined;
  if (expectations.expectMember) {
    if (!expectations.programId) {
      throw new Error("programId is required to verify a known member");
    }
    const actual = await lookupAvailable(connection, expectations.programId, expectations.expectMember.identity);
    knownMember = { ok: actual === expectations.expectMember.available, expected: expectations.expectMember.available, actual };
  }

  let memberCount: MemberCountCheck | undefined;
  if (typeof expectations.expectMembers === "number") {
    const actual = await snapshotMemberCount(connection);
    memberCount = { ok: actual === expectations.expectMembers, expected: expectations.expectMembers, actual };
  }

  const ok = doctor.ok && conformance.ok &&
    (knownMember?.ok ?? true) && (memberCount?.ok ?? true);
  return { doctor, conformance, ...(knownMember ? { knownMember } : {}), ...(memberCount ? { memberCount } : {}), ok };
}
```

Confirm the admin snapshot member-count path: the reference server's `GET /admin/api/v1/snapshot` response — grep `inspectAdmin` in `packages/reference/src/engine.ts` and the snapshot handler in `packages/server/src/server.ts` to confirm members live at `snap.members` (a top-level array). If they live under a different key (e.g. `snap.state.members`), adjust `snapshotMemberCount` and the test's expected count accordingly.

Export `runCloudVerification` and its types from wherever the CLI package exposes its API (add to `packages/cli/src/index.ts` barrel if present; otherwise ensure the test's import path resolves to this file).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/cloud-verify.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cloud-verify.ts tests/unit/cloud-verify.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): runCloudVerification (doctor + conformance + member checks)"
```

---

### Task 2: `lip cloud-verify` CLI command

**Files:**
- Modify: `packages/cli/src/cli.ts` (register the command)
- Test: `tests/unit/cli.test.ts` (or wherever CLI-command tests live; confirm)

**Interfaces:**
- Consumes: `runCloudVerification` (Task 1), the existing `connection(url, options)` helper and `formatReport` in `cli.ts`.

- [ ] **Step 1: Write the failing test** — a CLI test asserting the command runs the verification and reports. Model it on how `cli.test.ts` invokes existing commands (if it spawns the built CLI, build first; if it imports actions, adapt). Minimum assertion: invoking `cloud-verify` against a seeded real server prints a report line and, on a mismatched `--expect-available`, sets a non-zero exit code.

If `cli.test.ts` tests commands by spawning the compiled `packages/cli/dist/cli.js`, write the test to: start a seeded `startReferenceServer`, run `node packages/cli/dist/cli.js cloud-verify <url> --api-key ... --program-id demo-foodservice --expect-member known-guest --expect-available 0`, assert exit 0; repeat with `--expect-available 999`, assert non-zero exit. (Build with `npm run build --workspace @loyalty-interchange/cli` first, matching the file's existing approach.)

Confirm the exact harness `cli.test.ts` uses and match it; do not invent a new invocation style.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/cli.test.ts -t "cloud-verify"`
Expected: FAIL — unknown command `cloud-verify`.

- [ ] **Step 3: Register the command** in `packages/cli/src/cli.ts` (after the `test` command, before `program.parseAsync()`), importing `runCloudVerification` from `./cloud-verify.js`:

```ts
program
  .command("cloud-verify [url]")
  .description("Run doctor + baseline conformance and optional member checks against a provisioned host")
  .option("-k, --api-key <key>", "Admin/API key for Bearer auth")
  .option("--program-id <id>", "Program id (required for --expect-member)")
  .option("--expect-member <identity>", "Known member token identity to verify")
  .option("--expect-available <n>", "Expected available balance for --expect-member")
  .option("--expect-members <n>", "Expected total member count (uses the non-normative admin snapshot)")
  .action(async (url: string | undefined, options: ConnectionFlags & {
    programId?: string; expectMember?: string; expectAvailable?: string; expectMembers?: string;
  }) => {
    const conn = await connection(url, options);
    const expectations: Parameters<typeof runCloudVerification>[1] = {};
    if (options.programId) expectations.programId = options.programId;
    if (options.expectMember !== undefined) {
      if (options.expectAvailable === undefined) throw new Error("--expect-available is required with --expect-member");
      expectations.expectMember = {
        identity: { type: "token", value: options.expectMember },
        available: Number(options.expectAvailable)
      };
    }
    if (options.expectMembers !== undefined) expectations.expectMembers = Number(options.expectMembers);
    const report = await runCloudVerification(conn, expectations);
    console.log(formatReport(report.doctor));
    console.log(formatReport(report.conformance));
    if (report.knownMember) {
      console.log(`[${report.knownMember.ok ? "pass" : "fail"}] known member available: expected ${report.knownMember.expected}, got ${report.knownMember.actual}`);
    }
    if (report.memberCount) {
      console.log(`[${report.memberCount.ok ? "pass" : "fail"}] member count: expected ${report.memberCount.expected}, got ${report.memberCount.actual}`);
    }
    if (!report.ok) process.exitCode = 1;
  });
```

Confirm `ConnectionFlags` is the option type used by the existing `doctor`/`test` actions and that `connection`/`formatReport` are in scope in `cli.ts` (they are — used by `doctor`/`test`). Import `runCloudVerification` from `./cloud-verify.js`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/cli.test.ts` (and rebuild the CLI first if the test spawns the compiled binary)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli.ts tests/unit/cli.test.ts
git commit -m "feat(cli): add lip cloud-verify command"
```

---

### Task 3: CI integration test (attach → verify) + docs

**Files:**
- Create: `tests/conformance/cloud-attach-conformance.test.ts`
- Modify: `docs/cloud.md`

**Interfaces:**
- Consumes: `runCloudVerification` (Task 1); the control-plane attach harness from `apps/cloud/src/cloud.test.ts` (the "attaches a remote data-plane host" test, ~line 405) — `createDemoPlatform`, `startReferenceServer`, `MemoryCloudRepository`, `CloudControlPlane`, `startCloudServer`, and the operator/membership setup under issuer `urn:lip:trusted-gateway`.

- [ ] **Step 1: Write the failing test** (`tests/conformance/cloud-attach-conformance.test.ts`)

Reproduce the attach harness from `apps/cloud/src/cloud.test.ts`'s attach test (read it and copy the org→project→environment→operator setup and the attach call), seeding the reference host with a known member (as in Task 1's `seededServer`), then:

```ts
// after the environment is attached and `attachedEnv.api_url` is known:
const report = await runCloudVerification(
  { baseUrl: attachedEnv.api_url, apiKey: lipApiKey },
  {
    programId: "demo-foodservice",
    expectMember: { identity: { type: "token", value: "known-guest" }, available: 0 },
    expectMembers: 1
  }
);
expect(report.doctor.ok).toBe(true);
expect(report.conformance.ok).toBe(true);
expect(report.knownMember).toMatchObject({ ok: true });
expect(report.memberCount).toMatchObject({ ok: true });
expect(report.ok).toBe(true);
```

Import `runCloudVerification` from the CLI package, the control plane from `apps/cloud/src/...` (relative import from `tests/` is fine), and `startReferenceServer`/`createDemoPlatform` from `@loyalty-interchange/server`. Close both servers in a `finally`. Confirm the attach path returns the environment with `api_url` (the #4 endpoint response `data.api_url`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/conformance/cloud-attach-conformance.test.ts`
Expected: FAIL first because the test file/import isn't wired, then (once wired) it should PASS — this is an integration proof on already-shipped code (attach + verify both exist after Tasks 1-2). If it fails for a real reason, fix the wiring, not the assertion.

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run tests/conformance/cloud-attach-conformance.test.ts`
Expected: PASS.

- [ ] **Step 4: Document in `docs/cloud.md`**

Add a "Verifying a staging tenant" section: after attaching a host (the `/attach` endpoint), run
`lip cloud-verify <api_url> --api-key <key> --program-id <id> --expect-member <token> --expect-available <n> [--expect-members <N>]`
and record the printed report; it exits non-zero on any failure so it can gate a cutover. Note that member counts also appear in `lip state import`'s output, and that `--expect-members` reads the non-normative admin snapshot. Keep prose vendor-neutral.

- [ ] **Step 5: Full verification + commit**

Run: `npm run verify`
Expected: green (new unit, CLI, and conformance tests included).

```bash
git add tests/conformance/cloud-attach-conformance.test.ts docs/cloud.md
git commit -m "test(conformance): prove the attach -> cloud-verify path; document it"
```

---

## Self-Review

**Spec coverage:**
- `runCloudVerification` core (doctor + conformance + optional member/count) → Task 1. ✓
- `lip cloud-verify` command with exit code → Task 2. ✓
- CI proof of the #4 attach → conformance path → Task 3. ✓
- Docs for the operator staging run → Task 3 Step 4. ✓
- Both share one core (CLI + CI test both call `runCloudVerification`) → Tasks 2-3. ✓
- Out of scope (real infra, auto-provision, real archive) → no task adds them; the test seeds a synthetic member. ✓

**Placeholder scan:** No TBD/TODO. Code steps are complete. Several steps carry "confirm against file" notes (CLI import path, `cli.test.ts` invocation style, admin-snapshot member path, `makeProgram` ids, freshly-enrolled available value) — concrete verification instructions with stated fallbacks, required because those exact identifiers/shapes weren't all read during planning; not placeholders for missing logic.

**Type consistency:** `runCloudVerification`/`CloudVerificationReport`/`CloudVerificationExpectations` defined in Task 1 are consumed by name in Tasks 2-3. `DiagnosticReport` is the confirmed return type of `runDoctor`/`runBaselineConformance` (diagnostics.ts:14,47,109). `IdentityReference` and `Balance.available` match `packages/protocol/src/member.ts`. The `{ baseUrl, apiKey }` connection shape matches `ConnectionOptions`.
