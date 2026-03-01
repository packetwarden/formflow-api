# HackerMind API Abuse Test Pack (Authorized Security Testing Only)

Use this only for apps you own or have explicit permission to test.
Target base path: `/api/v1/*`.

## Postman Variables

- `base_url` (example: `https://your-worker-domain.workers.dev`)
- `access_token_admin`
- `workspace_id`
- `form_id`
- `idempotency_key` (UUID)
- `checkout_idempotency_key` (UUID)

## Optional Postman Pre-request Script (UUID headers)

```javascript
pm.variables.set("idempotency_key", crypto.randomUUID());
pm.variables.set("checkout_idempotency_key", crypto.randomUUID());
```

## Attack-Style Negative Tests

### 1) Signup mass-assignment probe (expect 400)

Method: `POST`
URL: `{{base_url}}/api/v1/auth/signup`
Headers: `Content-Type: application/json`

```json
{
  "email": "attacker+signup1@example.com",
  "password": "StrongPass123!",
  "full_name": "Probe User",
  "role": "owner",
  "is_admin": true,
  "workspace_id": "00000000-0000-0000-0000-000000000000"
}
```

Expected: strict schema rejection (`400`).

### 2) Login enum probe (expect 401)

Method: `POST`
URL: `{{base_url}}/api/v1/auth/login`
Headers: `Content-Type: application/json`

```json
{
  "email": "nonexistent-user@example.com",
  "password": "wrong-password"
}
```

Expected: generic auth failure (`401`), no user-existence leak.

### 3) Build create form mass-assignment probe (expect 400)

Method: `POST`
URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms`
Headers:
- `Authorization: Bearer {{access_token_admin}}`
- `Content-Type: application/json`

```json
{
  "title": "Attack Probe Form",
  "description": "schema strictness check",
  "slug": "forced-slug-attack",
  "status": "published",
  "version": 999,
  "workspace_id": "00000000-0000-0000-0000-000000000000",
  "deleted_at": "2026-02-28T00:00:00Z"
}
```

Expected: strict schema rejection (`400`).

### 4) Build PATCH stale-write race probe (expect 409)

Method: `PATCH`
URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}`
Headers:
- `Authorization: Bearer {{access_token_admin}}`
- `Content-Type: application/json`

```json
{
  "version": 1,
  "title": "stale write attempt"
}
```

Expected: optimistic lock conflict (`409`) when version is stale.

### 5) Build PATCH minimal invalid payload (expect 400)

Method: `PATCH`
URL: `{{base_url}}/api/v1/build/{{workspace_id}}/forms/{{form_id}}`
Headers:
- `Authorization: Bearer {{access_token_admin}}`
- `Content-Type: application/json`

```json
{
  "version": 2
}
```

Expected: validation error (`400`) because no editable field is provided.

### 6) Runner submit with invalid idempotency header (expect 400)

Method: `POST`
URL: `{{base_url}}/api/v1/f/{{form_id}}/submit`
Headers:
- `Idempotency-Key: invalid`
- `Content-Type: application/json`

```json
{
  "data": {
    "email": "probe@example.com"
  },
  "started_at": "2026-02-28T12:00:00Z"
}
```

Expected: `FIELD_VALIDATION_FAILED` for `Idempotency-Key` (`400`).

### 7) Runner unknown-field injection probe (expect 422)

Use at least one real field id from your published schema and add hostile extras.

Method: `POST`
URL: `{{base_url}}/api/v1/f/{{form_id}}/submit`
Headers:
- `Idempotency-Key: {{idempotency_key}}`
- `Content-Type: application/json`

```json
{
  "data": {
    "real_field_id_here": "normal value",
    "is_admin": true,
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "__proto__": {
      "polluted": "yes"
    }
  },
  "started_at": "2026-02-28T12:00:00Z"
}
```

Expected: unknown fields blocked (`422`) and never persisted.

### 8) Runner type-confusion payload (expect 422)

Method: `POST`
URL: `{{base_url}}/api/v1/f/{{form_id}}/submit`
Headers:
- `Idempotency-Key: {{idempotency_key}}`
- `Content-Type: application/json`

