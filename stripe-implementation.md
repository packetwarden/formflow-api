# Stripe Billing Implementation (Hosted Checkout + Portal + Webhook Recovery) - v4

Version: v4  
Last Updated: February 26, 2026  
Stripe API Version: `2026-01-28.clover`

## 1) Architecture Overview
Stripe billing entry points:
1. `POST /api/v1/stripe/workspaces/:workspaceId/checkout-session`
2. `POST /api/v1/stripe/workspaces/:workspaceId/portal-session`
3. `POST /api/v1/stripe/webhook`
4. `POST /api/v1/stripe/catalog/sync` (internal token protected)

Primary flow:
1. Owner/admin requests checkout or portal session.
2. Worker validates workspace customer mapping against Stripe before any session creation.
3. Worker self-heals stale mappings and retries once if Stripe rejects the customer reference.
4. Checkout creates Stripe-hosted subscription session for `pro` and `business`.
5. Webhook verifies signature, stores idempotently, and processes via lease-based claims.
6. Subscription sync updates `subscriptions` and refreshes `workspaces.plan`.
7. Scheduled jobs replay failed events, reclaim stale claims, enforce grace downgrades, sync catalog, and clean completed webhook rows.

Design principles:
1. Stripe payloads are untrusted and size-guarded.
2. Webhook processing is crash-safe via DB claim lease (`claim_expires_at` reclaim).
3. Stripe catalog is source of truth for recurring self-serve prices.
4. Checkout idempotency is durable via `stripe_checkout_idempotency`.
5. Customer mappings are validated at runtime, not blindly trusted from DB.

## 2) Environment Variables and Wrangler Bindings
Required:
1. `SUPABASE_URL`
2. `SUPABASE_ANON_KEY`
3. `SUPABASE_SERVICE_ROLE_KEY`
4. `STRIPE_SECRET_KEY`
5. `STRIPE_WEBHOOK_SIGNING_SECRET`
6. `CHECKOUT_SUCCESS_URL`
7. `CHECKOUT_CANCEL_URL`
8. `BILLING_PORTAL_RETURN_URL`
9. `CONTACT_SALES_URL`

Optional:
1. `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`
2. `BILLING_GRACE_DAYS` (default `7`)
3. `STRIPE_INTERNAL_ADMIN_TOKEN` (required for manual catalog sync endpoint)
4. `STRIPE_WEBHOOK_CLAIM_TTL_SECONDS` (default `300`)
5. `STRIPE_WEBHOOK_MAX_BODY_BYTES` (default `262144`)
6. `STRIPE_RETRY_BATCH_SIZE` (default `200`)
7. `STRIPE_GRACE_BATCH_SIZE` (default `500`)
8. `STRIPE_CATALOG_SYNC_ENABLED` (default `true`)
9. `STRIPE_CATALOG_SYNC_CRON` (default `*/15 * * * *`)
10. `STRIPE_CATALOG_ENV` (lookup key environment matcher)

Wrangler schedule defaults:
1. `*/5 * * * *` webhook replay + stale claim reclaim
2. `0 * * * *` grace downgrade pass
3. `*/15 * * * *` catalog sync
4. `30 2 * * *` webhook cleanup

## 3) Checkout Idempotency Contract
Checkout requires `Idempotency-Key` (UUID).

