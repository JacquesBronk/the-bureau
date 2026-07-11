# API Contract Design
> Define API contracts before implementation. Communicate contracts to frontend agents.

## When to Use
Load this tool when designing new API endpoints or modifying existing ones. Use it before writing implementation code and before sending contracts to frontend agents.

## Process

### 1. Research Existing Conventions
Before designing, read the codebase to answer:
- What URL pattern does the project use? (e.g., `/api/v1/resources`, `/resources`)
- What HTTP methods map to what operations?
- What is the response envelope structure? (e.g., `{ data, error, meta }` or flat)
- What is the error response format? (e.g., `{ error: { code, message, details } }`)
- How is pagination handled? (e.g., cursor-based, offset/limit, page/size)
- How is authentication passed? (e.g., Bearer token, cookie, API key header)

Your new endpoints MUST follow these existing conventions.

### 2. Define the Contract
For each endpoint, specify:

```
METHOD /path
  Auth: required | optional | none
  Request:
    Headers: (if non-standard)
    Params: (URL parameters)
    Query: (query string parameters with types and defaults)
    Body: (JSON schema with required/optional fields and types)
  Responses:
    2xx: (success response shape)
    4xx: (client error responses — 400, 401, 403, 404, 409)
    5xx: (server error response shape)
```

### 3. Design Checklist
Verify your contract against these rules:
- **Resource naming**: plural nouns (`/users`, not `/user`), unless the project uses singular
- **HTTP methods**: GET reads, POST creates, PUT/PATCH updates, DELETE removes
- **Status codes**: 200 for success, 201 for creation, 204 for no-content, 400 for bad input, 401 for unauthenticated, 403 for unauthorized, 404 for not found, 409 for conflict, 422 for unprocessable
- **Idempotency**: PUT and DELETE are idempotent. POST is not. Design accordingly.
- **Filtering/sorting**: Use query parameters, not request body, for GET endpoints
- **Pagination**: Include total count or next cursor in response metadata
- **Versioning**: Follow the project's versioning strategy (URL path, header, or none)

### 4. Communicate to Frontend Agents
When sending a contract to a frontend agent via `send_message`, use this format:

```
API Contract: [Feature Name]

POST /api/v1/users
  Auth: Bearer token required
  Body: { name: string (required), email: string (required), role?: "admin" | "user" }
  201: { data: { id: string, name: string, email: string, role: string, createdAt: string } }
  400: { error: { code: "VALIDATION_ERROR", message: string, details: [{ field, message }] } }
  409: { error: { code: "DUPLICATE_EMAIL", message: string } }

GET /api/v1/users
  Auth: Bearer token required
  Query: { page?: number (default 1), limit?: number (default 20), sort?: "name" | "createdAt" }
  200: { data: User[], meta: { total: number, page: number, limit: number } }

Ready for integration. Tests are written against these contracts.
```

Keep contracts concise. Include only what the frontend needs to integrate.

### 5. Lock the Contract
Once communicated, the contract is locked. Changes require:
1. Notification to all frontend agents who received the contract
2. A migration plan for any already-integrated endpoints
3. Updated tests reflecting the new contract

## Red Flags
- "I'll figure out the response shape during implementation" — STOP. Define it now.
- "The frontend can adapt to whatever I return" — No. Contracts exist for a reason.
- "I'll just return the database model directly" — STOP. API shapes and database shapes are independent. Design the API shape for the consumer.
- "This is an internal endpoint, it doesn't need a contract" — Internal endpoints still need contracts. Other agents depend on them.
