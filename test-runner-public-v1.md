# FormSandbox Runner API v1 Postman Test Guide

Version: v1  
Last Updated: February 23, 2026  
Target: Cloudflare Worker deployment (`/api/v1/f/*`)

## 1. Scope
This guide covers public runner endpoint testing only:
1. `GET /api/v1/f/:formId/schema`
2. `POST /api/v1/f/:formId/submit`

This guide validates:
1. strict fail-closed schema contract enforcement
2. logic-aware payload sanitization (hidden field stripping)
3. idempotency behavior (`Idempotency-Key`)
4. quota and rate-limit enforcement
5. stable status and error payload mappings

## 2. Prerequisites
Before running tests:
1. Deploy Worker with valid bindings:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
2. Database must be on `project-info-docs/formflow_beta_schema_v2.sql`.
3. For upgraded environments, apply migrations in order:
   - `project-info-docs/migrations/2026-02-23_fix_publish_form.sql`
   - `project-info-docs/migrations/2026-02-23_runner_public_api_v1.sql`
   - `project-info-docs/migrations/2026-02-24_runner_strict_submit_rate_limit.sql`
   - `project-info-docs/migrations/2026-02-27_runner_submission_gateway_hardening_v1.sql`
4. Prepare published test forms (see Section 4).
5. Confirm `check_request()` strict gate is active for submit-path rate-limit tests.

## 3. Postman Environment
Create a Postman environment with these variables:

| Variable | Example | Required |
|---|---|---|
| `base_url` | `https://formflow-api.<subdomain>.workers.dev` | Yes |
| `form_id_valid` | UUID | Yes |
| `form_id_invalid` | `00000000-0000-0000-0000-000000000000` | Yes |
| `form_id_logic_hide` | UUID | Yes |
| `form_id_invalid_schema_type` | UUID | Yes |
| `form_id_invalid_logic` | UUID | Yes |
| `form_id_quota_disabled` | UUID | Optional |
| `form_id_quota_exhausted` | UUID | Optional |
| `form_id_conflict` | UUID | Optional |
| `idempotency_key` | (set dynamically) | Yes |
| `submission_id_1` | (set dynamically) | Yes |
| `submission_id_2` | (set dynamically) | Yes |
| `run_started_at` | (set dynamically) | Yes |

## 4. Test Data Setup
Prepare forms for deterministic regression coverage:
1. `form_id_valid`: published, open, accepts submissions, schema uses only supported beta types.
2. `form_id_logic_hide`: published schema with logic that hides one field based on another.
3. `form_id_invalid_schema_type`: published schema contains unsupported field type.
4. `form_id_invalid_logic`: published schema contains unsupported logic shape/operator/action.
5. `form_id_quota_disabled`: workspace entitlement `max_submissions_monthly` disabled.
6. `form_id_quota_exhausted`: workspace entitlement limit reached.
7. `form_id_conflict`: form state that forces submit RPC conflict (`closed`/`not accepting`).

Recommended SQL checks:
```sql
SELECT id, title, status, accept_submissions, published_schema IS NOT NULL AS has_published_schema
FROM public.forms
WHERE id IN (
  '00000000-0000-0000-0000-000000000000' -- replace with your form ids
);
```

Optional entitlement simulation (test environment only):
```sql
-- Disable max_submissions_monthly for a workspace plan (test only)
UPDATE public.plan_entitlements pe
SET is_enabled = false
FROM public.features f
WHERE pe.feature_id = f.id
  AND f.key = 'max_submissions_monthly';
```

## 5. Common Postman Setup
Collection-level Pre-request Script:
```javascript
pm.environment.set("idempotency_key", pm.variables.replaceIn("{{$guid}}"));
pm.environment.set("run_started_at", new Date().toISOString());
```

Request header defaults for submit calls:
1. `Content-Type: application/json`
2. `Idempotency-Key: {{idempotency_key}}`

Optional collection-level Tests snippet:
```javascript
pm.test("Response is JSON when body exists", function () {
  const ct = pm.response.headers.get("Content-Type") || "";
  if (pm.response.text().length > 0) {
    pm.expect(ct.toLowerCase()).to.include("application/json");
  }
});
```

