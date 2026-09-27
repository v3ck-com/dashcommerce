# DashCommerce — v3ck-com fork

A development fork of [emdashCommerce/dashcommerce](https://github.com/emdashCommerce/dashcommerce), adding **Paystack test checkout and personalised products** on **EmDash 0.41.0**.

**Test-mode software, not a production payment release.** No live Paystack payments, automatic fulfilment, real email, or real-order migration is enabled. This repository contains synthetic fixtures, not an existing shop or its customer data. MIT; upstream attribution and history are retained.

## Supported development target

- EmDash **exactly 0.41.0**; other versions fail closed.
- Astro **7.3.5**, standalone Node, SQLite. Node 22.16+ and Bun 1.4.2.
- Native EmDash `pluginResponse()` and bounded raw-byte webhook contracts. **No EmDash dependency patches.**
- Trusted starter middleware owns cart cookies, method/origin checks and private caching. HTTPS uses a Secure `__Host-` cookie; HTTP is for loopback development.
- Cloudflare Workers and PostgreSQL are **not certified** by this fork. Existing Stripe features remain legacy code, not newly certified live-payment functionality.

## Implemented

- Explicit `paystack-test` provider; unknown providers fail rather than falling back to Stripe. Only `sk_test_` credentials and ZAR are accepted.
- Fixed-origin Paystack initialize/verify transport, bounded responses, timeouts, redirect refusal, SHA-512 webhook verification, and independently verified transaction identity/amount/currency/test domain/email.
- Server-priced checkout with complete shipping/billing addresses; current stock, personalisation, supported flat/free shipping and flat tax are revalidated.
- Durable checkout identity, one initialization claim, retry-safe references, recoverable order/item/payment writes, and concurrent callback/webhook handling using EmDash revision CAS.
- CAS stock reservations and idempotent consumption. A late payment with unavailable inventory is held for manual review, never silently re-reserved.
- Merchant-defined bounded text personalisation, separate cart lines for distinct options, and propagation to orders and receipts.
- Browser checkout, authoritative return polling, pending/failure/review states, uncertainty recovery link, and conditional purchased-cart cleanup that preserves newer edits.
- Durable **preview-only** receipt outbox. No Resend delivery or Yoco integration is activated; newsletters are outside this implementation.

## Run the checks

These checks create disposable databases and synthetic keys. Provider HTTP, DNS and the hosted payment page are intercepted locally; no Paystack/Stripe charge or email is sent.

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

CI runs the same gates on Node 22 and 24, with no payment credentials. Browser tests use the real cart, checkout, payment verification and order endpoints; only the external provider is simulated. Additional UI-state tests stub authority responses deliberately.

## Configure a fresh local store

Use a **new, disposable database** first. The inherited seed/bootstrap commands can replace matching collection definitions: do not run them against an existing shop without a migration plan and backup.

1. Follow the [starter instructions](packages/starter/README.md) and complete EmDash owner setup.
2. Set a persistent private `EMDASH_ENCRYPTION_KEY` using EmDash's supported configuration. Keep environment files and credentials out of Git.
3. In DashCommerce settings, choose **Paystack — test mode only**, enter the test secret, choose **hosted** checkout, and configure ZAR as an enabled/default currency. Native EmDash secret settings encrypt the secret at rest; the admin API returns only secret presence/hints.
4. Set ZAR product prices and finite managed stock. Configure supported delivery methods for the intended country. Fixture shipping/tax values are examples, not merchant-approved business rules.
5. Configure the canonical site URL. Callbacks require HTTPS, except explicit loopback HTTP development. Public webhook ingress is a separate deployment decision.

Webhook: `POST /_emdash/api/plugins/dashcommerce/checkout/paystack-webhook`.
Return verification: `GET /_emdash/api/plugins/dashcommerce/orders/by-draft?id=<private-draft-capability>`.
Never treat query-string payment status or a browser redirect as proof of payment.

### Personalisation schema

A product's `customisation_definition` JSON can contain up to four text fields:

```json
{"fields":[{"key":"recipient_name","required":true,"maxLength":40}]}
```

Keys are validated; text is trimmed, bounded (maximum 120 characters per field), escaped when displayed, and revalidated against the current product definition at checkout. Rich conditional options, uploads and paid extras are not implemented.

## Operational limits

- Test payments create TEST-labelled, on-hold orders. `paymentStatus: "paid"` means a **verified sandbox transaction** only when paired with `paymentProvider: "paystack-test"` and test metadata. It is not live money or permission to fulfil.
- Preview outbox entries are private plugin KV records under `receipt-preview:` with `delivery: "disabled"`; no mail transport runs.
- Ambiguous initialization is not automatically repeated. Keep its private draft reference and reconcile; a crash before the provider POST may need operator intervention.
- Inventory is maintained in a single CAS projection, not simultaneously decremented in CMS fields. Out-of-band CMS stock changes require explicit `reconcileInventory` from `packages/core/src/inventory/index.ts`. A merchant reconciliation UI, retention policy and high-volume partitioning are not provided.
- Legacy Stripe inventory/finalization must not be mixed with this projection without a separate compatibility/reconciliation plan. This fork does not claim production Stripe regression certification.
- Coupons, subscriptions, Connect, non-standard tax classes, advanced shipping, untracked/backorder stock, live Paystack and Paystack refunds are rejected in the test checkout.
- Production still needs independent security/operations review, merchant-approved shipping/tax/discount rules, reconciliation/refunds, backups, HTTPS, privacy/retention controls and fulfilment validation. Keep private order capabilities out of analytics and referrer logs.
- Existing stores, infrastructure, DNS and deployments are not modified by these scripts. There is no automatic migration from WordPress, another commerce implementation, or earlier experimental payment records.

The fork is source-only: npm release and upstream synchronization workflows are removed, and the core package is marked private to prevent accidental publication under the upstream npm name. See [upstream](https://github.com/emdashCommerce/dashcommerce) for its original feature documentation; those broader claims are not a certification of this fork.
