# FormSandbox Stripe Billing API v1 Test Guide

Version: v2  
Last Updated: February 25, 2026  
Target: Cloudflare Worker deployment (`/api/v1/stripe/*`)

## 1. Scope
This guide covers Stripe billing endpoint testing:
1. `POST /api/v1/stripe/workspaces/:workspaceId/checkout-session`
2. `POST /api/v1/stripe/workspaces/:workspaceId/portal-session`
3. `POST /api/v1/stripe/webhook`

This guide validates:
1. owner/admin authorization on billing routes
2. hosted checkout creation for `pro` and `business`
3. enterprise self-serve rejection behavior
4. billing portal creation behavior
5. webhook signature verification
6. webhook idempotency and subscription/workspace plan sync
7. payment failure grace-period behavior and recovery
8. retry and scheduled downgrade flows

## 2. Prerequisites
Before running tests:
1. Worker is deployed with Stripe billing code enabled.
2. DB baseline is `project-info-docs/formflow_beta_schema_v2.sql`.
3. Existing environments have migrations applied in order:
   - `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
   - `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
   - `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
   - `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql`
   - `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2.sql`
4. Worker bindings are configured:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SIGNING_SECRET`
   - `CHECKOUT_SUCCESS_URL`
   - `CHECKOUT_CANCEL_URL`
   - `BILLING_PORTAL_RETURN_URL`
   - `CONTACT_SALES_URL`
   - optional: `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`
   - optional: `BILLING_GRACE_DAYS`
   - optional: `STRIPE_WEBHOOK_CLAIM_TTL_SECONDS`
   - optional: `STRIPE_WEBHOOK_MAX_BODY_BYTES`
   - optional: `STRIPE_RETRY_BATCH_SIZE`
    - optional: `STRIPE_GRACE_BATCH_SIZE`
    - optional: `STRIPE_CATALOG_SYNC_ENABLED`
    - optional: `STRIPE_CATALOG_SYNC_CRON`
    - optional: `STRIPE_CATALOG_ENV`
    - optional: `STRIPE_INTERNAL_ADMIN_TOKEN`
5. Stripe dashboard is configured:
   - products/prices for `pro` and `business` monthly/yearly
   - customer portal enabled
   - webhook endpoint created with required events
6. `plan_variants.stripe_price_id` is populated for paid active variants.
7. You have:
   - one free workspace owned by test user
   - one paid workspace (for already-subscribed path)

## 3. Postman Environment
Create a Postman environment with these variables:

| Variable | Example | Required |
|---|---|---|
| `base_url` | `https://formflow-api.<subdomain>.workers.dev` | Yes |
| `owner_email` | `billing.owner@example.com` | Yes |
| `owner_password` | `StrongPassw0rd!` | Yes |
| `access_token` | (captured from login) | Yes |
| `workspace_id_free` | UUID | Yes |
| `workspace_id_paid` | UUID | Yes |
| `checkout_idempotency_key` | UUID | Yes |
| `checkout_session_url` | (captured) | Optional |
| `checkout_session_id` | (captured) | Optional |
| `portal_session_url` | (captured) | Optional |
| `stripe_customer_id` | (captured from DB) | Optional |
| `stripe_subscription_id` | (captured from DB) | Optional |
| `internal_admin_token` | shared secret for internal catalog sync | Optional |

## 4. Test Data Setup
Find free and paid workspaces:
```sql
SELECT w.id, w.name, w.plan
FROM public.workspaces w
JOIN public.profiles p ON p.id = w.owner_id
WHERE p.email = 'billing.owner@example.com'
  AND w.deleted_at IS NULL
ORDER BY w.created_at DESC;
```

Verify paid workspace has active paid subscription:
```sql
SELECT s.id, s.workspace_id, s.status, s.stripe_customer_id, s.stripe_subscription_id, pl.slug AS plan_slug
FROM public.subscriptions s
JOIN public.plans pl ON pl.id = s.plan_id
WHERE s.workspace_id = '<workspace_id_paid>'
ORDER BY s.created_at DESC;
```

