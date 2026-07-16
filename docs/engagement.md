# Analytics, CRM export, and messaging

The reference Admin API includes non-normative engagement tools built on the
portable member, ledger, reservation, issued-reward, and campaign models.

## Analytics

`GET /admin/api/v1/analytics` returns:

- active and marketing-consented member counts
- outstanding and reserved balances by loyalty unit
- daily earned, redeemed, and expired amounts by unit
- reservation outcomes by reward
- campaign run, targeting, and issuance totals

These aggregates are calculated from current engine state and do not alter LIP
protocol routes.

## CRM member export

`GET /admin/api/v1/exports/members` returns CSV by default. Add `format=json`
for JSON. Exports include member status, join date, tier, email, phone, consent,
and available balances.

Unconsented members are excluded by default. An authenticated operator can add
`include_unconsented=true` for an operational export. CSV values that begin
with spreadsheet formula characters are escaped to prevent formula injection.

## Messaging connectors

The bundled `webhook` adapter sends one signed JSON message per eligible
segment member. Connector secrets are write-only in Admin snapshots.

Headers:

```text
X-LIP-Message-Id: message_...
X-LIP-Message-Timestamp: 2026-07-16T...
X-LIP-Message-Signature: v1=<HMAC-SHA256>
```

The signature input is `<timestamp>.<raw-body>`.

Message jobs require an idempotency key, connector, segment, template id,
content object, and purpose. Marketing jobs skip members unless
`member.attributes.marketing_consent === true`; transactional jobs do not use
marketing consent. Delivery state, attempts, bounded exponential backoff, and
the most recent error are persisted across restarts.

Custom providers implement `MessagingConnectorAdapter` and are registered when
constructing `EngagementService`. This keeps provider-specific SDKs and
credentials out of the protocol and reference engine.