Server behavior:
1. Persist request in `stripe_checkout_idempotency` with 24-hour expiry.
2. Same key + same payload + unexpired returns cached checkout session.
3. Same key + different payload returns `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
4. Same key after expiry returns `IDEMPOTENCY_KEY_EXPIRED`.

Frontend requirement:
1. Generate a fresh UUID per checkout attempt.
2. Reuse only for same payload retries.
3. Rotate key after 24 hours.

## 4) Stripe Catalog Sync Model
Catalog sync controls product and price mappings only.

Accepted mapping contract:
1. Lookup key: `formsandbox:{env}:{plan_slug}:{interval}:usd`
2. Metadata keys: `plan_slug`, `interval`, `self_serve`
3. Supported self-serve plans: `pro`, `business`
4. Supported intervals: `monthly`, `yearly`

Sync behavior:
1. Scheduler scans active recurring prices.
2. Best candidate per `{plan_slug, interval, currency}` is selected.
3. Matching `plan_variants` rows are updated with Stripe `price_id` and amount.
4. Checkout and webhook fallback paths can force one sync attempt on price drift.

Important:
1. `/api/v1/stripe/catalog/sync` does not create, validate, or repair workspace customer mappings.
2. `/api/v1/stripe/catalog/sync` does not resolve `No such customer` failures.

## 5) Workspace Customer Mapping Recovery Model
Tables:
1. `workspace_billing_customers` (current mapping)
2. `workspace_billing_customer_events` (audit log)

Behavior:
1. Checkout and portal validate mapped customer existence using `stripe.customers.retrieve`.
2. If Stripe returns deleted customer or `resource_missing` on `customer`, mapping is invalidated.
3. Service creates a new Stripe customer and persists mapping.
4. Session creation retries once with remapped customer after missing-customer failures.
5. Audit events are written for `validated`, `invalidated`, `recreated`, and `webhook_deleted`.

Customer-create idempotency:
1. Key format is `customer:v2:{workspaceId}:{requestScopeHash}`.
2. Checkout request scope is based on incoming checkout `Idempotency-Key`.
3. Portal request scope uses per-request correlation UUID.

## 6) Webhook Processing Model (Lease Queue)
Table: `stripe_webhook_events`

Lifecycle:
1. Insert as `pending`, `attempts=0`.
2. Claim via RPC `claim_stripe_webhook_event(...)`:
   - due `pending|failed`, or stale `processing` with expired claim
   - increments attempts
   - sets `processor_id`, `processing_started_at`, `claim_expires_at`
3. On success: `completed`, `processed_at`, clear claim fields.
4. On failure: `failed`, set `last_error`, schedule `next_attempt_at` with backoff.

## 7) Event Mapping and Status Rules
Handled events:
1. `checkout.session.completed`
2. `customer.deleted`
3. `customer.subscription.created`
4. `customer.subscription.updated`
5. `customer.subscription.deleted`
6. `invoice.payment_failed`
7. `invoice.paid`

`customer.deleted` behavior:
1. Delete matching rows in `workspace_billing_customers`.
2. Cancel workspace subscriptions tied to deleted `stripe_customer_id`.
3. Write `workspace_billing_customer_events` with `event_type = webhook_deleted`.
4. Ensure free subscription and refresh `workspaces.plan`.

Status mapping:
1. `trialing -> trialing`
2. `active -> active`
3. `past_due -> past_due`
4. `unpaid -> unpaid` (non-entitled, free-tier ensure)
5. `paused -> paused` (non-entitled, free-tier ensure)
6. `canceled -> canceled` (free-tier ensure)
7. `incomplete_expired -> incomplete_expired` (terminal non-entitled, free-tier ensure)
8. `incomplete -> incomplete` (payment pending, non-entitled)

Transition safety:
1. If an existing Stripe-linked row transitions from `incomplete` to an entitled status (`active|trialing|past_due`), conflicting entitled rows for the workspace are demoted before update to avoid unique index conflicts.

Invoice behavior:
1. `invoice.payment_failed` sets `grace_period_end` only.
2. `invoice.paid` clears `grace_period_end`.
3. Invoice handlers do not force subscription status.

## 8) Stale Customer Mapping Recovery Runbook
Symptoms:
1. Checkout/portal fails with `STRIPE_CHECKOUT_SESSION_FAILED` or `STRIPE_PORTAL_SESSION_FAILED`.
2. Stripe request log shows `No such customer: 'cus_...'`.
3. Workspace mapping references deleted/non-existent Stripe customer.

Verification SQL:
```sql
SELECT workspace_id, stripe_customer_id, created_at, updated_at
FROM public.workspace_billing_customers
WHERE workspace_id = '<workspace_id>';
```

```sql
SELECT id, workspace_id, event_type, old_stripe_customer_id, new_stripe_customer_id, reason, stripe_event_id, created_at
FROM public.workspace_billing_customer_events
WHERE workspace_id = '<workspace_id>'
ORDER BY created_at DESC
LIMIT 50;
```

Expected recovery sequence:
1. `invalidated` event for old customer ID.
2. `recreated` event with new customer ID.
3. Checkout/portal request succeeds on retry path.

Stripe log check:
1. New `POST /v1/customers` request is present for recovery attempt.
2. Follow-up session call (`/v1/checkout/sessions` or `/v1/billing_portal/sessions`) uses new `customer` ID.

Manual intervention criteria:
1. Recovery keeps failing after one retry.
2. Mapping table update fails due DB constraints.
3. Stripe account misconfiguration or API key mismatch causes repeated `resource_missing`.

## 9) Production Go-Live Checklist
1. Apply migration `2026-02-25_stripe_billing_hardening_v2.sql`.
2. Apply migration `2026-02-26_stripe_customer_mapping_recovery_v3.sql`.
3. Apply migration `2026-02-26_stripe_incomplete_status_v4.sql`.
4. Verify one Stripe customer mapping per workspace.
5. Verify customer audit rows are written to `workspace_billing_customer_events`.
6. Configure and verify Stripe secrets and URLs.
7. Ensure webhook subscription includes `customer.deleted`.
8. Run test-mode checkout + portal + webhook + replay + stale-customer recovery + pending status scenarios.
9. Monitor failures/retries/audit events for first 48 hours.
