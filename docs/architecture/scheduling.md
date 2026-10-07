# Scheduling (milestone 3): proposal

Status: **approved 2026-10-01; all 5 steps built** (2026-10-07). Results with the local model: [evaluations/ai-scheduling-llama3.2-3b.md](../evaluations/ai-scheduling-llama3.2-3b.md). Decisions taken with the operator (2026-10-01): appointments belong to **providers**, each with their own hours; a caller is identified by **name + phone + date of birth**; the schedule lives **in our own database first** (calendar or EHR connections later).

## What we are building

The AI receptionist can find open times, **book, cancel and reschedule** appointments, and staff can see and manage the same calendar. The governing rule from the project is kept absolutely: **the AI may only say an appointment is booked, cancelled or moved after the backend has done it, and the words that say so are written by the backend, not by the AI.**

```
Caller ─► AI (text or phone) ─► asks for a tool ─► BACKEND decides ─► database
                                                       │
            availability, rules, identity, no double booking, audit
                                                       │
                          result ─► the backend writes the confirmation sentence
```

## Concepts

| Concept | Meaning |
|---|---|
| **Provider** | A doctor, nurse, therapist or room that can be booked. Has its own weekly hours and days off. |
| **Appointment type** | "New patient visit, 40 minutes", "Follow-up, 20 minutes". Each type lists which providers offer it. |
| **Slot** | A bookable start time for one provider and one type, worked out by code from the hours, days off, existing appointments, and the practice's rules. |
| **Patient** | Name, date of birth, phone. Only what scheduling needs; no clinical data. |
| **Appointment** | One provider, one type, one patient, a start and end, a status (booked, cancelled, completed, no show), and who made it (AI or a named staff member). |
| **Scheduling rules** (per practice) | Slot spacing (for example every 15 minutes), earliest booking (for example 2 hours' notice), furthest ahead (for example 60 days), latest cancellation (for example 24 hours before), and **whether the AI may book at all** (off by default, a separate switch from "AI on"). |

## Rules the backend enforces (the AI cannot change any of them)

1. **No double booking, guaranteed by the database**, not just by code: an exclusion constraint makes two booked appointments for one provider overlapping in time impossible, even for two callers at the same instant. The loser is told the time was just taken and is offered others.
2. **Availability is computed by code**, in the practice's own time zone (daylight saving safe, reusing the logic that already handles business hours), from provider hours, days off, existing appointments and the rules above. The AI never works out a time.
3. **The AI is shown a handful of real options** and picks one; the booking re-checks the slot at that moment.
4. **Repeated requests never double-book:** every booking carries an idempotency key, so a retried tool call returns the same appointment.
5. **Confirmation words come from the backend.** After a successful booking, cancellation or move, the caller hears a sentence the backend composes from the stored appointment ("Your follow-up with Dr Khan is booked for Tuesday 7 October at 10:00."). The model's own text for that turn is discarded. Anything the model says about a failure (the time was taken, no availability) goes through the normal reply checks. The existing reply check that blocks any booking claim stays in force for everything else.
6. **Cancel and reschedule respect the practice's cancellation window.** Inside the window the AI does not cancel; it takes a message for staff.
7. **Reschedule is one step:** the new time is booked and the old one released together, or neither happens.
8. Emergency and crisis messages still come first and still never reach the model.

## Who is calling: identity and privacy

- **Booking** needs name, date of birth and phone. A matching patient is reused; otherwise a new patient record is created.
- **Seeing, cancelling or moving existing appointments** needs the caller to match an existing patient on **all three** details. The caller ID of a phone call is *not* treated as proof (it can be faked); it is only a hint.
- **Three failed matches in one conversation lock identification for that conversation**: the AI offers to take a message for staff instead. A failed match never says which detail was wrong.
- A verified caller can be told **only the date, time, provider and type of their own appointments**. Never another patient's, never anything clinical. The AI cannot look up a person; only the caller's own verified record is ever reachable.
- Patient details are personal health information: tenant-isolated by the database like everything else, never written to application logs or audit metadata (identifiers only), and **a signed privacy agreement with every vendor that sees call content is needed before real patients are used** (unchanged from the AI receptionist plan).
- Known limit, accepted for scheduling only: name + date of birth + phone is a weak identity check. It is acceptable for low-risk actions (moving a visit) and is **never** used to release medical information, which the AI does not have anyway.

## What changes

**Database** (new migrations, all with row-level security like every tenant table; composite foreign keys so nothing can point at another practice's rows; no deletes, only cancel):
`providers` (with their weekly hours as a column, in the same shape as the practice's business hours), `appointment_types`, `provider_appointment_types`, `provider_time_off`, `patients`, `appointments` (with the exclusion constraint, which needs the `btree_gist` extension), `scheduling_settings`; plus on `conversations` the verified patient and the failed-match counter. Appointments are never edited in place except for status changes.

**Permissions** (added to the existing table; roles extended, not redesigned): `schedule:read` (see the calendar; owner, admin, staff), `schedule:manage` (book, cancel, move; owner, admin, staff), `schedule:configure` (providers, types, hours, rules; owner, admin), `patients:read` (find and view patients; owner, admin, staff). Viewers see none of it.

**API** (all under the signed-in practice, none takes a practice id): providers, appointment types, hours and days off, scheduling rules; `GET /api/availability`; appointments (list by day or week, book, cancel, reschedule); patients (search by name or phone, create). Every read of a patient record and every change to an appointment is audited, with identifiers only.

**AI tools** (added to the existing tool set; the model can only request): `find_available_slots`, `verify_patient`, `book_appointment`, `list_my_appointments`, `cancel_appointment`, `reschedule_appointment`. All validated by the backend; all recorded like every other tool call. They exist only when the practice has switched on AI scheduling.

**Web:** a schedule page (day and week view, book and cancel), screens for providers and their hours, appointment types and the rules, and a small patient search. The test chat and call review pages show scheduling actions like any other tool use.

## Tests

- **Availability engine** (pure code, the heaviest tests): multiple periods a day, days off, existing appointments, lead time, furthest-ahead limit, daylight-saving changes, different time zones, back-to-back visits, durations that do not fit.
- **Concurrency against a real database:** many callers booking the same slot at once end with exactly one appointment; repeated tool calls book once.
- **Tenant isolation** of every new table and endpoint, adversarial as before.
- **Identity:** wrong details, three failures, guessing another patient's appointment id, a caller trying to learn whether a person is a patient.
- **Scripted conversations** with the fake model: book, slot just taken, cancel inside and outside the window, reschedule, a model that claims "booked" without the backend, prompt injection, emergencies in the middle of booking.
- **Mutation checks** on every rule, as before; and, once built, a run of the conversation set against the real models (the free local one and, when available, a hosted one).

## Steps (each tested and reported before the next)

1. Foundations: tables, permissions, the availability engine, and the staff API for providers, types, hours, days off and rules. **Done** (see "Step 1 as built" below).
2. Patients and appointments (staff API): booking rules, the exclusion constraint, cancel and reschedule, idempotency, audit. **Done** (see "Step 2 as built" below).
3. AI scheduling: the tools, identity checks, backend-written confirmations, and the AI scheduling switch. **Done** (approved by the operator 2026-10-01; see "Step 3 design" and "Step 3 as built" below).
4. Web: schedule, providers, types, rules, patient search. **Done** (2026-10-02; see "Step 4 design" below and [web-app.md](web-app.md)).
5. Conversation test set against the real models, and the documentation. **Done** (2026-10-07): `npm run eval:scheduling`; results, backend changes and known limits in [evaluations/ai-scheduling-llama3.2-3b.md](../evaluations/ai-scheduling-llama3.2-3b.md).
6. Later, not in this milestone: text or email confirmations and reminders (needs a messaging provider), connections to Google Calendar or an EHR, several locations, recurring visits, waiting lists.

## Step 1 as built

**Migration `0012_scheduling_foundations`:** `scheduling_settings` (one row per practice, created on the first change; no row means the defaults), `providers`, `appointment_types`, `provider_appointment_types`, `provider_time_off`. All have row-level security (enabled and forced); the link table and time off use composite foreign keys so a row can never point at another practice's provider or type. The API role can read and insert, change only the listed columns (never `practice_id`), and cannot delete anything of record; only the provider-to-type links can be removed, because they are configuration, not history.

**Defaults** (no settings row): 15-minute slots, 2 hours' notice, 60 days ahead, 24-hour cancellation window, **AI booking off**.

**Endpoints** (all for the signed-in practice; reads need `schedule:read`, writes need `schedule:configure`, so staff can look but not change the setup, and viewers see nothing):

| Method and path | What it does |
|---|---|
| `GET`, `PATCH /api/scheduling/settings` | Read or change the booking rules. Switching AI booking on is refused (409, with the list of what is missing) until there is an active provider with hours who offers an active appointment type. Switching it off is always allowed. |
| `GET`, `POST /api/providers`, `GET`, `PATCH /api/providers/:id` | Providers with their weekly hours and the appointment types they offer. Switched off, never deleted. |
| `GET`, `POST /api/providers/:id/time-off`, `POST /api/provider-time-off/:id/cancel` | Days off (upcoming only in the list). Cancelled, never deleted. |
| `GET`, `POST`, `PATCH /api/appointment-types` | Visit types: name (unique per practice), 5 to 480 minutes, and which providers offer them. |
| `GET /api/availability?appointmentTypeId=…` | The open start times a caller would be offered, computed by the same code the AI will use. Optional `providerId`, `from`, `to` (at most 62 days, default the next 14) and `limit` (default 20, at most 100). Appointments do not exist yet, so for now only hours, days off and the rules limit it. |

**Availability engine** (`availability.ts`, `zoned-time.ts`): pure code with no database. Hours are read on the practice's own clock, so daylight-saving changes are handled (a time that does not exist that day is never offered; one that happens twice is offered once). Start times are on a grid counted from the start of each working period; a visit must finish within the period.

**Audit events** (identifiers and field names only, never names, reasons or other free text): `provider.created`, `provider.updated`, `appointment_type.created`, `appointment_type.updated`, `time_off.created`, `time_off.cancelled`, `scheduling.settings_updated`, `scheduling.ai_booking_enabled`, `scheduling.ai_booking_disabled`.

## Step 2 as built

**Migration `0013_patients_and_appointments`** (adds the `btree_gist` extension, which lets one exclusion constraint cover a provider and a time range):

- `patients`: first name, last name, date of birth, phone (international format), who created it (a person or the AI). The same name (any capitals), date of birth and phone exists once per practice (unique index). The API can add and read, never edit or delete (editing a patient is a later step).
- `appointments`: patient, provider, visit type, start and end (the end is the start plus the visit's length at booking time), status (`booked`, `cancelled`, `completed`, `no_show`), who booked it (person or AI), the appointment it replaced when moved, an idempotency key, and who cancelled it, when and why. **The database refuses overlapping appointments for one provider and for one patient** (two exclusion constraints; a cancelled appointment frees its time, a completed or no-show one still holds it). Composite foreign keys keep every reference inside one practice. The API can add and read, and may update only the status and cancellation fields; the time, patient, provider and key can never be rewritten, and nothing is deleted.

**Endpoints** (permissions in [authorization.md](authorization.md)):

| Method and path | What it does |
|---|---|
| `POST /api/patients` | Adds a patient, or returns the one who already matches on name, date of birth and phone (201 new, 200 existing). |
| `GET /api/patients?q=&limit=` | Search by the start of a first or last name (several words must all match) or part of a phone number; at least 2 characters, at most 25 results; `%` and `_` are ordinary characters. Audited as `patient.searched` with the number shown, never the text typed. |
| `GET /api/patients/:id` | One patient; audited as `patient.viewed`. |
| `GET /api/appointments?from&to&providerId&patientId&status&limit` | The calendar: appointments overlapping a window (default the next 7 days, at most 62), booked ones unless a status or `all` is asked for. Shows the patient's name only, never date of birth or phone. |
| `GET /api/appointments/:id` | One appointment. |
| `POST /api/appointments` | Books. Needs an `Idempotency-Key` header (8 to 100 letters, digits, `-`, `_`). 201 when booked; **200 with the same appointment when the same key is sent again**; 409 if the same key is used for a different request. |
| `POST /api/appointments/:id/cancel` | Cancels (optional reason, kept as a record, never in the audit log). |
| `POST /api/appointments/:id/reschedule` | Books the new time and releases the old one in one transaction, or neither; returns the new appointment, which points back at the old one. Optional `providerId` to move to another provider who offers the visit. Needs an `Idempotency-Key`. |

**How a booking is checked** (the same code will serve the AI receptionist in step 3, with the actor "AI" and the "caller" rules):

1. A repeated key returns the earlier result (or is refused if the request differs). Two identical requests at the same instant also book once.
2. The patient, provider and visit type must exist in this practice, be active, and the provider must offer the visit.
3. The exact start time must be one that would be offered right now (the availability engine, with the provider's days off and existing appointments). Otherwise 409 "That time is not available".
4. The database has the last word: if another booking took the time between the check and the insert, the exclusion constraint refuses it and the person is told "That time was just taken". Many callers booking one time at once end with exactly one appointment (tested).

**Staff versus caller rules.** A person at the front desk (`staff` mode) is limited by the provider's hours, days off, existing appointments, the slot grid and "not in the past" (and a year ahead at most), but **not** by the practice's minimum notice or furthest-ahead rules, which exist for callers. The AI receptionist (`caller` mode) is bound by every rule, and also by the **cancellation window**: it cannot cancel or move an appointment closer than the configured number of hours, or one that has already started; the refusal is a distinct error so the AI can offer to take a message for staff. Staff may cancel at any time.

**Audit events** (identifiers only, never names, dates of birth, phones, reasons or times): `patient.created`, `patient.viewed`, `patient.searched`, `appointment.booked`, `appointment.cancelled`, `appointment.rescheduled` (one event for a move, not a cancel plus a booking). Actor is the person, or "AI receptionist" with no user.

**Availability** now removes booked times (including a visit that would run into a booked time just past the end of the searched window).

**Not in this step:** editing a patient, marking an appointment completed or no-show (the statuses exist; nothing sets them yet), the AI tools and identity checks (step 3), and the web screens (step 4).

## Step 3 design: the AI receptionist books (approved 2026-10-01, built)

The rule that governs it all: **the AI asks, the backend does, and the backend writes every sentence that states a fact about an appointment.**

### What a conversation looks like

```
Caller: "I'd like to book a follow-up."
AI ─► list_appointment_types / find_available_slots      (backend computes real times)
AI:   "I have Tuesday 7 October at 10:00 AM with Dr Khan, or Wednesday 8 October at 2:30 PM with Dr Lee."
Caller: "Tuesday please."  (AI asks for first name, last name, date of birth, phone)
AI ─► book_appointment(slot "A2", name, date of birth, phone)
BACKEND checks everything, books, and WRITES the reply:
      "Your follow-up with Dr Khan is booked for Tuesday 7 October at 10:00 AM. Is there anything else I can help you with?"
```

### Tools (only offered when the practice has switched on AI booking, and never after an emergency or urgent request; the switch is checked again each time a tool runs)

| Tool | What the model gives | What the backend does |
|---|---|---|
| `list_appointment_types` | nothing | The visit types a caller can book (active, with an active provider), by name and length. |
| `find_available_slots` | visit type, optional earliest date, optional morning/afternoon | Up to 5 real slots from the availability engine under the **caller** rules. Each gets a short code (A1, A2...) kept with the conversation; the model passes the code back, **never a time or a provider**, so it cannot invent either. The backend also writes the readable wording of each slot (practice time zone, 12-hour clock). |
| `verify_patient` | first name, last name, date of birth, phone | Matches all four exactly. Success marks the conversation as verified for that patient. Failure never says which detail was wrong. **Three failures lock identification for the conversation**; the AI then offers to take a message. |
| `book_appointment` | slot code, first name, last name, date of birth, phone | Re-checks the slot at this moment (caller rules, days off, existing appointments), reuses the patient who matches all four details or adds a new one, books with an idempotency key made from the conversation and the slot, and writes the confirmation. It does **not** mark the conversation as verified (see "Why booking does not verify"). |
| `list_my_appointments` | nothing | Needs a verified conversation. The caller's own upcoming booked appointments only, each with a short code; the backend writes the list. |
| `cancel_appointment` | appointment code | Needs verified. Only the verified patient's own appointment; refused inside the cancellation window (the AI is told to take a message for staff instead). The backend writes the confirmation. |
| `reschedule_appointment` | appointment code, slot code | Needs verified. Same visit type only, same rules and window; the new time is booked and the old released together. The backend writes the confirmation. |

All of these run through the code already built in step 2 (`bookInTransaction`, `cancelInTransaction`, `rescheduleInTransaction`, `findOrCreateInTransaction`) with the actor "AI" and the "caller" rules. The practice always comes from the conversation; no tool takes a practice, patient or appointment id from the model (codes only, resolved from this conversation's own earlier results).

### Backend-written replies

When a tool states a fact about an appointment (booked, listed, cancelled, moved), the reply for that turn **is the backend's sentence**, and whatever the model wrote that turn is discarded. It is stored as a new turn source (`scripted_booking`) so reviewers can see it was not the model. The reply checker keeps blocking booking claims in **every model-written** line, as today. Failures (the time was just taken, not available, inside the cancellation window, not identified) are returned to the model as plain refusals, which it must explain in its own words; those words go through the normal reply checks.

### Identity rules, in detail

- **Why booking does not verify.** If it did, a caller could try date-of-birth guesses through "book" and then list the appointments of whoever matched. So booking never reveals whether a matching patient existed (the confirmation and the errors are identical either way, including "the patient already has something at that time", which is shown to the AI as just "that time is not available"), and seeing, cancelling or moving anything needs `verify_patient`, which counts failures.
- **Caller ID is not used** in this step (not as proof, not as a hint); the caller says their phone number like their other details.
- **A cap across conversations.** Three tries per conversation can be repeated with new calls, so the backend also refuses identification for the whole practice when more than 30 verification attempts failed in the last hour (the AI takes a message; staff are told once with an audit event). The numbers are constants for now, not settings.
- A verified caller hears only the date, time, provider and type of their **own** appointments. Never another patient's, never anything clinical.
- Names, dates of birth and phones the caller says are kept only where they already are (the transcript the caller's words appear in, and the patient record). The model's tool arguments are recorded for review like every other tool, so staff who can read conversations see them; nothing goes to logs or audit metadata.

### Database (migration 0014)

`conversations`: `verified_patient_id` (composite foreign key to `patients`), `identity_failures` (0 to 3, the database refuses more); `appointments`: `conversation_id` (which call booked it; composite foreign key); `conversation_turns.source` gains `scripted_booking`; the API role may update only the two new conversation columns.

### Other changes

- The system prompt stops saying "you cannot book" **only when booking is on**, and instead explains the tools and the rules (offer only what the tools return, never state a time yourself, ask for all four details before booking, after a booking let the system confirm).
- `AgentContext` carries whether booking is on and the practice's rules; tools read it, the model never sees it.
- Audit: `patient.verified` (AI actor, identifiers only), `conversation.identity_locked` (system actor), plus the appointment events from step 2 with the AI as actor and the conversation linked.

### Tests

Scripted-model conversations through the real stack: book; slot taken between offer and booking; invented slot code; wrong or injected codes; verify success, three failures lock, no hint of which detail was wrong, the practice-wide cap; list, cancel, move for the verified patient only; **another patient's appointment code refused**; cancel inside the window refused with a message offered; a model that says "booked" without the tool is still blocked; booking switched off (tools absent and refused if called anyway); an emergency or urgent message in the middle of booking (the emergency script wins, no booking tools afterwards); prompt injection in the caller's words; duplicate tool calls book once; tenant isolation; the backend-written sentences are exact and contain nothing clinical. Then mutation checks on every rule, and in step 5 a run of the conversation set against the real models (Ollama locally, Claude when a key exists).

### Decisions

1. **Booking never verifies; seeing or changing needs `verify_patient`** (above). **Agreed by the operator (2026-10-01).** On a call the caller notices nothing: the AI already has the details and passes them again.
2. **A practice-wide cap on failed identity checks per hour. Decided by the operator (2026-10-01): keep it, and make it configurable.** A new booking-rules setting (`identityFailureCapPerHour`, default 30, allowed 5 to 1000), set by owners and admins, audited by field name, column in migration 0014. When the cap is reached, identification is refused for the whole practice until the hour has passed (new bookings and messages still work), and one audit event says so. A staff task for it can come later.
3. **The AI may create new patients** when the details match nobody (a first-time caller). **Decided by the operator (2026-10-01): yes.**
4. **Time format is a per-practice setting (decided 2026-10-01): 12-hour ("Tuesday 7 October at 10:00 AM") or 24-hour ("Tuesday 7 October at 10:00" / "14:30").** It is a new booking-rules setting (`timeFormat`, default 12-hour), set like the other rules by owners and admins, audited by field name, and used for every sentence the backend writes. Added to migration 0014 and to `PATCH /api/scheduling/settings`.
5. **Backend confirmation (decided 2026-10-01):** the AI asks and the backend answers; the backend's sentence is what the caller hears. After a successful booking, cancel or move the turn ends immediately without asking the model to compose another reply, which also saves one model round (the slow part).

## Step 3 as built

**Migration `0014_ai_scheduling`:** booking-rules settings `time_format` (`12h` or `24h`, default `12h`) and `identity_failure_cap_per_hour` (5 to 1000, default 30); on `conversations`, `verified_patient_id` (composite foreign key, so never another practice's patient) and `identity_failures` (the database refuses more than 3); on `appointments`, `conversation_id` (which conversation booked it); the turn source `scripted_booking`; an index for counting failed checks per hour.

**Code:** `agent/scheduling-tools.ts` (the seven tools), `scheduling/appointment-text.ts` (every sentence the backend speaks about appointments, in the practice's time zone and clock format), and small changes to the agent: the tool list and the instructions depend on the switch, and a turn in which the backend wrote a sentence ends with that sentence plus "Is there anything else I can help you with?" without asking the model again.

**How it behaves, in short:**

- The model sees codes (S1, S2... for offered times, M1, M2... for the caller's own appointments) and plain words, never an id. What each code means is stored with the tool call (not shown to the model) and only codes issued *in the same conversation* are accepted. On later turns the instructions remind the model, in the system's own words, what each code was and whether the caller is identified.
- Offered times: at most 5, at most 3 on one day, over the next three weeks, optionally from a date and for mornings or afternoons, under the caller rules.
- Booking re-checks the time at that moment, finds or adds the patient (matching name without regard to capitals, date of birth and phone; spaces, dashes and brackets in phone numbers are removed), books under the AI's name with a key made from the conversation and the code (asking twice books once), and links the appointment to the conversation. A refusal is undone completely inside the tool (a savepoint) and told to the model in the same words whatever the cause, so it reveals nothing about other patients.
- **The reply checker now blocks booking claims in the model's words even when they name the visit** ("Your follow-up with Dr Khan is booked for...", "has been cancelled", "You have an appointment on Tuesday"). The backend's own sentences are the only way such words reach a caller.
- Identification: three failed checks lock it for the conversation (also enforced by the database); incomplete details are not a failure; every failure looks the same; the practice-wide cap counts failed checks in the last hour across all conversations and, once reached, refuses identification for everyone (booking a new visit still works) with one audit event per hour.
- Cancel and move: only the identified caller's own appointments, the same kind of visit for a move, and never inside the cancellation window (the model is told to offer a message instead).
- After an emergency or urgent message the scheduling tools disappear, as all tools but the message tools do. Switching booking off takes effect on the next tool call, even in the middle of a turn.
- On the phone, the backend's sentences are spoken in full (the caller cannot interrupt them), like the safety messages.

**Audit events (new):** `patient.verified` (AI), `conversation.identity_locked` (system), `scheduling.identity_cap_reached` (system); plus `appointment.booked`, `.cancelled`, `.rescheduled` and `patient.created` with the AI as the actor.

**Tests:** 66 conversation tests with the scripted model through the real stack (`test/agent-scheduling.int-spec.ts`), the sentence and clock tests, and the extended reply-checker tests.

**Not in this step:** the web screens (step 4) and a run against the real models (step 5). Small local models may find the codes harder to use than a large hosted model; that is what step 5 measures.

## Step 4 design: web screens (approved 2026-10-02, built)

The operator approved this, including the list-style calendar (a drawn grid can come later). Two new pages, following the existing ones (Angular standalone components, signals, no UI library, **no new dependency**), plus small additions elsewhere. All data comes from the step 1 to 3 API; **no API or database change is needed.**

**1. `/scheduling-setup`: "Scheduling setup"** (seen with `schedule:read`, changed with `schedule:configure`, so owners and admins edit and staff only look; viewers do not see it)

- **Booking rules:** slot length, minimum notice, how far ahead, cancellation window, 12-hour or 24-hour clock, the failed-identity cap, saved together (only what changed is sent, like the AI settings page).
- **"Let the AI receptionist book" switch**, separate from saving, with the list of what is still missing (from the 409) and why it matters.
- **Providers:** list (switched-off ones shown greyed), add and edit name, title, weekly hours (the same hours editor as the AI settings page) and which visit types they offer; switch off and on (no delete, as in the API).
- **Days off per provider:** upcoming list, add (start and end in the practice's time zone, reason), cancel.
- **Visit types:** name, length, which providers offer it, switch off and on.

**2. `/schedule`: "Schedule"** (seen with `schedule:read`; booking, cancelling and moving with `schedule:manage`, so owners, admins and staff)

- **Calendar as a list, not a drawn grid:** one day or one week at a time, earliest first, grouped by day, each line showing the time, provider, visit type, patient name, and "booked by AI" when it was. Filter by provider; previous, today and next buttons. Times in the practice's time zone and clock format. (A drawn calendar grid can come later; a list is clearer on small screens and needs no library.)
- **Book:** choose the visit type (and optionally a provider), see the open times the API offers (exactly what a caller would be offered), pick one, then **find the patient** (search by name or phone, at least 2 characters) **or add a new one** (first name, last name, date of birth, phone), confirm. Each booking attempt gets its own idempotency key, created in the browser and **reused if the same attempt is retried** (so a double click or a lost network reply never books twice). "That time was just taken" refreshes the open times.
- **Cancel** (optional reason, with a confirmation) and **Move** (pick a new open time for the same visit; the old one is released only if the new one is booked, by the API).
- Cancelled appointments hidden by default, shown with a toggle.

**As built:** the calendar range and days off are converted on the practice's clock in the browser (`core/zoned-time.ts`), the weekly hours editor is a small shared component (`shared/hours-editor`), and the cancel button has its own "danger" style. No API or database change was needed.

**3. Smaller changes:** two menu entries shown only to roles that may use them; the dashboard gets "Today: N appointments" for `schedule:read`; the test chat already marks the backend's own booking sentences ("Written by the system from the saved appointment"); `web-app.md` updated.

**Privacy on screen:** the calendar shows the patient's name only; date of birth and phone appear only in the patient search and the booking form (`patients:read`), and every search and view is audited by the API as today.

**Tests:** component tests for both pages against a fake HTTP backend: what each role sees and can do, only changed fields sent, the AI-booking switch and its missing list, hours validation, booking from search and from a new patient, the idempotency key reused on retry and new for a new attempt, "just taken" refresh, cancel and move, time zone and 12/24-hour display, error messages. Then mutation checks on the permission and idempotency behaviour, and a check against the real dev API through the proxy.

**Order:** setup page first (you need providers before anything can be booked), then the schedule page, then the small changes.

## Risks and things that need a human decision

- **Real patient data:** date of birth and phone make this personal health information; agreements with every vendor that sees it are required before real use. Stored data is protected by the database's tenant isolation and the host's disk encryption; encrypting individual columns is a later hardening step.
- **Practice policy** (cancellation window, how far ahead, whether the AI may book new patients at all) differs by clinic; the defaults above are suggestions, not clinical or legal advice.
- **Weak identity check** (see above): fine for scheduling, never for medical information.
- **One location per practice** for now.