## 6. Endpoint Matrix
| Method | Endpoint | Auth | Expected |
|---|---|---|---|
| GET | `/api/v1/f/:formId/schema` | No | `200` / `404` / `500` |
| POST | `/api/v1/f/:formId/submit` | No + `Idempotency-Key` | `201` / `400` / `403` / `404` / `409` / `422` / `429` / `500` |

## 7. Detailed Postman Requests

### 7.1 Get Schema (success path)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/f/{{form_id_valid}}/schema`

Tests tab:
```javascript
pm.test("Schema fetch success", function () {
  pm.expect(pm.response.code).to.eql(200);
});

const json = pm.response.json();
pm.expect(json).to.have.property("form");
pm.expect(json.form).to.have.property("id");
pm.expect(json.form).to.have.property("published_schema");
```

### 7.2 Get Schema (not found path)
Request:
1. Method: `GET`
2. URL: `{{base_url}}/api/v1/f/{{form_id_invalid}}/schema`

Expected:
1. Status `404`
2. Body includes `error`

### 7.3 Submit (success path)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_valid}}/submit`
3. Headers:
   - `Content-Type: application/json`
   - `Idempotency-Key: {{idempotency_key}}`
4. Body:
```json
{
  "data": {
    "name": "Jane Doe",
    "email": "jane@example.com"
  },
  "started_at": "{{run_started_at}}"
}
```

Tests tab:
```javascript
pm.test("Submit success", function () {
  pm.expect(pm.response.code).to.eql(201);
});

const json = pm.response.json();
pm.expect(json).to.have.property("submission_id");
pm.environment.set("submission_id_1", json.submission_id);
```

### 7.4 Submit Replay (same idempotency key returns same submission)
Important: disable or bypass collection pre-request key regeneration for this request.

Request:
1. Duplicate request from 7.3 with the exact same:
   - URL
   - Body
   - `Idempotency-Key`

Tests tab:
```javascript
pm.test("Idempotent replay returns success", function () {
  pm.expect(pm.response.code).to.be.oneOf([200, 201]);
});

const json = pm.response.json();
pm.test("Same submission id on replay", function () {
  pm.expect(json.submission_id).to.eql(pm.environment.get("submission_id_1"));
});
```

### 7.5 Submit New Attempt (new idempotency key returns new submission)
Request:
1. Same as 7.3, but let pre-request script generate a new key.

Tests tab:
```javascript
pm.test("Submit success with new key", function () {
  pm.expect(pm.response.code).to.eql(201);
});

const json = pm.response.json();
pm.environment.set("submission_id_2", json.submission_id);
pm.test("New submission id differs", function () {
  pm.expect(json.submission_id).to.not.eql(pm.environment.get("submission_id_1"));
});
```

### 7.6 Submit Missing Idempotency Header (`400`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_valid}}/submit`
3. Headers: only `Content-Type: application/json`
4. Body:
```json
{
  "data": {
    "name": "Missing Header"
  }
}
```

Expected:
1. Status `400`
2. Error includes validation issue for `Idempotency-Key`

### 7.7 Submit Invalid Idempotency Header (`400`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_valid}}/submit`
3. Headers:
   - `Content-Type: application/json`
   - `Idempotency-Key: invalid`

Expected:
1. Status `400`

### 7.8 Submit Invalid Body Shape (`400`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_valid}}/submit`
3. Headers:
   - `Content-Type: application/json`
   - `Idempotency-Key: {{idempotency_key}}`
4. Body:
```json
{
  "started_at": "{{run_started_at}}"
}
```

Expected:
1. Status `400`

### 7.9 Unknown Field Rejection (`422 FIELD_VALIDATION_FAILED`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_valid}}/submit`
3. Headers:
   - `Content-Type: application/json`
   - `Idempotency-Key: {{idempotency_key}}`
4. Body:
```json
{
  "data": {
    "name": "Known",
    "unknown_field": "Injected"
  }
}
```

Expected:
1. Status `422`
2. `code = FIELD_VALIDATION_FAILED`
3. `issues[]` includes `unknown_field`

