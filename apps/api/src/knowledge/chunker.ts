/** A piece longer than this is split at sentence boundaries. */
export const CHUNK_MAX_LENGTH = 900;
/** A paragraph shorter than this that does not end like a statement is treated as a heading. */
export const SHORT_PARAGRAPH_LENGTH = 80;

/**
 * A short line that is not a finished statement: "Opening hours", "Insurance:",
 * "Do you take walk-ins?". It only makes sense together with what follows, so
 * it is kept with the next paragraph. A short line that ends in a full stop
 * ("Parking is free.") is a fact on its own and stays separate.
 */
function isHeading(paragraph: string): boolean {
  return paragraph.length < SHORT_PARAGRAPH_LENGTH && !/[.!]$/.test(paragraph);
}

/**
 * Splits approved text into searchable pieces. One paragraph is one piece, so a
 * question and its answer written as a paragraph stay together and a search
 * returns just that answer, not a page of unrelated text. Headings and bare
 * questions join the paragraph that follows so they are not orphaned.
 * Overlong paragraphs are cut at sentence ends, and as a last resort at a space.
 */
export function chunkText(content: string): string[] {
  const paragraphs = content
    .replaceAll('\r\n', '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);

  const chunks: string[] = [];
  let carry = '';
  for (const paragraph of paragraphs) {
    const joined = carry ? `${carry}\n${paragraph}` : paragraph;
    if (isHeading(paragraph) && joined.length <= CHUNK_MAX_LENGTH) {
      carry = joined;
      continue;
    }
    chunks.push(...splitLong(joined));
    carry = '';
  }
  if (carry) {
    chunks.push(...splitLong(carry));
  }
  return chunks;
}

function splitLong(text: string): string[] {
  if (text.length <= CHUNK_MAX_LENGTH) {
    return [text];
  }
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    for (const part of hardSplit(sentence)) {
      const candidate = current ? `${current} ${part}` : part;
      if (candidate.length > CHUNK_MAX_LENGTH && current) {
        pieces.push(current);
        current = part;
      } else {
        current = candidate;
      }
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

/** A single "sentence" that is still too long (no punctuation): cut at the last space before the limit. */
function hardSplit(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_MAX_LENGTH) {
    const cut = rest.lastIndexOf(' ', CHUNK_MAX_LENGTH);
    const at = cut > 0 ? cut : CHUNK_MAX_LENGTH;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) {
    parts.push(rest);
  }
  return parts;
}
