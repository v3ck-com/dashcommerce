# Production readiness

Status: **not ready for production**. The production implementation is the target; the existing test-only implementation is the starting point, not the finished product.

## Scope and activation

Initial certification target: single-store Paystack hosted checkout, ZAR, personalised physical products, EmDash 0.41, standalone Node and SQLite. Wider platform/provider compatibility needs separate evidence. Existing Stripe paths must be isolated or validated before certification; choosing Paystack must not silently invoke Stripe operations.

Implement production-capable code separately from activation. Do not enable live payments, send real email, migrate the existing shop, change DNS or deploy without approval. Keep Yoco/Resend delivery mocked and newsletters excluded under the current operating instructions. A production email transport, if built, remains disabled until approved.

## Required acceptance gates

Every unchecked gate blocks a production-ready claim. Passing fixture tests alone is insufficient.

- [ ] **Mode separation:** explicit test/live configuration; match credential mode and provider transaction domain; persist immutable mode on attempts, payments, refunds and outbox records. No fallback between environments. Preserve historical test data without relabelling it as live.
- [ ] **Payment lifecycle:** durable initialization, verification, webhook processing, expiry, late success and reversal handling. Recover uncertain requests through reconciliation rather than blind repeated financial calls. Authenticate and audit operator interventions.
- [ ] **Reconciliation:** scheduled provider verification with bounded retries/backoff, persistent work state, operator queue and alerts. Recovery must not depend on a customer revisiting a receipt page.
- [ ] **Refunds:** provider-neutral durable requests, partial/full amount accounting, concurrent refund limits, ambiguous-response recovery and provider status reconciliation. Restock only under explicit policy; payment success and refund completion are separate states.
- [ ] **Inventory:** one authoritative accounting path with atomic reservations/consumption/restocking, safe expiry and returns, operator adjustments and reconciliation UI. Verify multi-process contention and crash recovery. Resolve legacy Stripe/CMS projection conflicts.
- [ ] **Order operations:** accurate paid/held/fulfilment states, administrative authorization, audit history, explicit transitions and usable personalisation details. No automatic shipping from unverified or review-required payments.
- [ ] **Notifications:** durable independently retryable outbox, deduplication, delivery failure visibility, explicit test/live separation and approved sender configuration. Preview records are not delivered receipts.
- [ ] **Checkout rules:** merchant-approved shipping destinations/rates, tax treatment and discount policy. Revalidate before payment and preserve the purchase snapshot. Unsupported rules must fail clearly, never produce invented totals.
- [ ] **Security/privacy:** administrator flows, secret encryption/rotation/redaction, webhook key rotation, cookie/proxy/CSRF handling, bounded requests, abuse limits, private capabilities, PII retention/deletion and dependency review.
- [ ] **Operations:** deployment configuration, HTTPS/webhook ingress, health/readiness checks, supervised background work, alerting, backups and demonstrated restore/rollback. Test the actual intended hosting/storage topology.
- [ ] **Migration:** non-destructive catalogue/options migration and comparison of prices, URLs, media and stock. Explicit decision on customer/order history, with backup and rollback evidence before applying anything to the existing shop.
- [ ] **Provider acceptance:** real Paystack sandbox-account hosted checkout, webhook, refund and recovery exercises with synthetic customers. Offline fixtures remain required regression tests, but cannot replace this gate.
- [ ] **Independent final review:** clean CI and reproducible acceptance evidence for the release candidate, including adversarial/concurrency/failure tests and merchant sign-off. No production claim based only on unit-test totals.

## Implementation order

1. Audit and mode/provider-neutral payment model; compatibility/migration tests.
2. Reconciliation and refund state machines; inventory integration and operator tools.
3. Order fulfilment controls, notification transport/outbox and browser/admin journeys.
4. Abuse/privacy controls, deployment/backup/restore tooling and non-destructive shop migration rehearsal.
5. Real sandbox-account validation, independent review and merchant acceptance; separate go-live approval.

## Merchant decisions outstanding

- VAT registration and whether catalogue prices include VAT; applicable tax treatment.
- Delivery destinations, courier/rates, free-shipping thresholds, collection and lead times.
- Whether stock means finished goods, made-to-order capacity or untracked availability.
- Personalisation requirements, paid extras and cancellation/refund/return rules.
- Discount policy (including whether discounts are intentionally disabled initially).
- Fulfilment workflow, notification requirements and approval to activate real email.
- Production hostname/hosting topology, retention requirements and migration scope.

These decisions do not prevent implementing the underlying machinery. They do prevent inventing business rules or signing off the store for real customers.
