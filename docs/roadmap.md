# Roadmap

Status: **2026-10-18.** One place for what is built, what comes next, what blocks what, and what must happen before real patients use the product. Each topic links to its own design document; this file does not repeat them.

## Where we are (built, tested and pushed)

| Milestone | What it is | Document |
|---|---|---|
| **M1 Foundation** | Sign-in, roles and permissions, team management, a practice's data isolated from every other practice by the database itself, audit log | [authentication](architecture/authentication.md), [authorization](architecture/authorization.md), [web app](architecture/web-app.md) |
| **M2a The AI receptionist, in writing** | Approved knowledge, safety layer (emergencies and crisis handled by fixed code, every reply checked), tools the backend validates, staff tasks, AI settings, conversation review, a test chat | [ai-receptionist](architecture/ai-receptionist.md) |
| **M3 Scheduling** | Providers, visit types, rules and open times in our own database; staff and AI can book, cancel and move; confirmations written by the backend; the Schedule and Scheduling setup pages; a real-model evaluation | [scheduling](architecture/scheduling.md), [evaluation](evaluations/ai-scheduling-llama3.2-3b.md) |
| **M2b Phone calls (steps 1 to 3)** | Phone numbers per practice, the incoming-call webhook with signature check, the live voice session | [telephony-voice](architecture/telephony-voice.md) |
| **The web phone** | A browser page to talk to the real receptionist by voice, for development (no phone provider needed) | [telephony-voice](architecture/telephony-voice.md) |
| **EHR groundwork (step 1)** | The AI's scheduling tools reach the calendar through one gateway, with our own calendar behind it and a contract test suite every future EHR adapter must pass. No change in behaviour | [ehr-integration](architecture/ehr-integration.md) |
| **Contacting callers by date of birth** | Messages and identity checks use name and date of birth; the backend finds the callback number (caller ID, patient record, or a number already said); two settings per practice | [ai-receptionist](architecture/ai-receptionist.md), [scheduling](architecture/scheduling.md) |

Quality today: **1,080 unit, 30 end-to-end and 1,093 integration tests on the API, 394 on the web app**, plus the real-model evaluation (`npm run eval:scheduling`), which has shown **no safety violation** in any run. New rules are checked by breaking them on purpose and confirming a test fails.

## What comes next, in order

Sizes are relative (small, medium, large), not time estimates.

| # | Work | Size | Needs a decision first? |
|---|---|---|---|
| 1 | ~~**EHR groundwork:** a `SchedulingGateway` interface and our own calendar behind it, with contract tests. No change in behaviour~~ **Done 2026-10-25** | large | Design: [ehr-integration](architecture/ehr-integration.md) |
| 2 | **A FHIR adapter** against a local test FHIR server with synthetic patients, passing the same contract tests; with it the connection table, capabilities, tiers and a status screen | large | No |
| 3 | **Phone, steps 4 and 5:** hand-over to a person, end-of-call clean-up (a call cut off by a restart stays "Still going" today), limits | medium | No (testable with the web phone and automated tests) |
| 4 | **AI monitoring dashboard:** conversations, outcomes, emergencies, tasks, replies the safety checks stopped, reply time | medium | No (the data already exists) |
| 5 | **The first vendor adapter** (athenahealth, Epic, Oracle Health...) | large | **Yes: which clinics, which EHR** |
| 6 | **Phone, steps 6 and 7 and a real provider:** screens, a live call test | medium | **Yes: voice provider** |
| 7 | **SMS** confirmations and reminders | medium | **Yes: SMS provider**, consent rules |
| 8 | **UI upgrade** (side menu, a component library) | medium | **Yes: library**; a mock-up first |
| 9 | **A larger language model** (the local one is weak at cancelling and moving); a hosted model for production | small to medium | **Yes: which model**; measured with the existing evaluation |
| 10 | **Outbound calls** (callbacks, reminders) | large | Later; needs consent rules |

Recommended order: 1 and 2 first (every later feature touches scheduling, so doing the groundwork late means redoing work), then 3 and 4, which are independent and visible.

## How a clinic's calls reach us (phone go-live)

The code for answering a call exists (see telephony-voice). What is missing is the connection to a clinic's real phone line. Each clinic gets **its own number on our side**; that is how we know whose call it is.

