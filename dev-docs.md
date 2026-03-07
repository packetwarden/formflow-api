# FormSandbox (FormFlow) Developer Documentation

Version: 2.6 (Edge-Native 2026 Architecture)  
Last Updated: February 28, 2026  
Owner: Backend Platform Team

## 1. Purpose
This document is the internal source of truth for FormSandbox backend implementation details, API contracts, database integration behavior, and schema version policy.

Use this document for:
1. onboarding backend engineers
2. validating route behavior before release
3. checking database contract assumptions
4. implementation references for future features

## 2. Critical Schema Policy
Current canonical schema: `project-info-docs/formflow_beta_schema_v2.sql`  
Previous schema (legacy reference only): `project-info-docs/formflow_beta_schema_v1.sql`

Rules:
1. New environments must be provisioned from V2 only.
2. New backend work must reference V2 function definitions and grants.
3. V1 remains historical and should not be used as deployment baseline.

## 3. Architecture Overview
Core philosophy:
1. Thin Edge, Thick Database.
2. Validate and authorize at Worker edge.
3. Push transactional consistency into Postgres functions and row-level security (RLS).

Primary stack:
1. Cloudflare Workers (compute)
2. Hono (routing)
3. Zod + `@hono/zod-validator` (request validation)
4. Supabase Postgres/Auth (database + identity)
5. TypeScript strict mode (type safety)

## 4. Repository Structure
```text
FormSandbox-v1/
├── src/
│   ├── index.ts
│   ├── db/
│   │   └── supabase.ts
│   ├── middlewares/
│   │   └── auth.ts
│   ├── routes/
│   │   ├── auth/index.ts
│   │   ├── build/index.ts
│   │   ├── f/index.ts
│   │   └── stripe/index.ts
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       └── validation.ts
├── project-info-docs/
│   ├── formflow_beta_schema_v1.sql
│   ├── formflow_beta_schema_v2.sql
│   └── migrations/
│       └── 2026-02-23_fix_publish_form.sql
├── changelog.md
├── dev-docs.md
└── wrangler.jsonc
```

## 5. Runtime Routing Topology
Main mount points in `src/index.ts`:
1. `/api/v1/auth` -> `src/routes/auth/index.ts`
2. `/api/v1/build` -> `src/routes/build/index.ts`
3. `/api/v1/f` -> `src/routes/f/index.ts`
4. `/api/v1/stripe` -> `src/routes/stripe/index.ts`

Global middleware:
1. `logger()`
2. `cors()`

Route-level write rate limiting (Cloudflare Worker-native):
1. `/api/v1/auth/*` write endpoints use `AUTH_WRITE_RATE_LIMITER`
2. `/api/v1/build/*` write endpoints use `BUILD_WRITE_RATE_LIMITER`
3. only `POST`, `PUT`, `PATCH`, `DELETE` are rate-limited

## 6. Authentication and Request Context Model
`requireAuth` middleware in `src/middlewares/auth.ts` performs:
1. Authorization header presence and Bearer format checks
2. token verification via `supabase.auth.getUser(token)`
3. request context enrichment:
   - `c.set('user', user)`
   - `c.set('accessToken', token)`

Context contract (`src/types/index.ts`):
1. `Variables.user: User | null`
2. `Variables.accessToken: string`

## 7. Supabase Client Pattern
`getSupabaseClient` in `src/db/supabase.ts` now supports request-scoped auth:
1. signature: `getSupabaseClient(url, key, accessToken?, extraHeaders?)`
2. if `accessToken` is provided, client is created with:
    - `global.headers.Authorization = Bearer <token>`
3. if `extraHeaders` is provided, headers are merged into `global.headers`:
   - runner usage: `x-forwarded-for`, `user-agent`, `referer`
4. hosted Supabase secret/publishable API keys are treated as non-JWT project keys:
   - supported formats: `sb_secret_*`, `sb_publishable_*`
   - when no explicit `accessToken` is present, the shared client strips `Authorization: Bearer <project_key>` before dispatch
   - `apikey` is preserved so the Supabase gateway can mint the short-lived backend JWT
5. `SUPABASE_SERVICE_ROLE_KEY` may be either:
   - legacy JWT `service_role`
   - hosted secret key `sb_secret_*`
6. edge-safe options enforced:
    - `auth.autoRefreshToken = false`
    - `auth.persistSession = false`
    - `auth.detectSessionInUrl = false`

Why this matters:
1. RLS is evaluated against the caller JWT, not service context.
2. Build routes remain multi-tenant safe with database-side access control.
3. runner/stripe backend paths remain compatible with modern hosted Supabase secret keys without mirroring non-JWT keys into `Authorization`.

## 8. Build API v1 (Beta-Complete)
Build router file: `src/routes/build/index.ts`

Global behavior:
1. all routes protected with `requireAuth`
2. path params validated with Zod UUID schemas
3. all form reads exclude soft-deleted rows (`deleted_at IS NULL`)
4. role-aware write authorization at edge:
   - read endpoints: workspace member-level visibility
   - create/update/publish: editor-level (`owner`, `admin`, `editor`)
   - delete: admin-level (`owner`, `admin`)
5. optimistic locking enforced on mutable form updates (`PATCH` metadata and `PUT` schema)
6. create-form path enforces `max_forms` entitlement via `get_workspace_entitlements`
7. submission read endpoints use bounded keyset pagination on (`created_at`, `id`) to avoid unbounded admin reads and timestamp-tie skips

### 8.1 GET `/api/v1/build/:workspaceId/forms`
Purpose: list workspace forms for builder dashboard.

Validation:
1. `workspaceId` must be UUID (`workspaceParamSchema`)

