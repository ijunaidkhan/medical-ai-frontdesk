import type { AfterHoursAction, AuditLogEntry, Permission, Role, TransferPurpose, UrgentAction, Weekday } from '@frontdesk/shared';

export const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const AFTER_HOURS_LABELS: Readonly<Record<AfterHoursAction, string>> = {
  take_message: 'Take a message for the team',
  transfer: 'Transfer the call to a person',
};

export const URGENT_ACTION_LABELS: Readonly<Record<UrgentAction, string>> = {
  urgent_task: 'Create an urgent task for staff',
  transfer: 'Transfer the call to a person',
  transfer_and_task: 'Transfer the call and create an urgent task',
};

export const TRANSFER_PURPOSE_LABELS: Readonly<Record<TransferPurpose, string>> = {
  front_desk: 'Front desk',
  on_call: 'On-call clinician',
  billing: 'Billing',
  other: 'Other',
};

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: 'Owner',
  admin: 'Administrator',
  staff: 'Staff',
  viewer: 'Viewer',
};

/** "Staff" is already plural, so a count of two is "2 Staff", not "2 Staffs". */
export const ROLE_LABELS_PLURAL: Readonly<Record<Role, string>> = {
  owner: 'Owners',
  admin: 'Administrators',
  staff: 'Staff',
  viewer: 'Viewers',
};

export const PERMISSION_DESCRIPTIONS: Readonly<Record<Permission, string>> = {
  'practice:read': 'View practice details',
  'practice:manage': 'Change practice details',
  'members:read': 'See who is on the team',
  'members:manage': 'Manage team roles and access',
  'audit:read': 'Review the activity log',
  'knowledge:read': 'See the clinic information the AI receptionist uses',
  'knowledge:manage': 'Write and approve the clinic information the AI receptionist uses',
  'tasks:read': 'See the task queue (callbacks and messages)',
  'tasks:manage': 'Create, assign and complete tasks',
  'ai:read': 'See how the AI receptionist is set up',
  'ai:configure': 'Change how the AI receptionist behaves and turn it on or off',
  'calls:read': 'Read conversations with the AI receptionist',
};

const AUDIT_LABELS: Readonly<Record<string, string>> = {
  'auth.login.success': 'Signed in',
  'auth.login.failed': 'Failed sign-in attempt',
  'auth.account.locked': 'Account locked after failed attempts',
  'auth.logout': 'Signed out',
  'auth.practice.switched': 'Switched practice',
  'auth.refresh.reuse_detected': 'Session ended: sign-in token reused',
  'auth.refresh.denied': 'Session ended: access removed',
  'practice.updated': 'Practice details changed',
  'member.role_changed': 'Team member role changed',
  'member.suspended': 'Team member suspended',
  'member.reactivated': 'Team member reactivated',
  'bootstrap.practice_created': 'Practice created',
  'knowledge.created': 'Knowledge entry added',
  'knowledge.updated': 'Knowledge entry edited',
  'knowledge.approved': 'Knowledge entry approved',
  'knowledge.archived': 'Knowledge entry archived',
  'knowledge.restored': 'Knowledge entry restored',
  'task.created': 'Task created',
  'task.updated': 'Task edited',
  'task.assigned': 'Task assigned',
  'task.status_changed': 'Task status changed',
  'ai.settings_updated': 'AI receptionist settings changed',
  'conversation.started': 'Test chat started',
  'conversation.escalated': 'Emergency or urgent call handled by the safety rules',
  'conversation.handed_off': 'Conversation handed to a person',
  'conversation.viewed': 'Conversation transcript viewed',
  'ai.enabled': 'AI receptionist turned on',
  'ai.disabled': 'AI receptionist turned off',
  'ai.transfer_target_created': 'Transfer number added',
  'ai.transfer_target_updated': 'Transfer number changed',
};

/** Who did it, for activity lists: the AI receptionist and the system are named as such, never as an "unknown user". */
export function actorLabel(entry: Pick<AuditLogEntry, 'actorType' | 'actorName'>): string {
  if (entry.actorType === 'ai') return 'AI receptionist';
  if (entry.actorType === 'system') return 'System';
  return entry.actorName ?? 'Unknown user';
}

/** A readable name for an audit event, falling back to the raw event name. */
export function auditLabel(action: string): string {
  return AUDIT_LABELS[action] ?? action;
}
