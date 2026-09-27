# Fork development starter

Read the [root README](../../README.md) for supported versions, test/live implementation boundaries, provider configuration and verification commands.

This starter uses EmDash 0.41.0, Astro 7.3.5 and the standalone Node adapter. The local `src/host/emdash-041-host.mjs` integration is required: it owns the cart cookie and request protections rather than bypassing EmDash's response policies.

For a **fresh local demo only**:

```sh
# From repository root, after installing dependencies
bun run --cwd packages/starter bootstrap
bun run --cwd packages/starter dev
```

Complete the EmDash owner setup, configure a persistent encryption key/canonical site URL, and select Paystack, test mode and hosted checkout in admin settings. Configure the existing product/variant, currency, shipping, tax, stock and coupon settings normally; integrated financial fixtures exercise ZAR. Test/live code is implemented, but configuring real live credentials or enabling actual email requires separate approval. See the root README and operator checklist for recovery and inventory adoption.

The bootstrap/seed command may replace matching collection definitions. Never run it against an existing shop without backups and an explicit migration plan. Keep databases, uploaded media, private environment files and credentials out of Git.

Build with `bun run build` at the repository root; start the built starter with `bun run --cwd packages/starter start`. Bind local development to loopback and do not expose it as a production store. A production database, HTTPS ingress and real-order operation are not configured here.

Inherited Cloudflare scripts and Stripe UI are not certified deployment/payment targets for this fork. The inherited create-package generator is upstream-oriented; clone this repository rather than assuming the upstream npm generator installs this fork.
