# AI receptionist (milestone 2)

Status: **approved 2026-09-30, in progress.** M2a is being built in small steps; M2b (telephony and voice) has not started. This records the approved design and the decisions taken while building it.

## Progress

| M2a step | Status |
|---|---|
| 1. Knowledge base (sources, approval workflow, chunks, full-text search, API, permissions) | **done** (migration 0005) |
| 2. Staff tasks (callback and message requests: table, statuses, assignment, API, permissions) | **done** (migration 0006) |
| 3. AI settings and escalation policy (configuration: greeting, hours, after-hours and urgent handling, emergency message, transfer numbers, on/off gate) | **done** (migration 0007); the escalation *engine* that reads it is built with the agent (step 4) |
| 4a. Foundations for the agent: conversation, turn and tool-call tables; an "AI" actor type in the audit log; `calls:read` (migration 0008) | **done** |
| 4b. Safety layer: urgency classifier, escalation planner, reply checker, conversation safety test set | **done** (`apps/api/src/agent/safety`) |
| 4c. Agent runtime: model interface + scripted model, tools, conversation flow, test-chat endpoint, transcript API | **done** (`apps/api/src/agent`; no migration needed) |
| 4d. A separate **crisis message** for suicide and self-harm (for example 988 in the US), next to the medical-emergency message (911) | **done** (migration 0009) |
| 5a. Web: AI settings screen (messages, hours, urgent handling, transfer numbers, on/off) | **done** (`/ai`) |
| 5b–5e. Web: knowledge, staff tasks, conversation review, test chat | next, in that order |
| 6. Real model adapter and the conversation test set | needs the operator's LLM key |

**Knowledge base rules (implemented):** a source is a draft until a person approves it; only approved sources have searchable chunks; editing the title or content of an approved source returns it to draft and removes its chunks at once, so the AI can never use unreviewed wording; archiving removes it; nothing is ever deleted (archived, not erased). Search is PostgreSQL full-text search with the caller's words OR-ed and ranked, tenant-scoped by row-level security, and returns nothing rather than guessing when nothing matches. Composite foreign keys make it impossible for a chunk to point at another practice's source.

**Staff task rules (implemented):** a task has a type (callback, message, question, other), a status (open, in progress, done, cancelled), a priority (normal, urgent), optional contact name and phone (international format), an optional due time and assignee. The assignee must be an *active* member of the same practice (also enforced by a composite foreign key). Allowed status moves are open ↔ in progress, and open or in progress to done or cancelled; a finished task can only be reopened, and must be reopened before it is edited. Completion time and person are recorded exactly when a task is done. Tasks are never deleted. Audit entries record type, priority, source and field names only, never the title or contact details (which may be personal information). Staff-made and AI-made tasks share one creation path (`TasksService.createInTransaction`), so the receptionist's tool (a later step) gets the same validation and audit; an AI-made task has no creator user and is marked as AI-made.

**AI settings rules (implemented):** one settings row per practice, all off by default. A practice writes a greeting; **the notice "You are speaking with an automated AI assistant, not a person." is always added by the system and cannot be removed.** Business hours are per weekday, in the practice's own time zone (daylight-saving safe; a period includes its opening minute and excludes its closing minute; at most three periods a day; `24:00` allowed only as a closing time). After hours the AI either takes a message or transfers; for an *urgent* request it transfers, creates an urgent task, or both. Transfer numbers are separate records (international format, unique per practice, deactivated rather than deleted), and settings can only point at an active number of the same practice (composite foreign key). Clinics may add **extra** urgent phrases for their specialty (for example crisis wording for a mental-health practice); these are added to the built-in list and can never replace it.

**The on switch is a safety gate.** The AI can only be turned on when it has a greeting, an emergency message (at least ten characters: what callers hear about who to call in a medical emergency, for example 911 in the US), a **crisis message** (at least ten characters: what callers hear if they mention suicide or self-harm, for example the 988 line in the US), business hours, and an active transfer number wherever the settings say calls are transferred. The API answers 409 with the full list of what is missing, and the database independently refuses `enabled` without a greeting, an emergency message and a crisis message, so no bug can bypass it. (Migration 0009 added the crisis message; practices that were already switched on without one were switched off by it, recorded in the audit log as the system, because that is the safe direction.) The two messages are separate because a receptionist gives two different answers: 911 for a medical emergency, 988 for thoughts of suicide. Turning the AI off is always allowed, and it cannot be left on while any of those are removed. **The wording of emergency messages and of the built-in urgent-symptom list needs review by someone medically and legally qualified before real patients use this.**

**Safety layer (implemented, `apps/api/src/agent/safety`)** is plain deterministic code that does not depend on the AI model:

