/** International phone number format (E.164): "+" then 7-15 digits, no spaces. */
export const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

export const PRACTICE_NAME_MAX_LENGTH = 120;

export interface PracticeDetails {
  id: string;
  name: string;
  /** Short name used in URLs; fixed once created. */
  slug: string;
  /** IANA time zone, e.g. "America/New_York". */
  timezone: string;
  phone: string | null;
  status: 'active' | 'suspended';
  createdAt: string;
}

/** Only the fields present are changed. `phone: null` clears the phone number. */
export interface UpdatePracticeRequest {
  name?: string;
  timezone?: string;
  phone?: string | null;
}
