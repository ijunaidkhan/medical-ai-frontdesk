# EHR integration (milestone 4): proposal

Status: **proposed 2026-10-18. Step 1 (the gateway and our own calendar behind it) built 2026-10-25; no EHR is connected yet.** It changes the plan in [scheduling.md](scheduling.md): for a clinic that uses an EHR, the EHR, not our database, must be the source of truth for patients and appointments. The whole plan is in [../roadmap.md](../roadmap.md).

Everything said here about EHR vendors comes from public articles and vendor pages (listed at the end). It is **indicative**: each vendor's current rules must be checked in its own documentation before anything is built for it.

## Why this document exists

On 2026-10-01 the schedule was placed "in our own database first (calendar or EHR connections later)". That let us build and prove the AI's booking behaviour (safety rules, identity checks, backend-written confirmations, a real-model evaluation) without needing an EHR. It does not fit a real clinic:

- A clinic's patients and calendar already live in its EHR, and staff keep working there. A second calendar in our database would be wrong the moment someone books or cancels in the EHR, and the AI would offer times that do not exist, or double-book.
- Sending our appointments out to the EHR by webhook does not fix that. The EHR calendar changes all day without telling us, the EHR may reject or overwrite what we send, and there is no single truth.

So: **when a clinic has an EHR, the AI reads availability from it and books in it.** Our own calendar stays, for clinics that have no EHR calendar to connect and for demos and tests.

## Principles

1. **One calendar of record per clinic.** Connected to an EHR: the EHR. Not connected: our own tables. Never both.
2. **The backend still owns everything** it owns today: authorization, validation, business rules, audit. The AI still only asks for tools.
3. **"Booked" only after the EHR confirms**, in words the backend writes (the existing rule, unchanged).
4. **Least patient data.** EHR patient records are not copied into our database. The AI identifies a caller by asking the EHR, and the result (an external id) is kept for that conversation only. We keep what we already keep: transcripts and tool calls, staff tasks, audit.
5. **A connection can fail at any time.** The AI then takes a message. It never guesses, and never says anything was booked.
6. **One interface, many adapters.** Adding an EHR never changes the AI tools, the prompts or the safety layer.
7. **No real patient data in development, tests or logs.**

## Three levels (tiers)

How deeply the AI is connected to one clinic's EHR is a per-clinic setting. A clinic starts low and moves up.

| Tier | The AI can | The EHR is |
|---|---|---|
| **0, messages only** | Answer calls and questions, recognise emergencies, take a message (name and date of birth; the callback number is found by the backend, see [ai-receptionist.md](ai-receptionist.md)) | Not touched. Staff book in the EHR themselves. Works with **any** EHR from day one, and is how every clinic starts. It exists today: it is what the AI does while "Let the AI book" is off |
| **1, read only** | All of tier 0, plus tell callers real open times and find a patient | Only read. Staff confirm bookings |
| **2, booking** | All of tier 1, plus book, cancel and move appointments | Read and written |

Why levels and not all or nothing:

- **EHRs differ.** Some have an open interface; some (several behavioural-health EHRs) have none that a clinic can use. Those clinics can only ever be tier 0.
- **Connecting is slow.** Vendor programs, reviews, agreements and per-clinic authorization take a long time. A clinic should not wait for all of it before getting any value.
- **Writing is riskier than reading.** A wrong appointment in a clinic's EHR costs more than a wrong answer. Read-only first, then booking after test calls.
- **Clear promises and pricing.** A clinic knows what it gets, and an EHR connection can be priced as its own add-on.

Our own calendar ("native" mode) is a separate choice for clinics without an EHR calendar to connect: it behaves like tier 2 against our tables.

## Design

```
AI tools (unchanged)
   -> backend rules: identity, failure limits, backend-written confirmations, audit
        -> SchedulingGateway            (new interface, one per call to the clinic's adapter)
             |- NativeAdapter           our tables and the availability engine (today's behaviour)
             |- FhirAdapter             FHIR R4 servers
             |- vendor adapters         athenahealth and others, one per EHR a paying clinic needs
                    -> the calendar of record
```

### The interface

Built in `apps/api/src/scheduling/gateway/scheduling-gateway.ts`, from what the AI tools needed (`agent/scheduling-tools.ts`, and the callback-number lookup in `agent/tools.ts`):

