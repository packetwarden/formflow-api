# FormSandbox Backend Changelog

All notable changes to the FormSandbox Backend API will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to Semantic Versioning.

---

## [Unreleased]

### Added
- **Stripe Billing Hardening v2**: Upgraded `src/routes/stripe/index.ts` with checkout idempotency ledger, lease-based webhook claims, stale-claim recovery, catalog sync, and hardened webhook guards.
- **Checkout Idempotency Header Contract**: `POST /api/v1/stripe/workspaces/:workspaceId/checkout-session` now requires `Idempotency-Key` UUID with deterministic error codes (`IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`, `IDEMPOTENCY_KEY_EXPIRED`).
- **Stripe Catalog Sync Surface**: Added internal `POST /api/v1/stripe/catalog/sync` endpoint (token-protected) and scheduled catalog sync support (`STRIPE_CATALOG_SYNC_CRON` / default `*/15 * * * *`).
- **Workspace Billing Customer Mapping**: Added `workspace_billing_customers` table model (one Stripe customer per workspace) and route-level usage.
- **Checkout Idempotency Ledger Table**: Added migration-backed `stripe_checkout_idempotency` table to persist checkout request/session mapping beyond Stripe's 24h idempotency cache.
- **Webhook Claim-Lease Metadata**: Added `processor_id`, `processing_started_at`, `claim_expires_at`, and `next_attempt_at` queue fields with new claim indexes for replay/recovery.
- **Race-Safe Free Subscription Function**: Added `ensure_free_subscription_for_workspace(UUID, TEXT)` with workspace advisory lock and `INSERT ... ON CONFLICT DO NOTHING`.
- **Webhook Claim RPC**: Added `claim_stripe_webhook_event(TEXT, TEXT, INTEGER, INTEGER)` to atomically claim/reclaim webhook jobs.
- **Stripe v2 Migration**: Added `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2.sql`.
- **Stripe v2 Rollback Migration**: Added `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2_rollback_to_v1.sql` for emergency schema downgrade to Stripe v1 contract.
- **Expanded Stripe Schedules**: Added catalog sync and webhook cleanup crons in `wrangler.jsonc` (`*/15 * * * *`, `30 2 * * *`).
- **Stripe v2 Documentation Set**: Updated `dev-docs.md`, `prd-backend.md`, `project-info-docs/stripe-implementation.md`, `project-info-docs/stripe-dashboard-setup.md`, `test-stripe-v1.md`, `test-v1.md`, and schema baseline comments for the hardening release.
- **Stripe Hosted Billing v1**: Implemented `/api/v1/stripe/workspaces/:workspaceId/checkout-session`, `/portal-session`, and `/webhook` in `src/routes/stripe/index.ts` with owner/admin gating, hosted checkout, and customer portal support.
- **Stripe Webhook Idempotency + Async Processing**: Added verified webhook ingestion (`constructEventAsync`) with idempotent event storage in `stripe_webhook_events` and async event processing status transitions (`pending` -> `processing` -> `completed|failed`).
- **Stripe Retry + Grace Scheduler**: Added scheduled handlers (cron) for webhook replay (`*/5 * * * *`) and grace-period downgrade enforcement (`0 * * * *`) through `runStripeScheduled`.
- **Stripe Migration + Implementation Docs**: Added `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql` and `project-info-docs/stripe-implementation.md`.
- **Shared Workspace Role Guard Utility**: Added `src/utils/workspace-access.ts` and reused it in build + stripe routes to centralize workspace access/role enforcement.
- **Stripe Environment Bindings**: Added Stripe + service-role env bindings to `src/types/index.ts` and checkout validation schema in `src/utils/validation.ts`.
- **Runner API v1 (Beta-Complete)**: Implemented public runner endpoints in `src/routes/f/index.ts` with `GET /api/v1/f/:formId/schema` and `POST /api/v1/f/:formId/submit` using UUID form lookup.
- **Strict Fail-Closed Dynamic Validation**: Added schema-derived field validation for public submissions with fail-closed behavior on unsupported field types, validation keys, and logic rule/operator/action shapes (`422 UNSUPPORTED_FORM_SCHEMA` / `FIELD_VALIDATION_FAILED`).
- **Logic-Aware Payload Sanitization**: Added heuristic logic evaluator for show/hide rules with alias support and hidden-field stripping before submission persistence.
- **Runner Idempotency Enforcement**: Added required `Idempotency-Key` header validation for `/api/v1/f/:formId/submit` and wired idempotency through `submit_form` RPC.
- **Runner Entitlement Enforcement**: Added `max_submissions_monthly` quota checks for runner submissions via `get_form_submission_quota`.
- **Worker-Native Rate Limiting (Auth/Build)**: Added Cloudflare `ratelimits` bindings and reusable middleware for write-method (`POST|PUT|PATCH|DELETE`) protection across `/api/v1/auth/*` and `/api/v1/build/*`, returning `429 RATE_LIMITED` with `Retry-After: 60`.
- **Runner Strict Rate-Limit Migration**: Added `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql` to harden `check_request()` to deterministic `2 submissions / 60 seconds / anon IP` with advisory-lock serialization.
- **Runner DB Functions + Privilege Hardening**: Added `get_published_form_by_id(UUID)` and `get_form_submission_quota(UUID)` plus explicit execute grants/revokes for runner and submission-rate-limit functions.
- **Runner Migration**: Added `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql` for runner function and grant rollout.
- **Runner Validation Schemas**: Added `runnerFormParamSchema`, `runnerSubmitBodySchema`, and `runnerIdempotencyHeaderSchema` in `src/utils/validation.ts`.
- **Forwarded Header Support in Supabase Client**: Extended `getSupabaseClient` to merge optional forwarded request headers for PostgREST pre-request hooks.
- **Runner Deep-Dive Documentation**: Added `runner-api-beta.md` with architecture flow, validation contract, security model, operational runbook, and deferred items.
- **Runner Test Guide**: Added `test-runner-public-v1.md` as a dedicated developer-readable test suite without modifying `test-v1.md`.
- **Build API v1 (Beta-Complete)**: Expanded authenticated builder routes in `src/routes/build/index.ts` with `POST /api/v1/build/:workspaceId/forms`, `PATCH /api/v1/build/:workspaceId/forms/:formId`, and `DELETE /api/v1/build/:workspaceId/forms/:formId` in addition to existing list/get/save/publish paths.
- **Optimistic Locking on Draft Saves**: Enforced strict `version` matching on `PUT /forms/:formId`; stale writes now return `409` with `current_version`.
- **Optimistic Locking on Metadata Updates**: Added strict version matching on `PATCH /api/v1/build/:workspaceId/forms/:formId` for metadata/settings updates.
- **Server-Managed Immutable Form Slugs**: Form creation now generates slug values from title server-side, auto-resolves collisions with suffix retries, and keeps slugs immutable after create.
- **Build Entitlement Guard (Create Path)**: Added `max_forms` entitlement enforcement via `get_workspace_entitlements`, returning `403` with machine-readable codes (`PLAN_LIMIT_EXCEEDED`, `PLAN_FEATURE_DISABLED`).
- **Role-Aware Build Writes**: Added explicit workspace-role checks so write endpoints return `403` for insufficient role instead of surfacing stale/conflict-like behavior.
- **Soft Delete for Forms**: Added admin-only soft delete flow that sets `deleted_at` and `status = 'archived'` and returns delete confirmation payload.
- **Request-Scoped Supabase Auth Context**: Extended `getSupabaseClient` to accept bearer tokens and forward `Authorization` headers for RLS-aware data access.
- **Build Route Validation Schemas**: Added additional build payload schemas (`createFormSchema`, `updateFormMetaSchema`) in `src/utils/validation.ts` alongside `updateDraftSchema` and `publishFormSchema`.
- **Publish RPC Migration**: Added `project-info-docs/migrations/2026-02-23_fix_publish_form.sql` to fix `publish_form()` settings extraction and restrict function execution to `authenticated`.
- **Core Route Structure**: Scaffolded Hono sub-routers for `/api/v1/auth`, `/api/v1/build`, `/api/v1/f`, and `/api/v1/stripe` in `src/index.ts`.
- **Authentication Endpoints**: Implemented `/signup`, `/login`, `/logout`, and `/me` routes natively tailored for Cloudflare Workers edge runtime (`src/routes/auth/index.ts`).
- **Edge-Native Supabase Client**: Added `getSupabaseClient` in `src/db/supabase.ts` which forces `auth.autoRefreshToken: false` and `auth.persistSession: false` to ensure memory safety on headless V8 Isolates.
- **Middleware**: Created `requireAuth` Hono middleware in `src/middlewares/auth.ts` to seamlessly block unauthenticated requests and cryptographically verify Bearer JWTs using Supabase.
- **Zod Validation**: Implemented strict schema parsers (`signUpSchema`, `loginSchema`) in `src/utils/validation.ts` to sanitize email/password inputs natively on the edge before they reach the database.
- **Environment Bindings**: Defined rigorous TypeScript bindings for Cloudflare environment secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) and custom context variables in `src/types/index.ts`.
- **Developer Documentation**: Authored `dev-docs.md` outlining the API routing strategy, architectural philosophy ("Thick Database, Thin Edge"), and edge coding standards.

