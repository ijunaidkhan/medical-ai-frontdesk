# AI receptionist (milestone 2)

Status: **approved 2026-09-30, in progress.** M2a is being built in small steps; M2b (telephony and voice) has not started. This records the approved design and the decisions taken while building it.

## Progress

| M2a step | Status |
|---|---|
| 1. Knowledge base (sources, approval workflow, chunks, full-text search, API, permissions) | **done** (migration 0005) |
| 2. Staff tasks (callback and message requests: table, statuses, assignment, API, permissions) | **done** (migration 0006) |
| 3. AI settings and escalation policy | next |
| 4. Agent runtime: model interface, tools, safety layer, conversation records, test-chat endpoint | |
| 5. Web screens: knowledge, tasks, settings, test chat, call review | |
| 6. Real model adapter and the conversation test set | needs the operator's LLM key |

**Knowledge base rules (implemented):** a source is a draft until a person approves it; only approved sources have searchable chunks; editing the title or content of an approved source returns it to draft and removes its chunks at once, so the AI can never use unreviewed wording; archiving removes it; nothing is ever deleted (archived, not erased). Search is PostgreSQL full-text search with the caller's words OR-ed and ranked, tenant-scoped by row-level security, and returns nothing rather than guessing when nothing matches. Composite foreign keys make it impossible for a chunk to point at another practice's source.

**Staff task rules (implemented):** a task has a type (callback, message, question, other), a status (open, in progress, done, cancelled), a priority (normal, urgent), optional contact name and phone (international format), an optional due time and assignee. The assignee must be an *active* member of the same practice (also enforced by a composite foreign key). Allowed status moves are open ↔ in progress, and open or in progress to done or cancelled; a finished task can only be reopened, and must be reopened before it is edited. Completion time and person are recorded exactly when a task is done. Tasks are never deleted. Audit entries record type, priority, source and field names only, never the title or contact details (which may be personal information). Staff-made and AI-made tasks share one creation path (`TasksService.createInTransaction`), so the receptionist's tool (a later step) gets the same validation and audit; an AI-made task has no creator user and is marked as AI-made.

## Order of work

| Milestone | Scope |
|---|---|
| **M2a** | Knowledge base, agent (text channel), tools, safety and escalation, staff tasks, call review, a text "test chat" in the web app |
| **M2b** | Phone number, real calls, speech in and out, transfers |
| **M3** | Appointments (book, cancel, reschedule) with SMS confirmations |
| **M4+** | EHR integrations, analytics, payments |

The brain is built and tested in text first: safety, answering only from approved facts and tool rules are the risky parts, and they are far cheaper to test without a phone line. The phone then connects to the same brain.

## Architecture

```
Caller ─► Phone provider ─► Voice channel ─┐
Staff "test chat" (web) ──► Text channel ──┤
                                           ▼
                        Agent runtime ◄──► LLM (behind an interface)
                           │      ▲
                           ▼      │
                     Safety layer (code, not just prompts)
                           │
                           ▼
        Tool request ─► backend validation ─► business rules ─► database
```

- **One brain, two channels.** Text and voice run the same agent runtime.
- **The tenant comes from how the conversation started** (the number dialed, or the signed-in staff member in test chat). The model never chooses or sees a practice id.
- **The AI only requests; the backend decides.** Anything the AI says about the clinic must come from a tool result (approved knowledge or structured practice data). If it has nothing, it says so and takes a message. It never claims an appointment is booked unless the backend confirms it.
- **Safety is code.** Urgent or clinical requests are detected and a fixed escalation policy decides what happens; replies are checked before they are spoken or shown (no diagnosis, treatment advice or false booking claims); any failure hands over to a human or takes a callback request, never silence.
- **Every turn, tool call and escalation is recorded**, and AI actions are audited with an "AI" actor. Viewing a transcript is itself audited.
- **Untrusted input.** Caller speech and retrieved documents are data, not instructions. Tools have no power beyond their narrow job; the practice always comes from the conversation, never from model output.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Order | Text brain first (M2a), phone second (M2b) | Cheap, fast, repeatable testing of the risky parts |
| Voice technology (M2b) | Chain: speech-to-text, LLM, text-to-speech | Text in the middle lets every reply be checked before it is spoken; vendors are swappable. Slightly higher latency |
| LLM | Behind an interface; a scripted fake model for tests; the real adapter needs the operator's API key and vendor agreement | No vendor chosen yet |
| Knowledge search (M2a) | **PostgreSQL full-text search**, behind a retriever interface | Good for clinic FAQs, no outside vendor, nothing leaves the database. Semantic search (pgvector embeddings) is added when an embeddings vendor is chosen |
| Knowledge input (M2a) | Typed or pasted text, entered by staff and **approved** before the AI may use it | Files and PDFs later |
| Language (M2a) | English | Others later |
| First customer | A single clinic with several staff | |
| Call recording | Transcripts only at first, with an AI-disclosure notice | Recording consent laws vary |

## Permissions added

`knowledge:read`, `knowledge:manage` (with the knowledge base); later `tasks:read`, `tasks:manage`, `ai:configure`, `calls:read`, `calls:review`. Roles are extended, not redesigned.

## Risks and things that need a human decision before real patients

- **HIPAA:** every vendor that touches call content (telephony, speech, LLM, embeddings, hosting) needs a signed agreement. Not verified for any vendor yet. Send vendors the minimum.
- **Emergencies:** the default urgent-symptom rules and wording need review by someone medically and legally qualified. They must not be switchable off by a clinic.
- **Cost and abuse:** per-number and per-conversation limits (spam, endless calls, toll fraud).
- **Prompt injection and unsafe replies:** covered by the conversation test set below, including adversarial cases.

## Testing approach

Tenant isolation of every new table and of retrieval, tested adversarially; a scripted conversation test set (emergency phrases, diagnosis and dosage questions, unanswerable questions, prompt injection, attempts to make the AI claim a booking) that runs in CI against a scripted fake model; an occasional run against the real model; unit tests for the policy engine, reply checks and tool validation.
