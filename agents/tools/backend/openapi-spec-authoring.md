# OpenAPI Spec Authoring
> Write correct, complete OpenAPI 3.1 specifications from API designs.

## When to Use
Load this tool when writing or updating an OpenAPI specification file. Use after resource modeling and contract design are complete — the spec is the machine-readable encoding of decisions already made.

## Process

### 1. Choose the Right Version
Use OpenAPI 3.1 unless the project already uses 3.0. Key 3.1 differences from 3.0:
- Full JSON Schema 2020-12 support (including `type: ["string", "null"]` instead of `nullable: true`)
- `webhooks` top-level key for event-driven APIs
- `$ref` can have sibling keywords (description, summary)

If the project has an existing spec, match its version exactly.

### 2. Document Structure
Every spec must include these top-level sections:

```yaml
openapi: "3.1.0"
info:
  title: <API name>
  version: <semver>
  description: <one paragraph — what this API does and who it's for>
paths:
  # endpoint definitions
components:
  schemas:
    # reusable data models
  parameters:
    # reusable query/path parameters
  responses:
    # reusable error responses
  securitySchemes:
    # auth definitions
security:
  # default security applied to all endpoints
```

### 3. Schema Design Rules
- Define each resource as a named schema under `components/schemas`.
- Use `$ref` to reference schemas — never inline a schema that appears in more than one endpoint.
- Distinguish between create (input) and read (output) schemas when they differ. Name them: `UserCreate`, `User`.
- Mark required fields explicitly. Do not assume consumers know which fields are optional.
- Use `format` for common types: `date-time` (ISO 8601), `email`, `uri`, `uuid`.
- Use `enum` for closed sets of values. Include every valid value.
- Use `example` on schemas and properties — a spec without examples is incomplete.

### 4. Path and Operation Rules
For each operation under `paths`:

```yaml
/resources/{id}:
  get:
    operationId: getResourceById    # unique, camelCase
    summary: Get a resource by ID   # one line
    description: ...                # optional, for complex operations
    tags: [Resources]               # group in documentation
    parameters:
      - $ref: '#/components/parameters/ResourceId'
    responses:
      '200':
        description: Resource found
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Resource'
            example:
              id: "abc-123"
              name: "Example"
      '404':
        $ref: '#/components/responses/NotFound'
```

Rules:
- Every operation needs a unique `operationId` (used for code generation).
- Every operation needs at least one success response and relevant error responses.
- Every response body needs `content` with media type and schema.
- Every path parameter must have a corresponding `parameters` entry.
- Use `tags` to group endpoints by resource.

### 5. Error Responses
Define reusable error responses in `components/responses`:

```yaml
components:
  responses:
    BadRequest:
      description: Invalid request parameters or body
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            error:
              code: "VALIDATION_ERROR"
              message: "Request validation failed"
              details:
                - field: "email"
                  message: "must be a valid email address"
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            error:
              code: "RESOURCE_NOT_FOUND"
              message: "The requested resource does not exist"
    Unauthorized:
      description: Missing or invalid authentication
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
    Forbidden:
      description: Insufficient permissions
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
```

Use RFC 9457 (Problem Details for HTTP APIs) if the project already uses it. Structure:
```yaml
ProblemDetail:
  type: object
  properties:
    type: { type: string, format: uri }
    title: { type: string }
    status: { type: integer }
    detail: { type: string }
    instance: { type: string, format: uri }
```

### 6. Pagination
Define a reusable pagination pattern. Two common approaches:

**Cursor-based** (preferred for large/changing datasets):
```yaml
PaginatedResponse:
  type: object
  properties:
    data:
      type: array
      items: {}  # override per-endpoint
    meta:
      type: object
      properties:
        hasMore: { type: boolean }
        cursor: { type: ["string", "null"] }
```

**Offset-based** (simpler, fine for stable datasets):
```yaml
PaginatedResponse:
  type: object
  properties:
    data:
      type: array
      items: {}
    meta:
      type: object
      properties:
        total: { type: integer }
        page: { type: integer }
        limit: { type: integer }
```

### 7. Security Schemes
Define the auth mechanism used by the project:

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    apiKey:
      type: apiKey
      in: header
      name: X-API-Key
```

Apply at the top level for default, override per-operation for exceptions:
```yaml
security:
  - bearerAuth: []

# Per-operation override (public endpoint):
paths:
  /health:
    get:
      security: []  # no auth required
```

### 8. Validation Checklist
Before delivering the spec, verify:

- [ ] Every `$ref` resolves to an existing schema/parameter/response
- [ ] Every path parameter has a matching `parameters` entry
- [ ] Every operation has a unique `operationId`
- [ ] Every request body has `required: true` when the body is mandatory
- [ ] Every response includes an `example`
- [ ] Error responses cover at least: 400, 401, 404 (and 403, 409 where relevant)
- [ ] Pagination parameters and response shape are consistent across all list endpoints
- [ ] `required` arrays on object schemas list all mandatory fields
- [ ] `type` and `format` are specified for every property
- [ ] The spec is valid YAML/JSON (no syntax errors)

## Iron Law
A spec without examples for every endpoint is incomplete. Do not deliver it.

## Red Flags
- "I'll add the error responses later" — define them now or they won't match the implementation.
- "The schema is obvious, I don't need to write it out" — write it out. Code generators and consumers need explicit schemas.
- "I'll just use `type: object` without properties" — every object schema must define its properties.
- Duplicating the same schema inline across multiple endpoints instead of using `$ref`.
