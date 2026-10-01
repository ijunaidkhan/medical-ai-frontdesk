import type { Generated, Insertable, Selectable, Updateable } from 'kysely';
import type {
  AfterHoursAction,
  AppointmentStatus,
  AuditActorType,
  BusinessHours,
  ConversationChannel,
  ConversationEscalation,
  ConversationOutcome,
  ConversationStatus,
  ToolStatus,
  TurnSource,
  TurnSpeaker,
  KnowledgeCategory,
  KnowledgeStatus,
  Role,
  TaskPriority,
  TaskStatus,
  TaskType,
  TransferPurpose,
  UrgentAction,
} from '@frontdesk/shared';

// Hand-written to match apps/api/migrations. A migration that changes a table
// must update its interface here; the integration tests catch drift in the
// parts they exercise.

export interface PracticesTable {
  id: Generated<string>;
  name: string;
  slug: string;
  timezone: Generated<string>;
  phone: string | null;
  status: Generated<'active' | 'suspended'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  status: Generated<'active' | 'disabled'>;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MembershipsTable {
  id: Generated<string>;
  practice_id: string;
  user_id: string;
  role: Role;
  status: Generated<'active' | 'suspended'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  practice_id: string;
  family_id: string;
  token_hash: Buffer;
  expires_at: Date;
  session_expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: string | null;
  created_ip: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface AuditLogsTable {
  id: Generated<string>;
  practice_id: string | null;
  actor_user_id: string | null;
  actor_type: Generated<AuditActorType>;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  ip: string | null;
  metadata: Generated<Record<string, unknown>>;
  occurred_at: Generated<Date>;
}

export interface KnowledgeSourcesTable {
  id: Generated<string>;
  practice_id: string;
  title: string;
  category: KnowledgeCategory;
  content: string;
  status: Generated<KnowledgeStatus>;
  version: Generated<number>;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** (The generated full-text-search column is only used through raw SQL, so it is not listed.) */
export interface KnowledgeChunksTable {
  id: Generated<string>;
  practice_id: string;
  source_id: string;
  ordinal: number;
  title: string;
  text: string;
  created_at: Generated<Date>;
}

export interface StaffTasksTable {
  id: Generated<string>;
  practice_id: string;
  type: TaskType;
  status: Generated<TaskStatus>;
  priority: Generated<TaskPriority>;
  title: string;
  details: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  created_by_type: 'user' | 'ai';
  created_by: string | null;
  assigned_to: string | null;
  due_at: Date | null;
  completed_at: Date | null;
  completed_by: string | null;
  /** The conversation this task came from, when the AI receptionist made it. */
  conversation_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TransferTargetsTable {
  id: Generated<string>;
  practice_id: string;
  label: string;
  phone: string;
  purpose: TransferPurpose;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AiSettingsTable {
  practice_id: string;
  enabled: boolean;
  greeting: string;
  after_hours_action: AfterHoursAction;
  after_hours_transfer_target_id: string | null;
  emergency_message: string;
  crisis_message: string;
  urgent_action: UrgentAction;
  urgent_transfer_target_id: string | null;
  extra_urgent_phrases: string[];
  business_hours: BusinessHours;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ConversationsTable {
  id: Generated<string>;
  practice_id: string;
  channel: ConversationChannel;
  status: Generated<ConversationStatus>;
  outcome: ConversationOutcome | null;
  escalation: ConversationEscalation | null;
  handoff_target_id: string | null;
  started_by: string | null;
  model: string | null;
  /** Phone calls: the provider's id for the call (makes repeated webhooks harmless), who called, which of our numbers, how long. */
  provider_call_sid: string | null;
  caller_number: string | null;
  phone_number_id: string | null;
  duration_seconds: number | null;
  turn_count: Generated<number>;
  started_at: Generated<Date>;
  ended_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PhoneNumbersTable {
  id: Generated<string>;
  practice_id: string;
  e164: string;
  provider: Generated<'twilio'>;
  provider_sid: string | null;
  label: Generated<string>;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SchedulingSettingsTable {
  practice_id: string;
  slot_minutes: Generated<number>;
  min_notice_hours: Generated<number>;
  max_advance_days: Generated<number>;
  cancel_min_hours: Generated<number>;
  ai_booking_enabled: Generated<boolean>;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProvidersTable {
  id: Generated<string>;
  practice_id: string;
  name: string;
  title: Generated<string>;
  hours: Generated<BusinessHours>;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AppointmentTypesTable {
  id: Generated<string>;
  practice_id: string;
  name: string;
  duration_minutes: number;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProviderAppointmentTypesTable {
  practice_id: string;
  provider_id: string;
  appointment_type_id: string;
}

export interface ProviderTimeOffTable {
  id: Generated<string>;
  practice_id: string;
  provider_id: string;
  starts_at: Date;
  ends_at: Date;
  reason: Generated<string>;
  active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface PatientsTable {
  id: Generated<string>;
  practice_id: string;
  first_name: string;
  last_name: string;
  /** A `date`: always select it as text (date_of_birth::text), or the driver turns it into a JS Date in the server's time zone. */
  date_of_birth: string;
  phone: string;
  created_by_type: 'user' | 'ai';
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface AppointmentsTable {
  id: Generated<string>;
  practice_id: string;
  patient_id: string;
  provider_id: string;
  appointment_type_id: string;
  starts_at: Date;
  ends_at: Date;
  status: Generated<AppointmentStatus>;
  booked_by_type: 'user' | 'ai';
  booked_by: string | null;
  rescheduled_from_id: string | null;
  idempotency_key: string;
  cancelled_at: Date | null;
  cancelled_by_type: 'user' | 'ai' | null;
  cancelled_by: string | null;
  cancel_reason: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ConversationTurnsTable {
  id: Generated<string>;
  practice_id: string;
  conversation_id: string;
  seq: number;
  speaker: TurnSpeaker;
  source: TurnSource;
  text: string;
  guard_reason: string | null;
  /** What the model wrote when the safety check replaced it. Never shown to the caller. */
  blocked_text: string | null;
  latency_ms: number | null;
  created_at: Generated<Date>;
}

export interface ToolInvocationsTable {
  id: Generated<string>;
  practice_id: string;
  conversation_id: string;
  turn_seq: number;
  tool_name: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: ToolStatus;
  duration_ms: number | null;
  created_at: Generated<Date>;
}

export interface Database {
  practices: PracticesTable;
  users: UsersTable;
  memberships: MembershipsTable;
  refresh_tokens: RefreshTokensTable;
  audit_logs: AuditLogsTable;
  knowledge_sources: KnowledgeSourcesTable;
  knowledge_chunks: KnowledgeChunksTable;
  staff_tasks: StaffTasksTable;
  transfer_targets: TransferTargetsTable;
  ai_settings: AiSettingsTable;
  phone_numbers: PhoneNumbersTable;
  scheduling_settings: SchedulingSettingsTable;
  providers: ProvidersTable;
  appointment_types: AppointmentTypesTable;
  provider_appointment_types: ProviderAppointmentTypesTable;
  provider_time_off: ProviderTimeOffTable;
  patients: PatientsTable;
  appointments: AppointmentsTable;
  conversations: ConversationsTable;
  conversation_turns: ConversationTurnsTable;
  tool_invocations: ToolInvocationsTable;
}

export type Practice = Selectable<PracticesTable>;
export type NewPractice = Insertable<PracticesTable>;
export type PracticeUpdate = Updateable<PracticesTable>;