Data flow:
1. check workspace visibility (`workspaces.id`, `deleted_at IS NULL`)
2. list forms by `workspace_id`
3. order by `updated_at DESC`

Selected fields:
1. `id`
2. `workspace_id`
3. `title`
4. `description`
5. `slug`
6. `status`
7. `version`
8. `published_at`
9. `created_at`
10. `updated_at`
11. `current_submissions`
12. `max_submissions`
13. `accept_submissions`

Status mapping:
1. `200` success
2. `404` workspace not visible/not found
3. `500` query failures

### 8.2 POST `/api/v1/build/:workspaceId/forms`
Purpose: create a form with server-managed immutable slug.

Validation:
1. `workspaceId` UUID
2. body schema (`createFormSchema`):
   - required: `title`
   - optional: `description`, `schema`, `max_submissions`, `accept_submissions`, `success_message`, `redirect_url`

Create behavior:
1. requires editor-level workspace role
2. resolves `max_forms` entitlement:
   - if disabled: return `403` with `PLAN_FEATURE_DISABLED`
   - if limit reached: return `403` with `PLAN_LIMIT_EXCEEDED`
3. optional draft `schema` is validated against the shared runner-compatible contract before insert
4. slug is generated by server from title; client cannot set slug
5. slug collisions are auto-resolved with suffix retries

Entitlement error contract:
1. includes `code`, `feature`, `current`, `allowed`, `upgrade_url`

Status mapping:
1. `201` created
2. `403` insufficient role or entitlement violation
3. `404` workspace not visible/not found
4. `422` unsupported form schema (`UNSUPPORTED_FORM_SCHEMA`)
5. `500` validation/query failures

### 8.3 GET `/api/v1/build/:workspaceId/forms/:formId`
Purpose: load form draft for editor hydration.

Validation:
1. `workspaceId` UUID
2. `formId` UUID

Selected fields:
1. all summary fields above
2. `schema`

Status mapping:
1. `200` success
2. `404` form not visible/not found
3. `500` query failures

### 8.4 PATCH `/api/v1/build/:workspaceId/forms/:formId`
Purpose: update form metadata/settings with strict optimistic locking.

Validation:
1. `workspaceId` UUID
2. `formId` UUID
3. body schema (`updateFormMetaSchema`):
   - required: `version`
   - optional mutable fields:
     - `title`
     - `description`
     - `max_submissions`
     - `accept_submissions`
     - `success_message`
     - `redirect_url`
   - strict payload (unknown fields rejected)
   - at least one mutable field required

Write behavior:
1. requires editor-level workspace role
2. updates only when `forms.version = clientVersion`
3. sets `version = clientVersion + 1`
4. if no row updated:
   - return `404` if form missing/not visible
   - return `409` if stale version

Conflict response contract:
1. `{ error: "Version conflict", current_version: <number> }`

Status mapping:
1. `200` updated
2. `403` insufficient role
3. `404` form not found
4. `409` stale version conflict
5. `500` update/check failure

### 8.5 PUT `/api/v1/build/:workspaceId/forms/:formId`
Purpose: save draft schema with strict optimistic locking.

Validation:
1. `workspaceId` UUID
2. `formId` UUID
3. body schema (`updateDraftSchema`):
   - `schema` object with required keys:
     - `layout`
     - `theme`
     - `steps`
     - `logic`
     - `settings`
   - `version` integer `>= 1`
4. `schema` must satisfy the shared runner-compatible contract before save

Write behavior:
1. requires editor-level workspace role
2. updates only when `forms.version = clientVersion`
3. sets:
   - `schema = payload.schema`
   - `version = clientVersion + 1`
4. if no row updated:
   - re-check form existence
   - return `404` if missing
   - return `409` if stale

Conflict response contract:
1. `{ error: "Version conflict", current_version: <number> }`

Status mapping:
1. `200` updated
2. `403` insufficient role
3. `404` form not found
4. `409` stale version conflict
5. `422` unsupported form schema (`UNSUPPORTED_FORM_SCHEMA`)
6. `500` update/check failure

### 8.6 POST `/api/v1/build/:workspaceId/forms/:formId/publish`
Purpose: publish current draft as immutable version snapshot.

Validation:
1. `workspaceId` UUID
2. `formId` UUID
3. body schema (`publishFormSchema`):
   - `description?` string, trimmed, max length 500

Execution flow:
1. pre-check form visibility in workspace
2. validate current draft `schema` against the shared runner-compatible contract
3. call RPC `publish_form` with:
   - `p_form_id`
   - `p_published_by` (current user id)
   - `p_description`
4. map SQL privilege code `42501` to HTTP `403`

Status mapping:
1. `200` published
2. `401` user context missing
3. `403` unauthorized publish attempt
4. `404` form not found
5. `422` unsupported form schema (`UNSUPPORTED_FORM_SCHEMA`)
6. `500` RPC/db failure

### 8.7 DELETE `/api/v1/build/:workspaceId/forms/:formId`
Purpose: soft delete form for beta-safe archival behavior.

Validation:
1. `workspaceId` UUID
2. `formId` UUID

Delete behavior:
1. requires admin-level workspace role
2. soft delete by setting:
   - `deleted_at = now()`
   - `status = 'archived'`
3. deleted forms are excluded from all build read endpoints

Status mapping:
1. `200` deleted with `{ form_id, deleted_at }`
2. `403` insufficient role
3. `404` form not found/already deleted
4. `500` delete failure

### 8.8 GET `/api/v1/build/:workspaceId/forms/:formId/submissions`
Purpose: list submissions for a single form in builder/admin surfaces.