- **Urgency classifier.** Every caller message is checked against a built-in list of *emergency* phrases (chest pain, cannot breathe, stroke signs, overdose, danger to others, and so on), a separate built-in list of *crisis* phrases (suicide and self-harm, including past tense and a caller describing someone else, such as "he wants to kill himself"), and *urgent* phrases (very high fever, out of medication, panic attack, in crisis, and so on), plus the practice's own extra urgent phrases. Matching ignores capitals, punctuation and apostrophes and works on whole words. An emergency always wins; a practice can add urgent phrases but can never remove or lower the built-in ones. It deliberately over-triggers (it does not understand negation: "no chest pain" is still an emergency), because a false alarm costs a moment and a missed emergency can cost a life. It knows English only, and cannot see deliberately disguised wording.
- **Escalation planner.** A crisis phrase is an emergency too, but the caller hears the practice's own **crisis message** (988) instead of the emergency message (911); a call with both kinds of phrase hears both (medical first); if the crisis message is ever empty the emergency message is used, so a caller never hears nothing. An emergency makes the caller hear the practice's own message(s) word for word plus a fixed "I have also alerted our team", creates an urgent task, and hands the conversation to the urgent number when one is configured. This cannot be configured away. An urgent request follows the practice's setting (transfer, urgent task, or both), always creates a task if there is nowhere to transfer to (a request is never lost), never uses an inactive number, prefers the after-hours number after hours when the practice transfers then, and always ends with the emergency message as a safety net. The AI model has no say in any of this: none of these words come from a model.
- **Reply checker.** Every reply the model writes is checked on its way out and replaced by a fixed safe line if it: names or guesses an illness ("you probably have…", "sounds like…", "a sign of…"); gives medication amounts or advice (digits or words: "500 mg", "two tablets", "stop taking…"); recommends treatments; offers false reassurance ("it's nothing serious"); claims an appointment was booked or confirmed (the receptionist cannot book yet; when booking exists, a claim will only pass with the backend's confirmation); claims to be a human, nurse or doctor; leaks or obeys instructions; is empty or too long. The checks are deliberately blunt: a false alarm costs one safe fallback line. All fixed lines are tested to pass the checker themselves.
- **The lists need qualified review.** The built-in phrase lists and the exact wording are a conservative starting point written by a developer, not a clinician. **They must be reviewed by someone medically and legally qualified for each country served before real patients use the receptionist.**
- **Tests.** About 200 cases: emergency sentences (including denials and mixed messages), urgent sentences, ordinary calls that must not trigger, weird input (empty, another script, emoji, huge messages, text that looks like instructions to the AI), replies that must be blocked and ordinary replies that must pass, and every escalation path. Deliberate breakages of each rule are caught.

**Agent runtime (implemented, `apps/api/src/agent`).** One message goes through these steps, in this order:

1. **Record.** The caller's message is stored (control characters removed, at most 2,000 characters) in a short transaction; no transaction is held open while the model thinks.
2. **Safety classifier (code).** A *new* emergency or urgent request is answered by the fixed script and **the model is not asked**. It creates an urgent task (priority set in code, never by a model) and, when the practice has a usable transfer number, hands the conversation over and the AI stops.
3. **Stays on the line when nobody takes the call.** If there is no transfer number, the conversation stays open and the script ends with "If you would like our team to call you back, tell me your name and phone number." So "I have chest pain and I need an appointment" gets the emergency message and an urgent task, and the appointment request is still captured as a callback task. The model is then in **message-only mode**: it is told not to discuss symptoms or answer questions, and it gets only two tools (`create_staff_task`, `end_conversation`); any other tool request is refused and recorded. If the caller repeats an emergency phrase, the model still answers (so contact details are not lost), the matching practice message (emergency and/or crisis) is added after its reply, and no second task is made. An urgent call that later becomes an emergency escalates again.
4. **Model with tools.** Otherwise the model answers with up to three rounds of tool calls (at most four calls a turn). Tools: `search_knowledge` (approved knowledge only), `get_practice_info` (name, phone, hours, open now), `create_staff_task` (normal priority only, at most three a conversation, validated by the same rules as staff-made tasks, made by the "AI" actor and linked to the conversation), `request_human_handoff` (hands over when a number is available; otherwise the model is told to take a message), `end_conversation`. The practice is never an argument: it comes from the stored conversation. Each tool runs in its own short transaction together with its record (`tool_invocations`); a failing tool rolls back and is recorded as an error; a refused call is recorded as rejected.
5. **Reply checker (code).** The reply is checked; an unsafe, empty or missing reply (including a model outage or a 20-second timeout) is replaced by a fixed safe line, marked on the transcript with the reason. The model's blocked words are not stored.
6. **Store and finish.** The reply is stored, with how it was produced (model, or which fixed script). Outcomes: `emergency` if the conversation was ever an emergency, `message_taken` if it created a task, otherwise `answered`; a hand-over ends as `handed_off` (or `emergency`). A conversation over 30 caller messages is ended with a fixed line plus the emergency message, but an emergency message inside it is still handled first.

Nothing here can be reached without a language model being configured, except the fixed safety scripts: a test chat cannot *start* (503) until an operator sets a model up. The default model is "unconfigured"; tests use a scripted fake, and the real vendor adapter is step 6.

Test chat (`POST /api/agent/test-conversations` and `.../:id/messages`) needs `ai:configure` and works before the AI is switched on, but only when the practice has a greeting and an emergency message (409 lists what is missing). Transcripts and tool calls are read with `calls:read`, and every view of a transcript is audited (`conversation.viewed`). Escalations are audited as `conversation.escalated` by the "system" actor, with the level and what happened, never the caller's words.

**Known limits:** a model's reply text that the checker blocks is not kept (only the reason). A test chat is one stream per conversation, so two messages sent at the same instant are ordered by the database but may interleave. The vendor adapter must merge or order the first assistant message (the greeting) as its API requires.

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
