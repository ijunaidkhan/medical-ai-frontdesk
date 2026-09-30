# Phone calls (milestone 2b): proposal

Status: **proposed, waiting for approval. Nothing here is built yet.** It connects real phone calls to the AI receptionist brain that already exists (see [ai-receptionist.md](ai-receptionist.md)).

## What we are building

A caller dials the practice's number and talks to the AI receptionist. The same brain answers as in the text test chat: the same safety rules, the same approved knowledge, the same tools, the same transcript and audit trail. The phone adds only a voice layer:

```
Caller ─► phone network ─► Twilio number
                              │  (1) "a call came in for +1415…"   webhook
                              ▼
                     our API: which practice owns this number?  ──► conversation created
                              │  (2) answers with instructions: connect this call to ConversationRelay
                              ▼
            Twilio ConversationRelay  (speech-to-text and text-to-speech happen at Twilio)
                              │  (3) WebSocket: caller's words as TEXT  ◄──► our reply as TEXT
                              ▼
            Agent (existing): safety classifier → model + tools → reply checker → transcript
                              │  (4) emergency / "speak to a person": we tell Twilio to hand the call over
                              ▼
            Twilio dials the practice's transfer number
```

Why **Twilio ConversationRelay**: it does the hard audio work (speech recognition, speaking, interruptions, silence) and gives our server plain text, which is exactly what our brain already takes. We do not write audio code. It is also covered by Twilio's HIPAA agreement (see Risks).

## Decisions I need from you

| # | Decision | My recommendation |
|---|---|---|
| 1 | Phone/voice provider | **Twilio** with ConversationRelay (alternatives: Telnyx, Vonage; more audio work for us) |
| 2 | Country and numbers | A **US** number to start (your 911/988 wording is US). A clinic keeps its real number and **forwards** to the Twilio number (always, or after hours / when busy) |
| 3 | Language model for voice | Claude, but the faster/cheaper **Haiku** for calls: callers wait for the whole reply, so speed matters |
| 4 | Recording | **None.** Transcripts only (as already decided). The AI says it is an AI at the start of every call |
| 5 | Longest call | **10 minutes** by default, then a polite goodbye with the emergency message |
| 6 | Signed agreements | **Twilio BAA** and **Anthropic BAA** before real patients call (both are the operator's to sign; I cannot do it) |
| 7 | Testing from your laptop | A free tunnel (Cloudflare Tunnel or ngrok) so Twilio can reach your computer |

## How one call works, step by step

1. **Call arrives.** Twilio sends a signed request to `POST /api/voice/incoming` with the number dialed (`To`) and the caller (`From`).
2. **Which practice?** The practice comes **only from the dialed number** (a table of numbers we control), never from anything the caller or Twilio's payload says beyond that number. Unknown number: a short "this number is not in service" message and hang up.
3. **Gates.** Practice active, AI receptionist switched on (so greeting, emergency message and crisis message all exist), call limits not exceeded. If the AI cannot answer, the caller hears a fixed message and, when the practice has a front-desk number, the call is transferred there. **A call is never just dropped without a message.**
4. **Conversation created** (`channel = phone`, the provider's call id, the caller's number for callbacks). The API answers with instructions that connect the call to ConversationRelay and **speak the greeting with the AI notice** ("You are speaking with an automated AI assistant, not a person").
5. **WebSocket** `/api/voice/relay` opens. It is bound to that one conversation by a short-lived single-use token in its address, and the handshake is signature-checked. Twilio sends what the caller said as text; each message is one caller turn.
6. **Each turn** runs the existing agent steps unchanged: emergency and crisis phrases get the fixed script (the model is never asked); otherwise model and tools; every reply checked before it is spoken. The reply text is sent back and Twilio speaks it. Replies are checked **whole** before speaking, so we do not stream unchecked words to the caller (a little slower, deliberately safer).
7. **Hand-over.** For an emergency with a transfer number, or "let me talk to a person", we tell Twilio the session is over; Twilio asks `POST /api/voice/action` what to do next; **we** answer with "dial this number", chosen from the stored conversation and the practice's configured numbers (never from text the model or caller produced).
8. **Hang-up or end.** The conversation is closed with its outcome; a status callback catches calls that ended abruptly. Staff see it in the conversation review page, and any callback tasks appear in the task queue.

If the caller is silent, speaks unclearly, or the model or our server fails, the caller hears a fixed safe line and an offer to take a message; after repeated failures the call is transferred to a person or ends politely. Never silence.

## Safety specific to voice

- Speech recognition makes mistakes. The safety classifier already over-triggers on purpose, so a misheard "chest pain" becomes a false alarm rather than a miss. Conversation tests will include misheard and run-together wording.
- Emergencies and crisis calls: same fixed scripts (911 / 988 messages), urgent task, hand-over when a number exists, callback offer when not.
- The AI never claims an appointment is booked (booking is milestone 3).
- Callers can interrupt the AI; an interrupted emergency message is **not interruptible** (the fixed safety scripts are sent as non-interruptible).
- Short replies (one to three sentences), no lists or formatting.

## Security

- **Webhooks are public addresses**, so every request is verified with Twilio's signature (`X-Twilio-Signature`, HMAC over the exact URL and parameters, using the account's secret token) before anything else happens. Unsigned or wrongly signed requests get 403 and are logged. The deny-by-default rule stays: these routes are explicitly marked and use their own signature guard instead of a user login.
- **Tenant isolation:** the practice is resolved from the dialed number by a narrow database function that returns only a practice id, then every query runs with row-level security for that practice, exactly as now. One practice can never reach another practice's conversations.
- **Numbers are operator-managed** at first (a command the operator runs), not self-service, so nobody can claim another clinic's number. This matches the decision not to build an operator console yet.
- **Secrets:** Twilio account token only in `.env` (validated at startup, never logged), like the Anthropic key.
- **Abuse and cost controls:** maximum call length, maximum simultaneous calls per practice, a per-caller rate limit, and a daily minutes cap per practice; calls over a limit get a fixed message. (Phone spam and toll-fraud are real for any public number.)
- **Privacy:** the caller's number is stored on the conversation (needed for callbacks) inside the practice's isolated data; it is never written to the audit log metadata or application logs.

