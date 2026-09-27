# Payment operations checklist

Production activation is **not approved**. Start with the [readiness gates](PRODUCTION-READINESS.md) and a disposable Node/SQLite store. This is operational guidance for the implemented code, not a validated deployment/restore runbook.

## Setup and environments

- Complete native EmDash owner authentication. Payment operations and financial admin actions require private native authorization; there is no public diagnostics/backdoor route.
- Keep `EMDASH_ENCRYPTION_KEY` persistent/private. Configure Paystack test and live secrets in their separate encrypted settings. Start with **Paystack / test / hosted**.
- Historical attempts, refunds and stock effects use their persisted environment, not the current settings selector. Retain the appropriate keys while historical work remains unresolved.
- Configure existing products, variants, shipping, tax and coupons normally. Shipping class overrides with undefined mixed-class semantics are unavailable; Stripe-only capabilities do not become Paystack capabilities.
- Keep receipt delivery disabled until explicitly authorized and native EmDash email is configured. Test records remain suppressed even when delivery is enabled.
- Never seed/bootstrap an existing shop or use unverified SQL deployment instructions without a migration plan and backup.

## Payment operations page

Open **DashCommerce → Payment operations** in the native admin. Lists are paginated and private.

- **Attempts:** inspect captured mode/state and request verification/recovery. A verified attempt can replay interrupted finalization. Reconciliation does not initialize a second payment.
- **Refunds:** distinguish pending, uncertain, failed and succeeded. Reconcile a known provider refund ID against the persisted transaction, mode, currency and amount. Provider identity must match; arbitrary IDs are not accepted.
- **Outbox:** inspect pending/suppressed/sending/sent/uncertain states without exposing message bodies in the operations list.
- **Inventory:** preview the selected environment's CMS baseline and operational availability; explicitly confirm adoption. A sale, reservation, refund, tracking edit or other state change invalidates a stale preview.

The ten-minute scan processes bounded attempt/refund/outbox work and retains pagination progress. Stock expiry has a separate scheduled sweep. The native Node process must remain running; configure supervision and monitoring before deployment. The queue is not a substitute for deployment alerting.

## Orders and refunds

- A callback URL is not payment proof. Public receipts become ready only after finalization is committed.
- Test orders may have a normal processing state, but are simulations: do not dispatch goods or count them as live revenue.
- A paid manual-review order is genuinely verified but lacks safe inventory or coupon capacity. Review accepted pricing/stock, fulfil manually only when appropriate, or issue a refund. Withheld grants are not issued just by changing status.
- Submit a refund once and retain its durable request identity. The browser preserves pending/uncertain intents; do not replace the token simply because a response was lost.
- Pending refunds reserve money but are not completed refunds and do not restore stock. Successful partial/full refunds update accounting and any explicitly requested restock; quantity budgets prevent repeated partial requests from over-restocking an item.
- Financial POST uncertainty returns a recovery response, not permission to resend. Locate the provider refund and reconcile its ID. Without independent provider evidence, the reservation remains held rather than guessing that no refund occurred.
- A confirmed refund with incomplete local effects can be replayed after repairing persistence. The effects marker is last; replay does not repeat the provider POST or restock.
- Signed Paystack dashboard notifications are independently retrieved. External refunds are recorded once and do **not** infer a restock. An exact recorded merchant-note identity can correlate a previously uncertain local request.
- Refunds are blocked while a new payment journal is incomplete. Legacy orders without a recorded inventory reservation cannot be automatically restocked; reconcile legacy stock separately.

## Inventory adoption

CMS quantities are merchant baselines, not a second decrementing financial ledger. Test and live projections are independent.

1. Inspect the intended product/variant and environment.
2. Establish the correct physical/capacity baseline outside the payment system.
3. Preview current CMS/tracking/availability state.
4. Confirm adoption only if that preview is still valid. A 409 requires a fresh preview, not a forced overwrite.

Adoption is a deliberate replacement operation, not a refresh button. Do not mix it with legacy inventory effects or apply it automatically after every CMS edit.

## Email and privacy

- Native delivery requires both explicit enablement and a non-test record. Queued preview/state records are not proof that an email was delivered.
- A `sending` or `uncertain` handoff may already have delivered. Inspect the mail system before any manual resend; automatic recovery deliberately does not duplicate it.
- Keep draft receipt capabilities, customer information and private queue data out of public logs/analytics. Define retention and erasure procedures before deploying.

Actual sandbox-account acceptance, production supervision, backups/restore and any existing-store migration remain separate approval gates. Do not deploy, change DNS, enable live payments or send real email on the strength of local fixture results alone.
