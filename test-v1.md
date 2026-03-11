# FormSandbox API v1 Postman Test Guide

Version: v2  
Last Updated: February 25, 2026  
Target: Cloudflare Worker deployment (`/api/v1/*`)

## 1. Scope
This guide covers testing core API routes:
1. `GET /`
2. `POST /api/v1/auth/signup`
3. `POST /api/v1/auth/login`
4. `GET /api/v1/auth/bootstrap`
5. `GET /api/v1/auth/me`
6. `POST /api/v1/auth/logout`
7. `GET /api/v1/workspaces/:workspaceId/overview`
8. `GET /api/v1/workspaces/:workspaceId/settings`
9. `PATCH /api/v1/workspaces/:workspaceId/settings`
10. `GET /api/v1/build/:workspaceId/forms`
11. `POST /api/v1/build/:workspaceId/forms`
12. `GET /api/v1/build/:workspaceId/forms/:formId`
13. `PATCH /api/v1/build/:workspaceId/forms/:formId`
14. `PATCH /api/v1/build/:workspaceId/forms/:formId/access`
15. `PUT /api/v1/build/:workspaceId/forms/:formId`
16. `POST /api/v1/build/:workspaceId/forms/:formId/publish`
17. `DELETE /api/v1/build/:workspaceId/forms/:formId`
18. `GET /api/v1/f/:formId/schema`
19. `POST /api/v1/f/:formId/access`
20. `POST /api/v1/f/:formId/submit`
21. `POST /api/v1/stripe/workspaces/:workspaceId/checkout-session`

Stripe billing has a dedicated deep-dive matrix in `test-stripe-v1.md`.

## 2. Prerequisites
Before running tests:
1. Deploy Worker with valid Supabase bindings:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
2. Use DB baseline `project-info-docs/formflow_beta_schema_v2.sql`.
3. If upgrading existing V1 DB, run:
   - `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
   - `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
   - `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
   - `project-info-docs/migrations/2026-02-27_runner_submission_gateway_hardening_v1.sql`
   - `project-info-docs/migrations/2026-02-27_security_definer_hardening_v2.sql`
   - `project-info-docs/migrations/2026-02-24_stripe_checkout_portal_v1.sql`
   - `project-info-docs/migrations/2026-02-25_stripe_billing_hardening_v2.sql`
4. Have at least one test user email/password ready (owner/editor).
5. Optional for permission negative tests: a second user with `viewer` role in the same workspace.
6. For Stripe checks, configure Stripe env vars and test keys as documented in `test-stripe-v1.md`.

## 3. Postman Environment
Create a Postman environment with these variables:

| Variable | Example | Required |
|---|---|---|
| `base_url` | `https://formflow-api.<subdomain>.workers.dev` | Yes |
| `email` | `qa.user@example.com` | Yes |
| `password` | `StrongPassw0rd!` | Yes |
| `access_token` | (set dynamically from login) | Yes |
| `workspace_id` | UUID | Yes (for build tests) |
| `workspace_version` | integer | Optional (workspace settings tests) |
| `form_id` | UUID | Yes (captured from create) |
| `form_version` | integer | Yes (for update tests) |
| `user_id` | UUID | Optional |
| `viewer_access_token` | JWT | Optional (permission negative tests) |

## 3A. Automated Live Validation Script
An automated integration check is available:
1. Script: `scripts/server-side-validation-check.mjs`
2. Package command: `npm run test:validation:live`

Required environment variables:
1. `FORMSANDBOX_BASE_URL`
2. `FORMSANDBOX_WORKSPACE_ID`
3. either:
   - `FORMSANDBOX_ACCESS_TOKEN`
   - or `FORMSANDBOX_EMAIL` + `FORMSANDBOX_PASSWORD`

Default script behavior:
1. logs in if needed
2. checks `/`
3. checks `/api/v1/auth/bootstrap`
4. optionally checks workspace overview/settings routes
5. checks `/api/v1/auth/me`
6. creates a temporary builder form automatically
7. verifies build validation failures (`422`, invalid redirect `400`)
8. publishes the temporary form
9. verifies runner validation failures and a successful submit
10. deletes the temporary form unless `FORMSANDBOX_KEEP_ARTIFACTS=1`