Verify Stripe price mappings:
```sql
SELECT p.slug AS plan_slug, pv.interval, pv.stripe_price_id, pv.is_active
FROM public.plan_variants pv
JOIN public.plans p ON p.id = pv.plan_id
WHERE p.slug IN ('pro', 'business')
ORDER BY p.slug, pv.interval;
```

## 5. Common Postman Setup
For authenticated requests add:
1. `Authorization: Bearer {{access_token}}`
2. `Content-Type: application/json`

Optional login request to capture `access_token`:
`POST {{base_url}}/api/v1/auth/login`
```json
{
  "email": "{{owner_email}}",
  "password": "{{owner_password}}"
}
```

Tests tab snippet:
```javascript
pm.test("Login success", function () {
  pm.expect(pm.response.code).to.eql(200);
});
const json = pm.response.json();
pm.environment.set("access_token", json.session.access_token);
```

Pre-request script for checkout requests (generate UUID key):
```javascript
if (!pm.environment.get("checkout_idempotency_key")) {
  pm.environment.set("checkout_idempotency_key", crypto.randomUUID());
}
```

## 6. Endpoint Matrix
| Method | Endpoint | Auth | Expected |
|---|---|---|---|
| POST | `/api/v1/stripe/workspaces/:workspaceId/checkout-session` | Yes (owner/admin + `Idempotency-Key`) | `200` / `400` / `403` / `404` / `409` / `500` |
| POST | `/api/v1/stripe/workspaces/:workspaceId/portal-session` | Yes (owner/admin) | `200` / `403` / `404` / `500` |
| POST | `/api/v1/stripe/webhook` | No (signature required) | `200` / `400` / `500` |
| POST | `/api/v1/stripe/catalog/sync` | Internal token (`x-internal-admin-token` or Bearer token) | `200` / `403` / `500` |

## 7. Detailed Postman + Stripe Tests

### 7.1 Checkout Session (free workspace -> `pro monthly`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id_free}}/checkout-session`
3. Headers:
   - `Idempotency-Key: {{checkout_idempotency_key}}` (UUID)
4. Body:
```json
{
  "plan_slug": "pro",
  "interval": "monthly"
}
```

Tests tab:
```javascript
pm.test("Checkout session created", function () {
  pm.expect(pm.response.code).to.eql(200);
});
const json = pm.response.json();
pm.expect(json.destination).to.eql("checkout");
pm.expect(json).to.have.property("url");
pm.expect(json).to.have.property("session_id");
pm.environment.set("checkout_session_url", json.url);
pm.environment.set("checkout_session_id", json.session_id);
```

### 7.2 Checkout Session (`business yearly`)
Request:
1. Same endpoint as `7.1`
2. Header:
   - `Idempotency-Key: {{checkout_idempotency_key}}` (generate a new UUID for this payload)
3. Body:
```json
{
  "plan_slug": "business",
  "interval": "yearly"
}
```

Expected:
1. `200`
2. `destination = "checkout"`

### 7.3 Enterprise Rejection (`403 CONTACT_SALES_REQUIRED`)
Request:
1. Same endpoint as `7.1`
2. Header:
   - `Idempotency-Key: {{checkout_idempotency_key}}` (UUID)
3. Body:
```json
{
  "plan_slug": "enterprise",
  "interval": "monthly"
}
```

Expected:
1. Status `403`
2. `code = CONTACT_SALES_REQUIRED`
3. response includes `contact_sales_url`

### 7.4 Free Plan Rejection (`400 INVALID_PLAN_FOR_CHECKOUT`)
Request:
1. Same endpoint as `7.1`
2. Header:
   - `Idempotency-Key: {{checkout_idempotency_key}}` (UUID)
3. Body:
```json
{
  "plan_slug": "free",
  "interval": "monthly"
}
```

Expected:
1. Status `400`
2. `code = INVALID_PLAN_FOR_CHECKOUT`

### 7.5 Already Paid Workspace Returns Portal
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id_paid}}/checkout-session`
3. Headers:
   - `Idempotency-Key: {{checkout_idempotency_key}}`
4. Body:
```json
{
  "plan_slug": "pro",
  "interval": "monthly"
}
```

Expected:
1. Status `200`
2. `destination = "portal"`
3. `reason = "ALREADY_SUBSCRIBED"`
4. `url` is Stripe billing portal URL

### 7.6 Portal Session Success
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id_paid}}/portal-session`
3. Body: none