## What changes

**Database** (migration 0010): a `phone_numbers` table (number, practice, provider, active; unique number); a narrow function `resolve_practice_by_number(number)` (the API's database role may call it, and it returns only the practice id); `conversations` gains the provider call id (unique, makes the webhooks **idempotent**: a repeated webhook never creates a second conversation), the caller's number, and the duration.

**API** (new, all under `/api/voice`): `POST incoming`, WebSocket `relay`, `POST action`, `POST status`. Existing agent service is generalised so a conversation can be served **without a signed-in user** (today it takes the test-chat user's login); tenant comes from the stored conversation. No change to the existing endpoints.

**New dependencies, and why:** a WebSocket server (`ws` with Nest's WebSocket adapter) because ConversationRelay connects to us over WebSocket. I would **not** add Twilio's large SDK: verifying signatures is a short, well-documented HMAC that I would implement and test against Twilio's published examples.

**Infrastructure:** the web server in front (nginx in the Docker setup) must pass WebSocket connections through, and the API needs a public `https` / `wss` address (a tunnel while developing).

**Screens** (web): conversation review (phone calls appear with transcript, tools used, outcome, duration) and the staff tasks queue, both already planned; a "phone numbers" list on the AI settings page (read-only for owners: which numbers are connected).

## Tests

- Signature check against Twilio's published test values, including tampered URL, tampered parameter and wrong token.
- A fake Twilio in the test suite that posts signed webhooks and plays a WebSocket call (setup, several prompts, an interruption, hang-up), against a real database: full call with a scripted model; emergency call; hand-over; unknown number; AI switched off; limits; repeated webhook (idempotent); another practice's number; concurrent calls.
- Conversation test set extended with misheard and run-together wording.
- Mutation checks on every rule, as before.
- **One real call** with you on your own phone (Twilio trial allows calls from numbers you verify), once the pieces exist.

## Steps (each tested and reported before the next)

1. Numbers table, the lookup function, signature check, config and secrets.
2. Incoming-call webhook and the instructions it returns; gates and idempotency.
3. Agent made usable without a signed-in user; the WebSocket session (prompts in, replies out, interruptions).
4. Hand-over and end-of-call handling; status callback.
5. Limits and abuse controls.
6. Screens: conversation review and staff tasks; connected numbers on the settings page.
7. Live call test with a tunnel and a real phone; conversation test set against the real model.

## Cost (approximate, checked on the vendors' pages today; confirm before relying on them)

| Item | Price |
|---|---|
| US local number | about $1.15 per month |
| Inbound call | about $0.0085 per minute |
| ConversationRelay (speech in and out) | about $0.07 per minute (Twilio lists speech-to-text and text-to-speech as part of this; confirm when signing up) |
| Language model | a few cents per call with Haiku; more with Sonnet |
| **Typical 5-minute call** | **roughly $0.45 to $0.60** |

A Twilio **trial** account is free to try but only accepts calls from phone numbers you verify (up to five), which is enough for our testing. Real patients need a paid account, which is also where the HIPAA agreement is signed.

## Risks and things I cannot verify for you

- **HIPAA:** Twilio says ConversationRelay is HIPAA-eligible and signs agreements with covered entities; Anthropic signs one for its API on request through their sales team (and their HIPAA setup restricts some features). **Both must be signed before real patients call**, and the choice of speech engines inside ConversationRelay must also be eligible. This is for you and your legal adviser to confirm.
- **Emergency wording and phrase lists** still need review by someone medically and legally qualified for your country.
- **Latency:** each reply waits for the model (about one to three seconds). The fast model and short replies keep it tolerable; I will measure it on the live test.
- **Emergency services:** the AI receptionist does not replace emergency services; the fixed messages tell callers to call 911 / 988, and a practice must not rely on it as its only way to be reached.
- **Forwarding setup** is the clinic's telephone carrier's job, not ours; I will document what to ask for.