Optional protected-form checks:
1. password-protected routes:
   - set `FORMSANDBOX_RUN_PASSWORD_PROTECTED_FORM_CHECKS=1`
   - set `FORMSANDBOX_PASSWORD_PROTECTED_FORM_ID`
2. require-auth capability probe:
   - set `FORMSANDBOX_RUN_REQUIRE_AUTH_FORM_CHECKS=1`
   - set `FORMSANDBOX_REQUIRE_AUTH_FORM_ID`
3. captcha-protected routes:
   - set `FORMSANDBOX_RUN_CAPTCHA_FORM_CHECKS=1`
   - set `FORMSANDBOX_CAPTCHA_FORM_ID`

Optional workspace checks:
1. set `FORMSANDBOX_RUN_WORKSPACE_CHECKS=1`
2. also set:
   - `FORMSANDBOX_WORKSPACE_ID`
3. optional for negative permission checks:
   - `FORMSANDBOX_VIEWER_ACCESS_TOKEN`

Optional Stripe checks:
1. set `FORMSANDBOX_RUN_STRIPE_CHECKS=1`
2. also set:
   - `FORMSANDBOX_STRIPE_WORKSPACE_ID`
   - `FORMSANDBOX_INTERNAL_ADMIN_TOKEN`

## 4. Getting `workspace_id` and Optional Viewer Setup
Use bootstrap to capture `workspace_id` for build and Stripe tests.

### 4.1 Workspace Bootstrap (captures `workspace_id`)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/auth/bootstrap`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200`
2. JSON has `user.id`
3. JSON has `current_workspace_id`
4. JSON has `workspaces[0].role`

Tests tab:
```javascript
pm.test("Bootstrap success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("user_id", json.user.id);
pm.environment.set("workspace_id", json.current_workspace_id);
pm.environment.set("workspace_count", json.workspaces.length);
```

Fallback SQL if bootstrap invariants are being investigated manually:
```sql
SELECT w.id AS workspace_id
FROM public.workspaces w
JOIN public.profiles p ON p.id = w.owner_id
WHERE p.email = 'qa.user@example.com'
  AND w.deleted_at IS NULL
LIMIT 1;
```

### 4.2 Optional Viewer Setup
1. Create/login a second user.
2. Add membership row:
```sql
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('<workspace_uuid>', '<viewer_user_uuid>', 'viewer')
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;
```
3. Store viewer JWT in `viewer_access_token`.

## 5. Common Postman Setup
For authenticated requests, add header:
1. `Authorization: Bearer {{access_token}}`

Recommended collection-level test:
```javascript
pm.test("Status is not 401", function () {
  pm.expect(pm.response.code).to.not.eql(401);
});
```

## 6. Endpoint Matrix
| Method | Endpoint | Auth | Expected |
|---|---|---|---|
| GET | `/` | No | `200` text |
| POST | `/api/v1/auth/signup` | No | `201` or `400` |
| POST | `/api/v1/auth/login` | No | `200` or `401` |
| GET | `/api/v1/auth/bootstrap` | Yes | `200` / `401` / `409` / `500` |
| GET | `/api/v1/auth/me` | Yes | `200` |
| POST | `/api/v1/auth/logout` | Yes | `200` |
| GET | `/api/v1/workspaces/:workspaceId/overview` | Yes | `200` / `401` / `404` / `500` |
| GET | `/api/v1/workspaces/:workspaceId/settings` | Yes (owner only) | `200` / `401` / `403` / `404` / `500` |
| PATCH | `/api/v1/workspaces/:workspaceId/settings` | Yes (owner only) | `200` / `400` / `401` / `403` / `404` / `409` / `500` |
| GET | `/api/v1/build/:workspaceId/forms` | Yes | `200` / `404` |
| POST | `/api/v1/build/:workspaceId/forms` | Yes | `201` / `403` / `404` / `422` |
| GET | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `404` |
| PATCH | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `403` / `404` / `409` |
| PATCH | `/api/v1/build/:workspaceId/forms/:formId/access` | Yes | `200` / `403` / `404` / `409` |
| PUT | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `403` / `404` / `409` / `422` |
| POST | `/api/v1/build/:workspaceId/forms/:formId/publish` | Yes | `200` / `403` / `404` / `422` |
| DELETE | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `403` / `404` |
| GET | `/api/v1/f/:formId/schema` | No | `200` / `400` / `403` / `404` |
| POST | `/api/v1/f/:formId/access` | No | `200` / `400` / `403` / `404` / `409` / `429` |
| POST | `/api/v1/f/:formId/submit` | No (`Idempotency-Key` required) | `201` / `400` / `403` / `404` / `409` / `422` / `429` / `500` |
| POST | `/api/v1/stripe/workspaces/:workspaceId/checkout-session` | Yes (`Idempotency-Key` required) | `200` / `400` / `403` / `404` / `409` / `500` |

