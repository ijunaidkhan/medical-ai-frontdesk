import { normalizeForMatching } from './text.js';

export type GuardReason =
  | 'empty'
  | 'too_long'
  | 'diagnosis'
  | 'medication_advice'
  | 'treatment_advice'
  | 'false_reassurance'
  | 'booking_claim'
  | 'human_claim'
  | 'prompt_leak'
  | 'tool_syntax'
  /** A time of day the model said that no tool result, nothing settled in the conversation and no caller words contain (see time-check.ts). */
  | 'unverified_time';

export type GuardVerdict = { ok: true } | { ok: false; reason: GuardReason };

/** Said instead of anything the guard blocks. It must itself pass the guard (tested). */
export const SAFE_FALLBACK_REPLY =
  'I am sorry, I am not able to help with that here. I can take a message for our team, or connect you with someone. What would you like to do?';

export const MAX_REPLY_LENGTH = 1_200;

const CONDITIONS =
  'infection|infections|disease|disorder|syndrome|cancer|diabetes|depression|anxiety|adhd|bipolar|asthma|pneumonia|covid|flu|virus|allergy|illness|tumou?r|migraine|ptsd|ocd|schizophrenia|arthritis|hypertension|anemia|anaemia|eczema|psoriasis|' +
  'heart attack|heart failure|heart disease|cardiac arrest|stroke|seizures?|epilepsy|appendicitis|fracture|concussion|sepsis|blood clot|embolism|ulcer|kidney stones?|gallstones?|hernia|uti|strep|bronchitis|shingles|dehydration|angina|arrhythmia|aneurysm|meningitis|panic attack|gerd|acid reflux|gout|lupus|hepatitis|hiv|food poisoning|tonsillitis|sinusitis|thyroid problem|miscarriage|overdose|blockage';
const MEDICINES =
  'medication|medications|medicine|medicines|meds|pills?|tablets?|capsules?|dose|doses|dosage|antibiotics?|antidepressants?|ibuprofen|paracetamol|acetaminophen|tylenol|aspirin|insulin|painkillers?|steroids?|sedatives?|benzos?|opioids?';

/**
 * Rules applied to the AI's text on ITS way out (the "lowercase" form keeps
 * punctuation and digits; the "normalised" form drops both). Each rule is a
 * deliberately blunt pattern: this is a safety net behind the instructions the
 * model already has, so a false alarm (a safe fallback line) is cheaper than a
 * miss. Tested with both blocked and allowed examples.
 */
