# Security policy

Do not report security vulnerabilities in a public issue. Contact the repository
maintainers privately with the affected version, reproduction steps, and impact.

Implementations must use TLS, authenticate every non-health endpoint, avoid
placing direct customer identifiers in logs or idempotency keys, and encrypt
sensitive identity claims at rest. The protocol permits identity references so
that transaction processors do not need to receive raw email addresses or phone
numbers.
