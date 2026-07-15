# Loyalty Interchange Protocol docs

LIP is an open, vendor-neutral transaction protocol for loyalty. The current
working draft is foodservice-first: it focuses on member resolution, restaurant
order evaluation, accrual, redemption reservation and capture, reversals,
refund adjustments, program catalogs, balances, tiers, and ledger history.

Use this directory for implementation guides and product-facing documentation.
Use `spec/` for the normative protocol contract.

## Quick start

```sh
npm install
npm start
```

Open `http://127.0.0.1:3210/admin/` and sign in with `lip-dev-key`.

The local server exposes:

- Protocol API: `http://127.0.0.1:3210/lip/v1`
- Health: `http://127.0.0.1:3210/health`
- Discovery: `http://127.0.0.1:3210/.well-known/lip`
- Admin dashboard: `http://127.0.0.1:3210/admin/`

Then verify the environment:

```sh
npm run lip -- doctor
npm run lip -- test
```

## Getting started

- [Getting started](getting-started.md): the shortest path from clean clone to a
  working loyalty request.
- [Five-minute quickstart](quickstart.md): start the reference platform,
  validate an order, enroll a member, and run conformance checks.
- [TypeScript SDK](typescript-sdk.md): use the idiomatic client, exact-money
  helpers, order builder, typed errors, and webhook verification.
- [Reference platform](reference-platform.md): understand the local server,
  durable SQLite state, Admin dashboard, and non-normative boundaries.
- [Punchh compatibility](punchh-compatibility.md): map a restaurant loyalty
  migration against current LIP coverage and adapter gaps.

## API reference

- [API endpoints](api-endpoints.md): current HTTP operations, auth, errors,
  retry behavior, and local curl examples.
- [OpenAPI contract](../spec/openapi.yaml): generated OpenAPI 3.1 binding.
- [Generated JSON Schemas](../spec/schemas): generated payload schemas.
- [SDK lifecycle example](../examples/typescript/full-lifecycle.ts): complete
  enroll, evaluate, earn, reserve, capture, reverse, and refund flow.

## Normative specification

- [Spec overview](../spec/README.md)
- [Core protocol](../spec/core.md)
- [Lifecycle rules](../spec/lifecycle.md)
- [Account experience](../spec/account-experience.md)
- [Foodservice profile](../spec/profiles/foodservice.md)
- [Webhooks](../spec/webhooks.md)
- [References](../spec/references.md)

When docs and spec disagree, treat `spec/` as canonical.

## What to build next

The docs should be organized like a developer portal, not a loose folder of
Markdown files. The next high-value guides are:

- Add loyalty to a restaurant checkout
- Configure a points-and-tiers program
- Configure a visit or stamp-card program
- Configure wallet credit and paid membership programs
- Handle refunds, voids, duplicate checks, and offline queues
- Operate webhooks in production
- Understand error codes and retry rules
- Publish and version provider conformance reports

See [API and documentation gap analysis](api-docs-gap-analysis.md) for the
current comparison against OpenLoyalty and Open WebUI documentation patterns.

## For agents and maintainers

Start with these files before changing behavior:

- `PLAN.md`: roadmap, milestones, and explicit product constraints
- `spec/openapi.yaml`: generated HTTP binding
- `packages/protocol/src`: source of generated schemas and types
- `packages/server/src/server.ts`: reference HTTP routes
- `packages/sdk/src/client.ts`: idiomatic TypeScript client
- `apps/admin/src/App.tsx`: reference Admin dashboard

Useful commands:

```sh
npm run generate
npm run typecheck
npm run test
npm run quickstart
```
