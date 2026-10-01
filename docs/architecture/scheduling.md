# Scheduling (milestone 3): proposal

Status: **approved 2026-10-01; step 1 of 5 built** (steps 2 to 5 are still to do). Decisions taken with the operator (2026-10-01): appointments belong to **providers**, each with their own hours; a caller is identified by **name + phone + date of birth**; the schedule lives **in our own database first** (calendar or EHR connections later).

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
2. Patients and appointments (staff API): booking rules, the exclusion constraint, cancel and reschedule, idempotency, audit.
3. AI scheduling: the tools, identity checks, backend-written confirmations, and the AI scheduling switch.
4. Web: schedule, providers, types, rules, patient search.
5. Conversation test set against the real models, and the documentation.
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

## Risks and things that need a human decision

- **Real patient data:** date of birth and phone make this personal health information; agreements with every vendor that sees it are required before real use. Stored data is protected by the database's tenant isolation and the host's disk encryption; encrypting individual columns is a later hardening step.
- **Practice policy** (cancellation window, how far ahead, whether the AI may book new patients at all) differs by clinic; the defaults above are suggestions, not clinical or legal advice.
- **Weak identity check** (see above): fine for scheduling, never for medical information.
- **One location per practice** for now.
