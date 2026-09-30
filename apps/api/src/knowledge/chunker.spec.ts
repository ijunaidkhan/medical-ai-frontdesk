import { CHUNK_MAX_LENGTH, chunkText, SHORT_PARAGRAPH_LENGTH } from './chunker.js';
import { searchTerms } from './retriever.js';

describe('chunkText', () => {
  it('keeps each paragraph as its own piece, so a search returns just the relevant answer', () => {
    const chunks = chunkText(
      [
        'We are open Monday to Friday from 8:00 to 17:00, and on Saturday from 9:00 to 13:00. We are closed on Sundays and public holidays.',
        'We accept most major insurance plans. Please bring your card and photo identification to every visit.',
        'To cancel or reschedule an appointment, please call at least 24 hours before it. Late cancellations may be charged a fee.',
      ].join('\n\n'),
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain('Monday to Friday');
    expect(chunks[1]).toContain('insurance');
  });

  it('joins a short heading to the paragraph that follows it', () => {
    const chunks = chunkText(
      'Opening hours\n\nWe are open Monday to Friday from 8:00 to 17:00, and on Saturday morning until 13:00 by appointment only.',
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/^Opening hours\nWe are open/);
  });

  it('keeps a bare question together with its answer', () => {
    const chunks = chunkText('Do you take walk-ins?\n\nYes, but appointments are seen first. Expect a wait of up to an hour on busy mornings.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Do you take walk-ins?');
    expect(chunks[0]).toContain('appointments are seen first');
  });

  it('keeps a short complete statement as its own piece instead of gluing it to an unrelated one', () => {
    expect(chunkText('Parking is free.\n\nWe accept most major insurance plans. Please bring your card and identification to every visit, thank you.')).toEqual([
      'Parking is free.',
      'We accept most major insurance plans. Please bring your card and identification to every visit, thank you.',
    ]);
  });

  it('does not lose a heading at the very end: it becomes its own piece', () => {
    expect(chunkText('A long enough first paragraph that stands on its own here, well over the short limit of eighty characters.\n\nThe end')).toHaveLength(2);
  });

  it('splits a very long paragraph at sentence ends, never past the limit', () => {
    const sentence = 'The clinic offers a wide range of services to patients of all ages.';
    const chunks = chunkText(Array.from({ length: 40 }, () => sentence).join(' '));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_LENGTH);
      expect(chunk.endsWith('.')).toBe(true); // cut at a sentence boundary
    }
    expect(chunks.join(' ').split(sentence).length - 1).toBe(40); // nothing lost or repeated
  });

  it('cuts text with no punctuation at a space, and loses nothing', () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(words);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_LENGTH);
    expect(chunks.join(' ')).toBe(words);
  });

  it('copes with one enormous unbroken word', () => {
    const chunks = chunkText('x'.repeat(CHUNK_MAX_LENGTH * 3));
    expect(chunks.length).toBe(3);
    expect(chunks.join('')).toBe('x'.repeat(CHUNK_MAX_LENGTH * 3));
  });

  it('normalises Windows line endings and repeated spaces', () => {
    expect(chunkText('First   paragraph with   extra spaces in it. It ends like a statement so it stands alone.\r\n\r\nSecond paragraph, which also ends like a statement.')).toEqual([
      'First paragraph with extra spaces in it. It ends like a statement so it stands alone.',
      'Second paragraph, which also ends like a statement.',
    ]);
  });

  it.each([[''], ['   '], ['\n\n\n'], ['\r\n \r\n']])('returns nothing for blank input %j', (input) => {
    expect(chunkText(input)).toEqual([]);
  });

  it('never produces an empty piece', () => {
    for (const text of ['a', 'a\n\n\n\nb', `${'p'.repeat(SHORT_PARAGRAPH_LENGTH)}\n\n\n\nq`]) {
      for (const chunk of chunkText(text)) expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('searchTerms', () => {
  it('reduces a question to plain lowercase words', () => {
    expect(searchTerms('What time do you OPEN on Saturday?')).toEqual(['what', 'time', 'do', 'you', 'open', 'on', 'saturday']);
  });

  it('removes accents and duplicates, and ignores one-letter words', () => {
    expect(searchTerms('Café café a I é')).toEqual(['cafe']);
  });

  it('keeps digits', () => {
    expect(searchTerms('open at 24 hours? room 12B')).toEqual(['open', 'at', '24', 'hours', 'room', '12b']);
  });

  it('lets nothing through that could act as search syntax', () => {
    const terms = searchTerms("x' | !(secret) & <-> :* ; drop table --");
    for (const term of terms) expect(term).toMatch(/^[a-z0-9]+$/);
    expect(terms.join(' ')).not.toMatch(/[|&!:()<>*'-]/);
  });

  it('caps the number of words', () => {
    expect(searchTerms(Array.from({ length: 50 }, (_, i) => `term${i}`).join(' '))).toHaveLength(12);
  });

  it.each([[''], ['   '], ['?!'], ['اردو'], ['a']])('returns nothing for %j', (input) => {
    expect(searchTerms(input)).toEqual([]);
  });
});
