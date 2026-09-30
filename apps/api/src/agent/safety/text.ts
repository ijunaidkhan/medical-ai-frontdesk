/**
 * Reduces what someone said to lowercase words separated by single spaces, so
 * "CAN'T breathe!!" and "cant   breathe" look identical. Apostrophes are
 * removed rather than replaced ("can't" becomes "cant"). Accents are dropped.
 * Only letters a-z and digits survive: text in other scripts becomes empty and
 * matches nothing (the safety phrases are English for now).
 */
export function normalizeForMatching(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’‘`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when `phrase` appears in `text` as whole words. Both must already be normalized. */
export function containsPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}
