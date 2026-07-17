# Sakura Japan cross-repository handoff

Updated: July 16, 2026

## Repository ownership

To avoid collisions while both repositories have uncommitted work:

- The loyalty agent owns `craveup-loyalty` on
  `feat/customer-identity-contract`.
- The Sakura agent owns `sakura-japan` and all Expo, BFF, payment, and mobile
  changes.
- The loyalty agent must not edit `sakura-japan` unless ownership is explicitly
  transferred again.

The loyalty agent briefly started a ten-location implementation in Sakura, then
removed every one of those edits after this ownership boundary was established.
No location-related changes from that attempt remain in the Sakura working
tree.

## Shared priority: customer identity contract

Implement the provider-neutral contract before replacing Sakura authentication.
The boundary should support Clerk first while remaining compatible with Auth0
or another standards-compliant OIDC provider.

The contract must define:

1. JWT issuer, audience, subject, tenant, expiry, and verified-contact claims.
2. Stable CraveUp customer ids independent of the identity provider.
3. Mapping from `{tenant_id, issuer, subject}` to one customer and one or more
   program-scoped LIP member ids.
4. Session introspection, profile, consent, export, and account-deletion APIs.
5. Identity linking, duplicate resolution, provider outages, token rejection,
   and partial-failure behavior.
6. Loyalty enrollment and deletion semantics without deleting financially
   retained ledger history.
7. A provider-neutral server adapter plus Clerk implementation.
8. Contract tests shared by every provider implementation.

Sakura should consume the resulting SDK instead of extending its current local
password and JSON-session implementation.

## Requested Sakura demo: ten locations

The product owner requested ten selectable demo locations. This belongs to the
Sakura agent. Recommended implementation:

- Add a bundled ten-location catalog and persist the selected location.
- Add a location picker reachable from Home, Menu, Cart, and Checkout.
- Clear or explicitly migrate the cart when the location changes.
- Keep Sakura Rewards brand-wide across all locations.
- Include `locationId` in preview, order, Crave prepare, and finalization
  requests.
- Validate location ids in the BFF and write the selected location into the LIP
  order scope and Sakura order record.
- Continue using the bundled demo menu for locations without a mapped Crave
  location.
- Support an environment-provided map from Sakura location ids to real Crave
  location ids instead of treating one `EXPO_PUBLIC_CRAVEUP_LOCATION_ID` as all
  ten stores.
- Add tests for the ten-location catalog, invalid location rejection,
  cross-location loyalty behavior, and location-preserving order history.

Do not represent fictional demo locations as live stores. Clearly label the
catalog as demo data until each location has a real Crave location id and
storefront readiness check.

## Cross-repository release gate

After the loyalty contract and SDK exist:

1. Sakura integrates Clerk using a separate consumer instance.
2. Sakura removes custom password/session endpoints and stores native tokens in
   secure storage.
3. Both repositories run the same identity-to-member contract tests.
4. Sakura runs mobile E2E for sign-in, enrollment, wallet, location selection,
   checkout, logout/login, and deletion.
5. Stripe and Crave storefront sandbox tests pass before live payments.