## 7. Detailed Postman Requests

### 7.1 Health Check
Request:
1. Method: `GET`
2. URL: `{{base_url}}/`

Expected:
1. Status `200`
2. Body text: `FormSandbox (FormFlow) API Edge Runtime`

### 7.2 Signup
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/auth/signup`
3. Headers: `Content-Type: application/json`
4. Body:
```json
{
  "email": "{{email}}",
  "password": "{{password}}",
  "full_name": "QA User"
}
```

Expected:
1. First run: `201`
2. Existing user: `400`

### 7.3 Login (captures token)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/auth/login`
3. Headers: `Content-Type: application/json`
4. Body:
```json
{
  "email": "{{email}}",
  "password": "{{password}}"
}
```

Tests tab:
```javascript
pm.test("Login success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("access_token", json.session.access_token);
pm.environment.set("user_id", json.user.id);
```

### 7.4 Current User (`/me`)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/auth/me`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200`
2. JSON has `user.id`

### 7.4A Workspace Bootstrap (`/bootstrap`)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/auth/bootstrap`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200`
2. JSON has `user.id`
3. JSON has `current_workspace_id`
4. JSON has `workspaces[0].id`
5. Response header `Cache-Control` is `no-store`

### 7.4B Workspace Overview (`/workspaces/:workspaceId/overview`)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/workspaces/{{workspace_id}}/overview`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200`
2. JSON has `workspace.id = {{workspace_id}}`
3. JSON has `membership.role`
4. JSON has `summary.member_count`
5. JSON has `summary.settings`
6. JSON does not expose raw editable `version`

Tests tab:
```javascript
pm.test("Workspace overview success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.expect(json.workspace.id).to.eql(pm.environment.get("workspace_id"));
pm.expect(json.membership.role).to.be.a("string");
pm.expect(json.summary.member_count).to.be.a("number");
```

### 7.4C Workspace Settings Read (`/workspaces/:workspaceId/settings`)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/workspaces/{{workspace_id}}/settings`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200` for owner
2. JSON has `workspace.version`
3. JSON has typed `settings`

Tests tab:
```javascript
pm.test("Workspace settings fetch success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("workspace_version", json.workspace.version);
```

### 7.4D Workspace Settings Patch (`/workspaces/:workspaceId/settings`)
Request:
1. Method: `PATCH`
2. URL: `{{base_url}}/api/v1/workspaces/{{workspace_id}}/settings`
3. Headers:
   - `Authorization: Bearer {{access_token}}`
   - `Content-Type: application/json`
4. Body:
```json
{
  "version": {{workspace_version}},
  "settings": {
    "about": {
      "tagline": "Workspace settings updated from Postman"
    }
  }
}
```

Expected:
1. `200`
2. `workspace.version` increments
3. `settings.about.tagline` reflects the change

Tests tab:
```javascript
pm.test("Workspace settings patch success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("workspace_version", json.workspace.version);
```

### 7.4E Workspace Settings Patch Conflict
Use the same request as 7.4D with an older `workspace_version`.

Expected:
1. `409`
2. Response shape:
```json
{
  "error": "Version conflict",
  "current_version": 3
}
```

### 7.5 Logout
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/auth/logout`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200`
2. Body message indicates client should remove locally stored access/refresh tokens.
3. Refresh-token sessions are revoked server-side for this user.
4. Existing access tokens may remain valid until their JWT `exp` timestamp.

### 7.6 List Forms
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200` with `{ forms: [] | [...] }`
2. or `404` if workspace is not accessible

### 7.7 Create Form (captures `form_id` and `form_version`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms`
3. Headers:
   - `Authorization: Bearer {{access_token}}`
   - `Content-Type: application/json`
