# Production readiness

## Implementation versus activation

**Normal Paystack test/live gateway code is implemented alongside Stripe. Production provider acceptance and deployment approval remain outstanding.** This is not a test-only gateway, but passing intercepted fixtures is not proof that a real merchant account, webhook ingress or payment/refund journey works.

The implementation reuses configurable products/variants, shipping, tax, coupons, inventory, orders and notifications. Merchant VAT, courier and email decisions were not prerequisites to implementing compatibility. Actual store configuration and go-live authorization remain separate from plugin development.

## Implemented and locally exercised

| Area | Current behavior |
| --- | --- |
| Provider/mode | Normal Paystack with separate encrypted test/live secrets; immutable persisted environment; legacy test alias retained. |
| Payment proof | Exact-byte webhook authentication plus independent provider verification; bounded transport; durable initialization identity; no blind replay of an uncertain POST. |
| Orders | Shared recoverable Stripe/Paystack finalization; final journal marker last; deterministic rows; indexed receipt lookup; newer cart edits survive cleanup. |
| Pricing | Authoritative product/variant prices, weights and categories; native shipping zones/rates; flat/table tax and product classes; deterministic eligible-line discounts. |
| Coupons | Live quota admission before initialization; same-coupon-row CAS commits usage/customer counters and order identity; bounded legacy hydration; code aliases/stable IDs; test isolation. Lost claims produce paid, held orders without grants. |
| Inventory | Separate test/live CAS projections; finite/untracked/backorder handling; idempotent consume/restock; explicit, stale-preview-safe CMS adoption. |
| Refunds | Full/partial pending accounting; amount and per-item quantity reservations before POST; persisted browser intent; provider-ID uniqueness; unknown-response recovery; incomplete effects replay; independently verified external Paystack refunds. |
| Operations | Native private authenticated pages/actions, bounded scheduled reconciliation, persisted pagination cursors and explicit recovery states. No customer return is required to run recovery. |
| Notifications | Durable order/refund outbox; opt-in native email; test suppression; uncertain delivery is not automatically retried. |
| UI | Normal test/live gateway selection; truthful pending/paid/held/refund states; personalisation retained; test warnings; private refund/recovery controls. |

Ordinary Stripe flows share accounting and finalization without claiming that Stripe subscriptions, Connect, Elements or Stripe Tax are interchangeable with Paystack. Stripe card declines retain their bounded reservation while the PaymentIntent remains retryable; terminal cancellation releases it. Stripe Tax totals are checked against provider proof without inventing a tax rate.

## Explicit compatibility limits

- Paystack subscriptions/vendor splits/Stripe Tax/Elements are unsupported and fail closed rather than being silently approximated.
- Nonempty flat-rate `shippingClassRates` are unavailable because mixed-class aggregation was never defined. Base-rate fallback would silently undercharge.
- Paystack zero-total/free-order checkout is not implemented. Currency/account capability still requires real provider acceptance; integrated fixtures cover ZAR.
- Text personalisation is supported; conditional builders, paid extras and uploads are not.
- Test projections never consume or restore live stock. Test financial records do not consume coupon quotas, contribute live financial aggregates, create digital grants or deliver email.
- Lost inventory/coupon capacity is an explicit manual-review hold, not automatic fulfilment or an automatic refund. Changing order status alone does not issue withheld download grants.
- An unknown financial POST without independently verifiable provider identity cannot safely be retried or declared failed. Operators must obtain provider evidence; there is no unsafe force-resend action.
- Provider dispute/chargeback and payout accounting are not automated by these ordinary payment/refund flows; monitor the provider account separately.
- Email delivery is at-most-one automatic handoff attempt, not exactly-once delivery. `sending`/`uncertain` require inspection.
- Reconciliation is bounded periodic scanning, not a deployment alerting service or an adaptive retry scheduler. The Node scheduler requires a running supervised process.
- Legacy unmarked/pre-journal orders and old CMS inventory effects need audited migration/reconciliation. Large legacy coupon histories fail closed beyond bounded hydration. No automatic legacy stock reconstruction is claimed.
- Stock and coupon accounting records are not a high-volume partitioned system. Retention/erasure and operational capacity need deployment-specific review.

## Evidence and remaining acceptance

See [verification](FORK-VERIFICATION.md) for the actual test counts and target versions. An independent read-only source review found no actionable defect in the reviewed normal Paystack/shared-order paths; it did not independently execute tests or certify provider behavior.

Before calling a deployment production-ready:

- [ ] Run actual Paystack sandbox-account hosted checkout, exact deployed webhook ingress, partial/full/dashboard refunds, interrupted requests and recovery with synthetic customers.
- [ ] Validate account currencies, provider response/event shapes, credential rotation and operator recovery against that account; do not substitute fixture success for this evidence.
- [ ] Obtain clean release-candidate CI and review the candidate on the intended supported Node/SQLite topology. Workers/PostgreSQL and broader Stripe functionality need separate evidence.
- [ ] Validate HTTPS/proxy/cookie configuration, supervision, health monitoring/alerts, abuse controls, secret handling and receipt-capability privacy.
- [ ] Demonstrate backups, restore/rollback and applicable retention/erasure procedures on disposable data.
- [ ] If an existing store will be migrated, separately approve scope and rehearse non-destructively with price/options/URLs/media/stock comparisons and rollback evidence.
- [ ] Approve actual store configuration and any real sender/delivery transport. Yoco/Resend activation and newsletters remain outside this work.
- [ ] Obtain explicit deployment and live-payment authorization.

No real payments, real email, deployment, DNS changes or existing-store migration were performed as part of this implementation verification.