Validation:
1. `workspaceId` UUID
2. `formId` UUID
3. query schema (`buildSubmissionListQuerySchema`):
   - `limit` integer `1..100`, default `25`
   - `cursor_created_at?` ISO datetime string with timezone offset
   - `cursor_submission_id?` UUID
   - both cursor fields must be provided together

Data flow:
1. check workspace visibility (`workspaces.id`, `deleted_at IS NULL`)
2. pre-check form visibility in workspace (`forms.id`, `workspace_id`, `deleted_at IS NULL`)
3. query `form_submissions` by `form_id`
4. exclude soft-deleted submissions (`deleted_at IS NULL`)
5. order by `created_at DESC`, then `id DESC`
6. if cursor fields are present, apply keyset filter:
   - `created_at < cursor_created_at`
   - OR `created_at = cursor_created_at AND id < cursor_submission_id`
7. request `limit + 1` rows to determine whether another page exists

Selected fields:
1. `id`
2. `form_id`
3. `form_version_id`
4. `status`
5. `data`
6. `respondent_id`
7. `started_at`
8. `completed_at`
9. `completion_time_ms`
10. `created_at`
11. `updated_at`

Response contract:
1. `{ submissions: Submission[], next_cursor: { created_at, submission_id } | null }`
2. `next_cursor` is derived from the last returned row when more rows are available

Security notes:
1. access follows existing RLS policy `Members can view submissions`
2. route does not expose `idempotency_key`, `encrypted_pii`, or `deleted_at`

Status mapping:
1. `200` success
2. `404` workspace/form not visible or not found
3. `500` query failures

### 8.9 GET `/api/v1/build/:workspaceId/forms/:formId/submissions/:submissionId`
Purpose: fetch one submission with responder/network metadata for admin review.

Validation:
1. `workspaceId` UUID
2. `formId` UUID
3. `submissionId` UUID

Data flow:
1. check workspace visibility
2. pre-check form visibility
3. query `form_submissions` by `id` + `form_id`
4. exclude soft-deleted rows (`deleted_at IS NULL`)

Selected fields:
1. all list fields above
2. `ip_address`
3. `user_agent`
4. `referrer`
5. `geo_country`
6. `geo_city`
7. `spam_score`

Security notes:
1. route intentionally omits `idempotency_key`, `encrypted_pii`, and `deleted_at`

Status mapping:
1. `200` success
2. `404` workspace/form/submission not visible or not found
3. `500` query failures

## 8A. Runner API v1 (Beta-Complete)
Runner router file: `src/routes/f/index.ts`

Global behavior:
1. all runner routes are public (no bearer auth required)
2. path params validated with UUID schema (`runnerFormParamSchema`)
3. submit route requires `Idempotency-Key` header (UUID)
4. submit route performs strict fail-closed schema validation before DB write
5. submit route performs logic-aware sanitization (hidden fields stripped)
6. submit route rejects unknown payload keys (`FIELD_VALIDATION_FAILED`)
7. submit route enforces monthly entitlement (`max_submissions_monthly`)
8. submit route enforces strict DB rate limiting via `check_request()` before processing

### 8A.1 GET `/api/v1/f/:formId/schema`
Purpose: load public published schema by `forms.id` UUID.

Validation:
1. `formId` UUID (`runnerFormParamSchema`)

Data flow:
1. call RPC `get_published_form_by_id(p_form_id := formId)`
2. return published schema + public completion/meta settings

Response contract (`200`):
1. `form.id`
2. `form.title`
3. `form.description`
4. `form.published_schema`
5. `form.success_message`
6. `form.redirect_url`
7. `form.meta_title`
8. `form.meta_description`
9. `form.meta_image_url`
10. `form.captcha_enabled`
11. `form.captcha_provider`
12. `form.require_auth`
13. `form.password_protected`

Status mapping:
1. `200` success
2. `404` form not published/not visible/not open
3. `500` RPC/db failure

### 8A.2 POST `/api/v1/f/:formId/submit`
Purpose: submit a response using strict edge validation + DB atomic insert.

Validation:
1. `formId` UUID (`runnerFormParamSchema`)
2. header schema (`runnerIdempotencyHeaderSchema`)
   - required: `Idempotency-Key` UUID
3. body schema (`runnerSubmitBodySchema`)
   - required: `data` object
   - optional: `started_at` ISO datetime (offset required, max 5 minutes future skew, max age 30 days)

Execution flow:
1. run `check_request()` RPC (strict rate-limit gate: 2 submissions per 60 seconds per anon IP)
2. load form via `get_published_form_by_id`
3. fail closed if published form requires unsupported protected-form features:
   - `require_auth = true` -> `403 FORM_AUTH_REQUIRED`
   - `password_protected = true` -> `403 FORM_PASSWORD_REQUIRED`
   - `captcha_enabled = true` -> `403 CAPTCHA_REQUIRED_UNSUPPORTED`
4. parse `published_schema` into strict runner contract
5. evaluate `logic[]` and compute visibility for submitted payload
6. strip hidden field values from payload
7. reject unknown keys not present in published field registry
8. enforce strict field-level validation for visible fields
9. normalize request metadata before trusted submit:
   - invalid `referer` is dropped
   - blank/oversized `user-agent` is dropped
10. enforce monthly entitlement with `get_form_submission_quota`
11. build trusted submit client using `SUPABASE_SERVICE_ROLE_KEY`
   - supported values: legacy JWT `service_role` or hosted `sb_secret_*`
   - hosted secret keys are sent through `apikey`; the shared client strips invalid `Authorization: Bearer <secret>` fallback when no explicit JWT is present
12. call `submit_form` RPC with:
   - `p_form_id`
   - sanitized `p_data`
   - required `p_idempotency_key`
   - metadata passthrough (`p_ip_address`, `p_user_agent`, `p_referrer`, `p_started_at`)