```json
{
  "data": {
    "email": ["array-instead-of-string"],
    "age": "999999999999999999999999",
    "consent": "true",
    "rating": 4.7
  },
  "started_at": "2026-02-28T12:00:00Z"
}
```

Expected: field-level validation failures (`422`).

### 9) Runner parser stress payload (expect 422 or 413)

Method: `POST`
URL: `{{base_url}}/api/v1/f/{{form_id}}/submit`
Headers:
- `Idempotency-Key: {{idempotency_key}}`
- `Content-Type: application/json`

```json
{
  "data": {
    "real_field_id_here": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "started_at": "2026-02-28T12:00:00Z"
}
```

Expected: graceful validation failure, not 5xx crash.

### 10) Runner strict rate limit probe (expect 429)

Method: `POST`
URL: `{{base_url}}/api/v1/f/{{form_id}}/submit`
Headers:
- `Idempotency-Key: <new UUID each request>`
- `Content-Type: application/json`

```json
{
  "data": {
    "real_field_id_here": "burst-test"
  },
  "started_at": "2026-02-28T12:00:00Z"
}
```

Send 3+ requests quickly from same IP. Expected: `429` with `Retry-After`.

### 11) Stripe checkout enum bypass probe (expect 400)

Method: `POST`
URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id}}/checkout-session`
Headers:
- `Authorization: Bearer {{access_token_admin}}`
- `Idempotency-Key: {{checkout_idempotency_key}}`
- `Content-Type: application/json`

```json
{
  "plan_slug": "pro",
  "interval": "weekly"
}
```

Expected: schema validation error (`400`).

### 12) Stripe checkout idempotency replay abuse test (expect 409 on second call)

Request A body:

```json
{
  "plan_slug": "pro",
  "interval": "monthly"
}
```

Request B body (same `Idempotency-Key`, changed payload):

```json
{
  "plan_slug": "business",
  "interval": "monthly"
}
```

Expected second response: `409` with idempotency payload mismatch code.

### 13) Stripe webhook signature bypass probe (expect 400)

Method: `POST`
URL: `{{base_url}}/api/v1/stripe/webhook`
Headers:
- `Content-Type: application/json`
- `stripe-signature: t=123,v1=fake,v0=fake`

```json
{
  "id": "evt_fake",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_fake"
    }
  }
}
```

Expected: `Invalid Stripe signature` (`400`).

### 14) Internal catalog sync auth bypass probe (expect 403)

Method: `POST`
URL: `{{base_url}}/api/v1/stripe/catalog/sync`
Headers:
- `Content-Type: application/json`

```json
{}
```

Expected: forbidden without internal token (`403`).

## What to watch for

- Any `500` or unhandled stack traces.
- Different error messages for equivalent auth failures.
- Acceptance of unknown keys (`role`, `workspace_id`, `__proto__`).
- Missing `Retry-After` on `429`.
- Idempotency key reuse accepted with changed payload.

## Optional logging checklist per request

- Endpoint + method
- Headers used (especially `Authorization`, `Idempotency-Key`)
- Request body hash
- Status code
- Response `code` value
- Correlation id (if returned)

## Authorization Manipulation Tests (Cross-Tenant / IDOR)

These checks validate that knowing another `workspaceId` or `formId` does **not** grant access.

### Extra Postman Variables

- `access_token_user_a`
- `access_token_user_b`
- `workspace_id_user_a`
- `workspace_id_user_b`
- `form_id_user_a`
- `form_id_user_b`

Use two real users in different workspaces:
- User A: member/admin of workspace A only
- User B: member/admin of workspace B only

### 15) Workspace forms listing with foreign workspace ID (expect 403 or 404)

Method: `GET`
URL: `{{base_url}}/api/v1/build/{{workspace_id_user_b}}/forms`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`

Expected: no forms from workspace B are returned to user A.

### 16) Direct foreign form read (expect 403 or 404)

Method: `GET`
URL: `{{base_url}}/api/v1/build/{{workspace_id_user_b}}/forms/{{form_id_user_b}}`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`

Expected: blocked (no cross-tenant form disclosure).

### 17) Workspace/Form mismatch tampering (expect 404)

Method: `GET`
URL: `{{base_url}}/api/v1/build/{{workspace_id_user_a}}/forms/{{form_id_user_b}}`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`

