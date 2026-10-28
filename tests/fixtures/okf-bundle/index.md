# Billing knowledge

## Decisions

* [Use Postgres for billing](decisions/use-postgres.md) - Why billing writes invoices to Postgres.

## Concepts

* [Accounts](concepts/a.md) - Who owns an invoice.
* [Invoices](concepts/generated-block.md) - What an invoice holds.
* [Payments](concepts/generated-flow.md) - How a payment settles an invoice.
* [Refunds](concepts/both.md) - How a refund reverses a payment.

## Tables

* [Orders](tables/orders.md) - One row per order.

## Runbooks

* [Rotate the billing key](runbooks/stale.md) - The old key rotation steps.
* [Restore billing](runbooks/fresh.md) - How to restore billing from a backup.
