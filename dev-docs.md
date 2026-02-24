# FormSandbox (FormFlow) Developer Documentation

Version: 2.5 (Edge-Native 2026 Architecture)  
Last Updated: February 24, 2026  
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
4. edge-safe options enforced:
    - `auth.autoRefreshToken = false`
    - `auth.persistSession = false`
    - `auth.detectSessionInUrl = false`

Why this matters:
1. RLS is evaluated against the caller JWT, not service context.
2. Build routes remain multi-tenant safe with database-side access control.

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
3. slug is generated by server from title; client cannot set slug
4. slug collisions are auto-resolved with suffix retries

Entitlement error contract:
1. includes `code`, `feature`, `current`, `allowed`, `upgrade_url`

Status mapping:
1. `201` created
2. `403` insufficient role or entitlement violation
3. `404` workspace not visible/not found
4. `500` validation/query failures

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
5. `500` update/check failure

### 8.6 POST `/api/v1/build/:workspaceId/forms/:formId/publish`
Purpose: publish current draft as immutable version snapshot.

Validation:
1. `workspaceId` UUID
2. `formId` UUID
3. body schema (`publishFormSchema`):
   - `description?` string, trimmed, max length 500

Execution flow:
1. pre-check form visibility in workspace
2. call RPC `publish_form` with:
   - `p_form_id`
   - `p_published_by` (current user id)
   - `p_description`
3. map SQL privilege code `42501` to HTTP `403`

Status mapping:
1. `200` published
2. `401` user context missing
3. `403` unauthorized publish attempt
4. `404` form not found
5. `500` RPC/db failure

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
   - optional: `started_at` ISO datetime (offset required)

Execution flow:
1. run `check_request()` RPC (strict rate-limit gate: 2 submissions per 60 seconds per anon IP)
2. load form via `get_published_form_by_id`
3. parse `published_schema` into strict runner contract
4. evaluate `logic[]` and compute visibility for submitted payload
5. strip hidden field values from payload
6. reject unknown keys not present in published field registry
7. enforce strict field-level validation for visible fields
8. enforce monthly entitlement with `get_form_submission_quota`
9. call `submit_form` RPC with:
   - `p_form_id`
   - sanitized `p_data`
   - required `p_idempotency_key`
   - metadata passthrough (`p_ip_address`, `p_user_agent`, `p_referrer`, `p_started_at`)
10. return completion payload for runner UX

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
3. `403` entitlement blocked (`PLAN_FEATURE_DISABLED`, `PLAN_LIMIT_EXCEEDED`)
4. `404` form not found
5. `409` form state conflict from `submit_form` RPC
6. `422` strict schema or field validation failure (`UNSUPPORTED_FORM_SCHEMA`, `FIELD_VALIDATION_FAILED`)
7. `429` rate-limited
8. `500` internal or RPC failure

### 8A.3 Submit Runtime Hardening (Post Dependency Upgrade)
Additional hardening in `src/routes/f/index.ts`:
1. `parseStrictRateLimitError` safely parses non-standard RPC error payloads before status/code mapping.
2. `/submit` handler is wrapped in a guarded `try/catch` and logs unhandled failures using:
   - `console.error('Runner submit unhandled error:', error)`
3. unhandled runtime failures now return deterministic JSON instead of opaque worker text-only 500:
   - `{ "error": "Failed to submit form", "code": "RUNNER_INTERNAL_ERROR" }`
4. `@hono/zod-validator` remains in use for both route param and JSON body validation.

## 8B. Stripe Billing API v1 (Implemented)
Stripe router file: `src/routes/stripe/index.ts`

Endpoints:
1. `POST /api/v1/stripe/workspaces/:workspaceId/checkout-session`
2. `POST /api/v1/stripe/workspaces/:workspaceId/portal-session`
3. `POST /api/v1/stripe/webhook`

Checkout + portal behavior:
1. both session endpoints require authenticated owner/admin workspace role
2. self-serve checkout supports paid tiers only (`pro`, `business`)
3. enterprise checkout is blocked with `CONTACT_SALES_REQUIRED`
4. if a workspace already has active paid subscription, checkout endpoint returns portal URL with:
   - `destination: "portal"`
   - `reason: "ALREADY_SUBSCRIBED"`
