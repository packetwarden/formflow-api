# Runner API v1 (Beta) - Developer Deep Dive

Version: 1.2  
Last Updated: February 23, 2026  
Owner: Backend Platform Team

## 1. Purpose
This document is the implementation-level reference for public runner endpoints under `/api/v1/f/*`.

Use this guide to:
1. maintain the public submit-path security model
2. understand strict fail-closed schema validation behavior
3. verify DB function contracts and grants
4. onboard backend engineers to runner internals
5. track deferred runner capabilities

## 2. Endpoint Contracts
### 2.1 GET `/api/v1/f/:formId/schema`
Returns a published/public form payload by UUID (`forms.id`).

Path contract:
1. `formId` must be a UUID

Success response (`200`):
```json
{
  "form": {
    "id": "uuid",
    "title": "string",
    "description": "string|null",
    "published_schema": {},
    "success_message": "string|null",
    "redirect_url": "string|null",
    "meta_title": "string|null",
    "meta_description": "string|null",
    "meta_image_url": "string|null",
    "captcha_enabled": true,
    "captcha_provider": "string|null",
    "require_auth": false,
    "password_protected": false
  }
}
```

Status mapping:
1. `200` success
2. `404` form not published/not visible/not within schedule window
3. `500` backend/RPC error

### 2.2 POST `/api/v1/f/:formId/submit`
Processes public submission with strict validation, logic-aware sanitization, quota checks, rate limiting, and idempotent persistence.

Headers:
1. required `Idempotency-Key` UUID

Body:
```json
{
  "data": { "field_id": "value" },
  "started_at": "2026-02-23T10:30:00Z"
}
```

`started_at` is optional and must be ISO datetime with offset.

Success response (`201`):
```json
{
  "submission_id": "uuid",
  "success_message": "string|null",
  "redirect_url": "string|null"
}
```

Status mapping:
1. `201` success
2. `400` invalid params/headers/body
3. `403` entitlement blocked (`PLAN_FEATURE_DISABLED`, `PLAN_LIMIT_EXCEEDED`)
4. `404` form not found/unavailable
5. `409` form state conflict from submit RPC
6. `422` strict schema/field validation failure (`UNSUPPORTED_FORM_SCHEMA`, `FIELD_VALIDATION_FAILED`)
7. `429` rate-limited
8. `500` unexpected backend error

## 3. Architecture Flow (Text Diagram)
Submit path sequence:
1. validate `formId` + JSON body + `Idempotency-Key`
2. build anon Supabase client with forwarded request headers (`x-forwarded-for`, `user-agent`, `referer`)
3. call `public.check_request()` (strict DB rate-limit gate: 2 submissions per 60 seconds per anon IP)
4. load form with `public.get_published_form_by_id(formId)`
5. parse/normalize `published_schema` into strict runtime contract
6. evaluate logic (`show`/`hide`) and compute visibility state
7. strip hidden submitted fields
8. reject unknown keys and validate visible field values
9. enforce monthly entitlement with `public.get_form_submission_quota(formId)`
10. execute `public.submit_form(...)` with sanitized payload and metadata
11. return `submission_id` + completion settings

## 4. Strict Schema Contract
### 4.1 Supported Field Types
| Type |
| --- |
| `text` |
| `textarea` |
| `email` |
| `number` |
| `tel` |
| `url` |
| `date` |
| `datetime` |
| `time` |
| `radio` |
| `select` |
| `multiselect` |
| `checkbox` |
| `boolean` |
| `rating` |

### 4.2 Supported Validation Keys
| Validation Key |
| --- |
| `required` |
| `min` |
| `max` |
| `minLength` |
| `maxLength` |
| `pattern` |
| `options` |

### 4.3 Fail-Closed Rules
1. each field must provide non-empty `id` and `type`
2. unsupported field type fails with `422 UNSUPPORTED_FORM_SCHEMA`
3. unsupported validation key under `validation` or `rules` fails with `422 UNSUPPORTED_FORM_SCHEMA`
4. invalid option/validation value shapes fail with `422 UNSUPPORTED_FORM_SCHEMA`
5. `radio`/`select`/`multiselect` require non-empty options