4. Body:
```json
{
  "title": "API Regression Form",
  "description": "Created from Postman",
  "schema": {
    "layout": "flat",
    "theme": {},
    "steps": [],
    "logic": [],
    "settings": {}
  },
  "accept_submissions": true
}
```

Tests tab:
```javascript
pm.test("Create form success", function () {
  pm.expect(pm.response.code).to.eql(201);
});

const json = pm.response.json();
pm.environment.set("form_id", json.form.id);
pm.environment.set("form_version", json.form.version);
```

### 7.8 Get Form by ID (refresh version)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}`
3. Headers: `Authorization: Bearer {{access_token}}`

Tests tab:
```javascript
pm.test("Form fetch success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("form_version", json.form.version);
```

### 7.9 Patch Metadata (optimistic lock success path)
Request:
1. Method: `PATCH`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}`
3. Headers:
   - `Authorization: Bearer {{access_token}}`
   - `Content-Type: application/json`
4. Body:
```json
{
  "version": {{form_version}},
  "description": "Metadata updated via PATCH",
  "max_submissions": 100,
  "success_message": "Thanks for submitting"
}
```

Tests tab:
```javascript
pm.test("Metadata patch success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("form_version", json.form.version);
```

### 7.10 Patch Metadata (stale conflict path)
Use same request as 7.9 with an older `version`.

Expected:
1. `409`
2. Response shape:
```json
{
  "error": "Version conflict",
  "current_version": 3
}
```

### 7.11 Update Draft Schema (PUT success path)
Request:
1. Method: `PUT`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}`
3. Headers:
   - `Authorization: Bearer {{access_token}}`
   - `Content-Type: application/json`
4. Body:
```json
{
  "schema": {
    "layout": "flat",
    "theme": {},
    "steps": [],
    "logic": [],
    "settings": {
      "updated_from_postman": true
    }
  },
  "version": {{form_version}}
}
```

Tests tab:
```javascript
pm.test("Draft update success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("form_version", json.form.version);
```

### 7.12 Publish Form
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}/publish`
3. Headers:
   - `Authorization: Bearer {{access_token}}`
   - `Content-Type: application/json`
4. Body:
```json
{
  "description": "Published from Postman regression suite"
}
```

Expected:
1. `200`
2. Response includes `version` object from `publish_form` RPC.

### 7.13 Delete Form (admin path)
Request:
1. Method: `DELETE`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200`
2. Response includes:
```json
{
  "form_id": "uuid",
  "deleted_at": "timestamp"
}
```

### 7.14 Verify Soft Delete
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `404` (soft-deleted forms are hidden from build reads)

## 8. Negative Tests Checklist
1. Missing `Authorization` on `/api/v1/auth/me` -> `401`
2. Invalid UUID in build route param -> `400`
3. Missing `schema` in PUT body -> `400`
4. Missing `version` in PUT/PATCH body -> `400`
5. PATCH with only `version` and no editable fields -> `400`
6. Viewer token `POST /build/:workspaceId/forms` -> `403`
7. Viewer token `PUT /build/:workspaceId/forms/:formId` -> `403`
8. Editor token `DELETE /build/:workspaceId/forms/:formId` -> `403`
9. Publish with inaccessible workspace/form -> `404` or `403`
10. Create when `max_forms` limit reached -> `403` with `code = PLAN_LIMIT_EXCEEDED`
11. Direct Supabase RPC `check_request()` with authenticated key -> blocked (`401/403`)
12. Direct Supabase RPC `get_workspace_entitlements(UUID)` with anon key -> blocked (`401/403`)
13. Authenticated `publish_form(...)` RPC with mismatched `p_published_by` -> blocked (`403`, SQLSTATE `42501`)
14. Direct Supabase RPC `submit_form(...)` with anon/authenticated key -> blocked (`401/403`)
15. Create with unsupported schema field type/operator/action -> `422 UNSUPPORTED_FORM_SCHEMA`
16. PUT draft with unsupported schema field type/operator/action -> `422 UNSUPPORTED_FORM_SCHEMA`
17. Publish invalid draft contract -> `422 UNSUPPORTED_FORM_SCHEMA`
18. Runner submit against published form with `require_auth = true` -> `403 FORM_AUTH_REQUIRED`
19. Locked schema fetch without access token -> `403 FORM_PASSWORD_REQUIRED`
20. Runner submit against password-protected form without valid unlock token -> `403 FORM_ACCESS_TOKEN_INVALID`
21. Captcha-enabled unlock/submit without token -> `403 CAPTCHA_REQUIRED`
22. Captcha-enabled unlock/submit with invalid token -> `403 CAPTCHA_VERIFICATION_FAILED`
23. Signup/login with uppercase email succeeds and stored request email is normalized lowercase
24. Malformed `Authorization` header on `/auth/bootstrap`, `/auth/me`, or `/auth/logout` -> `401`
25. Authenticated user with zero visible workspaces on `/auth/bootstrap` -> `409 WORKSPACE_BOOTSTRAP_EMPTY`
26. Non-member `GET /workspaces/:workspaceId/overview` -> `404`
27. Viewer `GET /workspaces/:workspaceId/settings` -> `403`
28. Viewer `PATCH /workspaces/:workspaceId/settings` -> `403`
29. Workspace settings patch with stale `version` -> `409`
30. Workspace settings patch with unknown nested key -> `400`
31. Workspace settings patch with invalid URL/color/email/timezone -> `400`
32. Workspace overview response must not expose raw `settings`, `version`, `retention_days`, or billing internals