Tests tab:
```javascript
pm.test("Portal session created", function () {
  pm.expect(pm.response.code).to.eql(200);
});
const json = pm.response.json();
pm.expect(json).to.have.property("url");
pm.environment.set("portal_session_url", json.url);
```

### 7.7 Portal Unauthorized User (`403`)
Request:
1. Use token from non-member or viewer-only user
2. Method: `POST`
3. URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id_paid}}/portal-session`

Expected:
1. Status `403`
2. body contains authorization error

### 7.8 Webhook Invalid Signature (`400`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/stripe/webhook`
3. Headers:
   - `stripe-signature: invalid`
   - `Content-Type: application/json`
4. Body:
```json
{
  "id": "evt_invalid_test",
  "type": "invoice.paid",
  "data": { "object": {} }
}
```

Expected:
1. Status `400`
2. body: `Invalid Stripe signature`

### 7.9 Valid Webhook Delivery via Stripe CLI (Checkout Completed)
Use Stripe CLI:
```bash
stripe trigger checkout.session.completed
```

Expected:
1. Worker returns `200`
2. A row is created in `public.stripe_webhook_events` with `status` eventually `completed`
3. `subscriptions` row is inserted/updated
4. `workspaces.plan` updates to paid plan slug

Verification SQL:
```sql
SELECT event_id, event_type, status, attempts, processed_at, last_error
FROM public.stripe_webhook_events
ORDER BY created_at DESC
LIMIT 20;
```

### 7.10 Subscription Updated Sync
Trigger:
```bash
stripe trigger customer.subscription.updated
```

Expected:
1. webhook event processed
2. subscription status/period/price mapping updates in DB

Verification SQL:
```sql
SELECT s.workspace_id, s.status, s.current_period_start, s.current_period_end,
       s.cancel_at_period_end, s.grace_period_end, pl.slug AS plan_slug
FROM public.subscriptions s
JOIN public.plans pl ON pl.id = s.plan_id
WHERE s.workspace_id = '<workspace_id_under_test>'
ORDER BY s.created_at DESC
LIMIT 5;
```

### 7.11 Payment Failed Sets Grace Period
Trigger:
```bash
stripe trigger invoice.payment_failed
```

Expected:
1. `grace_period_end` is set (now + `BILLING_GRACE_DAYS`)
2. subscription `status` remains sourced from Stripe subscription state (no forced invoice-status overwrite)

### 7.12 Payment Recovery Clears Grace Period
Trigger:
```bash
stripe trigger invoice.paid
```

Expected:
1. `grace_period_end` becomes `NULL`
2. subscription `status` remains sourced from Stripe subscription state

### 7.13 Subscription Deleted Downgrades Plan
Trigger:
```bash
stripe trigger customer.subscription.deleted
```

Expected:
1. paid subscription status becomes `canceled`
2. free subscription row exists (if no other paid active row)
3. `workspaces.plan = 'free'`

Verification SQL:
```sql
SELECT s.workspace_id, s.status, pl.slug AS plan_slug, s.created_at
FROM public.subscriptions s
JOIN public.plans pl ON pl.id = s.plan_id
WHERE s.workspace_id = '<workspace_id_under_test>'
ORDER BY s.created_at DESC;
```

### 7.14 Idempotency Check (Duplicate Event)
Method:
1. Open recent event in Stripe Dashboard Events.
2. Click **Resend** to same webhook endpoint.

Expected:
1. endpoint responds `200`
2. duplicate event is not re-applied destructively
3. no duplicate side effects on `subscriptions`

Validation SQL:
```sql
SELECT event_id, COUNT(*) AS row_count
FROM public.stripe_webhook_events
GROUP BY event_id
HAVING COUNT(*) > 1;
```
Expected:
1. no rows returned

### 7.15 Retry Job Recovery (failed -> completed)
Setup (test environment only):
1. pick a failed row in `stripe_webhook_events`
2. ensure root cause is fixed (e.g., missing `stripe_price_id` mapping)
3. wait for retry cron (`*/5 * * * *`)

Expected:
1. event status moves from `failed` to `completed`
2. `attempts` increments
3. `last_error` clears on success

