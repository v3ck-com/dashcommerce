# Fork verification — 2026-09-27

## Normal gateway implementation

Target: EmDash **0.41.0**, Astro **7.3.5**, standalone Node/SQLite, Bun **1.4.2**. Current integrated local run: **Node 26.8.1**. The CI matrix independently runs Node 22 and 24; inspect the checks attached to the candidate commit rather than treating a local result as CI evidence.

- Frozen dependency installation: pass.
- Core suite: **302 tests, 1,290 assertions, zero failures**, across 30 files.
- Workspace typecheck: pass; seven existing starter hints.
- Core/starter builds: pass; existing bundle-size warning remains.
- Trusted host middleware: **5 tests**, plus native EmDash HTTP/SQLite cookie, cache, HEAD, status and method checks.
- **8 integrated native HTTP scenarios:** authoritative proof and concurrent callbacks; interrupted order writes/restart; abandoned payment release; normal test/live tax/coupons/refunds and persisted mode; lost refund responses/operator recovery; stale stock preview rejection and refund-effect replay after an interrupted notification write; pre-initialization coupon capacity, confirmed-failure release and native coupon-code edits.
- Chromium: **7 tests**, including a normal synthetic live-mode checkout and pending-to-completed refund journey. Principal flows use actual application endpoints; provider traffic/pages are intercepted. Additional UI-state tests intentionally stub authority responses.
- Production dependency audit: **zero known vulnerabilities**, 655 packages checked.
- Independent read-only source review: no actionable defect found in reviewed normal Paystack/shared order paths. The reviewer did not independently run the suites or certify provider behavior.

Targeted regressions include separate inventory environments, immutable payment mode, interrupted finalization/refund effects, cumulative partial-restock limits, external refund correlation, indexed receipts beyond 200 orders, incomplete-payment refund rejection, coupon accounting/audit interruption, coupon edits racing accounting, code aliases, customer identity changes, lost coupon capacity/manual review, and retryable Stripe card declines versus terminal cancellation.

These results do **not** certify actual Paystack sandbox-account behavior, real Stripe transactions, production email, Workers, PostgreSQL, deployment monitoring, restore/rollback or an existing-store migration. All financial/provider calls were synthetic and intercepted, including live-mode tests. No real financial credentials, customer data, charges, email delivery, deployment or DNS changes were used.

## Previous published baseline

The initial test-only fork (`f6df98c`) passed 176 core tests/704 assertions, five host tests and six browser tests, with HTTP checks on Node 22/24/26. Those results describe that earlier commit, not this larger normal-gateway implementation. The current integrated evidence above supersedes its feature/test counts.

See [readiness](PRODUCTION-READINESS.md), [operator guidance](OPERATOR_CHECKLIST.md) and the [CI workflow](../.github/workflows/ci.yml). Source/fixture success remains distinct from provider acceptance and explicit go-live authorization.
