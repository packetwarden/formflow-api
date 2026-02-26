# Stripe Dashboard Setup Guide (FormSandbox v2)

## Purpose
Use this checklist to configure Stripe Dashboard for FormSandbox billing with:

1. Hosted Checkout for self-serve plans (`pro`, `business`)
2. Customer Portal for subscription management
3. Webhooks for subscription state sync

This guide covers **test mode first**, then **live mode**.

## 1) Pre-Setup Checklist
Before touching Dashboard, confirm:

1. Backend deploy includes `/api/v1/stripe/*` endpoints.
2. Database migration is applied:
    - `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql`
    - `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2.sql`
    - `project-info-docs/migrations/2026-02-26_stripe_customer_mapping_recovery_v3.sql`
3. You know your environment webhook URLs:
   - staging: `https://<staging-domain>/api/v1/stripe/webhook`
   - production: `https://<prod-domain>/api/v1/stripe/webhook`
4. You have owner-level Stripe Dashboard permissions.
5. You have a `CONTACT_SALES_URL` ready for enterprise (non-self-serve).

## 2) Account-Level Stripe Settings
In Stripe Dashboard, set these first:

1. **Business Profile**
   - legal business name
   - support email
   - support URL
   - statement descriptor
2. **Branding**
   - logo
   - brand color
   - accent color
3. **Customer emails**
   - payment receipts enabled
   - invoice emails enabled (if used)
4. **Security**
   - enforce 2FA for admins
   - confirm least-privilege team roles

## 3) Create Products and Prices
Create exactly these self-serve plans:

1. `pro` monthly
2. `pro` yearly
3. `business` monthly
4. `business` yearly

Rules:

1. `enterprise` should **not** have self-serve checkout price IDs in DB.
2. Use recurring prices (`type: recurring`) with flat amount (`usage_type: licensed`).
3. Currency in this v2 release scope: `USD`.
4. Each self-serve recurring price should include:
   - lookup key: `formsandbox:{env}:{plan_slug}:{interval}:usd`
   - metadata: `plan_slug`, `interval`, `self_serve=true`

Recommended naming convention:

1. Product names:
   - `FormSandbox Pro`
   - `FormSandbox Business`
2. Price nicknames:
   - `pro_monthly_usd`
   - `pro_yearly_usd`
   - `business_monthly_usd`
   - `business_yearly_usd`

After creation, run backend catalog sync. Do not rely on manual copy/paste of `price_...` IDs as primary flow in v2.

## 4) Tax and Discounts Configuration
### Stripe Tax
1. Enable Stripe Tax (if required by your jurisdictions).
2. Configure tax registrations and nexus regions.
3. Keep `automatic_tax.enabled = true` in backend checkout session creation (already implemented).

### Promotion codes / coupons
1. Create coupons for allowed campaigns.
2. Create promotion codes tied to coupons.
3. Keep checkout setting `allow_promotion_codes = true` (already implemented).

## 5) Customer Portal Configuration
Go to Customer Portal settings and create/configure one portal configuration:

1. Allow customer actions:
   - update payment method
   - view invoices/payment history
   - cancel subscription
   - switch plans
2. Plan switching:
   - allow only `pro <-> business`
   - keep billing intervals consistent with your catalog (monthly/yearly)
3. Cancellation policy:
   - set cancellation to **end of billing period** (matches product policy)
4. Proration behavior:
   - upgrades immediate
   - downgrades effective at period end
5. Save configuration and copy `bpc_...` ID.
6. Set env var:
   - `STRIPE_BILLING_PORTAL_CONFIGURATION_ID=<bpc_id>`

## 6) Webhook Endpoint Setup
Create webhook endpoints per environment.

### Test mode endpoint
1. Mode toggle: **Test**.
2. Add endpoint URL:
   - `https://<staging-domain>/api/v1/stripe/webhook`
