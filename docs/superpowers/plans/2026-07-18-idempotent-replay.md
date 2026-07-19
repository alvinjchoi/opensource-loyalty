# Idempotent Replay Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an idempotency-key retry that regenerates `request_id`/`occurred_at` return the original result (with the retry's `request_id`) instead of a false `409 idempotency_conflict` or an SDK validation error.

**Architecture:** The engine gains a payload-only idempotency fingerprint (v2) and matches stored entries against v2 OR the legacy v1 algorithm (dual-check migration). On replay it echoes the current request's `request_id`. The SDK needs no code change; the spec gains the normative rule. Ship as 0.1.1.

**Tech Stack:** TypeScript, Node ≥ 20.19, Vitest, npm workspaces.

## Global Constraints

- Node.js `>=20.19.0`; TypeScript; ESM (`.js` import specifiers in source).
- Immutability: never mutate stored engine state or a stored response in place — clone then modify.
- Inter-package `@loyalty-interchange/*` dependencies use exact pinned versions (`"0.1.0"`), not ranges.
- `npm run verify` (typecheck + tests + package inspection + build) must pass before any release step.
- Regenerated spec artifacts must stay in sync: `spec/openapi.yaml` and `docs-site/api-reference/openapi.yaml` are both written by `npm run generate`.

---

### Task 1: Engine — payload-only idempotency fingerprint (v2) + dual-check

**Files:**
- Modify: `packages/reference/src/engine.ts` (the `idempotencyFingerprint` function ~lines 191-201, and the `once()` method)
- Test: `tests/unit/engine.test.ts`

**Interfaces:**
- Produces: `idempotencyFingerprintV1(value: unknown): string` and `idempotencyFingerprintV2(value: unknown): string`, both exported from `packages/reference/src/engine.ts` (re-exported through the package index if the index uses `export *`).
- Consumes: existing module-private `fingerprint(value)` and `stableValue(value)`.

- [ ] **Step 1: Write the failing test** — a retry that changes only `occurred_at` (same key, same payload) must replay, not conflict. Add to `tests/unit/engine.test.ts` inside the accrual describe block:

```ts
it("replays idempotently when only occurred_at changes on retry", () => {
  const engine = enrolledEngine();
  const request = {
    context: makeContext("accrual-occurred-at-retry"),
    member_id: "member-001" as const,
    order: makeOrder()
  };
  const first = engine.postAccrual(request);

  const retry = structuredClone(request);
  retry.context.occurred_at = "2026-07-14T11:30:00.000Z"; // different event time

  const replay = engine.postAccrual(retry);
  expect(replay.entry.entry_id).toBe(first.entry.entry_id);
  expect(engine.getLedger()).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/engine.test.ts -t "only occurred_at changes"`
Expected: FAIL — throws `EngineError` `idempotency_conflict` (the old fingerprint includes `occurred_at`).

- [ ] **Step 3: Write minimal implementation** — replace the single `idempotencyFingerprint` function with exported v1 + v2:

```ts
/**
 * v1 idempotency fingerprint: strips only context.request_id.
 * Retained so entries stored before v2 still match a pinned replay.
 */
export function idempotencyFingerprintV1(value: unknown): string {
  if (!value || typeof value !== "object") {
    return fingerprint(value);
  }
  const request = value as Record<string, unknown>;
  if (!request.context || typeof request.context !== "object") {
    return fingerprint(value);
  }
  const { request_id: _requestId, ...context } = request.context as Record<string, unknown>;
  return fingerprint({ ...request, context });
}

/**
 * v2 idempotency fingerprint: strips the entire context envelope. The identity
 * of "the same logical request" is the business payload; envelope fields
 * (request_id, occurred_at, source, versions) do not affect it.
 */
export function idempotencyFingerprintV2(value: unknown): string {
  if (!value || typeof value !== "object") {
    return fingerprint(value);
  }
  const { context: _context, ...payload } = value as Record<string, unknown>;
  return fingerprint(payload);
}
```

Then update `once()` to store v2 and match either version:

