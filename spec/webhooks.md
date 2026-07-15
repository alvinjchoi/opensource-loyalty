# Webhook signature profile

LIP webhook receivers MUST verify the exact request body before parsing or
transforming JSON. Delivery uses these HTTP headers:

- `LIP-Webhook-Timestamp`: nonnegative Unix seconds
- `LIP-Webhook-Signature`: one or more comma-separated `v1=<base64url>` values

For signature version `v1`, the sender computes HMAC-SHA256 over the byte
sequence formed by the UTF-8 timestamp, one ASCII period, and the unmodified
request body:

```text
HMAC-SHA256(secret, timestamp + "." + raw_body)
```

The digest is encoded as unpadded base64url. A receiver MUST compare signatures
in constant time and MUST reject a timestamp outside its configured tolerance.
The recommended tolerance is 300 seconds.

Multiple `v1` values permit signing-key rotation. The receiver accepts the
delivery when any supported signature matches an active secret. Unknown
signature versions MUST be ignored.

Signature verification does not replace CloudEvent deduplication. Receivers
MUST still deduplicate deliveries using CloudEvent `source` plus `id`.
