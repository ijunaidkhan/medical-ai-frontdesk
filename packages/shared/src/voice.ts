/**
 * Phone numbers connected to a practice's AI receptionist. They are added by the
 * operator, so practices can only look at them.
 */
export interface PhoneNumberSummary {
  id: string;
  /** International format, e.g. +14155550123. */
  number: string;
  label: string;
  /** A number that is switched off does not answer calls. */
  active: boolean;
}