```ts
  private once<T>(
    operation: string,
    context: RequestContext,
    request: unknown,
    run: () => T
  ): T {
    const key = `${context.source.system}|${operation}|${context.idempotency_key}`;
    const prior = this.idempotency.get(key);
    if (prior) {
      const matches =
        prior.fingerprint === idempotencyFingerprintV2(request) ||
        prior.fingerprint === idempotencyFingerprintV1(request);
      if (!matches) {
        throw new EngineError(
          "idempotency_conflict",
          "Idempotency key was already used with a different request"
        );
      }
      return clone(prior.response as T);
    }

    const response = run();
    this.idempotency.set(key, {
      fingerprint: idempotencyFingerprintV2(request),
      response: clone(response)
    });
    return response;
  }
```

- [ ] **Step 4: Add the dual-check regression test** — a pre-existing v1-stored entry must still match a pinned replay. Add to `tests/unit/engine.test.ts` (import the helper at the top: `import { LoyaltyEngine, EngineError, idempotencyFingerprintV1 } from "@loyalty-interchange/reference";` — extend the existing import):

```ts
it("still matches a legacy v1-fingerprinted entry via dual-check", () => {
  const engine = enrolledEngine();
  const request = {
    context: makeContext("legacy-v1-key"),
    member_id: "member-001" as const,
    order: makeOrder()
  };
  // Post once, then rewrite the stored fingerprint to the legacy v1 value to
  // simulate an entry written by a pre-0.1.1 engine.
  const first = engine.postAccrual(request);
  const snapshot = engine.exportState();
  const key = `${request.context.source.system}|accrual.post|${request.context.idempotency_key}`;
  const entry = snapshot.idempotency.find(([k]) => k === key)!;
  entry[1] = { ...entry[1], fingerprint: idempotencyFingerprintV1(request) };
  const rehydrated = new LoyaltyEngine(makeProgram(), { state: snapshot });

  const replay = rehydrated.postAccrual(structuredClone(request)); // pinned envelope
  expect(replay.entry.entry_id).toBe(first.entry.entry_id);
});
```

Note: confirm the `LoyaltyEngine` constructor's state option name and `exportState()` shape against `packages/reference/src/engine.ts` before running; adjust `{ state: snapshot }` / `exportState()` to the actual API (the snapshot type carries `idempotency: Array<[string, ReferenceIdempotencyRecord]>`, engine.ts:109). If hydration uses a different entry point (e.g. `engine.hydrate(snapshot)`), use that.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/engine.test.ts`
Expected: PASS — including the existing "posts an order once across exact retries and changed idempotency keys" and "detects reuse of an idempotency key with changed input" tests (changed-payload conflict still works because v2 differs on payload change).

- [ ] **Step 6: Commit**

```bash
git add packages/reference/src/engine.ts tests/unit/engine.test.ts
git commit -m "fix(engine): payload-only idempotency fingerprint with v1 dual-check

Retries that regenerate occurred_at no longer false-conflict; entries stored
under the legacy fingerprint still match a pinned replay."
```

---

### Task 2: Engine — echo the current request_id on replay

**Files:**
- Modify: `packages/reference/src/engine.ts` (add a helper; change the replay return in `once()`)
- Test: `tests/unit/engine.test.ts` (add one test; update the existing "enrolls, replays idempotently, and resolves an identity" test at ~line 497)

**Interfaces:**
- Consumes: `once()` from Task 1; `RequestContext` (already imported).
- Produces: module-private `withReplayedRequestId<T>(response, requestId)`.

- [ ] **Step 1: Write the failing test** — a retry with a fresh `request_id` replays the original result but carries the retry's `request_id`. Add to `tests/unit/engine.test.ts`:

```ts
it("echoes the retry's request_id on idempotent replay", () => {
  const engine = enrolledEngine();
  const request = {
    context: makeContext("accrual-request-id-echo"),
    member_id: "member-001" as const,
    order: makeOrder()
  };
  const first = engine.postAccrual(request);

  const retry = structuredClone(request);
  retry.context.request_id = "retry-request-id-echo";

  const replay = engine.postAccrual(retry);
  expect(replay.entry.entry_id).toBe(first.entry.entry_id);      // original result
  expect(replay.context.request_id).toBe("retry-request-id-echo"); // echoes the retry
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/engine.test.ts -t "echoes the retry's request_id"`
Expected: FAIL — `replay.context.request_id` is the original request's id, not `"retry-request-id-echo"`.

