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

Use Clerk directly for Sakura customer authentication. The shared loyalty
boundary supports Clerk, Auth0, or another standards-compliant OIDC provider
without wrapping the provider's sign-up, sign-in, recovery, or session APIs.

The contract must define:

1. JWT issuer, audience, subject, expiry, authorized party, and
   verified-contact claims. Tenant scope comes from trusted BFF configuration,
   not an untrusted token choice.
2. Stable CraveUp customer ids independent of the identity provider.
3. Mapping from `{tenant_id, issuer, subject}` to one customer and one or more
   program-scoped LIP member ids.
4. Identity linking, duplicate resolution, provider outages, token rejection,
   and partial-failure behavior.
5. Loyalty enrollment and deletion semantics without deleting financially
   retained ledger history.
6. Contract tests for OIDC validation and identity-to-member mapping.

`@loyalty-interchange/identity` now supplies this thin server-side contract.
Sakura should use Clerk's native Expo SDK, pass its access token to the BFF, and
use this package there instead of extending the current password and
JSON-session implementation.

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

After the identity package is published or linked into Sakura:

1. Sakura integrates Clerk using a separate consumer instance.
2. Sakura removes custom password/session endpoints and stores native tokens in
   secure storage.
3. Sakura adds BFF tests proving Clerk tokens resolve to the expected stable
   customer and member ids.
4. Sakura runs mobile E2E for sign-in, enrollment, wallet, location selection,
   checkout, logout/login, and deletion.
5. Stripe and Crave storefront sandbox tests pass before live payments.