Expected: no object returned when `form_id` belongs to a different workspace.

### 18) Foreign form PATCH tampering (expect 403 or 404)

Method: `PATCH`
URL: `{{base_url}}/api/v1/build/{{workspace_id_user_b}}/forms/{{form_id_user_b}}`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`
- `Content-Type: application/json`

```json
{
  "version": 1,
  "title": "cross-tenant overwrite attempt"
}
```

Expected: blocked update.

### 19) Foreign form PUT tampering (expect 403 or 404)

Method: `PUT`
URL: `{{base_url}}/api/v1/build/{{workspace_id_user_b}}/forms/{{form_id_user_b}}`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`
- `Content-Type: application/json`

```json
{
  "version": 1,
  "schema": {
    "layout": {},
    "theme": {},
    "steps": [],
    "logic": [],
    "settings": {}
  }
}
```

Expected: blocked draft overwrite.

### 20) Foreign form publish attempt (expect 403 or 404)

Method: `POST`
URL: `{{base_url}}/api/v1/build/{{workspace_id_user_b}}/forms/{{form_id_user_b}}/publish`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`
- `Content-Type: application/json`

```json
{
  "description": "unauthorized publish attempt"
}
```

Expected: blocked publish.

### 21) Foreign form delete attempt (expect 403 or 404)

Method: `DELETE`
URL: `{{base_url}}/api/v1/build/{{workspace_id_user_b}}/forms/{{form_id_user_b}}`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`

Expected: blocked delete.

### 22) Subscription checkout against foreign workspace (expect 403 or 404)

Method: `POST`
URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id_user_b}}/checkout-session`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`
- `Idempotency-Key: {{checkout_idempotency_key}}`
- `Content-Type: application/json`

```json
{
  "plan_slug": "pro",
  "interval": "monthly"
}
```

Expected: blocked billing session creation for non-member/non-admin workspace.

### 23) Subscription portal against foreign workspace (expect 403 or 404)

Method: `POST`
URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id_user_b}}/portal-session`
Headers:
- `Authorization: Bearer {{access_token_user_a}}`

Expected: blocked portal session creation.

### 24) Checkout idempotency isolation across workspaces (no data bleed)

Use the **same** `Idempotency-Key` twice.

Request A:
- URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id_user_a}}/checkout-session`
- Headers: `Authorization: Bearer {{access_token_user_a}}`, `Idempotency-Key: {{checkout_idempotency_key}}`
- Body:

```json
{
  "plan_slug": "pro",
  "interval": "monthly"
}
```

Request B:
- URL: `{{base_url}}/api/v1/stripe/workspaces/{{workspace_id_user_b}}/checkout-session`
- Headers: `Authorization: Bearer {{access_token_user_b}}`, `Idempotency-Key: {{checkout_idempotency_key}}`
- Body:

```json
{
  "plan_slug": "pro",
  "interval": "monthly"
}
```

Expected: workspace B must never receive workspace A checkout URL/session data.

### 25) User identity isolation via token swap (`/auth/me`)

Method: `GET`
URL: `{{base_url}}/api/v1/auth/me`

Run twice with different headers:
- `Authorization: Bearer {{access_token_user_a}}`
- `Authorization: Bearer {{access_token_user_b}}`

Expected: each response returns only the caller's own user identity.

### 26) UUID enumeration consistency check (existence leak test)

Try 5-10 requests against build endpoints using:
- random non-existent `workspaceId`
- real foreign `workspaceId`

Example:
- `GET {{base_url}}/api/v1/build/{{workspace_id_random}}/forms`
- `GET {{base_url}}/api/v1/build/{{workspace_id_user_b}}/forms` with user A token

Expected: avoid distinguishable responses that reveal tenant existence patterns.

## Authorization Findings Template

For each test record:
- `request_id` (your own generated id)
- actor token (`user_a` or `user_b`)
- target workspace/form ids
- status code
- response `error`/`code`
- whether unauthorized data was returned
- pass/fail
