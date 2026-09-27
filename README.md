# DashCommerce — v3ck-com fork

A development fork of [emdashCommerce/dashcommerce](https://github.com/emdashCommerce/dashcommerce), adding **Paystack as a normal payment gateway alongside Stripe**, personalised products, and recoverable shared commerce workflows on **EmDash 0.41.0**. MIT; upstream attribution and history are retained.

**Test and live code paths are implemented; production activation is not approved or certified.** Verification uses disposable databases and intercepted synthetic provider traffic, including tests of live-mode code. No actual payment, real email, deployment or existing-store migration is performed. See [readiness and limitations](docs/PRODUCTION-READINESS.md), [operator guidance](docs/OPERATOR_CHECKLIST.md) and [verification evidence](docs/FORK-VERIFICATION.md).

## Implemented

- Normal `paymentProvider=paystack`, explicit test/live selection and separately encrypted credentials. The legacy `paystack-test` alias remains test-only. Persisted transactions keep their original environment after settings change.
- Hosted checkout, fixed-origin initialize/verify/refund transport, bounded responses and exact-byte authenticated webhooks. Provider reference, amount, currency, environment and customer are independently checked; redirects are not payment proof.
- Shared authoritative pricing: current product/variant prices and weights, personalisation, shipping zones, flat/free/pickup/weight rates, flat or table tax with product tax classes, and existing coupon rules. Discounts are allocated deterministically across eligible lines and preserved on order items.
- Live coupon quota claims before initialization; same-record CAS accounting for usage, customer limits and replay identity. Test transactions do not consume live coupon quotas. Lost capacity holds a paid order for review rather than silently granting fulfilment.
- Shared Stripe/Paystack order finalization, deterministic order/item identities, recoverable effects and final markers committed last. Ordinary orders are not automatically held merely because Paystack was used.
- Separate test/live inventory projections, atomic reservations/consumption, explicit partial restocking, and guarded CMS stock adoption through the private operations page.
- Durable full/partial refunds, monetary and per-item restock reservations, pending/uncertain states, provider-ID reconciliation and independently verified Paystack dashboard refund synchronization. An ambiguous financial POST is never blindly repeated.
- Native private payment operations, bounded periodic recovery, truthful receipts/refund states and purchased-cart cleanup that preserves newer cart edits.
- Durable receipt/refund outbox. Actual delivery requires explicit configuration and native EmDash email; test messages remain suppressed. Uncertain email handoffs are not automatically resent.

Paystack does **not** substitute for Stripe Elements, Stripe Tax, Connect/vendor splits or subscriptions. Those remain separate Stripe-specific capabilities. Yoco/Resend activation and newsletters are outside this implementation.

## Supported development target

- EmDash **exactly 0.41.0**; other versions fail closed. Native response/body/storage contracts, **no dependency patches**.
- Astro **7.3.5**, standalone Node and SQLite; Node 22.16+ and Bun 1.4.2.
- Trusted starter middleware owns cart cookies, method/origin checks and private caching. HTTPS uses a Secure `__Host-` cookie; HTTP is for loopback development.
- Paystack currency allowlist: GHS, KES, NGN, USD and ZAR, subject to the merchant account's actual capabilities. Integrated financial fixtures exercise ZAR.
- Workers/PostgreSQL and real provider behavior are not certified by this fork. Existing broader Stripe features do not inherit certification from the shared-order tests.

## Run the checks

Provider HTTP/DNS and hosted payment pages are intercepted locally. No provider credentials are needed.

```sh
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build
bun run test:host
bun run test:http
bunx playwright install chromium
bun run test:browser
bun audit --production
```

CI runs the same gates on Node 22 and 24. Browser tests use real application cart, checkout, verification and order endpoints; only the external provider is simulated. Additional UI-state tests intentionally stub authority responses.

## Configure a fresh local store

Use a **new disposable database** first. Seed/bootstrap may replace matching collection definitions; never run it against an existing shop without an audited migration and backup.

1. Follow the [starter instructions](packages/starter/README.md) and complete native EmDash owner setup.
2. Configure a persistent private `EMDASH_ENCRYPTION_KEY` through supported EmDash configuration. Keep keys/environment files out of Git.
3. In DashCommerce settings choose **Paystack**, **test** mode and **hosted** checkout; enter the test secret. Secret settings are encrypted at rest and admin responses expose only presence/hints. Live credentials and activation are separate, explicit decisions.
4. Configure the existing product, variant, stock, shipping, tax and coupon settings normally. Fixture values are examples, not business-policy defaults imposed by this fork.
5. Set the canonical site URL. Callbacks require HTTPS except explicit loopback development. Public webhook ingress requires its own deployment approval.

Webhook: `POST /_emdash/api/plugins/dashcommerce/checkout/paystack` (legacy `/checkout/paystack-webhook` remains supported).

Receipt: `GET /_emdash/api/plugins/dashcommerce/orders/by-draft?id=<private-draft-capability>`.

Keep receipt capabilities out of analytics and referrer logs. Never infer payment from URL parameters.

### Personalisation

A product's `customisation_definition` JSON supports up to four bounded text fields:

```json
{"fields":[{"key":"recipient_name","required":true,"maxLength":40}]}
```

Values are trimmed, bounded (maximum 120 characters per field), escaped, repriced/revalidated at checkout and retained on order items. Different options remain distinct cart lines. Conditional option builders, uploads and paid extras are not implemented.

## Important boundaries

- Test orders can exercise normal processing states, but remain clearly labelled simulations: no live stock, revenue/coupon accounting, digital grants or email delivery.
- Nonempty per-shipping-class flat-rate overrides are not priced: their mixed-class aggregation semantics are undefined. Such methods are unavailable rather than silently falling back to their base rate.
- Zero-total/free-order checkout is not implemented by the Paystack payment gateway.
- Inventory projections, not simultaneous CMS decrements, govern operational stock. CMS stock changes require deliberate preview/adoption. Test and live adoption are separate.
- Unknown refund POST outcomes require independently verified provider information; an absent provider ID is not permission to resend or release the financial reservation.
- Pre-journal/unmarked legacy financial records and old inventory effects require explicit reconciliation. There is no automatic migration from another shop or earlier experiments. Legacy automatic refund restocking is rejected without a recorded inventory reservation.
- Large legacy coupon histories fail closed when bounded hydration is insufficient. High-volume partitioning, retention/erasure, deployment monitoring and backup/restore procedures need deployment-specific validation.

The fork is source-only: npm release/upstream synchronization workflows are removed and the core package is private to prevent accidental publication under the upstream package name. Existing storefronts, services, DNS and customer data are not modified by these checks.