3. Select events:
    - `checkout.session.completed`
    - `customer.deleted`
    - `customer.subscription.created`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.paid`
4. Save endpoint and copy signing secret (`whsec_...`).
5. Set env var in staging:
   - `STRIPE_WEBHOOK_SIGNING_SECRET=<whsec_test>`

### Live mode endpoint
Repeat the same steps in **Live** mode with production URL and store:

1. `STRIPE_WEBHOOK_SIGNING_SECRET=<whsec_live>`

Important:

1. Keep test and live secrets separate.
2. Never reuse test secret in production.

## 7) API Keys and Environment Variables
Set these Worker secrets per environment:

1. `STRIPE_SECRET_KEY` (`sk_test_...` or `sk_live_...`)
2. `STRIPE_WEBHOOK_SIGNING_SECRET` (environment-specific `whsec_...`)
3. `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` (`bpc_...`, optional but recommended)
4. `CHECKOUT_SUCCESS_URL`
5. `CHECKOUT_CANCEL_URL`
6. `BILLING_PORTAL_RETURN_URL`
7. `CONTACT_SALES_URL`
8. `BILLING_GRACE_DAYS` (default `7`)
9. `STRIPE_WEBHOOK_CLAIM_TTL_SECONDS` (default `300`)
10. `STRIPE_WEBHOOK_MAX_BODY_BYTES` (default `262144`)
11. `STRIPE_RETRY_BATCH_SIZE` (default `200`)
12. `STRIPE_GRACE_BATCH_SIZE` (default `500`)
13. `STRIPE_CATALOG_SYNC_ENABLED` (default `true`)
14. `STRIPE_CATALOG_SYNC_CRON` (default `*/15 * * * *`)
15. `STRIPE_INTERNAL_ADMIN_TOKEN` (for `/api/v1/stripe/catalog/sync`)

API version note:

1. Backend is pinned to Stripe API version `2026-01-28.clover`.

## 8) Data Mapping Checklist (Stripe -> DB)
After dashboard setup, verify DB mappings:

1. `plan_variants`:
   - each sellable paid variant has correct `stripe_price_id`
   - only active variants are marked `is_active = true`
2. `plans`:
   - `free`, `pro`, `business`, `enterprise` slugs are correct
3. `subscriptions`:
    - unique active-subscription index is present
    - `stripe_customer_id` lookup index exists
4. `workspace_billing_customers`:
   - exactly one Stripe customer per workspace
5. `stripe_checkout_idempotency`:
   - checkout idempotency rows are created and expired as expected
6. `stripe_webhook_events`:
   - lease columns exist (`processor_id`, `processing_started_at`, `claim_expires_at`, `next_attempt_at`)
   - retry/reclaim indexes exist after v2 migration
7. `workspace_billing_customer_events`:
   - events are written for `validated`, `invalidated`, `recreated`, `webhook_deleted`

Operational note:
1. `/api/v1/stripe/catalog/sync` updates `plan_variants` pricing data only.
2. Customer mapping recovery is handled in checkout/portal flows and `customer.deleted` webhook processing.

## 9) Frontend Checkout Idempotency Rules
1. Frontend must send `Idempotency-Key` (UUID) for checkout session requests.
2. Reusing key with different payload is rejected (`IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`).
3. Reusing same payload after 24 hours is rejected (`IDEMPOTENCY_KEY_EXPIRED`).
4. Frontend must generate a new key after 24 hours.

## 10) Test Mode End-to-End Validation
Run this sequence before live launch:

1. Checkout from a free workspace to `pro monthly`:
   - expect checkout URL response
2. Complete test payment:
   - expect webhook insert + subscription sync
3. Call checkout again on paid workspace:
   - expect redirect destination `portal` with reason `ALREADY_SUBSCRIBED`
4. From portal, switch plans and verify webhook sync.
5. Trigger payment failure scenario:
   - expect `past_due` + `grace_period_end`
6. Trigger payment recovery:
   - expect `active` + cleared `grace_period_end`
7. Verify `workspaces.plan` cache matches active paid plan or `free`.

## 11) Production Go-Live Checklist
Do this in order:

1. Confirm all test validations pass.
2. Recreate/verify products, prices, coupons, and portal config in **Live** mode.
3. Run production catalog sync (`POST /api/v1/stripe/catalog/sync`) with internal token and verify `plan_variants` reflects live Stripe prices.
4. Set production secrets (`sk_live`, `whsec_live`, URLs).
5. Deploy backend.
6. Perform one controlled production checkout smoke test.
7. Validate webhook rows and subscription/workspace plan updates.
8. Monitor webhook failures and retries for at least 48 hours.

## 12) Common Mistakes to Avoid
1. Mixing test `price_...` IDs in production DB.
2. Using wrong webhook secret for environment.
3. Forgetting to include `customer.deleted` and `customer.subscription.deleted` events.
4. Allowing enterprise price in self-serve flow.
5. Not setting portal cancellation to end-of-period when policy requires it.
6. Missing tax registration setup while `automatic_tax` is enabled.
7. Missing `lookup_key` / `self_serve` metadata on Stripe prices (breaks catalog sync mapping).
8. Reusing checkout idempotency keys after 24h from frontend.

## 13) Operational Ownership
Recommended owners:

1. Product/Finance: pricing, coupons, tax policy
2. Backend: webhook reliability, state sync, retries
3. DevOps: env secrets and deployment controls
4. Support/Ops: failed webhook review and replay handling