| Way | How | Notes |
|---|---|---|
| **Call forwarding** (start here) | The clinic forwards its line to our number: after hours only, when busy or unanswered, or always | Simplest, and the clinic can switch it off at any time |
| A new separate number | The clinic publishes an "AI line" | No forwarding, but patients keep using the old number |
| A SIP trunk from the clinic's phone system | The phone system sends calls to us and takes transfers back to an extension | Cleanest, needs the clinic's phone administrator |
| Porting the number | The clinic moves its number to our provider | We answer every call; days to weeks, a big step for the clinic |

Three things to get right per clinic: **caller ID** may be lost on forwarding (we now use it as the callback number, so a test call is needed; the fallbacks are the patient record or asking), **a transfer back must go to a direct line or extension, never to the forwarded main number** (a loop), and **one number per clinic** on our side.

Questions to ask every clinic: which phone system and company, whether it can forward conditionally, who has administrator access, which direct line takes transfers, and whether the AI should answer after hours, when busy, or always.

## Before real patients (production checklist)

**Legal and compliance**
- A signed agreement (BAA) with each clinic, and with every subcontractor that touches call content: hosting, speech, language model, telephony, and any EHR integration vendor.
- Each EHR vendor's partner program, security questionnaire and agreement.
- A medically and legally qualified review of the emergency and crisis messages and of the AI's limits.

**Hosting (undecided)**
- The operator does not prefer AWS (2026-10-18). The line "Infrastructure: AWS" in `CLAUDE.md` is therefore not a hosting decision, and no deployment has been designed yet.
- Requirements whichever provider is chosen: it signs a BAA, gives a **fixed outgoing IP address** (for EHR allow-lists), encrypted backups, TLS to the database, a secrets manager, and logs that never contain patient details.
- Cost, and payment from Pakistan, to be checked at sign-up.

**Security**
- Invitations and two-factor sign-in, a review of rate limits, and an outside security test.
- The database owner role and TLS settings noted in [authentication](architecture/authentication.md).

**Operations**
- Monitoring and alerts (including each clinic's EHR connection), an incident process, backups that are restored in a test, and a data-retention and deletion policy.

**Product**
- A hosted language model fast and reliable enough for live calls, measured with the evaluation.
- A real phone provider and a live test with each clinic's forwarding.

## Decisions waiting for the operator

| Decision | Why it matters |
|---|---|
| Which clinics, and which EHR first | Everything from step 5 depends on it; it also sets the tier each clinic starts at |
| Hosting provider | Fixed IP, BAA, cost, payment |
| Voice provider, and whether to try ElevenLabs (see below) | Real phone calls; one option also covers the voice |
| Is an EHR connection a paid add-on, with tier 0 as the base product | Pricing and promises to clinics |
| Which larger language model | Cancelling and moving by the AI |
| SMS provider | Reminders |
| Who creates vendor developer accounts and signs partner agreements | EHR sandboxes and production |

**About ElevenLabs** (checked 2026-10-18 on its own pages): it can provide the voice, the listening and a hosted agent, and its agents can use **webhook tools** that call an EHR's FHIR interface, but **ElevenLabs does not provide ready-made EHR connectors**: the integration still has to be built (its own tutorial builds the FHIR tools and uses a pre-built Cal.com calendar integration). HIPAA and a BAA are available only on an enterprise contract. The gateway in [ehr-integration](architecture/ehr-integration.md) would be the target of such tools, so that work is not lost either way. A custom-LLM mode, where ElevenLabs only does speech and telephony and our backend stays the brain, would keep our safety layer; whether it keeps the fixed emergency message and a short enough delay is **not yet tested**.

## What the product cannot do today

- It is **not ready for real patients**: no agreements signed, no clinical review, no security test, no hosting chosen.
- English only; inbound calls only.
- Appointments live in **our own database**, with no connection to any EHR.
- No real phone number is connected; voice has only been tried through the web phone and automated tests.
- With the small local model, **cancelling and moving appointments by the AI is weak** (see the [evaluation](evaluations/ai-scheduling-llama3.2-3b.md)); the AI usually takes a message instead.
- Identifying a caller by name and date of birth alone is weaker than also asking for a phone number (a setting; the stricter check can be switched on).
- Documentation of the whole system (a code map, API reference) is still to be written.