### 7.10 Missing Required Visible Field (`422 FIELD_VALIDATION_FAILED`)
Request:
1. Submit to a form where `email` is required, but omit it.

Expected:
1. Status `422`
2. `code = FIELD_VALIDATION_FAILED`
3. Issue message indicates missing required field

### 7.11 Unsupported Field Schema (`422 UNSUPPORTED_FORM_SCHEMA`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_invalid_schema_type}}/submit`
3. Standard submit headers
4. Body with minimal `data`

Expected:
1. Status `422`
2. `code = UNSUPPORTED_FORM_SCHEMA`
3. `issues[]` describes unsupported field contract

### 7.12 Unsupported Logic Schema (`422 UNSUPPORTED_FORM_SCHEMA`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_invalid_logic}}/submit`
3. Standard submit headers

Expected:
1. Status `422`
2. `code = UNSUPPORTED_FORM_SCHEMA`
3. `issues[]` describes unsupported logic contract

### 7.13 Logic Stripping Verification
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_logic_hide}}/submit`
3. Standard submit headers
4. Body:
```json
{
  "data": {
    "contact_method": "phone",
    "details": "must-be-stripped-if-hidden"
  }
}
```

Expected:
1. Status `201`
2. Response contains `submission_id`

Post-submit DB verification:
```sql
SELECT id, data
FROM public.form_submissions
WHERE id = '<submission_id_from_response>';
```
Expected DB assertion:
1. `data` must not include hidden `details` key when logic hides that field.

### 7.14 Quota Feature Disabled (`403 PLAN_FEATURE_DISABLED`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_quota_disabled}}/submit`
3. Standard submit headers

Expected:
1. Status `403`
2. `code = PLAN_FEATURE_DISABLED`
3. body includes `feature`, `current`, `allowed`, `upgrade_url`

### 7.15 Quota Exhausted (`403 PLAN_LIMIT_EXCEEDED`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_quota_exhausted}}/submit`
3. Standard submit headers

Expected:
1. Status `403`
2. `code = PLAN_LIMIT_EXCEEDED`
3. body includes `feature`, `current`, `allowed`, `upgrade_url`

### 7.16 Form State Conflict (`409`)
Request:
1. Method: `POST`
2. URL: `{{base_url}}/api/v1/f/{{form_id_conflict}}/submit`
3. Standard submit headers

Expected:
1. Status `409`
2. body includes `error = "Form state conflict"`

### 7.17 Rate-Limit (`429`) via Collection Runner
Setup:
1. Create one request targeting:
   - `POST {{base_url}}/api/v1/f/{{form_id_valid}}/submit`
2. Use pre-request script to regenerate idempotency key each iteration:
```javascript
pm.environment.set("idempotency_key", pm.variables.replaceIn("{{$guid}}"));
```
3. Run Collection Runner with enough iterations to exceed your threshold.

Tests tab:
```javascript
const code = pm.response.code;
pm.test("Runner status is expected", function () {
  pm.expect([201, 429]).to.include(code);
});
```

Pass condition:
1. At least one response returns `429`
2. Rate-limited responses include machine-readable code (`RATE_LIMITED` or mapped equivalent)

## 8. Strict Field-Type Validation Matrix
Use `form_id_valid` and mutate one field per request.

| Field Type | Valid Value | Invalid Value | Expected Invalid Result |
|---|---|---|---|
| `text` | `"abc"` | `123` | `422 FIELD_VALIDATION_FAILED` |
| `textarea` | `"long text"` | `{}` | `422 FIELD_VALIDATION_FAILED` |
| `email` | `"user@acme.com"` | `"not-an-email"` | `422 FIELD_VALIDATION_FAILED` |
| `number` | `42` | `"42"` | `422 FIELD_VALIDATION_FAILED` |
| `tel` | `"+1-555-111-2222"` | `true` | `422 FIELD_VALIDATION_FAILED` |
| `url` | `"https://example.com"` | `"bad-url"` | `422 FIELD_VALIDATION_FAILED` |
| `date` | `"2026-02-23"` | `"23-02-2026"` | `422 FIELD_VALIDATION_FAILED` |
| `datetime` | `"2026-02-23T10:00:00Z"` | `"invalid-date"` | `422 FIELD_VALIDATION_FAILED` |
| `time` | `"13:45"` | `"25:99"` | `422 FIELD_VALIDATION_FAILED` |
| `radio` | `"option_a"` | `"missing_option"` | `422 FIELD_VALIDATION_FAILED` |
| `select` | `"option_b"` | `{ "x": 1 }` | `422 FIELD_VALIDATION_FAILED` |
| `multiselect` | `["a","b"]` | `["a","bad"]` | `422 FIELD_VALIDATION_FAILED` |
| `checkbox` | `true` | `false` when required | `422 FIELD_VALIDATION_FAILED` |
| `boolean` | `false` | `"false"` | `422 FIELD_VALIDATION_FAILED` |
| `rating` | `5` | `4.5` | `422 FIELD_VALIDATION_FAILED` |