### 7.16 Grace Expiry Downgrade Job
Setup (test environment only):
```sql
UPDATE public.subscriptions
SET status = 'past_due',
    grace_period_end = NOW() - INTERVAL '1 minute'
WHERE id = '<subscription_id_under_test>';
```
Wait for grace cron (`0 * * * *`).

Expected:
1. target paid row marked `canceled`
2. free subscription row ensured
3. `workspaces.plan` becomes `free`

### 7.17 Checkout Idempotency Replay (same key, same payload, <24h)
Request flow:
1. Set `checkout_idempotency_key` to a fixed UUID.
2. Call checkout once with payload `{ "plan_slug": "pro", "interval": "monthly" }`.
3. Call checkout again with the same header and same payload.

Expected:
1. second call returns `200`
2. response includes `idempotent_replay = true`
3. `session_id` on second call equals first call

### 7.18 Checkout Idempotency Conflict (same key, different payload)
Request flow:
1. Reuse the same `checkout_idempotency_key` from `7.17`.
2. Change payload to `{ "plan_slug": "business", "interval": "yearly" }`.

Expected:
1. response is `409`
2. `code = IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`

### 7.19 Checkout Idempotency Expiry (>24h)
Setup (test environment only):
```sql
UPDATE public.stripe_checkout_idempotency
SET expires_at = NOW() - INTERVAL '1 minute'
WHERE workspace_id = '<workspace_id_free>'
  AND idempotency_key = '<uuid_used_in_7_17>';
```
Retry checkout with same header key and same payload.

Expected:
1. response is `409`
2. `code = IDEMPOTENCY_KEY_EXPIRED`
3. frontend rotates to a new UUID key and retry succeeds

### 7.20 Crash-Safe Lease Reclaim (`processing` -> reclaimed)
Setup (test environment only):
1. pick a webhook `event_id` row with valid payload.
2. simulate crashed worker lease:
```sql
UPDATE public.stripe_webhook_events
SET status = 'processing',
    processor_id = 'test-crash-worker',
    processing_started_at = NOW() - INTERVAL '10 minutes',
    claim_expires_at = NOW() - INTERVAL '2 minutes',
    next_attempt_at = NULL
WHERE event_id = '<event_id_under_test>';
```
3. wait for retry cron (`*/5 * * * *`) or trigger scheduler manually.

Expected:
1. row gets reclaimed by claim logic
2. `attempts` increments
3. row converges to `completed` or deterministic `failed` with `next_attempt_at`

### 7.21 Free Subscription Race Safety
Setup (test environment only):
1. run these in two SQL sessions at the same time for the same workspace:
```sql
SELECT * FROM public.ensure_free_subscription_for_workspace('<workspace_uuid>', 'race-test');
```
2. then verify active non-Stripe free rows:
```sql
SELECT workspace_id, COUNT(*) AS non_stripe_entitled_rows
FROM public.subscriptions
WHERE workspace_id = '<workspace_uuid>'
  AND stripe_subscription_id IS NULL
  AND status IN ('active','trialing','past_due')
GROUP BY workspace_id;
```

Expected:
1. count is exactly `1`
2. one call may report `created = true`, the other `created = false`

### 7.22 Catalog Sync + Drift Recovery
Flow:
1. create/activate a new Stripe recurring price for an existing self-serve variant (`pro` or `business`) with required lookup key + metadata.
2. call internal sync endpoint:
   - `POST {{base_url}}/api/v1/stripe/catalog/sync`
   - header: `x-internal-admin-token: {{internal_admin_token}}`
3. verify `plan_variants.stripe_price_id` updates to the new active Stripe price.

Expected:
1. API returns `200` with sync stats
2. checkout uses refreshed price mapping without deploy

### 7.23 Unknown Price Webhook Fallback
Flow:
1. deliver a webhook payload whose subscription price is not currently mapped in DB.
2. backend should force one catalog sync and retry variant mapping once.

Expected:
1. if sync resolves mapping, event completes successfully
2. if still unresolved, event becomes `failed` with deterministic error reason

### 7.24 Webhook Payload Size Guard
Flow:
1. send webhook request body larger than `STRIPE_WEBHOOK_MAX_BODY_BYTES` (default `262144`).
2. include any signature header value.

