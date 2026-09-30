/**
 * Control characters other than tab and newline. A NUL (\u0000) in particular is
 * refused by PostgreSQL text and jsonb columns, so untrusted text (what a caller
 * typed, what a model produced) is cleaned before it is stored or searched.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripControl(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '');
}

/** A copy of `value` that PostgreSQL jsonb will accept (no NUL escapes) and that is not huge. */
export function jsonSafe(value: Record<string, unknown>, maxLength = 8_000): Record<string, unknown> {
  const text = JSON.stringify(value).replace(/\\u0000/g, '');
  return text.length > maxLength ? { truncated: true } : (JSON.parse(text) as Record<string, unknown>);
}