const RULES: Array<{ reason: GuardReason; test: (lowercase: string, normalised: string) => boolean }> = [
  {
    // A model that writes its tool request, or code, as the reply instead of using the tool mechanism.
    // Callers would hear it read aloud ("curly bracket name colon create staff task..."). Replies are plain sentences.
    reason: 'tool_syntax',
    test: (lowercase) =>
      /^\s*[[{]/.test(lowercase) ||
      /"(name|function|tool|tool_name|parameters|arguments|args)"\s*:/.test(lowercase) ||
      /"(name|function|tool|tool_name|parameters|arguments|args)\s*[[{]/.test(lowercase) ||
      /<\/?\s*(tool_call|tool_calls|function_call|function|tool_use)\b/.test(lowercase) ||
      /\[\s*tool_calls?\s*\]/.test(lowercase) ||
      /```/.test(lowercase) ||
      // The name of one of the receptionist's own tools: a small model narrating a tool ("find_available_slots
      // returns...") instead of using it, or telling the caller to use one. Callers never hear these names.
      /\b(search_knowledge|get_practice_info|create_staff_task|request_human_handoff|end_conversation|list_appointment_types|find_available_slots|verify_patient|book_appointment|list_my_appointments|cancel_appointment|reschedule_appointment)\b/.test(lowercase),
  },
  {
    // Amounts of a medicine, however written: "500 mg", "2 tablets", "0.5ml".
    reason: 'medication_advice',
    test: (lowercase) => /\b\d+(\.\d+)?\s?(mg|mcg|µg|ml|milligrams?|milliliters?|millilitres?|units|tablets?|pills?|capsules?)\b/.test(lowercase),
  },
  {
    // The same, with the amount written as a word: "two tablets", "half a pill", "a couple of doses".
    reason: 'medication_advice',
    test: (_l, normalised) =>
      /\b(one|two|three|four|five|six|seven|eight|ten|half|a couple of|a few|another|extra|an extra)( a| an)? (tablets?|pills?|capsules?|doses?|spoonfuls?|teaspoons?|tablespoons?|drops)\b/.test(normalised),
  },
  {
    reason: 'medication_advice',
    test: (_l, normalised) =>
      new RegExp(`\\b(take|taking|start|starting|stop|stopping|skip|skipping|double|doubling|increase|increasing|decrease|decreasing|reduce|reducing|switch|switching|try|trying|use|using|drink|drinking|apply|applying|give|giving)\\b[^.?!]{0,50}\\b(${MEDICINES})\\b`).test(normalised),
  },
  {
    // Naming or guessing at an illness ("you probably have...", "sounds like...", "this is a sign of...").
    reason: 'diagnosis',
    test: (_l, normalised) =>
      new RegExp(`\\byou (probably |likely |possibly |may |might |could |must |definitely |certainly |do )?(have|are suffering from|are experiencing|be having|be suffering from|be experiencing)\\b[^.?!]{0,40}\\b(${CONDITIONS})\\b`).test(normalised) ||
      new RegExp(`\\b(sounds|looks|seems) like (you|it|this|that)?( are| is| have| has)?( a| an)?\\b[^.?!]{0,40}\\b(${CONDITIONS})\\b`).test(normalised) ||
      /\b(this|that|it) (is|could be|might be|may be|sounds like|looks like) (a |an )?(sign|symptom|indication|indicator) of\b/.test(normalised) ||
      /\bi (diagnose|would diagnose|think you have|believe you have|suspect you have|think it is|think its)\b/.test(normalised) ||
      /\b(your|the) diagnosis\b/.test(normalised),
  },
  {
    reason: 'treatment_advice',
    test: (_l, normalised) =>
      /\b(you should|i recommend|i suggest|i would suggest|try to|try|it would help to|you could try)\b[^.?!]{0,60}\b(rest|ice|heat|stretch|stretching|exercise|diet|therapy|cream|ointment|herbal|remedy|remedies|supplement|supplements|vitamin|vitamins|fasting|detox)\b/.test(normalised) ||
      /\b(the )?(best|recommended|usual|standard|typical) treatment\b/.test(normalised) ||
      /\btreatment for [a-z ]{2,30} (is|includes|involves)\b/.test(normalised),
  },
  {
    reason: 'false_reassurance',
    test: (_l, normalised) =>
      /\b(nothing to worry about|no need to worry about (it|that|your (symptoms?|pain|condition))|its nothing serious|its probably nothing|it is nothing serious|not serious|nothing serious|youll be fine|you will be fine|you are going to be fine|youre going to be fine|completely normal|perfectly normal|totally normal)\b/.test(normalised),
  },
  {
    // Only the backend may say an appointment is arranged, changed or listed, and it does so in its own
    // sentences, which skip this check (see appointment-text.ts). Any such claim in the MODEL's words is
    // therefore false or unverified, whatever the visit is called: the model cannot know it happened.
    reason: 'booking_claim',
    test: (_l, normalised) =>
      // ("i've" is "ive" once apostrophes are removed, so the contracted forms are listed too.)
      /\b((i|ive|i have|i just|ive just|i already|ive already) (booked|scheduled|confirmed|cancel+ed|rescheduled|arranged|reserved|moved) (your|the|an|a) (appointment|visit|booking|slot|consultation)|your (appointment|visit|booking|slot|consultation) (is|has been|was|will be) (now )?(booked|scheduled|confirmed|cancel+ed|rescheduled|arranged|reserved|set)|youre (all )?(booked|scheduled|confirmed)|you are (all )?(booked|scheduled|confirmed)|(i|ive|i have) (booked|scheduled) you)\b/.test(normalised) ||
      // The same claim with the visit's own name in it ("your follow-up with Dr Khan is booked for Tuesday").
      /\b(is|are|has been|have been|was|will be) (now |all |already |successfully )?(booked|scheduled|confirmed|cancel+ed|rescheduled|reserved|moved) (for|on|to|at|with)\b/.test(normalised) ||
      /\b(has|have) been (now |successfully )?(cancel+ed|rescheduled)\b/.test(normalised) ||
      /\b(i|ive|i have|i just|ive just|i already|ive already) (booked|scheduled|confirmed|cancel+ed|rescheduled|arranged|reserved|moved) (you|that|this|it|them)\b/.test(normalised) ||
      // Telling the caller what they have booked, which only the backend can know.
      /\b(you have|youve got|you have got) (an? )?(appointment|visit|booking) (on|at|for) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|\d)/.test(normalised) ||
      /\b(you have|youve got|you have got) (an?|one|\d+|two|three|four|five) upcoming (appointments?|visits?|bookings?)\b/.test(normalised),
  },
  {
    reason: 'human_claim',
    test: (_l, normalised) =>
      /\b(i am|im) (a |an )?(real |actual |live )?(human|person|nurse|doctor|physician|clinician|therapist|psychologist|psychiatrist|pharmacist|receptionist|medical (professional|assistant))\b/.test(normalised) ||
      /\b(not|no longer) (an? )?(ai|robot|bot|machine|computer|automated)\b/.test(normalised) ||
      /\bas (a|your) (nurse|doctor|physician|clinician|therapist|pharmacist)\b/.test(normalised),
  },
  {
    reason: 'prompt_leak',
    test: (_l, normalised) => /\b(system prompt|my (system )?(prompt|instructions|rules) (is|are|say|says|tell|tells)|ignore (all |any )?(previous|prior|above) instructions)\b/.test(normalised),
  },
];

/**
 * Checks what the AI is about to say. Runs on EVERY model reply, independent of
 * the model. When it blocks, the caller gets SAFE_FALLBACK_REPLY instead and the
 * reason is recorded on the conversation for review.
 */
export function checkReply(reply: string): GuardVerdict {
  const trimmed = reply.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (trimmed.length > MAX_REPLY_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  const lowercase = trimmed.toLowerCase();
  const normalised = normalizeForMatching(trimmed);
  for (const rule of RULES) {
    if (rule.test(lowercase, normalised)) {
      return { ok: false, reason: rule.reason };
    }
  }
  return { ok: true };
}