| Method | Meaning |
|---|---|
| `listVisitTypes()` | The visit types a caller can book |
| `findSlots(query)` | Open times for a visit type in a window, earliest first, under the practice's rules for callers |
| `findPatient(name and date of birth, or all four details)` | The one matching patient (id and the number on file), or none (two matches are never guessed between) |
| `listAppointments(patient)` | The patient's upcoming appointments |
| `getAppointment(id)` | One appointment, to check it is the caller's own and to word the confirmation |
| `book(patient or new patient, slot, idempotencyKey)` | Create the appointment; returns it |
| `cancel(appointment, reason)` | Cancel |
| `reschedule(appointment, slot, idempotencyKey)` | Move |
| `capabilities()` (step 2) | What this adapter can do for this clinic: read availability, find a patient, create a patient, book, cancel, reschedule, hold a slot. The AI is only offered what the clinic's tier and the adapter both allow |

Every method takes a **scope**: the practice, the request details for audit, and the database transaction the tool runs in. Our own calendar works inside that transaction, so a booking, its audit entry and the record of the tool call commit or roll back together. (It must: the tool locks the conversation row while it checks identity, and a booking in a second transaction would wait on that lock for ever.) An adapter that calls an EHR does not use the transaction for that call; how long a tool may hold the transaction open while it waits on an EHR is decided in step 2.

Adapters report refusals the same way: `ConflictException` when a time is taken or the change cannot be made, `CancellationWindowError` inside the practice's cancellation window, `NotFoundException` or `BadRequestException` otherwise. The tools turn these into the same words for the model whatever the calendar.

Normalised types: **Slot** (provider reference, visit-type reference, start and end), **PatientRef** (id and the number on file, never shown to the model), **AppointmentRecord** (id, patient, visit type, and the facts the backend's sentences use). The short codes the AI sees (S1, M1...) are still issued per conversation by the backend; what each code stands for (including the EHR's own slot id) is kept in the stored record of the tool call and never shown to the model, as today.

### The adapters

- **NativeAdapter** (built, `scheduling/gateway/native-adapter.ts`): wraps the existing services and tables (`providers`, `appointment_types`, `provider_appointment_types`, `patients`, `appointments`) and the pure availability engine (`scheduling/availability.ts`). Behaviour did not change: every existing test passes unchanged.
- **FhirAdapter:** FHIR R4 `Schedule`, `Slot`, `Appointment` and `Patient`. The Argonaut scheduling guide also defines `$find`, `$hold` and `$book` operations that a server may support. Many vendors add their own operations or limits on top.
- **Vendor adapters:** one per EHR, built when a paying clinic needs it (see "What we know about vendors").
- **Where in the code:** `apps/api/src/scheduling/gateway/`: the interface, the adapters, and a registry (`SchedulingGateways.forPractice(scope)`) that returns the clinic's adapter (always the NativeAdapter until step 2). The AI tools call the gateway instead of the services; the staff screens still use the services directly.

### How each tool maps

