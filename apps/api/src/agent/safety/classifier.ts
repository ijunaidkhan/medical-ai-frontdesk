import { CRISIS_PHRASES, EMERGENCY_PHRASES, URGENT_PHRASES } from './lexicon.js';
import { containsPhrase, normalizeForMatching } from './text.js';

export type UrgencyLevel = 'emergency' | 'urgent' | 'none';

export interface UrgencyClassification {
  level: UrgencyLevel;
  /** The (normalised) phrases that matched, for the record. Never the caller's own sentence. */
  matches: string[];
  /** An emergency that involves a medical or safety threat (the practice's emergency message applies). */
  medical: boolean;
  /** An emergency that involves suicide or self-harm (the practice's crisis message applies). */
  crisis: boolean;
}

const NONE: UrgencyClassification = { level: 'none', matches: [], medical: false, crisis: false };

/**
 * Decides how urgent one caller message is. Deterministic and independent of
 * any AI model. An emergency phrase always wins; a practice's own extra phrases
 * count as URGENT (they can add sensitivity but can never lower an emergency).
 * Suicide and self-harm phrases are emergencies too, flagged as `crisis` so the
 * caller hears the crisis message; a message can be both `medical` and `crisis`.
 */
export function classifyUrgency(callerText: string, extraUrgentPhrases: readonly string[] = []): UrgencyClassification {
  const text = normalizeForMatching(callerText);
  if (text.length === 0) {
    return { ...NONE, matches: [] };
  }

  const medical = unique(EMERGENCY_PHRASES.filter((phrase) => containsPhrase(text, phrase)));
  const crisis = unique(CRISIS_PHRASES.filter((phrase) => containsPhrase(text, phrase)));
  if (medical.length > 0 || crisis.length > 0) {
    return { level: 'emergency', matches: [...medical, ...crisis], medical: medical.length > 0, crisis: crisis.length > 0 };
  }

  const extras = extraUrgentPhrases.map(normalizeForMatching).filter((phrase) => phrase.length > 0);
  const urgent = unique([...URGENT_PHRASES, ...extras].filter((phrase) => containsPhrase(text, phrase)));
  return urgent.length > 0 ? { level: 'urgent', matches: urgent, medical: false, crisis: false } : { ...NONE, matches: [] };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