- [ ] **Step 3: Write minimal implementation** — add the helper near the other module functions in `engine.ts`:

```ts
/** Returns a clone of a response with its response-context request_id replaced. */
function withReplayedRequestId<T>(response: T, requestId: string): T {
  if (response && typeof response === "object" && "context" in response) {
    const ctx = (response as { context?: unknown }).context;
    if (ctx && typeof ctx === "object") {
      return {
        ...(response as object),
        context: { ...(ctx as object), request_id: requestId }
      } as T;
    }
  }
  return response;
}
```

Change the replay return line in `once()` from:

```ts
      return clone(prior.response as T);
```

to:

```ts
      return withReplayedRequestId(clone(prior.response as T), context.request_id);
```

- [ ] **Step 4: Update the existing enroll-replay test** — it asserted the replay equals the original verbatim; now the replay echoes the retry's request_id. In `tests/unit/engine.test.ts`, change the assertion in "enrolls, replays idempotently, and resolves an identity" (~line 510) from:

```ts
    expect(replay).toEqual(enrolled);
```

to:

```ts
    expect(replay).toEqual({
      ...enrolled,
      context: { ...enrolled.context, request_id: "retry-request-id" }
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/engine.test.ts`
Expected: PASS. Two other existing tests stay green without changes and only the enroll test (Step 4) needed updating:
- "posts an order once across exact retries" — uses `structuredClone` with an unchanged `request_id`, so its echoed id equals the original (`toEqual(first)` holds).
- "hydrates a complete snapshot..." — asserts only `entry_id` (not the full response), so the echoed `request_id` does not affect it.

- [ ] **Step 6: Commit**

```bash
git add packages/reference/src/engine.ts tests/unit/engine.test.ts
git commit -m "fix(engine): echo the retry request_id on idempotent replay"
```

---

### Task 3: SDK — full-stack retry regression test + guide docs

**Files:**
- Test: `tests/unit/sdk.test.ts`
- Modify: `docs/typescript-sdk.md` and `docs-site/guides/typescript-sdk.mdx`

**Interfaces:**
- Consumes: `LipClient` (`packages/sdk`), `startReferenceServer` (`packages/server`), `LoyaltyEngine` (`packages/reference`), `makeProgram`/`makeOrder` (`tests/fixtures.ts`) — all already imported in `tests/unit/sdk.test.ts`.

- [ ] **Step 1: Write the failing test** — a caller-level retry that reuses the idempotency key across two SDK calls (each generating a fresh `request_id`) succeeds and returns the original result. Model it on the existing enroll test in `tests/unit/sdk.test.ts` (the one near line 381 that passes `{ idempotencyKey: "sdk-enroll-key" }`). Use the real-server harness that file already sets up; reuse its client-construction pattern. The two calls must produce different `request_id`s (the default incrementing `idGenerator` does this):

```ts
it("replays a caller-level retry that reuses the idempotency key", async () => {
  const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
    apiKey: "sdk-retry-key"
  });
  try {
    const client = new LipClient({
      baseUrl: running.url,
      apiKey: "sdk-retry-key",
      source: { system: "sdk-retry-test" }
    });
    const enroll = { program_id: "demo-foodservice", identity: { type: "token", value: "retry-guest" } };
    const first = await client.members.enroll(enroll, { idempotencyKey: "retry-shared-key" });
    const second = await client.members.enroll(enroll, { idempotencyKey: "retry-shared-key" });
    expect(second.member.member_id).toBe(first.member.member_id); // no throw, original result
  } finally {
    await running.close();
  }
});
```

Confirm the exact `LipClient` constructor options and `members.enroll` signature against `tests/unit/sdk.test.ts`'s existing usage before running; match its `source`/`program_id`/identity shape (the file already enrolls successfully, so copy that call).

- [ ] **Step 2: Run test to verify it fails (against the pre-fix engine)**

Run: `git stash && npx vitest run tests/unit/sdk.test.ts -t "caller-level retry"; git stash pop`
Expected without the fix: FAIL — `LipValidationError: response request_id does not match the request` (or a 409). With Tasks 1-2 applied it should already PASS, so this step primarily documents intent; if it passes with the fix in place, that is the success condition.