| Tool | Gateway call | Tier needed |
|---|---|---|
| `list_appointment_types` | `listVisitTypes` (for an EHR: the clinic's mapped visit types, see mapping) | 1 |
| `find_available_slots` | `findSlots` (and `getAppointment` when moving) | 1 |
| `verify_patient` | `findPatient`, then `listAppointments` | 1 |
| `list_my_appointments` | `listAppointments` | 1 |
| `book_appointment` | `book` (with `findPatient`; a new patient only if the adapter can create one) | 2 |
| `cancel_appointment` | `getAppointment`, `cancel` | 2 |
| `reschedule_appointment` | `getAppointment`, `reschedule` | 2 |
| `create_staff_task` | `findPatient`, for the number on file when the call has no caller ID | 0 (uses the EHR only if it can be read) |
| `search_knowledge`, hand-off, end | not related to the EHR | 0 |

## Data: what lives where

| Data | Lives in |
|---|---|
| Patients, providers, calendar, appointments (clinic uses an EHR) | **The EHR only** |
| The same, for a clinic on our own calendar | Our tables (as today) |
| Conversations, transcripts, tool calls, blocked replies | Ours (as today) |
| Staff tasks, audit log, AI and scheduling settings, knowledge | Ours (as today) |
| The EHR connection: vendor, non-secret settings, status, mapping | Ours (new tables below) |
| The EHR connection's keys and secrets | A secrets store, never plain in the database |
| External ids (the EHR's appointment id, for a booking made in a conversation) | Ours, with the conversation |
| A short availability cache (about 30 to 60 seconds), to keep a phone call fast | Ours, in memory; a booking is always confirmed live |

## One clinic's connection

New tables (proposed; Row Level Security and audit like every other table):

- **`practice_ehr_connections`:** practice, vendor (`native`, `fhir`, `athenahealth`...), status (`draft`, `testing`, `active`, `paused`, `error`), tier, non-secret settings (base URL, the EHR's practice and department ids, tenant id, time zone), a pointer to the secret, capabilities, last check time and last error (never with patient details).
- **`practice_ehr_providers` and `practice_ehr_appointment_types`:** our provider and visit-type names mapped to the EHR's ids, and **whether the AI may book each one** (a clinic will not want the AI booking every provider or every kind of visit).

Keys: each clinic has its own, kept in the hosting provider's secrets manager (or encrypted with envelope encryption), with rotation. Only an owner or administrator can change a connection, and every change is audited by field name only.

Onboarding (a wizard in the web app, later):

1. Choose the vendor.
2. Authorize: a clinic-side step that differs per vendor (athenahealth: the practice authorizes the app in its own settings; Oracle Health: the health system's administrator adds our client id to its tenant and Oracle reviews the scopes; Epic: site-specific approval).
3. Test the connection (one harmless read).
4. Map providers and visit types, and choose which the AI may book.
5. Run read-only (tier 1) with test calls.
6. Switch on booking (tier 2).

A health check runs regularly, the status is shown on the page, and a failing connection raises an alert.

## A booking, step by step

1. The AI asks for times; the backend asks the adapter (`findSlots`), applies the clinic's rules, and issues codes.
2. The caller chooses; the backend identifies the caller (`findPatient`) or, for someone new, checks the adapter can create a patient.
3. The backend books (`book`) with an idempotency key made from the conversation and the slot.
4. Only on success does the backend write the confirmation sentence and store the EHR's appointment reference.

What can go wrong, and what happens:

| Problem | Behaviour |
|---|---|
| The EHR is slow or down | A short timeout, then the AI takes a message (a staff task) and says nothing was booked |
| The slot was taken in between | The caller is offered other times (as today) |
| The booking call times out | Never retried blind: first check whether the appointment exists, because many EHRs have no idempotency keys |
| Two callers want one slot | The EHR decides; the loser is offered others. If the EHR supports holding a slot, it is held while the caller confirms |
| Rate limit or expired token | Backoff and token refresh per clinic; one clinic's problems never slow another's |
| A new patient and the EHR cannot create one by API | The call becomes a task ("new patient request") for staff |
| Two systems disagree on time zones | The clinic's own time zone is stored with the connection and used for every spoken time (as today) |

## What we know about vendors (indicative)

| EHR | Interface (as publicly described) | Production access | Realistic tier |
|---|---|---|---|
| athenahealth | Cloud REST API with open-slot and book endpoints | The athenahealth Marketplace partner program first, then each practice authorizes the app | 2 |
| Epic | FHIR plus Epic's own operations (`Appointment.$find`, `$book`); a free developer sandbox with fictitious patients | Writes need site-specific approval; each hospital's setup differs | 2, with effort |
| Oracle Health (Cerner) | FHIR R4 with SMART Backend Services (a signed token from our private key); an open read sandbox | Each customer's administrator adds our client id to its tenant; Oracle reviews the scopes; no self-serve go-live | 2, with effort |
| eClinicalWorks | FHIR R4 read is good; appointments and writes go through a separate program or HL7 messages, under a separate contract | A contract per write capability | 1 to 2 |
| SimplePractice, TherapyNotes, TheraNest (Therapy Brands), ICANotes | No public API for a clinic; partner-gated at best | Not available to us | **0** |
| Others (NextGen, Oracle on-premises, DrChrono, ModMed, ...) | Each different | Each different | Decided one at a time |

Integration vendors (Redox, NexHealth and others) can cover several EHRs with one connection, but their scheduling coverage is partial (NexHealth is mostly dental), they cost money per connection, and they add one more party that needs an agreement. They are evaluated when three or more different EHRs are requested.

## Network and production

- Many EHRs only accept API calls from **allow-listed IP addresses**, so the hosting must provide a **fixed outgoing IP address**. On-premises EHRs may need a VPN. This is a requirement on the (still undecided) hosting provider, whichever it is.
- TLS everywhere; a rate limit, a timeout and a circuit breaker per clinic.
- The adapters know nothing about the hosting provider; nothing here depends on one.

## Compliance

- The clinic is the covered entity and we are its business associate: **a signed agreement with each clinic**, and with every subcontractor that touches call content (hosting, speech, language model).
- Each EHR vendor's partner program has its own agreement, security questionnaire and app review.
- No patient data is copied out of the EHR beyond what a conversation needs, and nothing is logged with patient details.

## How we develop and test without real data

1. **A local FHIR server** in Docker (HAPI FHIR, `docker run -p 8080:8080 hapiproject/hapi:latest`) filled with **synthetic patients** (Synthea) and our own `Schedule` and `Slot` seed (doctors, hours, open times). The `FhirAdapter` and its tests run against it. Free, no account, no real data. It is not a real EHR: vendor quirks do not appear.
2. **Vendor sandboxes** (Epic on FHIR, athenahealth Preview, Oracle's open sandbox), with developer accounts created by the operator. A sandbox does not show what production does; expect surprises at the first clinic.
3. **A first clinic:** read-only first, then booking after test calls.
4. **Contract tests** (built: `apps/api/test/support/gateway-contract.ts`, run for the NativeAdapter by `test/scheduling-gateway.int-spec.ts`): visit types, open times, finding a patient, booking once per key, a taken time, a new patient, cancelling, the cancellation window, moving, and practices kept apart. Every adapter runs the same suite, so they all behave the same to the AI. The existing real-model evaluation (`npm run eval:scheduling`) is reused.

## What changes in our code

- **API (step 1, built):** the gateway folder above; `agent/scheduling-tools.ts` and `agent/tools.ts` use it. **Later:** connection endpoints and a permission for who may change a connection.
- **Database:** one migration with the tables above. The existing scheduling tables stay and are the NativeAdapter's. `conversations.verified_patient_id` points at our `patients` table, so an EHR patient's id needs its own column there.
- **Web:** an "EHR connection" page (status, mapping, tier). For a clinic on an EHR the Schedule and Providers screens are hidden or read-only, because staff manage the calendar in the EHR.
- **Unchanged:** the AI tools and prompts, the safety layer, the reply checker, identity rules and failure limits (each check is now an EHR call, and the practice-wide failure cap still counts them), the idempotency rules, tenant isolation, conversation review, tasks, the evaluation tool.

## Steps (each tested and reported before the next)

1. **Groundwork (built 2026-10-25):** the gateway, the NativeAdapter and the contract tests, with **no change in behaviour** (every existing test passes unchanged). No database, API or screen changes.
2. **FhirAdapter** on the local FHIR server, passing the same contract tests, together with what only matters once there is a second adapter: the connection table, capabilities, the tier setting (today the "Let the AI book" switch is the only one; a second switch beside it now would change behaviour), a status screen, and how long a tool may wait on an EHR.
3. **The first vendor adapter**, chosen by the first paying clinic: sandbox, then a read-only pilot, then booking.
4. **The onboarding wizard** and health checks.
5. **Integration vendors:** evaluated when three or more different EHRs are asked for.

## Decisions the operator still has to take

1. **Which clinics, and which EHR first?** Everything after step 2 depends on it.
2. **Hosting provider** (it must give a fixed outgoing IP and sign a BAA).
3. **Is the EHR connection a paid add-on** (setup and monthly), with tier 0 as the base product?
4. **Who creates the vendor developer accounts** and signs the partner agreements.

## Risks and limits

- Each EHR is its own project, with its own review and agreement; a clinic can take weeks or months to connect, mostly on the clinic's and vendor's side.
- Some clinics' EHRs can never go beyond tier 0.
- A sandbox is not production: the first real clinic will show differences.
- A phone call cannot wait long: a slow EHR means the AI takes a message instead.
- Patient identity by name and date of birth is weaker than a phone number as well; with an EHR every failed check is also a call to the EHR.
- The vendor facts above are public, indicative and may be out of date.

## Sources

- [FHIR scheduling APIs (Schedule, Slot, Appointment) across Epic, Oracle and athenahealth](https://nirmitee.io/blog/fhir-scheduling-api-appointment-slot-epic-oracle-athenahealth/)
- [Argonaut scheduling implementation guide](https://www.fhir.org/guides/argonaut/scheduling/CapabilityStatement-server.html)
- [Epic on FHIR documentation](https://fhir.epic.com/Documentation) and [Epic scheduling APIs](https://www.mindbowser.com/epic-scheduling-api-guide/)
- [athenahealth API access](https://mydata.athenahealth.com/access-the-apis) and [athenahealth integration guide](https://www.tactionsoft.com/blog/athenahealth-api-integration-guide/)
- [Oracle Health authorization framework](https://docs.oracle.com/en/industries/health/millennium-platform-apis/fhir-authorization-framework/) and [app provisioning](https://docs.oracle.com/en/industries/health/millennium-platform-apis/fhir-app-provisioning)
- [eClinicalWorks API and write-back](https://nirmitee.io/blog/eclinicalworks-integration-fhir-hl7-api-guide/)
- [SimplePractice API report](https://supergood.ai/api-report-card/simplepractice) and [TherapyNotes API report](https://supergood.ai/api-report-card/therapynotes)
- [Redox scheduling data model](https://developer.redoxengine.com/api-reference/redox-data-model-api/datamodels/scheduling) and [NexHealth supported systems](https://www.nexhealth.com/resources/ehr-appointment-scheduling)
- [HAPI FHIR with Docker and Synthea](https://medblocks.com/training/courses/fhir-fundamentals/fhir-fun-4-15-exercise-solution)
