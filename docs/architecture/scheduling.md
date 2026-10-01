# Scheduling (milestone 3): proposal

Status: **approved 2026-10-01; steps 1 and 2 of 5 built** (steps 3 to 5 are still to do). Decisions taken with the operator (2026-10-01): appointments belong to **providers**, each with their own hours; a caller is identified by **name + phone + date of birth**; the schedule lives **in our own database first** (calendar or EHR connections later).

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

## Risks and things that need a human decision

- **Real patient data:** date of birth and phone make this personal health information; agreements with every vendor that sees it are required before real use. Stored data is protected by the database's tenant isolation and the host's disk encryption; encrypting individual columns is a later hardening step.
- **Practice policy** (cancellation window, how far ahead, whether the AI may book new patients at all) differs by clinic; the defaults above are suggestions, not clinical or legal advice.
- **Weak identity check** (see above): fine for scheduling, never for medical information.
- **One location per practice** for now.