- [ ] **Step 3: Run the test with the fix in place**

Run: `npx vitest run tests/unit/sdk.test.ts -t "caller-level retry"`
Expected: PASS.

- [ ] **Step 4: Add the idempotent-retry note to the SDK guide** — append to `docs/typescript-sdk.md` a section:

```markdown
## Idempotent retries

To retry a mutation safely, reuse the **same `idempotencyKey`** across attempts:

\`\`\`ts
const opts = { idempotencyKey: `${orderId}-accrue` };
await lip.accruals.post(request, opts);   // first attempt
await lip.accruals.post(request, opts);   // retry — returns the original result
\`\`\`

You do not need to pin `request_id` or `occurred_at`; the provider treats the
business payload as the request identity and echoes your retry's `request_id`
on the replayed response. Reusing a key with a **different** business payload
returns `409 idempotency_conflict`.
```

Mirror the same section into `docs-site/guides/typescript-sdk.mdx` (MDX: keep the fenced code block; no `<` / `{` in prose).

- [ ] **Step 5: Run tests + verify docs render locally**

Run: `npx vitest run tests/unit/sdk.test.ts`
Expected: PASS. (Mintlify render is validated on deploy; ensure the MDX has valid frontmatter already present in the file.)

- [ ] **Step 6: Commit**

```bash
git add tests/unit/sdk.test.ts docs/typescript-sdk.md docs-site/guides/typescript-sdk.mdx
git commit -m "test(sdk): cover caller-level idempotent retry; document the pattern"
```

---

### Task 4: Spec — normative rule + OpenAPI regen

**Files:**
- Modify: `spec/core.md` (the "Requests" / idempotency section, ~lines 15-23)
- Modify: `scripts/generate-spec.ts` (the `ResponseContext.request_id` description) — the generator is the source; `spec/openapi.yaml` and `docs-site/api-reference/openapi.yaml` are generated from it.

**Interfaces:**
- Consumes: `npm run generate` (writes both openapi copies + schemas + SDK client).

- [ ] **Step 1: Add the normative rule to `spec/core.md`** — after the existing idempotency paragraph (the one ending "...caller mistakenly changes the idempotency key."), insert:

```markdown
Idempotency compares the **business payload** of a request. The `context`
envelope — `request_id`, `occurred_at`, `source`, and the protocol/profile
versions — MUST NOT by itself cause a conflict: a retry that reuses the
idempotency key with the same business payload but a regenerated envelope MUST
return the original result. On such a replay, the response `context.request_id`
MUST reflect the replaying request (it echoes the retry's `request_id`);
`processed_at` reflects the original processing.
```

- [ ] **Step 2: Update the `ResponseContext.request_id` description in the generator** — in `scripts/generate-spec.ts`, find the `ResponseContext` `request_id` field description ("Opaque, stable identifier within the owning system.") and change it to:

```
Echoes the request's request_id. On an idempotent replay it echoes the replaying request's request_id, not the original.
```

(If the description text lives in a schema/TypeBox source rather than `generate-spec.ts`, grep for the exact string `Opaque, stable identifier within the owning system` across `packages/protocol/src` and `scripts/` and edit it at its source.)

- [ ] **Step 3: Regenerate and verify sync**

Run:
```bash
npm run generate
grep -c "Echoes the request's request_id" spec/openapi.yaml docs-site/api-reference/openapi.yaml
diff -q spec/openapi.yaml docs-site/api-reference/openapi.yaml
```
Expected: both files report `1`; `diff -q` prints nothing (in sync).

- [ ] **Step 4: Run the spec conformance check**

Run: `npm run spec:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spec/core.md scripts/generate-spec.ts spec/openapi.yaml docs-site/api-reference/openapi.yaml spec/schemas
git commit -m "spec: define idempotency comparison and replay request_id semantics"
```

---

### Task 5: Release prep — 0.1.1

**Files:**
- Modify: all `packages/*/package.json` + root `package.json` (version + inter-package deps)
- Modify: `CHANGELOG.md`, `docs-site/changelog.mdx`
- Modify: `package-lock.json` (via `npm install`)