## 5. Logic Contract and Sanitization
### 5.1 Supported Logic Aliases
Condition container aliases:
1. `if`
2. `when`
3. `conditions`

Action container aliases:
1. `then`
2. `action`
3. `actions`

Field id aliases:
1. `id`
2. `field_id`
3. `fieldId`
4. `key`
5. `name`

### 5.2 Supported Operators
| Operator |
| --- |
| `eq` |
| `neq` |
| `in` |
| `not_in` |
| `gt` |
| `gte` |
| `lt` |
| `lte` |
| `contains` |
| `not_contains` |
| `exists` |
| `not_exists` |

### 5.3 Supported Actions
1. `show`
2. `hide`
3. `show_field`
4. `hide_field`
5. `set_visibility`

### 5.4 Logic Failure Behavior
1. unsupported logic operator/action/shape fails with `422 UNSUPPORTED_FORM_SCHEMA`
2. hidden fields are removed before persistence
3. unknown submitted keys are rejected with `422 FIELD_VALIDATION_FAILED`

## 6. Security Model and Failure Rationale
Defense layers:
1. strict edge validation and contract parsing
2. logic-aware sanitization to remove hidden-field injection attempts
3. strict DB-backed rate-limit gate (`check_request`)
4. DB-backed entitlement guard (`get_form_submission_quota`)
5. atomic idempotent write path (`submit_form`)

Failure-mode rationale:
1. public endpoint receives untrusted traffic
2. permissive parsing creates bypass risk in dynamic forms
3. fail-closed behavior prioritizes integrity over permissive compatibility in beta

## 7. Database Functions and Privileges
Runner-dependent functions:
1. `public.check_request()`
2. `public.submit_form(UUID, JSONB, UUID, INET, TEXT, TEXT, TIMESTAMPTZ, UUID)`
3. `public.get_published_form_by_id(UUID)`
4. `public.get_form_submission_quota(UUID)`

Privilege model:
1. revoke execute from `PUBLIC`
2. grant execute to `anon, authenticated` where public runner access is required

Rollout artifacts:
1. migration: `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
2. migration: `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
3. canonical baseline: `project-info-docs/formflow_beta_schema_v2.sql`

## 8. Operational Runbook
### 8.1 Migration Order
Existing environment:
1. `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
2. `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
3. `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`

Fresh environment:
1. apply `project-info-docs/formflow_beta_schema_v2.sql`

### 8.2 Verification SQL
```sql
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
      'check_request',
      'submit_form',
      'get_published_form_by_id',
      'get_form_submission_quota'
  );
```

### 8.3 Runtime Verification
1. GET schema returns `200` for a published/open form
2. valid submit returns `201` with `submission_id`
3. replaying same idempotency key returns same `submission_id`
4. unsupported schema constructs return `422 UNSUPPORTED_FORM_SCHEMA`
5. unknown payload field returns `422 FIELD_VALIDATION_FAILED`
6. rate-limit overflow returns `429 RATE_LIMITED`
7. disabled/exceeded quota returns `403` with plan error code

Primary test document:
1. `test-runner-public-v1.md`

### 8.4 Runtime Stability Notes
1. `@hono/zod-validator` remains the request validation layer for `formId` params and submit JSON body.
2. `/submit` includes defensive runtime containment:
   - `parseStrictRateLimitError` safely parses non-standard RPC error payloads and maps strict 4xx/429 responses.
   - top-level `try/catch` wraps submit execution to prevent opaque worker-level 500 crashes.
3. If an unhandled submit-path exception still occurs, response contract is:
   - status: `500`
   - body: `{ "error": "Failed to submit form", "code": "RUNNER_INTERNAL_ERROR" }`

## 9. Remaining / Deferred
1. Stripe webhook route (`/api/v1/stripe/webhook`) remains pending in beta.
2. advanced field types outside explicit beta contract remain intentionally blocked.
3. advanced logic action semantics beyond show/hide remain deferred.
4. captcha verification pipeline is not yet enforced in submit path.
5. optional plan-lookup caching (KV/DO) is deferred; quota checks are DB-backed per request.