Expected:
1. response is `413`
2. event is not inserted into `stripe_webhook_events`

## 8. Negative Tests Checklist
1. Missing auth header on checkout/portal -> `401`
2. Invalid `workspaceId` UUID -> `400`
3. Non-member workspace access -> `403`
4. Viewer tries checkout/portal -> `403`
5. `plan_slug = enterprise` -> `403 CONTACT_SALES_REQUIRED`
6. `plan_slug = free` -> `400 INVALID_PLAN_FOR_CHECKOUT`
7. invalid interval value -> `400`
8. missing `Idempotency-Key` on checkout -> `400 FIELD_VALIDATION_FAILED`
9. same key + different payload -> `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`
10. same key after expiry -> `409 IDEMPOTENCY_KEY_EXPIRED`
11. missing webhook signature -> `400`
12. invalid webhook signature -> `400`
13. oversized webhook body -> `413`
14. duplicate webhook replay -> `200` and no duplicate side effects
15. `/api/v1/stripe/catalog/sync` without internal token -> `403`

## 9. Expected Response Shapes
Checkout success (`200`):
```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "session_id": "cs_test_...",
  "destination": "checkout"
}
```

Already subscribed (`200`):
```json
{
  "url": "https://billing.stripe.com/p/session/...",
  "destination": "portal",
  "reason": "ALREADY_SUBSCRIBED"
}
```

Portal success (`200`):
```json
{
  "url": "https://billing.stripe.com/p/session/..."
}
```

Enterprise blocked (`403`):
```json
{
  "error": "Enterprise plan is not available via self-serve checkout",
  "code": "CONTACT_SALES_REQUIRED",
  "contact_sales_url": "https://..."
}
```

Webhook invalid signature (`400`):
```json
{
  "error": "Invalid Stripe signature"
}
```

Idempotency key reused with different payload (`409`):
```json
{
  "error": "Idempotency key was reused with a different request payload",
  "code": "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"
}
```

Idempotency key expired (`409`):
```json
{
  "error": "Idempotency key is expired. Generate a new key and retry.",
  "code": "IDEMPOTENCY_KEY_EXPIRED"
}
```

Catalog out of sync (`409`):
```json
{
  "error": "Catalog is out of sync with Stripe",
  "code": "CATALOG_OUT_OF_SYNC",
  "correlation_id": "uuid"
}
```

Checkout internal failure (`500`):
```json
{
  "error": "Failed to create Stripe checkout session",
  "code": "STRIPE_CHECKOUT_SESSION_FAILED",
  "correlation_id": "uuid"
}
```

## 10. Recommended Smoke Sequence
Run in this order:
1. Login and capture `access_token`
2. Checkout success on free workspace (`7.1`)
3. Checkout idempotency replay/expiry suite (`7.17`, `7.18`, `7.19`)
4. Complete checkout on Stripe-hosted page
5. Verify webhook + subscription sync (`7.9`)
6. Re-call checkout for paid workspace (`7.5`)
7. Portal session success (`7.6`)
8. Payment failed/recovery (`7.11`, `7.12`)
9. Duplicate webhook idempotency (`7.14`)
10. Crash-safe lease reclaim (`7.20`)
11. Catalog sync and drift checks (`7.22`, `7.23`)

Pass criteria:
1. Success-path requests return expected `200`.
2. Validation and authorization violations return deterministic `4xx` codes.
3. Webhook rows converge to `completed` after retries.
4. `workspaces.plan` always matches active paid subscription or `free`.
5. Free-subscription race checks never produce duplicate non-Stripe entitled rows.
6. No unexpected `5xx` responses.

## 11. Release Checklist
1. `cmd /c npx tsc --noEmit` passes
2. Stripe test-mode checkout + portal flow passed
3. All subscribed webhook events verified
4. Checkout idempotency matrix verified (`replay`, `payload conflict`, `expiry`)
5. Webhook stale-lease reclaim validated
6. Grace-period downgrade and recovery validated
7. Catalog sync and unknown-price fallback validated
8. Production Stripe live IDs/secrets configured separately from test mode
9. `project-info-docs/stripe-dashboard-setup.md` completed and signed off
