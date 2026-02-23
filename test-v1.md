# FormSandbox API v1 Postman Test Guide

Version: v1  
Last Updated: February 23, 2026  
Target: Cloudflare Worker deployment (`/api/v1/*`)

## 1. Scope
This guide covers testing all currently available endpoints:
1. `GET /`
2. `POST /api/v1/auth/signup`
3. `POST /api/v1/auth/login`
4. `GET /api/v1/auth/me`
5. `POST /api/v1/auth/logout`
6. `GET /api/v1/build/:workspaceId/forms`
7. `GET /api/v1/build/:workspaceId/forms/:formId`
8. `PUT /api/v1/build/:workspaceId/forms/:formId`
9. `POST /api/v1/build/:workspaceId/forms/:formId/publish`

Also includes expected behavior for currently unimplemented route groups:
1. `/api/v1/f/*`
2. `/api/v1/stripe/*`

## 2. Prerequisites
Before running tests:
1. Deploy Worker with valid Supabase bindings:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
2. Use DB baseline `project-info-docs/formflow_beta_schema_v2.sql`.
3. If upgrading existing V1 DB, run:
   - `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
4. Have one test user email/password ready.

## 3. Postman Environment
Create a Postman environment with these variables:

| Variable | Example | Required |
|---|---|---|
| `base_url` | `https://formflow-api.<subdomain>.workers.dev` | Yes |
| `email` | `qa.user@example.com` | Yes |
| `password` | `StrongPassw0rd!` | Yes |
| `access_token` | (set dynamically from login) | Yes |
| `workspace_id` | UUID | Yes (for build tests) |
| `form_id` | UUID | Yes (for build tests) |
| `form_version` | integer | Yes (for update tests) |
| `user_id` | UUID | Optional |

## 4. Getting `workspace_id` and `form_id`
There is no create/list workspace endpoint yet. Get IDs using Supabase SQL Editor.

Find workspace ID for your user:
```sql
SELECT w.id AS workspace_id
FROM public.workspaces w
JOIN public.profiles p ON p.id = w.owner_id
WHERE p.email = 'qa.user@example.com'
  AND w.deleted_at IS NULL
LIMIT 1;
```

If you need a test form, create one:
```sql
INSERT INTO public.forms (workspace_id, title, slug)
VALUES (
  '<workspace_uuid>',
  'QA Test Form',
  'qa-test-form-' || substr(gen_random_uuid()::text, 1, 8)
)
RETURNING id, version;
```

Set returned IDs into `workspace_id`, `form_id`, and `form_version`.

## 5. Common Postman Setup
For authenticated requests, add header:
1. `Authorization: Bearer {{access_token}}`

Recommended collection-level tests (for authenticated requests):
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
| GET | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `404` |
| PUT | `/api/v1/build/:workspaceId/forms/:formId` | Yes | `200` / `404` / `409` |
| POST | `/api/v1/build/:workspaceId/forms/:formId/publish` | Yes | `200` / `403` / `404` |

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

Tests tab script:
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
2. Body message indicates client should remove token.

Note:
1. Current implementation returns success message even if server-side token revocation is not fully enforced.

### 7.6 List Forms
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms`
3. Headers: `Authorization: Bearer {{access_token}}`

Expected:
1. `200` with `{ forms: [] | [...] }`
2. or `404` if workspace is not accessible

### 7.7 Get Form by ID (captures version)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}`
3. Headers: `Authorization: Bearer {{access_token}}`

Tests tab script:
```javascript
pm.test("Form fetch success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("form_version", json.form.version);
```

### 7.8 Update Draft Schema (optimistic lock success path)
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

Tests tab script:
```javascript
pm.test("Draft update success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.environment.set("form_version", json.form.version);
```

### 7.9 Update Draft Schema (stale version conflict path)
Use same request as 7.8 but set body `version` to an older value.

Expected:
1. `409`
2. Response shape:
```json
{
  "error": "Version conflict",
  "current_version": 3
}
```

### 7.10 Publish Form
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

Possible failures:
1. `403` if DB function raises SQLSTATE `42501` (not editable workspace)
2. `404` if form is not visible/not found
3. `500` for RPC/database issues

## 8. Negative Tests Checklist
Run these quickly after smoke tests:
1. Missing `Authorization` on `/api/v1/auth/me` -> `401`
2. Invalid UUID in build route param -> `400`
3. Missing `schema` in PUT body -> `400`
4. Missing `version` in PUT body -> `400`
5. Publish with inaccessible workspace/form -> `404` or `403`

## 9. Currently Unimplemented Route Groups
These are mounted but have no handlers yet, so expect `404`:
1. `GET {{base_url}}/api/v1/f/<any>`
2. `POST {{base_url}}/api/v1/f/<any>`
3. `POST {{base_url}}/api/v1/stripe/webhook`

## 10. Recommended Smoke Sequence
Run in this order:
1. Health check
2. Signup (optional if user exists)
3. Login (capture token)
4. `/auth/me`
5. Build forms list
6. Build form get (capture version)
7. Build form update success
8. Build form update stale conflict
9. Build publish
10. Logout

Pass criteria:
1. All success-path endpoints return expected 2xx responses.
2. Conflict and validation paths return expected 4xx responses.
3. No unexpected 5xx responses.
