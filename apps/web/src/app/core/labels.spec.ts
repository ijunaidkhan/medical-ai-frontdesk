import { PERMISSIONS } from '@frontdesk/shared';
import { actorLabel, auditLabel, PERMISSION_DESCRIPTIONS } from './labels';

describe('actorLabel', () => {
  it('names the AI receptionist and the system, whatever else the entry says', () => {
    expect(actorLabel({ actorType: 'ai', actorName: null })).toBe('AI receptionist');
    expect(actorLabel({ actorType: 'ai', actorName: 'Someone' })).toBe('AI receptionist'); // an AI action is never credited to a person
    expect(actorLabel({ actorType: 'system', actorName: null })).toBe('System');
  });

  it('shows the person’s name, or "Unknown user" when there is none', () => {
    expect(actorLabel({ actorType: 'user', actorName: 'Jane Smith' })).toBe('Jane Smith');
    expect(actorLabel({ actorType: 'user', actorName: null })).toBe('Unknown user');
  });
});

describe('auditLabel', () => {
  it.each([
    ['auth.login.success', 'Signed in'],
    ['knowledge.approved', 'Knowledge entry approved'],
    ['task.status_changed', 'Task status changed'],
    ['ai.enabled', 'AI receptionist turned on'],
    ['phone_number.added', 'Phone number connected'],
    ['phone_number.disabled', 'Phone number switched off'],
    ['provider.created', 'Provider added'],
    ['appointment_type.updated', 'Appointment type changed'],
    ['time_off.cancelled', 'Provider time off cancelled'],
    ['patient.created', 'Patient added'],
    ['patient.viewed', 'Patient details viewed'],
    ['patient.searched', 'Patients searched'],
    ['appointment.booked', 'Appointment booked'],
    ['appointment.cancelled', 'Appointment cancelled'],
    ['appointment.rescheduled', 'Appointment moved'],
    ['patient.verified', 'Caller identified by the AI receptionist'],
    ['conversation.identity_locked', 'Caller identification locked after failed matches'],
    ['scheduling.settings_updated', 'Booking rules changed'],
    ['scheduling.ai_booking_enabled', 'AI receptionist allowed to book appointments'],
    ['scheduling.ai_booking_disabled', 'AI receptionist no longer allowed to book appointments'],
    ['conversation.escalated', 'Emergency or urgent call handled by the safety rules'],
    ['conversation.viewed', 'Conversation transcript viewed'],
  ])('describes %s in plain words', (action, label) => {
    expect(auditLabel(action)).toBe(label);
  });

  it('falls back to the raw name for an event it does not know', () => {
    expect(auditLabel('something.new')).toBe('something.new');
  });
});

describe('PERMISSION_DESCRIPTIONS', () => {
  it('has a plain-language line for every permission', () => {
    for (const permission of PERMISSIONS) {
      expect(PERMISSION_DESCRIPTIONS[permission]).toEqual(expect.any(String));
      expect(PERMISSION_DESCRIPTIONS[permission].length).toBeGreaterThan(10);
    }
  });
});
