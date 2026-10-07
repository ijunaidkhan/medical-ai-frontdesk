/**
 * Times of day in what the AI is about to say must come from somewhere real: a tool result in this
 * turn (offered appointment times, opening hours, approved knowledge), what the backend has already
 * settled in this conversation, or the caller's own words. A model that makes up "Monday at 10:00 AM"
 * would send a caller to a time that does not exist, so such a reply is held back.
 *
 * Only times written as times count ("10:00", "10:00 AM", "10 am", "14:30"); "at 5" alone is too vague to judge.
 */

/** Minutes after midnight that a written time may mean (a 12-hour time without AM or PM can mean two). */
function readings(hour: number, minute: number, suffix: string | undefined, twentyFourHour: boolean): number[] {
  if (minute > 59) return [];
  if (suffix) {
    if (hour < 1 || hour > 12) return [];
    const pm = suffix.startsWith('p');
    return [((hour % 12) + (pm ? 12 : 0)) * 60 + minute];
  }
  if (hour > 23) return [];
  // "09:00" (a leading zero) or "14:30" is a 24-hour time; "2:00" may be morning or afternoon.
  return !twentyFourHour && hour >= 1 && hour <= 12 ? [hour * 60 + minute, ((hour % 12) + 12) * 60 + minute] : [hour * 60 + minute];
}

const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\w:])/gi;

/** Every time of day written in the text, each with the minutes after midnight it may mean. */
export function timesIn(text: string): Array<{ written: string; minutes: number[] }> {
  const found: Array<{ written: string; minutes: number[] }> = [];
  for (const match of text.matchAll(TIME)) {
    const [written, hourText, minuteText, suffix] = match;
    // A bare number ("3 options", "1991") is not a time: it needs minutes or AM/PM.
    if (minuteText === undefined && suffix === undefined) continue;
    const minutes = readings(Number(hourText), Number(minuteText ?? 0), suffix?.toLowerCase().replace(/\./g, ''), hourText!.length === 2 && hourText!.startsWith('0'));
    if (minutes.length > 0) found.push({ written: written.trim(), minutes });
  }
  return found;
}

/** The times in `reply` that appear nowhere in `sources`; empty when every time has a source. */
export function unsupportedTimes(reply: string, sources: string): string[] {
  const known = new Set(timesIn(sources).flatMap((time) => time.minutes));
  return timesIn(reply)
    .filter((time) => !time.minutes.some((minutes) => known.has(minutes)))
    .map((time) => time.written);
}