5. checkout session uses hosted Stripe Checkout subscription mode with:
   - promotion codes enabled
   - automatic tax enabled
   - optional trial days from `plan_variants.trial_period_days`
   - metadata (`workspace_id`, `plan_variant_id`, `requested_by_user_id`)

Webhook behavior:
1. verifies `stripe-signature` using Stripe SDK `constructEventAsync`
2. inserts `event_id` idempotently into `stripe_webhook_events`
3. duplicate event inserts return `200` without reprocessing
4. accepted events are processed asynchronously via `waitUntil`
5. subscription state sync updates:
   - `subscriptions` (source of truth)
   - `workspaces.plan` cache

Webhook event coverage:
1. `checkout.session.completed`
2. `customer.subscription.created`
3. `customer.subscription.updated`
4. `customer.subscription.deleted`
5. `invoice.payment_failed`
6. `invoice.paid`

Scheduled jobs (Worker `scheduled` handler):
1. webhook replay pass (`*/5 * * * *`):
   - retries `pending|failed` rows under attempt cap
2. grace-period downgrade pass (`0 * * * *`):
   - downgrades expired `past_due` subscriptions to free
   - refreshes `workspaces.plan`

## 9. Validation Catalog
Validation file: `src/utils/validation.ts`

Auth schemas:
1. `signUpSchema`
2. `loginSchema`

Build schemas:
1. `workspaceParamSchema`
2. `formParamSchema`
3. `buildParamSchema`
4. `draftSchemaShape`
5. `createFormSchema`
6. `updateFormMetaSchema`
7. `updateDraftSchema`
8. `publishFormSchema`

Runner schemas:
1. `runnerFormParamSchema`
2. `runnerSubmitBodySchema`
3. `runnerIdempotencyHeaderSchema`

## 10. Database Contract Updates in V2
Schema file: `project-info-docs/formflow_beta_schema_v2.sql`

`publish_form` changes merged into V2:
1. fixed settings source:
   - old: `SELECT schema, settings FROM public.forms` (invalid in beta schema)
   - new: `COALESCE(schema -> 'settings', '{}'::jsonb)`
2. added publish authorization guard inside function:
   - workspace must be in `private.user_editable_workspace_ids()`
   - unauthorized call raises SQLSTATE `42501`
3. function execution hardening:
   - `REVOKE ALL ON FUNCTION public.publish_form(UUID, UUID, TEXT) FROM PUBLIC`
   - `GRANT EXECUTE ON FUNCTION public.publish_form(UUID, UUID, TEXT) TO authenticated`

Runner contract additions in V2:
1. `get_published_form_by_id(UUID)`:
   - public runner loader by `forms.id`
   - returns published schema + completion/meta settings
2. `get_form_submission_quota(UUID)`:
    - resolves workspace from form id
    - returns `max_submissions_monthly` entitlement + current monthly usage
3. execute privilege hardening:
   - `check_request()`: revoked from `PUBLIC`, granted to `anon, authenticated`
   - `submit_form(...)`: revoked from `PUBLIC`, granted to `anon, authenticated`
   - runner helper functions revoked from `PUBLIC`, granted to `anon, authenticated`

Migration source file:
1. `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
2. `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
3. `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
4. `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql`

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
5. `project-info-docs/stripe-implementation.md`
6. `runner-api-beta.md`
7. `test-runner-public-v1.md`

## 12. Operational Runbook
For fresh database setup:
1. execute `project-info-docs/formflow_beta_schema_v2.sql`
2. do not bootstrap from V1

For existing V1 environments:
1. execute `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
2. execute `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
3. execute `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
4. execute `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql`
5. verify function privileges and runner behavior

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
      'get_form_submission_quota'
  );
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
1. automated Stripe test matrix (webhook fixtures + end-to-end checkout/portal simulation)
2. optional worker-side entitlement KV cache for high-throughput runner traffic
3. expanded runner schema contract support for advanced field types/actions (deferred)

## 15. Documentation Governance
When backend behavior changes:
1. update `dev-docs.md` in the same PR
2. update `changelog.md`
3. if SQL contract changed, update schema baseline and migration docs
4. keep schema policy section current (active version pointer)