### Changed
- **Stripe Status Policy Alignment**: Entitled status set is now `active|trialing|past_due`; `unpaid|paused|canceled` trigger immediate free-tier ensure.
- **Invoice Event Handling**: `invoice.payment_failed` and `invoice.paid` now mutate `grace_period_end` only and no longer force subscription status in DB.
- **Checkout Security Envelope**: Stripe internals are no longer returned to clients; checkout/portal errors now return stable app code + `correlation_id`.
- **Webhook Processing Resilience**: Processing model moved from simple status flip to lease claim + stale claim rescue.
- **Stripe Tax Behavior**: Checkout session creation now sets `automatic_tax.enabled = true`.
- **Runner Submit Strong Rate-Limit Enforcement**: `/api/v1/f/:formId/submit` now uses explicit `check_request()` RPC gating before form processing to enforce strict DB-backed throttling (2/60 per anon IP), independent of idempotency-key variance.
- **Rate-Limit Failure Policy by Surface**: Auth/build Worker-native middleware remains fail-open on limiter runtime errors, while runner submit strict gate is fail-closed (`500 RATE_LIMIT_CHECK_FAILED`) when strict rate-limit evaluation fails.
- **Deterministic 500 Envelope for Submit Path**: Wrapped `/api/v1/f/:formId/submit` execution in guarded `try/catch` and now return `{ error, code: "RUNNER_INTERNAL_ERROR" }` for previously opaque worker-level failures.
- **Dependency Graph Alignment**: Updated dependency set and lockfile to aligned versions (`hono@4.12.x`, `@hono/zod-validator@0.7.x`, `zod@4.3.x`, `wrangler@4.67+`) to avoid mixed-runtime behavior.
- **Zod v4 Compatibility Update**: Updated record schema usage in `src/utils/validation.ts` to Zod v4-compatible signatures (`z.record(z.string(), z.unknown())`).

### Initialized
- Initialized Cloudflare Workers configuration via `wrangler.jsonc`.
- Set up `package.json` with primary dependencies (`hono`, `zod`, `@supabase/supabase-js`, `@hono/zod-validator`).
- Created `tsconfig.json` tuned for strict mode and Cloudflare Workers Types.
