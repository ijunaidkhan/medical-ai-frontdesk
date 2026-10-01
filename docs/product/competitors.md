# Competitors and positioning

Status: **working notes, 2026-10-01.** Based on what companies and third-party listing sites say publicly. Vendors' own numbers are marketing claims and have **not** been verified. Revisit before using any of this in sales material.

## What we could and could not find out

- We found **what competitors offer**, not **what technology they run**. Which language model, speech engine or telephony provider they use is not public in anything we found, and we should not guess in documents.
- A claim such as "reduces admin work by 73%" is the vendor's own and means little without the method behind it.

## The two EHR vendors the operator named

| | CureMD Virtual Medical Receptionist | OmniMD AI Front Desk |
|---|---|---|
| Positioning | An AI add-on to CureMD's own practice software | An AI add-on to OmniMD's own EHR |
| Calls and scheduling | Answers 24/7; schedules, reschedules, cancels; syncs with the practice calendar | Scheduling, check-in and follow-ups |
| Front-office extras | Registration and check-in; real-time insurance verification; billing questions and payment collection | Insurance and referral checks; billing, copays, invoices; reminders |
| EHR connection | Calendar sync | "Deep" integration with its own EHR plus an API (HL7, FHIR) |
| Claims | 14 languages; first-ring answer; "up to 73%" less admin work; ">98% first-call resolution" | "Learns from every interaction"; call and scheduling analytics |
| Compliance claims | HIPAA, SOC 2 Type II, ISO 27001, ISO 9001 | HIPAA-compliant |
| Price (as listed) | not found | $0.05 per call |

Sources: [CureMD listing](https://www.stork.ai/compare/curemd-virtual-medical-receptionist-vs-assort-health), [OmniMD listing](https://www.stork.ai/ja/omnimd-ai-front-desk).

## The wider market

Healthcare AI receptionists are a crowded, well-funded category: Assort Health (specialty-specific, large funding round), Hello Patient (medium and large groups), Simbie AI (24/7 receptionist for scheduling, refills and intake), Phreesia VoiceAI, MedReception.ai, Vocca and others. Source: [market overview](https://doctorconnect.net/best-ai-medical-receptionists-2026).

## Where this product stands

**Built and deliberately strong**

- Emergency and crisis handling is **plain code a model cannot override**: fixed practice messages (for example 911 and 988), urgent staff tasks, hand-over to a person, and a callback offer when no one can take the call.
- **Every reply is checked before a caller sees it** (no diagnosis, no medication advice, no false booking claims, no code read aloud); every action the AI asks for is validated by the backend, which also enforces rules such as "only end a conversation when the caller says goodbye" and "a message needs a phone number".
- **Tenant isolation enforced by the database**, an audit log, and a reviewable record of every conversation, tool use and blocked reply.
- **Model choice is a setting**: a free model on the operator's own computer, or a hosted one. No lock-in to one vendor.

**Not built yet (what competitors sell)**

- Booking, rescheduling and cancelling appointments (milestone 3), with calendar or EHR connection so the AI sees real availability.
- Insurance verification, payments, SMS reminders and confirmations.
- Real phone numbers and live calls (milestone 2b, in progress; the live-session part is built, real telephony is not connected).
- More than English.
- Compliance certification (SOC 2 and similar) and signed vendor agreements for every provider that touches call content.
- Review, task-queue and analytics screens (planned).

## Positioning that is realistic

- The EHR vendors sell an AI add-on **to their own customers**. A practice on a different system, or on none, is not their customer.
- A defensible first position is **a safe, transparent front desk that works alongside any system**: answers calls, answers only from the practice's approved information, takes reliable messages, escalates emergencies correctly, and (next) books appointments through a simple calendar.
- What to emphasise: **safety that does not depend on the AI model behaving**, tenant isolation, a complete review trail, and choice of model. What not to claim yet: booking, EHR integration, certifications or call volumes the product does not have.

## Risks to keep in view

- Large vendors can bundle an AI receptionist into software practices already pay for.
- Healthcare buyers expect compliance evidence (signed agreements, audits) before they trust a small vendor with call content.
- Quality of a small free model is far below a large hosted model; the first paying customers will need a hosted model with the right agreements.
