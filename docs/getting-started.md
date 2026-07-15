# Getting started

This is the shortest path from a clean clone to a working loyalty request.

## 1. Start the sandbox

```sh
npm install
npm start
```

Keep that terminal open. The local sandbox runs at:

```text
http://127.0.0.1:3210
```

Use this development API key:

```text
lip-dev-key
```

Open the dashboard:

```text
http://127.0.0.1:3210/admin/
```

## 2. Check that it works

In a second terminal:

```sh
curl http://127.0.0.1:3210/health
```

Expected response:

```json
{
  "status": "ok",
  "protocol_version": "1.0",
  "profile": "foodservice/1.0"
}
```

Then check authenticated capabilities:

```sh
curl http://127.0.0.1:3210/lip/v1/capabilities \
  -H 'Authorization: Bearer lip-dev-key'
```

## 3. Run the full loyalty flow

```sh
npm run example:sdk
```

This runs the happy path end to end:

```text
enroll member
  -> evaluate order
  -> post accrual
  -> reserve reward
  -> capture reward
  -> reverse reward
  -> adjust refunded order
```

## 4. Use the SDK in an app

```ts
import { LipClient } from "@loyalty-interchange/sdk";

const lip = new LipClient({
  baseUrl: "http://127.0.0.1:3210",
  apiKey: "lip-dev-key",
  source: { system: "my-ordering-app", instance: "local" }
});

const capabilities = await lip.capabilities();
```

The SDK creates request ids, timestamps, idempotency keys, and protocol context
for application calls.

## 5. Know where to go next

- [API endpoints](api-endpoints.md): current HTTP routes and curl examples.
- [TypeScript SDK](typescript-sdk.md): SDK operations, errors, money helpers,
  order builder, and webhook verification.
- [Five-minute quickstart](quickstart.md): more CLI checks, validation, Docker,
  reset, and seed controls.
- [Reference platform](reference-platform.md): server, Admin dashboard, storage,
  and non-normative boundaries.

You should not need the normative specification for the first successful local
request. Use `spec/` when you are implementing a provider, writing an adapter,
or validating conformance.