13. return completion payload for runner UX

Strict validation contract:
1. required field properties: `id`, `type`
2. supported field types:
   - `text`, `textarea`, `email`, `number`, `tel`, `url`, `date`, `datetime`, `time`, `radio`, `select`, `multiselect`, `checkbox`, `boolean`, `rating`
3. supported validation keys:
   - `required`, `min`, `max`, `minLength`, `maxLength`, `pattern`, `options`
4. unsupported field type/validation key => `422` with code `UNSUPPORTED_FORM_SCHEMA`
5. unsupported logic operator/action/shape => `422` with code `UNSUPPORTED_FORM_SCHEMA`

Logic evaluator contract:
1. condition aliases: `if`, `when`, `conditions`
2. action aliases: `then`, `action`, `actions`
3. field aliases: `id`, `field_id`, `fieldId`, `key`, `name`
4. operators:
   - `eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, `exists`, `not_exists`
5. actions:
   - `show`, `hide`, `show_field`, `hide_field`, `set_visibility`
6. unsupported operator/action in published schema => fail closed

Success response contract (`201`):
1. `submission_id`
2. `success_message`
3. `redirect_url`

Status mapping:
1. `201` submission accepted
2. `400` invalid header/body/param shape
3. `403` protected form / entitlement blocked (`FORM_AUTH_REQUIRED`, `FORM_PASSWORD_REQUIRED`, `CAPTCHA_REQUIRED_UNSUPPORTED`, `PLAN_FEATURE_DISABLED`, `PLAN_LIMIT_EXCEEDED`)
4. `404` form not found
5. `409` form state conflict from `submit_form` RPC
6. `422` strict schema or field validation failure (`UNSUPPORTED_FORM_SCHEMA`, `FIELD_VALIDATION_FAILED`)
7. `429` rate-limited
8. `500` internal or RPC failure
   - privileged submit RPC auth/config failure returns `RUNNER_BACKEND_AUTH_MISCONFIGURED`

### 8A.3 Submit Runtime Hardening (Post Dependency Upgrade)
Additional hardening in `src/routes/f/index.ts`:
1. `parseStrictRateLimitError` safely parses non-standard RPC error payloads before status/code mapping.
2. `/submit` handler is wrapped in a guarded `try/catch` and logs unhandled failures using:
   - `console.error('Runner submit unhandled error:', error)`
3. unhandled runtime failures now return deterministic JSON instead of opaque worker text-only 500:
   - `{ "error": "Failed to submit form", "code": "RUNNER_INTERNAL_ERROR" }`
4. `@hono/zod-validator` remains in use for both route param and JSON body validation.

## 8B. Stripe Billing API v4 (Crash-Safe, Drift-Safe, Race-Hardened)
Stripe router file: `src/routes/stripe/index.ts`

Endpoints:
1. `POST /api/v1/stripe/workspaces/:workspaceId/checkout-session`
2. `POST /api/v1/stripe/workspaces/:workspaceId/portal-session`
3. `POST /api/v1/stripe/webhook`
4. `POST /api/v1/stripe/catalog/sync` (internal token-protected)

Checkout + portal behavior:
1. both session endpoints require authenticated owner/admin workspace role
2. self-serve checkout supports paid tiers only (`pro`, `business`)
3. enterprise checkout is blocked with `CONTACT_SALES_REQUIRED`
4. checkout requires `Idempotency-Key` UUID header and stores attempt state in `stripe_checkout_idempotency`
5. idempotency outcomes:
   - same key + same payload + under 24 hours returns cached checkout session
   - same key + different payload returns `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`
   - same key after 24 hours returns `IDEMPOTENCY_KEY_EXPIRED`
6. if a workspace already has active paid subscription, checkout endpoint returns portal URL with:
   - `destination: "portal"`
   - `reason: "ALREADY_SUBSCRIBED"`
7. checkout session uses hosted Stripe Checkout subscription mode with:
    - promotion codes enabled
    - `automatic_tax.enabled = true`
    - optional trial days from `plan_variants.trial_period_days`
    - metadata (`workspace_id`, `plan_variant_id`, `requested_by_user_id`)
8. checkout can return `CATALOG_OUT_OF_SYNC` when Stripe price mappings cannot be reconciled
9. checkout error responses return stable app `code` values; Stripe internals stay server-side and include `correlation_id` for traceability
10. one Stripe customer is enforced per workspace in `workspace_billing_customers`
11. checkout/portal validate mapped `stripe_customer_id` against Stripe before session creation
12. if mapped customer is deleted/missing, service invalidates mapping, recreates customer, and retries session creation once
13. customer mapping audit entries are written to `workspace_billing_customer_events` with event types:
   - `validated`
   - `invalidated`
   - `recreated`
   - `webhook_deleted`

Catalog sync behavior:
1. Stripe is source-of-truth for recurring sellable prices
2. sync maps Stripe -> DB via metadata/lookup key convention:
   - lookup key: `formsandbox:{env}:{plan_slug}:{interval}:usd`
   - metadata: `plan_slug`, `interval`, `self_serve`
3. `/api/v1/stripe/catalog/sync` accepts either `x-internal-admin-token` or `Authorization: Bearer <token>`
4. if both internal auth headers are present and differ, request is rejected with `403`
5. missing `STRIPE_INTERNAL_ADMIN_TOKEN` is treated as worker misconfiguration and returns `500 BILLING_CONFIG_MISSING`
3. default scheduled sync cron is `*/15 * * * *` (env override: `STRIPE_CATALOG_SYNC_CRON`)
4. webhook unknown `price_id` path attempts one forced sync + retry before marking failed
5. `/api/v1/stripe/catalog/sync` is catalog-only and does not repair workspace customer mappings

Webhook behavior:
1. verifies `stripe-signature` using Stripe SDK `constructEventAsync`
2. enforces payload size guard before parse (`STRIPE_WEBHOOK_MAX_BODY_BYTES`)
3. `invoice.created` is acknowledged immediately with `200` after signature verification (fast-ack path; no durable queue insert)
4. non-ack-only events insert `event_id` idempotently into `stripe_webhook_events`
5. duplicate non-ack-only event inserts return `200` without reprocessing
6. accepted non-ack-only events are processed asynchronously via lease-based claim processing:
   - claim due `pending|failed`
   - reclaim stale `processing` by expired `claim_expires_at` (and legacy `NULL` claim rows)
7. subscription state sync updates:
   - `subscriptions` (authoritative source of truth)
   - `workspaces.plan` UI cache via DB trigger-coupled sync
8. `invoice.payment_failed`, `invoice.payment_action_required`, and `invoice.payment_attempt_required` set `grace_period_end` (no invoice-driven status overwrite)
9. `invoice.paid` clears `grace_period_end`
10. `customer.subscription.*` and `customer.subscription.trial_will_end` paths fetch the latest Stripe subscription snapshot before DB sync
11. stale-event guard is applied using `subscriptions.last_stripe_event_created_at` watermark fields
12. `invoice.finalization_failed` syncs from Stripe, then enforces local `status = unpaid`; plan cache convergence is handled by DB trigger/reconcile (no synthetic free row insert)
13. `unpaid`, `paused`, `canceled`, and `incomplete_expired` statuses converge workspace access to implicit free without synthetic free rows
14. `incomplete` status is persisted as payment-pending and remains non-entitled (workspace plan cache remains `free` until entitled status)
15. `customer.subscription.trial_will_end` is processed with subscription sync and structured operational logging (no outbound notifier in current release)

Webhook event coverage:
1. `checkout.session.completed`
2. `customer.deleted`
3. `customer.subscription.created`
4. `customer.subscription.updated`
5. `customer.subscription.deleted`
6. `customer.subscription.paused`
7. `customer.subscription.resumed`
8. `customer.subscription.trial_will_end`
9. `invoice.created` (ack-only)
10. `invoice.payment_failed`
11. `invoice.payment_action_required`
12. `invoice.payment_attempt_required` (forward-compatible alias handling)
13. `invoice.finalization_failed`
14. `invoice.paid`

Scheduled jobs (Worker `scheduled` handler):
1. webhook replay pass (`*/5 * * * *`):
   - retries due `pending|failed` rows under attempt cap
   - reclaims stale `processing` rows
2. grace-period downgrade pass (`0 * * * *`):
   - downgrades expired `past_due` subscriptions to free
3. catalog sync pass (`*/15 * * * *` by default):
   - syncs Stripe recurring prices into active `plan_variants`
4. webhook cleanup pass (`30 2 * * *`):
   - purges completed webhook rows older than retention window
   - runs `reconcile_workspace_plan_cache(...)` and logs drift count/sample workspace IDs

## 9. Validation Catalog
Validation file: `src/utils/validation.ts`

Auth schemas:
1. `signUpSchema`
2. `loginSchema`
3. `normalizedEmailSchema`
4. `passwordSchema`
5. `loginPasswordSchema`
6. `optionalDisplayNameSchema`

Build schemas:
1. `workspaceParamSchema`
2. `formParamSchema`
3. `buildParamSchema`
4. `draftSchemaShape`
5. `createFormSchema`
6. `updateFormMetaSchema`
7. `updateDraftSchema`
8. `publishFormSchema`
9. `clearableTextSchema`
10. `absoluteHttpUrlSchema`
11. `clearableAbsoluteHttpUrlSchema`

Runner schemas:
1. `runnerFormParamSchema`
2. `runnerSubmitBodySchema`
3. `runnerIdempotencyHeaderSchema`
4. `startedAtSchema`
5. `safeRefererSchema`
6. `safeUserAgentSchema`

Stripe schemas:
1. `stripeCheckoutSessionSchema`
2. `stripeCheckoutIdempotencyHeaderSchema`
3. `stripeSignatureHeaderSchema`
4. `internalAdminAuthHeaderSchema`

Shared form contract file: `src/utils/form-contract.ts`
1. `parsePublishedContract(...)`
2. `sanitizeAndValidateData(...)`

## 10. Database Contract Updates in V2
Schema file: `project-info-docs/formflow_beta_schema_v2.sql`

Canonical launch baseline status:
1. V2 now includes the fresh-install launch contract through `2026-03-06_function_search_path_hardening_v3.sql`.
2. Fresh installs from V2 already include:
   - `workspace_billing_customers`
   - `workspace_billing_customer_events`
   - `stripe_checkout_idempotency`
   - `claim_stripe_webhook_event(...)`
   - `refresh_workspace_plan_cache(...)`
   - `reconcile_workspace_plan_cache(...)`
   - `apply_stripe_subscription_snapshot(...)`
   - webhook lease columns on `stripe_webhook_events`
   - Stripe event watermark columns on `subscriptions`
3. Post-V2 migration files remain the incremental upgrade path for already-provisioned environments.

`publish_form` changes merged into V2:
1. fixed settings source:
   - old: `SELECT schema, settings FROM public.forms` (invalid in beta schema)
   - new: `COALESCE(schema -> 'settings', '{}'::jsonb)`
2. added publish authorization guard inside function:
   - `p_published_by` must equal `(SELECT auth.uid())`
   - workspace must be in `private.user_editable_workspace_ids()`
   - unauthorized call raises SQLSTATE `42501`
3. function execution hardening:
   - `REVOKE ALL ON FUNCTION public.publish_form(UUID, UUID, TEXT) FROM PUBLIC`
   - `GRANT EXECUTE ON FUNCTION public.publish_form(UUID, UUID, TEXT) TO authenticated`
4. SECURITY DEFINER hardening:
   - trigger SECURITY DEFINER functions use `SET search_path = ''`
   - `submit_form(...)` enforces trusted service-role execution in-function using PostgREST request role (`current_setting('role', true)`) with legacy JWT-claim fallback
   - hosted `sb_secret_*` backend keys remain compatible because request role resolves `service_role` even when `request.jwt.claim.role` is absent
   - `REVOKE CREATE ON SCHEMA public FROM PUBLIC` to reduce object-shadowing risk

Runner contract additions in V2:
1. `get_published_form_by_id(UUID)`:
   - public runner loader by `forms.id`
   - returns published schema + completion/meta settings
2. `get_form_submission_quota(UUID)`:
    - resolves workspace from form id
    - returns `max_submissions_monthly` entitlement + current monthly usage
3. execute privilege hardening:
   - `check_request()`: revoked from `PUBLIC`, granted to `anon` only
   - `submit_form(...)`: revoked from `PUBLIC`, granted to `service_role`
   - `get_workspace_entitlements(UUID)`: revoked from `PUBLIC, anon, authenticated`; granted to `authenticated, service_role`
   - `get_published_form(TEXT, TEXT)`: revoked from `PUBLIC`; granted to `anon, authenticated`
   - runner helper functions revoked from `PUBLIC`, granted to `anon, authenticated`
4. submission table hardening:
   - removed permissive insert policy (`WITH CHECK (true)`) on `public.form_submissions`
   - revoked direct `INSERT` on `public.form_submissions` from `anon` and `authenticated`
5. troubleshooting signal for hosted secret-key drift:
   - Supabase API logs showing `jwt: []` together with `Authorization: Bearer sb_secret_...` and `403/42501` on `/rest/v1/rpc/submit_form` indicate backend client misconfiguration, not caller authorization failure

RLS initplan wrapper hardening in V2:
1. all policies that use `private.user_workspace_ids()`, `private.user_editable_workspace_ids()`, or `private.user_admin_workspace_ids()` now use:
   - `= ANY(ARRAY(SELECT ...))`
2. `publish_form(...)` authorization check now uses:
   - `NOT (v_workspace_id = ANY(ARRAY(SELECT private.user_editable_workspace_ids())))`
3. no new `workspace_id` indexes were added in this hardening pass:
   - active schema already has leading `workspace_id` B-tree coverage for RLS paths (`workspace_members`, `forms`, `subscriptions`)

Least-privilege grants hardening v1 in V2:
1. removed broad table-level grants to `authenticated` on:
   - `profiles`, `workspaces`, `workspace_members`, `forms`, `form_versions`, `form_submissions`
2. removed direct `anon` table grants on core builder tables:
   - `profiles`, `workspaces`, `workspace_members`, `forms`, `form_versions`, `form_submissions`
3. direct authenticated writes are now limited to `public.forms` with column-level grants:
   - `INSERT`: `workspace_id`, `title`, `slug`, `description`, `schema`, `max_submissions`, `accept_submissions`, `success_message`, `redirect_url`
   - `UPDATE`: `title`, `description`, `schema`, `max_submissions`, `accept_submissions`, `success_message`, `redirect_url`, `version`, `status`, `deleted_at`
4. direct hard-delete grant paths removed from soft-delete tables for `authenticated`:
   - `profiles`, `workspaces`, `forms`, `form_submissions`

Function search-path hardening v3 in V2:
1. pinned `SET search_path = ''` on trigger helper functions:
   - `public.set_updated_at()`
   - `public.cascade_soft_delete()`
2. resolves Security Advisor "Function Search Path Mutable" findings for these functions

Migration sources now folded into canonical V2 baseline:
1. `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
2. `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
3. `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
4. `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql`
5. `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2.sql`
6. `project-info-docs/migrations/2026-02-26_stripe_customer_mapping_recovery_v3.sql`
7. `project-info-docs/migrations/2026-02-26_stripe_incomplete_status_v4.sql`
8. `project-info-docs/migrations/2026-02-27_runner_submission_gateway_hardening_v1.sql`
9. `project-info-docs/migrations/2026-02-27_security_definer_hardening_v2.sql`
10. `project-info-docs/migrations/2026-03-02_rls_initplan_wrapper_hardening_v1.sql`
11. `project-info-docs/migrations/2026-03-04_implicit_free_entitlements_v5.sql`
12. `project-info-docs/migrations/2026-03-04_stripe_plan_cache_consistency_v6.sql`
13. `project-info-docs/migrations/2026-03-05_grants_least_privilege_hardening_v1.sql`
14. `project-info-docs/migrations/2026-03-06_function_search_path_hardening_v3.sql`
15. `project-info-docs/migrations/2026-03-07_runner_service_role_secret_key_compat_v1.sql`
16. `project-info-docs/migrations/2026-03-07_build_submission_read_grants_v1.sql`