- [ ] **Step 1: Bump versions and inter-package deps to 0.1.1** (preserves JSON formatting):

```bash
for f in packages/*/package.json package.json; do
  sed -i '' -E \
    -e 's/("version": )"0\.1\.0"/\1"0.1.1"/' \
    -e 's/("@loyalty-interchange\/[a-z-]+": )"0\.1\.0"/\1"0.1.1"/g' \
    "$f"
done
npm install
```

- [ ] **Step 2: Verify the bump is consistent**

Run:
```bash
grep -rl '"0.1.0"' packages/*/package.json package.json || echo "no 0.1.0 left"
node -e "console.log(require('./packages/sdk/package.json').version)"
```
Expected: "no 0.1.0 left"; version prints `0.1.1`.

- [ ] **Step 3: Add the CHANGELOG entry** — prepend under the title in `CHANGELOG.md`:

```markdown
## 0.1.1 - 2026-07-18

- Fix idempotent replay: a retry that reuses the idempotency key with a
  regenerated `request_id`/`occurred_at` now returns the original result
  (echoing the retry's `request_id`) instead of a false `409` or an SDK
  validation error. Entries stored before this release still match a pinned
  replay (dual-check).
```

- [ ] **Step 4: Add a changelog.mdx `<Update>` block** — insert above the `0.1.0` `<Update>` in `docs-site/changelog.mdx`:

```mdx
<Update label="0.1.1" description="2026-07-18">
  ## Idempotent replay fix

  A retry that reuses the idempotency key with a regenerated `request_id` /
  `occurred_at` now returns the original result — the provider compares the
  business payload and echoes the retry's `request_id` on the replayed
  response. Reusing a key with a different payload still returns
  `409 idempotency_conflict`. Idempotency entries stored before 0.1.1 keep
  working under a pinned replay (dual-check).
</Update>
```

- [ ] **Step 5: Full verification**

Run: `npm run verify`
Expected: 24 test files pass (plus the new tests), typecheck + build clean, package inspection lists all ten packages at `0.1.1`.

- [ ] **Step 6: Commit**

```bash
git add packages/*/package.json package.json package-lock.json CHANGELOG.md docs-site/changelog.mdx
git commit -m "chore: release 0.1.1 (idempotent replay fix)"
```

- [ ] **Step 7 (post-merge, manual): cut the release**

After the branch merges to `main`, publish by creating the GitHub release (the provenance workflow auto-publishes all ten packages to npm):

```bash
gh release create v0.1.1 --target main --title "v0.1.1" --notes "Idempotent replay fix (#9). See CHANGELOG."
```

Then verify: `curl -s https://registry.npmjs.org/@loyalty-interchange/reference | python3 -c "import json,sys;print(json.load(sys.stdin)['dist-tags'])"` shows `latest: 0.1.1`.

---

## Self-Review

**Spec coverage:**
- Payload-only fingerprint (v2) → Task 1. ✓
- Dual-check migration (v1 + v2) → Task 1 (once() lookup + regression test). ✓
- Echo current request_id on replay → Task 2. ✓
- `processed_at` kept original → Task 2 (helper only rewrites `request_id`). ✓
- SDK no code change + docs → Task 3. ✓
- Spec normative text + openapi regen → Task 4. ✓
- 0.1.1 release (versions, CHANGELOG, changelog.mdx) → Task 5. ✓
- Out of scope (SDK replay helper, fingerprint_version field, processed_at change) → not present in any task. ✓

**Placeholder scan:** No TBD/TODO. Each code step shows full code. Two steps ask the implementer to confirm an exact API name against the source (engine hydration entry point in Task 1 Step 4; `LipClient`/`enroll` shape in Task 3 Step 1) — these are verification instructions with a concrete fallback, not placeholders.

**Type consistency:** `idempotencyFingerprintV1`/`idempotencyFingerprintV2` defined in Task 1 are used by name in Task 1's `once()` and Task 1's regression test. `withReplayedRequestId` defined and used in Task 2. `ReferenceIdempotencyRecord` shape (`{ fingerprint, response }`) matches engine.ts:55/109. Response `.context.request_id` path matches `responseContext()` output.
