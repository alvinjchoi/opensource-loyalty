# AI prompts

Install LIP agent skills first:

```bash
npx skills add .
```

Enable the MCP server via [`mcp.json`](../mcp.json). Then use these prompts with
your agent (Cursor, Claude Code, Codex, etc.). Attach [`llms.txt`](../llms.txt)
or enable the `lip` MCP server for accurate spec context.

Before any prompt: start the local sandbox (`npm start` or `npm run lip -- serve`)
and confirm with `npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key`.

## Bootstrap a new integration

```text
I am integrating Loyalty Interchange Protocol (LIP) into a restaurant ordering
app. Read llms.txt, spec/lifecycle.md, and examples/typescript/full-lifecycle.ts
first.

Requirements:
- The mobile/web app must NOT hold the LIP merchant API key.
- Add a backend-for-frontend that enrolls members, previews checkout with
  orders/evaluate, and runs reserve → pay → accrue → capture with reverse on
  failure.
- Use stable idempotency keys derived from order_id for every mutation.
- Use @loyalty-interchange/sdk LipClient, not raw fetch.

Start by scaffolding the BFF routes and SDK client, then wire the checkout flow.
Run npm run lip -- test when done.
```

## Add earn/redeem preview to a cart screen

```text
The cart currently computes points client-side. Replace that with an engine-
backed preview.

Read docs/typescript-sdk.md (orders.evaluate) and spec/profiles/foodservice.md.

Add a BFF endpoint POST /orders/preview that:
1. Prices the draft order server-side (minor units, reconciled totals).
2. Calls lip.orders.evaluate with the draft FoodserviceOrder.
3. Returns estimated_accrual.amount, balances, and rewards[].status with
   unavailable_reasons.

Update the cart UI to call this endpoint when the user is signed in and show
the engine's earn estimate and which rewards are available — do not hardcode
points thresholds.
```

## Implement webhook delivery receiver

```text
The LIP reference server can push signed CloudEvents. Implement a webhook
receiver in my backend.

Read spec/webhooks.md, docs/webhook-delivery.md, and the SDK verifyWebhook
docs in docs/typescript-sdk.md.

Requirements:
- POST /loyalty/webhook accepts the raw body (verify before JSON.parse).
- Verify LIP-Webhook-Timestamp and LIP-Webhook-Signature: v1=... using
  verifyWebhook from @loyalty-interchange/sdk.
- Deduplicate on CloudEvent source + id.
- Log or store received events for debugging.
- Reject forged signatures with 401.

Show how to start lip serve with LIP_WEBHOOK_URL and LIP_WEBHOOK_SECRET set.
```

## Add refund with points clawback

```text
Implement a full refund flow that puts loyalty state back the way it was.

Read spec/lifecycle.md (adjustments and reversals) and
examples/typescript/full-lifecycle.ts (adjustOrder).

For an order that earned points and optionally redeemed a reward:
1. If a redemption was captured, call redemptions/reverse (restores burned points).
2. Call orders/adjust with type full_refund and negative eligible_spend_delta
   (claws back earned points).
3. Use idempotency keys derived from the order id.
4. Make the refund endpoint idempotent — a second call returns the same result.

Add tests that assert the member balance after refund matches expectations.
```

## Validate a FoodserviceOrder payload

```text
I have a JSON order export from our POS. Validate it against LIP before we
send it to orders/evaluate.

Read spec/profiles/foodservice.md and spec/schemas/FoodserviceOrder.json.

Check:
- scope.program_id, brand_id, merchant_id, location_id are present
- line subtotals, discounts, tax, and order totals reconcile
- tenders sum to totals.total for paid orders
- loyalty_eligible flags and excluded categories/tags are correct

Use: npm run lip -- validate ./my-order.json -s FoodserviceOrder
Fix any validation errors and explain each fix.
```

## Run conformance and fix failures

```text
My LIP deployment is failing conformance checks.

Run:
  npm run lip -- doctor <url> --api-key <key>
  npm run lip -- test <url> --api-key <key>

Read the failure output, map each check to the relevant spec section, and fix
the implementation. Do not weaken the tests — fix the provider or adapter.
```

## Custom program for a brand

```text
Create a JSON program definition for a QSR brand: 1 point per $1 spent,
50 points = $5 off any order, 365-day point expiration with 30- and 7-day
warnings, brand-funded rewards.

Read packages/server/src/demo.ts for the demo program shape and
spec/schemas/ProgramCatalog.json for required fields.

Save as my-program.json and show the lip serve --program command to boot with
it. Add a unit test or curl example that enrolls a member and accrues on a
sample order.
```

## End-to-end test suite

```text
Add an end-to-end test suite that boots the real LIP server and my BFF as child
processes, then drives the full customer lifecycle over HTTP.

Cover: signup/enroll, guest order (no accrual), member order (earn math),
insufficient-balance redemption rejection, successful redemption, refund with
points clawback, webhook signature verification, and idempotent order retry
(same orderKey must not double-accrue).

Use Node's built-in test runner and isolated temp databases. A companion BFF's
end-to-end test suite is a good reference pattern.
```
