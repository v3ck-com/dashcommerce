# Initial fork verification — 2026-09-27

Target: EmDash 0.41.0, Astro 7.3.5, standalone Node/SQLite, Bun 1.4.2.

Local integrated results:

- Frozen dependency installation: pass.
- Core suite: **176 tests, 704 assertions, zero failures**.
- Workspace typecheck: pass; seven existing starter hints.
- Core/starter builds: pass; bundle-size warning remains.
- Trusted host middleware: **5 tests**, plus real native EmDash HTTP cookie/status/cache/HEAD checks.
- Real HTTP payment lifecycle: pass on **Node 22, 24 and 26**. Covers retry identity, client-price rejection, provider-amount mismatch, concurrent webhook/return, exact-byte signatures, one durable order/payment/outbox, stock consumption, partial SQLite write failure, process restart and abandoned-payment release.
- Chromium: **6 tests**. The principal journey uses real application cart/contact/shipping/checkout/verification/order endpoints and a physical personalised item. Provider page and provider/DNS HTTP are local fixtures. Includes HTML-shaped text escaping, pending/paid receipt, provider review, uncertain-initialization recovery, unsupported provider and legacy Stripe UI selection.
- Production dependency audit: **zero known vulnerabilities**. The inherited Astro 6 dependency was upgraded after the audit identified critical/high advisories.
- Staged privacy checks: no known private environment credentials, customer databases, runtime logs, workstation paths or infrastructure addresses.

Independent review findings about browser stock setup, initialization uncertainty, manual-review rendering and purchased-cart cleanup were resolved and followed by integrated reruns. Cleanup uses conditional deletion so a newer cart survives.

These are development test results, **not a live-payment, real Paystack sandbox-account, production Stripe, Workers or PostgreSQL certification**. No real payment credentials, customer data, provider network calls, email delivery, deployment or existing-store migration were used. See the root README for operational limits and the GitHub CI workflow for clean-runner checks.
