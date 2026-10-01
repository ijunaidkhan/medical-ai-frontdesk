import { containsPhrase, normalizeForMatching } from './safety/text.js';

/** Ways a caller says they are finished. Matched as whole words, ignoring capitals and punctuation. */
const FAREWELLS = [
  'bye',
  'goodbye',
  'good bye',
  'thank you',
  'thankyou',
  'thanks',
  'cheers',
  'that is all',
  'thats all',
  'that will be all',
  'that is everything',
  'thats everything',
  'nothing else',
  'no thank you',
  'no thanks',
  'i am done',
  'im done',
  'all done',
  'that is it',
  'thats it',
  'see you',
  'take care',
  'have a good day',
  'have a nice day',
].map(normalizeForMatching);

/**
 * Has the caller said they are finished? The receptionist may end a conversation
 * only after this is true: a small or confused model must never hang up on a
 * caller who is still talking. A message that asks something is never a goodbye
 * ("thanks, what are your hours?"). Deliberately simple code, not another model.
 */
export function callerIsFinished(callerText: string): boolean {
  if (callerText.includes('?')) {
    return false;
  }
  const text = normalizeForMatching(callerText);
  return FAREWELLS.some((phrase) => containsPhrase(text, phrase));
}
