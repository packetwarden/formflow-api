# Product Requirement Document (PRD): FormSandbox (Backend API)

**Version:** 2.2 (Edge-Native 2026 Architecture)
**Current Phase:** Backend & Infrastructure Only. (Frontend UI is strictly deferred).

## 1. Project Overview & 2026 Philosophy

**Goal**: Build a highly scalable, edge-based API for a dynamic form builder and submission engine.
**Core Philosophy**: "The Schema is the Application." The backend strictly acts as a validation, evaluation, and storage layer for typed JSON definitions.
**Modern 2026 Methodology**:

* **Thick Database, Thin Edge**: We offload complex transactions, race-condition management, and idempotency to Postgres RPCs (e.g., `submit_form()`). The Cloudflare Worker acts only as a fast, secure gateway.
* **End-to-End Type Safety**: Using Hono and Zod to guarantee API contracts, ensuring that invalid data never touches the database.
* **Serverless Simplicity**: Bypassing complex Kubernetes/Docker orchestration in favor of a direct Worker-to-Supabase pipeline, allowing for rapid iteration and massive scale out of the box.

## 2. Tech Stack & Infrastructure

### Core Backend Stack

* **Edge Compute**: Cloudflare Workers (V8 Isolates for sub-millisecond cold starts).
* **API Framework**: Hono.js (Ultra-fast web standard routing, optimized for the edge).
* **Validation**: Zod + `@hono/zod-validator` (Strict schema hydration and payload checking).
* **Database & Auth**: Supabase (PostgreSQL 15+, Row Level Security, pg_cron).
* **Language**: TypeScript (Strict Mode).

### Orchestration & Integrations

* **Billing & Entitlements**: Stripe Webhooks (Processed securely at the edge and logged idempotently to Postgres).
* **Stateful Tasks (Future-Proofing)**: Cloudflare Workflows (To be used for multi-step webhook integrations, email dispatch, or AI evaluations without hitting worker timeout limits).

## 3. API Routing Strategy (Hono Framework)

We utilize a RESTful design optimized through Hono's `app.route()` grouping feature to separate distinct domains. This allows us to cleanly apply authentication middleware to builder routes while keeping public runner routes unrestricted.

*Constraint*: `formId` (or slug) must be globally unique to allow flat, fast database lookups for the public routes without needing a workspace context.

| HTTP Method | Route | Description | Auth Required |
| --- | --- | --- | --- |
| **Authentication Group (`/api/v1/auth/*`)** |  |  |  |
| **POST** | `/api/v1/auth/signup` | Register a new user via Supabase Auth. | No |
| **POST** | `/api/v1/auth/login` | Authenticate user and return session. | No |
| **POST** | `/api/v1/auth/logout` | Invalidate current session. | Yes (Bearer) |
| **GET** | `/api/v1/auth/me` | Fetch the current authenticated user's profile. | Yes (Bearer) |
| **Builder Group (`/api/v1/build/:workspaceId/*`)** |  |  |  |
| **GET** | `/api/v1/build/:workspaceId/forms` | Fetch all forms belonging to the workspace. | Yes (Bearer) |
| **GET** | `/api/v1/build/:workspaceId/forms/:formId` | Fetch the draft `schema` JSONB for the editor. | Yes (Bearer) |
| **PUT** | `/api/v1/build/:workspaceId/forms/:formId` | Save updates to the draft `schema` JSONB. | Yes (Bearer) |
| **POST** | `/api/v1/build/:workspaceId/forms/:formId/publish` | Trigger the `publish_form()` RPC to lock a new version. | Yes (Bearer) |
| **Public Runner Group (`/api/v1/f/*`)** |  |  |  |
| **GET** | `/api/v1/f/:formId/schema` | Fetch the `published_schema` for public rendering. | No (Public) |
| **POST** | `/api/v1/f/:formId/submit` | Process submission natively. | No (Rate-limited) |
| **System Group** |  |  |  |
| **POST** | `/api/v1/stripe/webhook` | Handles Stripe events for subscriptions, updating Postgres. | Stripe Signature |

## 4. Architecture: The Logic & Submission Engine

The submission pipeline is the most critical backend flow. It ensures data integrity and security at the edge before data ever reaches Postgres.

1. **Hydration & Rate Limiting**: The Worker receives the submission. Hono middleware checks IP rate limits.
2. **Schema Fetch**: The Worker fetches the locked `published_schema` from Supabase using the flat `formId`.
3. **Dynamic Zod Compilation**: The Worker converts the static JSON schema into an executable Zod schema.
4. **Logic Engine Stripping**: A pure TypeScript function evaluates the schema's `logic[]` rules against the submitted answers.
* *Security Constraint*: If a logic rule dictates a field should be hidden, the backend *must* strip that field from the payload to prevent malicious data injection.


5. **ACID Transaction**: The sanitized payload, along with the `idempotency_key`, is sent to the Supabase `submit_form()` RPC. Postgres handles the row-level locking, submission counting, and duplicate prevention natively.

## 5. Data Model & Entitlements (Supabase Schema V1)

The backend relies completely on the provided Beta v1 Schema. Key structural pillars include:

* **Workspaces & RBAC**: Every form belongs to a `workspace`. RLS ensures users can only query/update forms within their `user_workspace_ids()`.
* **Immutable Versioning**: `forms` hold the mutable draft `schema`. Publishing creates an immutable `form_versions` row. Submissions are strictly tied to a `form_version_id`.
* **Idempotency Natively**: `form_submissions` utilizes an `idempotency_key` with a unique index. The `submit_form` RPC uses `ON CONFLICT DO NOTHING`, guaranteeing that network retries from the edge do not result in double charges or duplicate entries.
* **Entitlement Engine**: Feature gating is detached from hardcoded tiers. Hono middleware will query `get_workspace_entitlements()` to check limits (e.g., `max_submissions_monthly`) before allowing POST requests to succeed.

*Note for DB Sync*: The `get_published_form` RPC from the V1 schema currently requires a `p_workspace_slug`. This will need to be refactored to query exclusively by the globally unique `p_form_slug` or `form_id` to support the new flat `/f/:formId` route structure.

## 6. Stripe Webhook & Event Processing

In 2026, webhooks must be treated as untrusted and highly volatile.

1. **Edge Verification**: Hono verifies the Stripe cryptographic signature using Web Crypto APIs native to the Worker.
2. **Payload Guard**: The Worker rejects oversized webhook payloads before parsing/signature work to reduce abuse surface.
3. **Idempotent Insert**: The event payload is inserted into `stripe_webhook_events`; `event_id` remains the dedupe key.
4. **Lease-Based Claims**: Event processing uses a DB-backed claim lease (`processor_id`, `claim_expires_at`) so stale `processing` rows can be reclaimed.
5. **State Sync**: The Worker parses supported events and updates `subscriptions` as source of truth.
6. **Grace Handling**: Invoice events set/clear `grace_period_end`; status transitions remain sourced from Stripe subscription state.
7. **Terminal Status Policy**: `unpaid`, `paused`, and `canceled` immediately trigger free-tier ensure and cache refresh.
8. **Durable Checkout Idempotency**: Checkout request dedupe is persisted in `stripe_checkout_idempotency` to extend safety beyond Stripe's 24-hour idempotency cache.
9. **Customer Mapping Invariant**: Billing enforces one Stripe customer per workspace via `workspace_billing_customers`.
10. **Stripe-as-Source Catalog**: Recurring prices are synced from Stripe to `plan_variants`; checkout and webhook fallback force one sync attempt on drift before deterministic failure.
