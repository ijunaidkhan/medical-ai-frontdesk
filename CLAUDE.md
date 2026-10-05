# AI Medical Front Desk

## Product

This is a multi-tenant SaaS AI medical receptionist.

The system allows medical practices to:

- Configure an AI receptionist
- Answer inbound calls
- Answer approved clinic questions
- Schedule appointments
- Cancel appointments
- Reschedule appointments
- Route calls
- Create staff tasks
- Send SMS
- Review conversations
- Monitor AI performance

## Technology

Frontend:
- Angular
- TypeScript

Backend:
- NestJS
- TypeScript

Database:
- PostgreSQL
- pgvector

Infrastructure:
- AWS
- Docker

AI:
- Realtime voice model
- LLM tool calling
- RAG knowledge base

## Architecture Rules

The LLM is NOT the source of truth.

The backend owns:

- authorization
- validation
- business rules
- patient access
- appointment availability
- database mutations
- audit logs

The AI can request tools but cannot directly modify data.

Example:

AI
 ↓
Tool request
 ↓
Backend validation
 ↓
Business rules
 ↓
Database / external integration
 ↓
Result
 ↓
AI response

## Multi-tenancy

Every organization/practice must be isolated.

Never allow one tenant to access another tenant's:

- patients
- calls
- appointments
- knowledge
- users
- integrations
- audit logs

## Medical safety

The AI must not:

- diagnose
- prescribe
- provide treatment advice
- invent medical information
- claim an appointment was booked unless backend confirms it

Clinical/urgent requests must follow configured escalation policies.

## Development Rules

Before implementing a major feature:

1. Explain the architecture.
2. Identify affected modules.
3. Identify database changes.
4. Identify API changes.
5. Identify tests.
6. Implement incrementally.
7. Run tests.
8. Report what changed.

Do not rewrite unrelated code.

Do not introduce dependencies without explaining why.

Do not hard-code credentials.

Do not commit secrets.

Code commenting and neat and clean to the point code.

## Code Quality

- Strict TypeScript
- DTO validation
- Unit tests
- Integration tests
- Structured logging
- Error handling
- Idempotency for external side effects
- Audit logging for sensitive operations