## 11. Implementation Files Added or Updated
Updated:
1. `src/routes/build/index.ts`
2. `src/utils/validation.ts`
3. `src/middlewares/auth.ts`
4. `src/types/index.ts`
5. `src/db/supabase.ts`
6. `src/routes/f/index.ts`
7. `src/routes/stripe/index.ts`
8. `src/index.ts`
9. `src/utils/workspace-access.ts`
10. `changelog.md`
11. `dev-docs.md`
12. `project-info-docs/formflow_beta_schema_v2.sql`

Added:
1. `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
2. `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
3. `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
4. `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql`
5. `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2.sql`
6. `project-info-docs/migrations/2026-02-26_stripe_customer_mapping_recovery_v3.sql`
7. `project-info-docs/migrations/2026-02-26_stripe_incomplete_status_v4.sql`
8. `project-info-docs/migrations/2026-02-27_runner_submission_gateway_hardening_v1.sql`
9. `project-info-docs/migrations/2026-02-27_security_definer_hardening_v2.sql`
10. `project-info-docs/migrations/2026-03-02_rls_initplan_wrapper_hardening_v1.sql`
11. `project-info-docs/migrations/2026-03-04_implicit_free_entitlements_v5.sql`
12. `project-info-docs/migrations/2026-03-04_stripe_plan_cache_consistency_v6.sql`
13. `project-info-docs/migrations/2026-03-05_grants_least_privilege_hardening_v1.sql`
14. `project-info-docs/migrations/2026-03-06_function_search_path_hardening_v3.sql`
15. `project-info-docs/migrations/2026-03-07_runner_service_role_secret_key_compat_v1.sql`
16. `project-info-docs/migrations/2026-03-07_build_submission_read_grants_v1.sql`
17. `project-info-docs/stripe-implementation.md`
18. `runner-api-beta.md`
19. `test-runner-public-v1.md`

## 12. Operational Runbook
For fresh database setup:
1. execute `project-info-docs/formflow_beta_schema_v2.sql`
2. no follow-up migrations are required for the current launch contract
3. do not bootstrap from V1

For existing V1 environments:
1. execute `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
2. execute `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
3. execute `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
4. execute `project-info-docs/migrations/2026-02-27_runner_submission_gateway_hardening_v1.sql`
5. execute `project-info-docs/migrations/2026-02-27_security_definer_hardening_v2.sql`
6. execute `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql`
7. execute `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2.sql`
8. execute `project-info-docs/migrations/2026-02-26_stripe_customer_mapping_recovery_v3.sql`
9. execute `project-info-docs/migrations/2026-02-26_stripe_incomplete_status_v4.sql`
10. execute `project-info-docs/migrations/2026-03-02_rls_initplan_wrapper_hardening_v1.sql`
11. execute `project-info-docs/migrations/2026-03-04_implicit_free_entitlements_v5.sql`
12. execute `project-info-docs/migrations/2026-03-04_stripe_plan_cache_consistency_v6.sql`
13. execute `project-info-docs/migrations/2026-03-05_grants_least_privilege_hardening_v1.sql`
14. execute `project-info-docs/migrations/2026-03-06_function_search_path_hardening_v3.sql`
15. execute `project-info-docs/migrations/2026-03-07_runner_service_role_secret_key_compat_v1.sql`
16. execute `project-info-docs/migrations/2026-03-07_build_submission_read_grants_v1.sql`
17. verify function privileges, table/column grants hardening, search-path hardening, webhook lease reclaim, checkout idempotency, customer-recovery audit behavior, pending-payment status handling, RLS initplan wrapper predicates, implicit-free entitlement fallback, plan-cache trigger sync, stale-event watermark behavior, and reconciliation RPC behavior

