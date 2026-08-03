# Contributing to LIP

Loyalty Interchange Protocol is developed in the open. Changes to normative
behavior start as an issue or proposal and must include conformance fixtures.

## Local development

```sh
npm install
npm run verify
```

Configuration is read from the process environment. Nothing in this repo reads a
`.env` file implicitly, so export the values yourself. Every value in
`.env.example` is a documented local-development default:

```sh
cp .env.example .env
set -a; . ./.env; set +a
npm run dev
```

`.env` is gitignored. The PostgreSQL storage suite and the cloud control plane
need a database; `docker compose up -d postgres` provides one.

<details>
<summary>Crave team members: pull shared values from Infisical instead</summary>

The repo is linked to the `CraveUp Loyalty` Infisical project, so no `.env` file
is needed:

```sh
brew install infisical/get-cli/infisical   # once
infisical login                            # once
infisical run --env=dev -- npm run dev
```

`infisical secrets --env=dev` lists what you get. The `dev` environment holds
local-development values only; production credentials live in the deployment
platform, not here.

</details>

## Compatibility policy

- Patch releases clarify documentation and fix implementation defects.
- Minor releases may add optional fields, operations, event types, or profiles.
- Major releases may change required fields or existing semantics.
- Implementations must ignore unknown optional object properties unless a schema
  explicitly prohibits them.
- A normative change is incomplete until the JSON Schema, OpenAPI document,
  examples, and conformance tests agree.

## Design principles

1. Model the transaction lifecycle, not a vendor's product surface.
2. Keep financial values exact and make funding ownership explicit.
3. Make retries safe through idempotency.
4. Separate the cross-vertical core from profile-specific semantics.
5. Prefer existing Internet standards over custom transport conventions.
