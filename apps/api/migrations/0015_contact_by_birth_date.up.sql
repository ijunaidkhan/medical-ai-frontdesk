-- Callers are identified and contacted by date of birth instead of by dictated phone numbers (which
-- speech recognition gets wrong): the callback number comes from the caller's own number on a real call,
-- or from the patient record, and is asked for only as a last resort.

-- ---------------------------------------------------------- messages for staff
-- A message left by the AI receptionist can carry the caller's date of birth, so staff can find the patient.

ALTER TABLE staff_tasks ADD COLUMN contact_date_of_birth date
  CHECK (contact_date_of_birth IS NULL OR contact_date_of_birth >= DATE '1900-01-01');

-- --------------------------------------------------------- practice settings
-- What the receptionist asks for when taking a message: name + date of birth (the system finds the number),
-- or name + phone number (the earlier behaviour).

ALTER TABLE ai_settings ADD COLUMN message_contact text NOT NULL DEFAULT 'name_dob'
  CHECK (message_contact IN ('name_dob', 'name_phone'));

-- What identifies a caller who wants to hear about, cancel or move an appointment: name + date of birth,
-- or all three of name, date of birth and phone number. (Three is the stricter check.)

ALTER TABLE scheduling_settings ADD COLUMN identity_check text NOT NULL DEFAULT 'name_dob'
  CHECK (identity_check IN ('name_dob', 'name_dob_phone'));

GRANT UPDATE (message_contact) ON ai_settings TO frontdesk_app;
GRANT UPDATE (identity_check) ON scheduling_settings TO frontdesk_app;
