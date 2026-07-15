# Standards and prior art

LIP composes with established standards where they already solve the problem:

- [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.2.html) defines the HTTP API document.
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12) defines message structure.
- [CloudEvents 1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) defines event envelopes.
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) defines HTTP problem details.
- [BCP 14](https://www.rfc-editor.org/info/bcp14) defines normative requirement language.

Adjacent loyalty and commerce work informed the scope but is not required by LIP:

- [Conexxus Loyalty Standard](https://www.conexxus.org/ourwork/loyalty-standard)
- [The Coupon Bureau Universal Coupons](https://www.thecouponbureau.org/universalcoupons)
- [Schema.org MemberProgram](https://schema.org/MemberProgram)
- [Toast loyalty integration model](https://doc.toasttab.com/doc/devguide/apiLoyaltyProgramIntegrationOverview.html)
- [ARTS retail data model](https://www.omg.org/retail-depository/arts-odm-73/hmcontent.htm)

These systems address useful slices of the problem. LIP's contribution is a
vendor-neutral transaction lifecycle with portable restaurant order semantics,
idempotent financial behavior, and explicit franchise funding ownership.