## 9. Negative Tests Checklist
1. Invalid `formId` UUID in route param -> `400`
2. Missing `Idempotency-Key` on submit -> `400`
3. Invalid `Idempotency-Key` format -> `400`
4. Missing `data` object -> `400`
5. Unknown payload field -> `422 FIELD_VALIDATION_FAILED`
6. Missing required visible field -> `422 FIELD_VALIDATION_FAILED`
7. Unsupported field schema shape/type -> `422 UNSUPPORTED_FORM_SCHEMA`
8. Unsupported logic shape/operator/action -> `422 UNSUPPORTED_FORM_SCHEMA`
9. Form unavailable/not published -> `404`
10. Submission conflict state -> `409`
11. Entitlement disabled -> `403 PLAN_FEATURE_DISABLED`
12. Entitlement exceeded -> `403 PLAN_LIMIT_EXCEEDED`
13. Burst submissions -> `429`
14. Direct Supabase Data API `INSERT` to `public.form_submissions` with anon key -> blocked (`401/403`)
15. Direct Supabase RPC `submit_form` call with anon key -> blocked (`401/403`)

## 10. Expected Response Shapes
Success schema (`200`):
```json
{
  "form": {
    "id": "uuid",
    "title": "string",
    "published_schema": {}
  }
}
```

Success submit (`201`):
```json
{
  "submission_id": "uuid",
  "success_message": "string|null",
  "redirect_url": "string|null"
}
```

Field validation (`422`):
```json
{
  "error": "Field validation failed",
  "code": "FIELD_VALIDATION_FAILED",
  "issues": [
    { "field_id": "email", "message": "must be a valid email" }
  ]
}
```

Unsupported schema (`422`):
```json
{
  "error": "Unsupported form schema",
  "code": "UNSUPPORTED_FORM_SCHEMA",
  "issues": [
    "Field \"x\" has unsupported type \"file_upload\""
  ]
}
```

Entitlement blocked (`403`):
```json
{
  "error": "Submission quota exceeded",
  "code": "PLAN_LIMIT_EXCEEDED",
  "feature": "max_submissions_monthly",
  "current": 100,
  "allowed": 100,
  "upgrade_url": "/pricing"
}
```

Rate limit (`429`):
```json
{
  "error": "Too many requests. Please try again later.",
  "code": "RATE_LIMITED"
}
```

## 11. Recommended Smoke Sequence
Run in this order:
1. Schema success (`7.1`)
2. Submit success (`7.3`)
3. Idempotency replay (`7.4`)
4. Unknown field rejection (`7.9`)
5. Unsupported schema (`7.11`)
6. Unsupported logic (`7.12`)
7. Quota enforcement (`7.14`, `7.15`)
8. Rate-limit burst (`7.17`)

Pass criteria:
1. Success-path requests return expected `200`/`201`.
2. Contract-violation requests return deterministic `4xx` codes.
3. No unexpected `5xx` responses.
4. Direct Supabase write-path bypass attempts are blocked with `401/403`.

## 12. Release Checklist
1. `cmd /c npx tsc --noEmit` passes
2. Postman collection run exported and attached to release notes
3. Idempotency replay proves same `submission_id`
4. Strict fail-closed coverage complete for unsupported schema and logic
5. Entitlement and rate-limit behaviors verified in target environment
6. Direct Supabase submission bypass attempts are blocked
