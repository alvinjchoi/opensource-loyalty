# Cloud staging conformance: design (issue #8)

Follows #4 (the regional attach adapter), which this uses to reach a
Cloud-provisioned tenant.

## Problem

Before a live cutover, an operator must prove that a Cloud-provisioned tenant
(reached via the #4 attach flow), not just the in-process local spike runtime,
passes the CLI conformance suite: `lip doctor` (discovery/health/auth/
capabilities) and `lip test` (baseline HTTP conformance), plus a member-count
and known-member check after importing an archive. Today there is no automated
proof of the full Cloud attach → conformance path, and no single operator
command that runs the whole verification and records a report.

## Decision

Deliver **both**: an automated in-repo harness that proves the attach →
conformance path in CI, and a new operator-facing `lip cloud-verify` command
that runs the same verification against a real staging URL and records a
report. Both share one core so the automated path and the operator path can
never drift.

## Design

### 1. Core — `runCloudVerification` (new `packages/cli/src/cloud-verify.ts`)

```ts
export interface CloudVerificationExpectations {
  programId?: string;
  expectMember?: { identity: IdentityReference; available: number };
  expectMembers?: number;
}
export interface CloudVerificationReport {
  doctor: DiagnosticReport;
  conformance: ConformanceReport;          // from runBaselineConformance
  knownMember?: { ok: boolean; identity: IdentityReference; expected: number; actual: number | null };
  memberCount?: { ok: boolean; expected: number; actual: number | null };
  ok: boolean;                             // all present sections ok
}
export function runCloudVerification(
  connection: { baseUrl: string; apiKey: string },
  expectations?: CloudVerificationExpectations
): Promise<CloudVerificationReport>;
```

- Always runs `runDoctor(connection)` and `runBaselineConformance(connection)`
  (both already exported from `packages/cli/src/diagnostics.ts`).
- `expectMember`: looks up the member via `POST /lip/v1/members/lookup`
  (`{ context, program_id, identity }`) and asserts the primary account's
  `available` equals `expectMember.available`.
- `expectMembers`: reads `GET /admin/api/v1/snapshot` (non-normative admin
  surface; the operator key carries `admin:read`) and asserts the total member
  count equals `expectMembers`. This section is clearly labelled non-normative.
- `ok` is the AND of every section that ran.

### 2. CLI — `lip cloud-verify <url>` (`packages/cli/src/cli.ts`)

Options: `--api-key <key>`, `--program-id <id>`,
`--expect-member <identity>:<available>` (identity parsed as
`type:issuer:value` or a token; documented format),
`--expect-members <n>`. It builds the connection (reusing the existing
`connection()` helper), calls `runCloudVerification`, prints a formatted,
recordable report (reuse `formatReport` for the doctor section; add compact
lines for the member sections), and sets a non-zero exit code when
`report.ok` is false — so it gates a cutover in scripts.

### 3. CI integration test — `tests/conformance/cloud-attach-conformance.test.ts`

Proves the whole Cloud attach → conformance path with ephemeral local servers:

1. Start a real reference LIP host (`startReferenceServer` on a program with a
   known member seeded to a known balance).
2. Create a Cloud environment through the control plane and **attach** the host
   (the #4 `attachEnvironment` flow), yielding the environment's `api_url`.
3. Call `runCloudVerification({ baseUrl: api_url, apiKey }, { expectMember, expectMembers })`.
4. Assert `report.ok`, `report.doctor.ok`, `report.conformance.ok`, and the
   member sections.

Lives under top-level `tests/` (which may import any workspace), so the test
can use both the control plane (`apps/cloud`) and the CLI verification
(`packages/cli`) without creating an `apps/cloud → packages/cli` dependency.

### 4. Docs — `docs/cloud.md`

Add a "Verifying a staging tenant" section: after `attach`, run
`lip cloud-verify <api_url> --api-key ... --expect-member <identity>:<available> [--expect-members N]`
and record the printed report; note that import counts also come from
`lip state import`'s own output, and that `--expect-members` uses the
non-normative admin snapshot.

## Testing

- Unit (`packages/cli` test): `runCloudVerification` against a stub/real
  reference server — happy path `ok: true`; a wrong `expectMember.available` →
  `knownMember.ok: false` and overall `ok: false`; a wrong `expectMembers` →
  `memberCount.ok: false`; a doctor/conformance failure propagates to `ok:
  false`.
- Integration (`tests/conformance/...`): the full attach → verify path above.
- CLI exit code: `report.ok === false` yields a non-zero process exit.

## Acceptance criteria

- `lip cloud-verify <url> --api-key ...` runs doctor + baseline conformance and,
  when asked, verifies a known member and the member count, printing a report
  and exiting non-zero on any failure.
- An automated test proves a Cloud environment attached via #4 passes the full
  verification.
- `npm run verify` green.

## Out of scope (follow-ups)

- Provisioning real staging infrastructure (the operator does that per their
  private runbook; this harness uses ephemeral local servers).
- Auto-provisioning (still a future #4 follow-up).
- Importing a real production archive in the automated test (it seeds a
  synthetic known member instead — no PII).
