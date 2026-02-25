# FormSandbox API v1 Postman Test Guide

Version: v2  
Last Updated: February 25, 2026  
Target: Cloudflare Worker deployment (`/api/v1/*`)

## 1. Scope
This guide covers testing core API routes:
1. `GET /`
2. `POST /api/v1/auth/signup`
3. `POST /api/v1/auth/login`
4. `GET /api/v1/auth/me`
5. `POST /api/v1/auth/logout`
6. `GET /api/v1/build/:workspaceId/forms`
7. `POST /api/v1/build/:workspaceId/forms`
8. `GET /api/v1/build/:workspaceId/forms/:formId`
9. `PATCH /api/v1/build/:workspaceId/forms/:formId`
10. `PUT /api/v1/build/:workspaceId/forms/:formId`
11. `POST /api/v1/build/:workspaceId/forms/:formId/publish`
12. `DELETE /api/v1/build/:workspaceId/forms/:formId`
13. `GET /api/v1/f/:formId/schema`
14. `POST /api/v1/f/:formId/submit`
15. `POST /api/v1/stripe/workspaces/:workspaceId/checkout-session`

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
| `form_id` | UUID | Yes (captured from create) |
| `form_version` | integer | Yes (for update tests) |
| `user_id` | UUID | Optional |
| `viewer_access_token` | JWT | Optional (permission negative tests) |

## 4. Getting `workspace_id` and Optional Viewer Setup
Find workspace ID for your user:
```sql
SELECT w.id AS workspace_id
FROM public.workspaces w
JOIN public.profiles p ON p.id = w.owner_id
WHERE p.email = 'qa.user@example.com'
  AND w.deleted_at IS NULL
LIMIT 1;
```

Optional viewer setup:
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
| GET | `/api/v1/auth/me` | Yes | `200` |
| POST | `/api/v1/auth/logout` | Yes | `200` |
| GET | `/api/v1/build/:workspaceId/forms` | Yes | `200` / `404` |
| POST | `/api/v1/build/:workspaceId/forms` | Yes | `201` / `403` / `404` |
| GET | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `404` |
| PATCH | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `403` / `404` / `409` |
| PUT | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `403` / `404` / `409` |
| POST | `/api/v1/build/:workspaceId/forms/:formId/publish` | Yes | `200` / `403` / `404` |
| DELETE | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `403` / `404` |
| GET | `/api/v1/f/:formId/schema` | No | `200` / `400` / `404` |
| POST | `/api/v1/f/:formId/submit` | No (`Idempotency-Key` required) | `200` / `400` / `404` / `409` / `429` |
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
4. For full Stripe scenarios (webhooks, lease reclaim, drift sync, race tests), run `test-stripe-v1.md`.

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
