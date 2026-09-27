# Operator checklist — production blocked

This fork is **not yet approved for production deployment**. The inherited deployment checklist was not validated for this fork: it assumed Stripe environment configuration, PostgreSQL/Workers support and an `options.key` column that do not match the certified Node/SQLite test target. Do not use those old instructions to modify a store.

The authoritative production acceptance checklist is [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md). Current local setup and test commands are in the [root README](../README.md).

Until those gates pass:

- Keep live payments and actual email delivery disabled.
- Do not run seed/bootstrap against an existing shop; it can replace matching collection definitions.
- Do not change site URL/database records using unverified SQL snippets.
- Do not mix the new reservation projection with legacy Stripe inventory effects.
- Do not deploy or migrate the existing storefront without explicit approval, backups and a tested rollback.

Production runbooks and verified deployment/restore commands will be added with the implementation and exercised against disposable data before approval.