Emergency rollback (Stripe v2 -> Stripe v1):
1. roll back backend code to the last Stripe v1 git revision
2. execute `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2_rollback_to_v1.sql`
3. if rollback blocks on duplicate active-like subscriptions, resolve duplicates per script hint and rerun
4. verify checkout/portal/webhook flows with `test-stripe-v1.md` v1-compatible subset

Recommended verification SQL:
```sql
-- ensure core functions exist
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
      'publish_form',
      'submit_form',
      'check_request',
      'get_published_form_by_id',
      'get_form_submission_quota',
      'claim_stripe_webhook_event',
      'refresh_workspace_plan_cache',
      'reconcile_workspace_plan_cache',
      'apply_stripe_subscription_snapshot'
  );

-- ensure launch-only Stripe tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
      'workspace_billing_customers',
      'workspace_billing_customer_events',
      'stripe_checkout_idempotency',
      'stripe_webhook_events'
  )
ORDER BY table_name;

-- ensure webhook lease and Stripe watermark columns are present
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
      (table_name = 'stripe_webhook_events' AND column_name IN (
          'processor_id',
          'processing_started_at',
          'claim_expires_at',
          'next_attempt_at'
      ))
      OR (table_name = 'subscriptions' AND column_name IN (
          'last_stripe_event_id',
          'last_stripe_event_type',
          'last_stripe_event_created_at'
      ))
  )
ORDER BY table_name, column_name;

-- verify trigger helper functions pin search_path
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('set_updated_at', 'cascade_soft_delete');

-- verify service-role-only RPC grants
SELECT routine_name, grantee, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_schema = 'public'
  AND routine_name IN (
      'claim_stripe_webhook_event',
      'refresh_workspace_plan_cache',
      'reconcile_workspace_plan_cache',
      'apply_stripe_subscription_snapshot'
  )
ORDER BY routine_name, grantee, privilege_type;

-- verify least-privilege table grants for authenticated on core builder tables
SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS table_privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'authenticated'
  AND table_name IN (
      'profiles',
      'workspaces',
      'workspace_members',
      'forms',
      'form_versions',
      'form_submissions'
  )
GROUP BY table_name
ORDER BY table_name;

-- verify anon has no direct table privileges on core builder tables
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND table_name IN (
      'profiles',
      'workspaces',
      'workspace_members',
      'forms',
      'form_versions',
      'form_submissions'
  );

-- verify no direct DELETE grants remain on soft-delete tables
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'authenticated'
  AND privilege_type = 'DELETE'
  AND table_name IN ('profiles', 'workspaces', 'forms', 'form_submissions');

-- verify forms has no table-level UPDATE grant for authenticated
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'authenticated'
  AND table_name = 'forms'
  AND privilege_type = 'UPDATE';

-- verify forms column-level INSERT/UPDATE grant set for authenticated
SELECT privilege_type, column_name
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'forms'
  AND grantee = 'authenticated'
  AND privilege_type IN ('INSERT', 'UPDATE')
ORDER BY privilege_type, column_name;

-- verify no direct anon/authenticated grants exist on service-role-only Stripe tables
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN (
      'workspace_billing_customers',
      'workspace_billing_customer_events',
      'stripe_checkout_idempotency',
      'stripe_webhook_events'
  );

-- ensure plan-cache sync trigger is present on subscriptions
SELECT t.tgname
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'subscriptions'
  AND t.tgname = 'sync_workspace_plan_cache_from_subscriptions'
  AND NOT t.tgisinternal;

-- ensure removed free-row artifacts are absent
SELECT
  to_regprocedure('public.ensure_free_subscription_for_workspace(uuid,text)') AS ensure_free_rpc,
  to_regprocedure('public.handle_new_workspace_subscription()') AS workspace_trigger_fn;

SELECT t.tgname
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'workspaces'
  AND t.tgname = 'on_workspace_created_subscription'
  AND NOT t.tgisinternal;

-- ensure no synthetic free subscription rows remain
SELECT COUNT(*) AS synthetic_free_rows
FROM public.subscriptions s
JOIN public.plans p ON p.id = s.plan_id
WHERE p.slug = 'free'
  AND s.stripe_subscription_id IS NULL;

-- ensure removed non-Stripe entitled uniqueness index is absent
SELECT to_regclass('public.idx_subscriptions_one_non_stripe_entitled') AS removed_non_stripe_index;

-- ensure no touched policy still contains raw helper form:
--   IN (SELECT private.user_*_workspace_ids())
SELECT tablename, policyname
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname IN (
      'Users can view workspace co-members',
      'Users can view their workspaces',
      'Members can view workspace members',
      'Admins can add members',
      'Admins can update members',
      'Admins can remove members',
      'Members can view workspace forms',
      'Editors can create forms',
      'Editors can update forms',
      'Admins can delete forms',
      'Members can view form versions',
      'Members can view submissions',
      'Editors can update submissions',
      'Admins can delete submissions',
      'Members can view workspace subscriptions'
  )
  AND (
      COALESCE(qual, '') ~ 'IN \\(SELECT private\\.user_(workspace|editable_workspace|admin_workspace)_ids\\(\\)\\)'
      OR COALESCE(with_check, '') ~ 'IN \\(SELECT private\\.user_(workspace|editable_workspace|admin_workspace)_ids\\(\\)\\)'
  );

-- ensure touched policies use wrapper form:
--   ANY(ARRAY(SELECT private.user_*_workspace_ids()))
SELECT tablename, policyname
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname IN (
      'Users can view workspace co-members',
      'Users can view their workspaces',
      'Members can view workspace members',
      'Admins can add members',
      'Admins can update members',
      'Admins can remove members',
      'Members can view workspace forms',
      'Editors can create forms',
      'Editors can update forms',
      'Admins can delete forms',
      'Members can view form versions',
      'Members can view submissions',
      'Editors can update submissions',
      'Admins can delete submissions',
      'Members can view workspace subscriptions'
  )
  AND NOT (
      COALESCE(qual, '') ~ 'ANY\\(ARRAY\\(SELECT private\\.user_(workspace|editable_workspace|admin_workspace)_ids\\(\\)\\)\\)'
      OR COALESCE(with_check, '') ~ 'ANY\\(ARRAY\\(SELECT private\\.user_(workspace|editable_workspace|admin_workspace)_ids\\(\\)\\)\\)'
  );

-- verify leading workspace_id index coverage for core RLS paths
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('workspace_members', 'forms', 'subscriptions')
  AND indexdef ~* '\\(workspace_id(,|\\))';

-- representative RLS execution plans (run as authenticated role/session)
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT id, workspace_id, status, updated_at
FROM public.forms
ORDER BY updated_at DESC
LIMIT 50;

EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT s.id, s.form_id, s.created_at
FROM public.form_submissions s
JOIN public.forms f ON f.id = s.form_id
ORDER BY s.created_at DESC
LIMIT 50;
```

## 13. Development Commands
Install:
```bash
npm install
```

Run local worker:
```bash
npm run dev
```

Generate Worker bindings types:
```bash
npm run cf-typegen
```

Type-check:
```bash
.\node_modules\.bin\tsc.cmd --noEmit
```

Deploy:
```bash
npm run deploy
```

## 14. Known Gaps and Next Targets
Planned next backend milestones:
1. automated Stripe test matrix (webhook fixtures + end-to-end checkout/portal simulation + crash-lease reclaim)
2. optional worker-side entitlement KV cache for high-throughput runner traffic
3. expanded runner schema contract support for advanced field types/actions (deferred)

## 15. Documentation Governance
When backend behavior changes:
1. update `dev-docs.md` in the same PR
2. update `changelog.md`
3. if SQL contract changed, update schema baseline and migration docs
4. keep schema policy section current (active version pointer)

## 16. Frontend Integration (Stripe v2)
1. Frontend must generate a new UUID `Idempotency-Key` for each checkout attempt.
2. Frontend may retry with the same key only for the same plan/interval payload.
3. Frontend must rotate the key after 24 hours (server returns `IDEMPOTENCY_KEY_EXPIRED`).
4. Frontend must never reuse the same key for a different payload (server returns `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`).