### 8.1 Security SQL Audit Snippets
Search-path hardening audit (expect zero rows):
```sql
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef = true
  AND (
    p.proconfig IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM unnest(p.proconfig) AS cfg
      WHERE cfg LIKE 'search_path=%'
    )
  )
ORDER BY n.nspname, p.proname;
```

Function execute exposure audit for public SECURITY DEFINER functions (expect only explicitly approved rows):
```sql
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef = true
  AND has_function_privilege('public', p.oid, 'EXECUTE')
ORDER BY p.proname;
```

Optional entitlement-disable simulation:
```sql
-- Disable max_forms for free tier (test-only)
UPDATE public.plan_entitlements pe
SET is_enabled = false
FROM public.features f
JOIN public.plans p ON p.id = pe.plan_id
WHERE pe.feature_id = f.id
  AND f.key = 'max_forms'
  AND p.slug = 'free';
```
Expected create response:
1. `403`
2. `code = PLAN_FEATURE_DISABLED`

## 9. Runner and Stripe Contract Notes
1. Runner submit route (`POST /api/v1/f/:formId/submit`) requires `Idempotency-Key` UUID header.
2. Stripe checkout route (`POST /api/v1/stripe/workspaces/:workspaceId/checkout-session`) requires `Idempotency-Key` UUID header.
3. Stripe checkout deterministic `409` codes:
   - `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`
   - `IDEMPOTENCY_KEY_EXPIRED`
   - `CATALOG_OUT_OF_SYNC`
4. Builder create/save/publish now reject runner-incompatible form contracts with `422 UNSUPPORTED_FORM_SCHEMA`.
5. Runner protected-form fail-closed codes:
   - `FORM_AUTH_REQUIRED`
   - `FORM_PASSWORD_REQUIRED`
   - `FORM_ACCESS_TOKEN_INVALID`
   - `CAPTCHA_REQUIRED`
   - `CAPTCHA_VERIFICATION_FAILED`
6. For full Stripe scenarios (webhooks, lease reclaim, drift sync, race tests), run `test-stripe-v1.md`.
7. Runner write path is strict-gateway only: direct anon Data API inserts to `public.form_submissions` and direct anon `submit_form` RPC calls are expected to fail.

## 10. Recommended Smoke Sequence
Run in this order:
1. Health check
2. Signup (optional if user exists)
3. Login (capture token)
4. `/auth/me`
5. Build forms list
6. Build form create (capture `form_id`, `form_version`)
7. Build metadata patch success
8. Build draft update success
9. Build publish
10. Build delete
11. Runner schema fetch + submit smoke
12. Stripe checkout smoke with fresh `Idempotency-Key`
13. Logout

Pass criteria:
1. All success-path endpoints return expected 2xx responses.
2. Conflict/permission/validation paths return expected 4xx responses.
3. No unexpected 5xx responses.
