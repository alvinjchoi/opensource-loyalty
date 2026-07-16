# Releasing npm packages

All eight `@loyalty-interchange/*` workspaces are configured as public packages
with provenance, repository metadata, Node.js requirements, and restricted
`dist` package contents.

## One-time npm setup

1. Create or claim the `@loyalty-interchange` npm organization.
2. For each package, configure npm trusted publishing for this GitHub
   repository and `.github/workflows/release.yml`.
3. Protect the GitHub `npm` environment with required reviewers.

No long-lived npm token is required. The workflow uses GitHub OIDC and npm
provenance.

## Verify without publishing

Run the **Publish npm packages** workflow manually with `dry_run` enabled, or:

```sh
npm ci
npm run verify
npm run spec:check
npm run test:packages
```

## Publish

Bump changed package versions and internal dependency ranges together, then
publish a GitHub release. The release workflow verifies the repository and
publishes packages in dependency order.

Publishing is intentionally not performed from a developer laptop. A failed
package stops the workflow to avoid silently producing a partially ordered
release.
