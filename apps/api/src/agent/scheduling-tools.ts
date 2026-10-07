import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { TimeFormat } from '@frontdesk/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { sql, type Transaction } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { Database } from '../database/database.types.js';
import { CreatePatientDto } from '../scheduling/appointments.dto.js';
import { bookedSentence, cancelledSentence, clockParts, formatWhen, listSentence, movedSentence, oneLine, type AppointmentFacts } from '../scheduling/appointment-text.js';
import { AppointmentsService, CancellationWindowError } from '../scheduling/appointments.service.js';
import { PatientsService } from '../scheduling/patients.service.js';
import { SchedulingService } from '../scheduling/scheduling.service.js';
import { localDate, zonedInstant } from '../scheduling/zoned-time.js';
import type { ModelToolDefinition } from './model/language-model.js';
import { stripControl } from './sanitize.js';
import type { ToolResult, ToolRuntime } from './tools.js';

type Trx = Transaction<Database>;

/** Times offered to a caller at once, how many may fall on one day, how far ahead to look. */
export const SLOTS_OFFERED = 5;
const MAX_SLOTS_PER_DAY = 3;
const SEARCH_DAYS = 21;
const SEARCH_LIMIT = 80;
const DAY = 86_400_000;
/** Identity checks that may fail in one conversation before identification is locked (the database enforces the same number). */
export const MAX_IDENTITY_FAILURES = 3;

/** Which tools' results hold the codes of offered times, and of the caller's own appointments (verify_patient lists them too). */
const SLOT_SOURCES = ['find_available_slots'] as const;
const APPOINTMENT_SOURCES = ['list_my_appointments', 'verify_patient'] as const;

export const SCHEDULING_TOOL_NAMES = ['list_appointment_types', 'find_available_slots', 'verify_patient', 'book_appointment', 'list_my_appointments', 'cancel_appointment', 'reschedule_appointment'] as const;

const PATIENT_DETAILS = {
  firstName: { type: 'string', description: 'The caller\'s first name.' },
  lastName: { type: 'string', description: 'The caller\'s last name.' },
  dateOfBirth: { type: 'string', description: 'Date of birth as YYYY-MM-DD, for example 1990-05-17.' },
  phone: { type: 'string', description: 'The phone number the caller said, written as a plus sign, the country code, then the number, with no spaces.' },
} as const;

const DEFINITIONS: Record<(typeof SCHEDULING_TOOL_NAMES)[number], ModelToolDefinition> = {
  list_appointment_types: {
    name: 'list_appointment_types',
    description: 'List the kinds of appointment a caller can book (name and length). Use when the caller has not said what kind of visit they want.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  find_available_slots: {
    name: 'find_available_slots',
    description:
      'Find real open appointment times. Returns a few options, each with a code and the exact words to say. Only offer times this tool returns, exactly as written; never say any other time.',
    parameters: {
      type: 'object',
      properties: {
        appointmentType: { type: 'string', description: 'The kind of visit, exactly as returned by list_appointment_types.' },
        appointmentCode: { type: 'string', description: 'When MOVING one of the caller\'s appointments: its code (for example M1) instead of appointmentType.' },
        earliestDate: { type: 'string', description: 'Optional. Do not offer anything before this date (YYYY-MM-DD).' },
        timeOfDay: { type: 'string', enum: ['morning', 'afternoon', 'any'], description: 'Optional. When the caller prefers.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  verify_patient: {
    name: 'verify_patient',
    description:
      'Check who the caller is, so they can hear or change their own appointments. Needs all four details. You are told only whether they matched. Do not use it to book a new appointment.',
    parameters: { type: 'object', properties: PATIENT_DETAILS, required: ['firstName', 'lastName', 'dateOfBirth', 'phone'], additionalProperties: false },
  },
  book_appointment: {
    name: 'book_appointment',
    description:
      'Book one of the times returned by find_available_slots for the caller. Needs the slot code the caller chose and the caller\'s first name, last name, date of birth and phone. The system confirms the booking itself; you do not need to.',
    parameters: { type: 'object', properties: { slotCode: { type: 'string', description: 'The code of the chosen time, for example S1.' }, ...PATIENT_DETAILS }, required: ['slotCode', 'firstName', 'lastName', 'dateOfBirth', 'phone'], additionalProperties: false },
  },
  list_my_appointments: {
    name: 'list_my_appointments',
    description: 'Tell the caller their own upcoming appointments. Only works after verify_patient matched. The system says the list itself.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  cancel_appointment: {
    name: 'cancel_appointment',
    description: 'Cancel one of the caller\'s own appointments, using the code from list_my_appointments. Only works after verify_patient matched. The system confirms it itself.',
    parameters: { type: 'object', properties: { appointmentCode: { type: 'string', description: 'The code of the appointment, for example M1.' } }, required: ['appointmentCode'], additionalProperties: false },
  },
  reschedule_appointment: {
    name: 'reschedule_appointment',
    description:
      'Move one of the caller\'s own appointments to another time. Needs the appointment code from list_my_appointments and a slot code from find_available_slots for the SAME kind of visit. Only works after verify_patient matched. The system confirms it itself.',
    parameters: {
      type: 'object',
      properties: { appointmentCode: { type: 'string', description: 'The code of the appointment to move, for example M1.' }, slotCode: { type: 'string', description: 'The code of the new time, for example S2.' } },
      required: ['appointmentCode', 'slotCode'],
      additionalProperties: false,
    },
  },
};

const rejected = (result: Record<string, unknown>): ToolResult => ({ status: 'rejected', result });

const argText = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  const text = typeof value === 'string' ? stripControl(value).trim() : '';
  return text !== '' ? text.slice(0, 200) : undefined;
};

/** Speech recognition and models write phone numbers with spaces and dashes; the stored form has none. */
export const normalizePhone = (text: string): string => text.replace(/[\s\-().]/g, '');

/** A real calendar date written YYYY-MM-DD, or null. */
function parseDate(text: string | undefined): { year: number; month: number; day: number } | null {
  const match = text === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? { year, month, day } : null;
}

const SPOKEN_DIGITS: Record<string, string> = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/** The digits in what someone said, in order, with spoken digits ("four one five") turned into figures. */
export function digitsSaid(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/g, (word) => SPOKEN_DIGITS[word]!)
    .replace(/\D/g, '');
}

/** Each number the caller said, as its digits ("+1 (415) 555-0111" and "four one five, five five five, ..." are one number each). */
function numbersSaid(text: string): Array<{ digits: string; international: boolean }> {
  const figures = text.toLowerCase().replace(/\b(zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/g, (word) => SPOKEN_DIGITS[word]!);
  return [...figures.matchAll(/\+?\d[\d\s().,-]*\d/g)].map((match) => ({ digits: match[0].replace(/\D/g, ''), international: match[0].startsWith('+') }));
}

/**
 * Whether the caller said this phone number: one of the numbers they said must be exactly it, or exactly it
 * without the country code (people say "415 555 0111", or "0300 1234567" with the local 0 for +923001234567).
 * A number with a digit missing, added or changed does not match.
 */
export function phoneWasSaid(phone: string, callerWords: string): boolean {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return false;
  return numbersSaid(callerWords).some((said) => {
    if (said.digits === digits) return true;
    // Only a number said WITHOUT a country code may have one added (1 to 3 digits); one said with "+" must match exactly.
    if (said.international) return false;
    const national = said.digits.replace(/^0/, '');
    return national.length >= 7 && digits.endsWith(national) && digits.length - national.length <= 3;
  });
}

/** Letters and digits only, lower case: "Follow-up" and "follow up appointment" can then be compared. */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The visit type the model meant. Models say "follow-up appointment" or "a long visit" rather than the exact
 * name, so: the exact name first; otherwise the longest name that appears inside what was said; otherwise the
 * only name that contains what was said. Anything less certain is "not found", and the model is given the list.
 */
export function matchType<T extends { name: string }>(types: readonly T[], wanted: string): T | undefined {
  const said = squash(wanted);
  if (said === '') return undefined;
  const exact = types.find((type) => squash(type.name) === said);
  if (exact) return exact;
  const inside = types.filter((type) => squash(type.name) !== '' && said.includes(squash(type.name))).sort((a, b) => squash(b.name).length - squash(a.name).length);
  if (inside.length > 0) return inside[0];
  // A fragment must be long enough to mean something ("a" is inside almost any name).
  if (said.length < 3) return undefined;
  const containing = types.filter((type) => squash(type.name).includes(said));
  return containing.length === 1 ? containing[0] : undefined;
}

/** One key per (conversation, action, subject): asking twice for the same thing in one conversation books once. */
const idempotencyKey = (...parts: string[]): string => `ai-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 48)}`;

interface IssuedSlot {
  code: string;
  providerId: string;
  appointmentTypeId: string;
  startsAt: string;
  /** How the time was worded to the model, kept so later turns can be reminded of what each code means. */
  label: string;
}
interface IssuedAppointment {
  code: string;
  appointmentId: string;
  label: string;
}

/**
 * The scheduling tools of the AI receptionist. Each one validates what the model asked for, then does
 * its narrow job through the same services the staff screens use, inside the practice-scoped transaction
 * it is given. The model never supplies a practice, patient, provider, appointment or time: only short
 * codes that this conversation's own earlier tool results issued. Where a tool states a fact about an
 * appointment, it hands the sentence to the backend's line list (`runtime.state.lines`), which becomes
 * the whole reply for that turn.
 */
@Injectable()
export class SchedulingTools {
  constructor(
    private readonly scheduling: SchedulingService,
    private readonly appointments: AppointmentsService,
    private readonly patients: PatientsService,
  ) {}

  definitions(): ModelToolDefinition[] {
    return SCHEDULING_TOOL_NAMES.map((name) => DEFINITIONS[name]);
  }

  handles(name: string): boolean {
    return (SCHEDULING_TOOL_NAMES as readonly string[]).includes(name);
  }

  async execute(trx: Trx, runtime: ToolRuntime, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // The practice may have switched booking off since the conversation began: checked every time, not once.
    const settings = await this.scheduling.loadSettings(trx, runtime.practiceId);
    if (!settings.aiBookingEnabled) {
      return rejected({ error: 'Booking by the assistant is not available right now. Offer to take a message for the team with create_staff_task.' });
    }
    const format = settings.timeFormat;
    switch (name) {
      case 'list_appointment_types':
        return this.listTypes(trx);
      case 'find_available_slots':
        return this.findSlots(trx, runtime, args, format);
      case 'verify_patient':
        return this.verify(trx, runtime, args, settings.identityFailureCapPerHour, format);
      case 'book_appointment':
        return this.book(trx, runtime, args, format);
      case 'list_my_appointments':
        return this.listMine(trx, runtime, format);
      case 'cancel_appointment':
        return this.cancel(trx, runtime, args, format);
      case 'reschedule_appointment':
        return this.reschedule(trx, runtime, args, format);
      default:
        return rejected({ error: 'Unknown tool' });
    }
  }

  // ---------------------------------------------------------- finding times

  /** The visit types a caller can book: active, with at least one active provider who offers them. */
  private bookableTypes(trx: Trx) {
    return trx
      .selectFrom('appointment_types as t')
      .select(['t.id', 't.name', 't.duration_minutes'])
      .where('t.active', '=', true)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('provider_appointment_types as link')
            .innerJoin('providers as p', 'p.id', 'link.provider_id')
            .select('link.provider_id')
            .whereRef('link.appointment_type_id', '=', 't.id')
            .where('p.active', '=', true),
        ),
      )
      .orderBy('t.name')
      .limit(30)
      .execute();
  }

  private async listTypes(trx: Trx): Promise<ToolResult> {
    const types = await this.bookableTypes(trx);
    if (types.length === 0) {
      return { status: 'ok', result: { types: [], note: 'There is nothing to book right now. Offer to take a message for the team.' } };
    }
    return { status: 'ok', result: { types: types.map((type) => ({ name: oneLine(type.name), lengthMinutes: type.duration_minutes })) } };
  }

  private async findSlots(trx: Trx, runtime: ToolRuntime, args: Record<string, unknown>, format: TimeFormat): Promise<ToolResult> {
    const types = await this.bookableTypes(trx);
    const wanted = argText(args, 'appointmentType');
    // Only a code of the caller's own appointments (M1, M2...) means "moving"; anything else in that field (a small
    // model put a time's code, S1, there) is ignored, so a plain search is not mistaken for a move.
    const appointmentCode = /^m\d{1,3}$/i.test(argText(args, 'appointmentCode') ?? '') ? argText(args, 'appointmentCode') : undefined;
    let type: (typeof types)[number] | undefined;
    if (appointmentCode) {
      // Moving an appointment: search for the same kind of visit as the caller's own appointment with that code.
      const who = await this.requireVerified(trx, runtime);
      if ('status' in who) return who;
      const own = await this.ownAppointment(trx, runtime, who.patientId, appointmentCode);
      if (!own) {
        return rejected({ error: 'That is not one of the caller\'s appointments listed in this conversation. Use list_my_appointments first.' });
      }
      type = types.find((candidate) => candidate.id === own.appointment_type_id);
    } else if (wanted) {
      type = matchType(types, wanted);
    } else if (types.length === 1) {
      type = types[0]; // only one kind of visit: nothing to choose, so the model does not have to name it
    } else {
      return rejected({ error: 'Say which kind of visit (appointmentType), or give appointmentCode when moving an appointment.', availableTypes: types.map((candidate) => candidate.name) });
    }
    if (!type) {
      return rejected({
        error: `"${wanted ?? ''}" is not a kind of visit. To book, use one of availableTypes. To MOVE an existing appointment, first call verify_patient with the caller's details, then call find_available_slots with appointmentCode (for example M1) instead of appointmentType.`,
        availableTypes: types.map((candidate) => candidate.name),
      });
    }
    const timeOfDay = argText(args, 'timeOfDay') ?? 'any';
    if (!['morning', 'afternoon', 'any'].includes(timeOfDay)) {
      return rejected({ error: 'timeOfDay must be morning, afternoon or any.' });
    }
    const timeZone = runtime.context.practice.timezone;
    const now = new Date();
    let from = now;
    const earliest = argText(args, 'earliestDate');
    if (earliest !== undefined) {
      const date = parseDate(earliest);
      if (!date) {
        return rejected({ error: 'earliestDate must be a real date written YYYY-MM-DD.' });
      }
      const startOfDay = zonedInstant(date, 0, timeZone) ?? zonedInstant(date, 60, timeZone) ?? new Date(Date.UTC(date.year, date.month - 1, date.day));
      if (startOfDay.getTime() > from.getTime()) from = startOfDay;
    }
    const to = new Date(from.getTime() + SEARCH_DAYS * DAY);
    const found = await this.scheduling.findSlots(trx, runtime.practiceId, { appointmentTypeId: type.id, from, to, limit: SEARCH_LIMIT, now });

    // A handful of real options, spread over a few days rather than the first five of one morning.
    const perDay = new Map<string, number>();
    const chosen: typeof found.slots = [];
    for (const slot of found.slots) {
      const startsAt = new Date(slot.startsAt);
      const { hour } = clockParts(startsAt, timeZone);
      if ((timeOfDay === 'morning' && hour >= 12) || (timeOfDay === 'afternoon' && hour < 12)) continue;
      const day = localDate(startsAt, timeZone);
      const dayKey = `${day.year}-${day.month}-${day.day}`;
      if ((perDay.get(dayKey) ?? 0) >= MAX_SLOTS_PER_DAY) continue;
      perDay.set(dayKey, (perDay.get(dayKey) ?? 0) + 1);
      chosen.push(slot);
      if (chosen.length >= SLOTS_OFFERED) break;
    }
    if (chosen.length === 0) {
      return {
        status: 'ok',
        result: { slots: [], note: 'No open times were found in the next three weeks for that. Offer to take a message so the team can call the caller back, using create_staff_task.' },
      };
    }

    // Codes are unique across the whole conversation, so "S2" always means the same time.
    const earlier = (await this.issued<IssuedSlot>(trx, runtime.conversationId, SLOT_SOURCES, 'slots')).length;
    const wording = chosen.map((slot) => ({ when: formatWhen(new Date(slot.startsAt), timeZone, format), provider: oneLine(slot.providerName) }));
    const issuedNow = chosen.map(
      (slot, index): IssuedSlot => ({
        code: `S${earlier + index + 1}`,
        providerId: slot.providerId,
        appointmentTypeId: slot.appointmentTypeId,
        startsAt: slot.startsAt,
        label: `${wording[index]!.when} with ${wording[index]!.provider}`,
      }),
    );
    return {
      status: 'ok',
      result: {
        slots: chosen.map((_slot, index) => ({ code: issuedNow[index]!.code, ...wording[index]! })),
        lengthMinutes: type.duration_minutes,
        note: 'Offer these times exactly as written (the "when" and "provider" words) and let the caller choose. Do not say any other time.',
      },
      // What is kept for later steps (which code is which time and provider) is not shown to the model.
      stored: { slots: issuedNow },
    };
  }

  // ----------------------------------------------------------- who is calling

  private async verify(trx: Trx, runtime: ToolRuntime, args: Record<string, unknown>, capPerHour: number, format: TimeFormat): Promise<ToolResult> {
    const conversation = await trx.selectFrom('conversations').select(['identity_failures']).where('id', '=', runtime.conversationId).forUpdate().executeTakeFirstOrThrow();
    // Locked: no more checks in this conversation, and no hint of what was wrong with any earlier one.
    if (conversation.identity_failures >= MAX_IDENTITY_FAILURES) {
      return rejected({ matched: false, locked: true, error: 'The caller could not be identified. Do not try again. Offer to take a message for the team with create_staff_task.' });
    }
    const details = this.details(args);
    if ('problems' in details) {
      return rejected({ error: 'Those details are not complete or not valid. Ask the caller again for the missing ones.', problems: details.problems });
    }
    // A model that mistyped the number is not a caller guessing: refused without counting as a failed check.
    const misheard = await this.phoneNotSaid(trx, runtime, details.dto.phone);
    if (misheard) return misheard;

    // Many conversations together can still be used to guess: a cap for the whole practice per hour.
    const recent = await trx
      .selectFrom('tool_invocations')
      .select((eb) => eb.fn.countAll<string>().as('failures'))
      .where('tool_name', '=', 'verify_patient')
      .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
      .where(sql<boolean>`result ->> 'matched' = 'false'`)
      .executeTakeFirstOrThrow();
    if (Number(recent.failures) >= capPerHour) {
      await this.noteCapReached(trx, runtime, capPerHour);
      return rejected({ matched: false, unavailable: true, error: 'Identifying callers is not available right now. Offer to take a message for the team with create_staff_task.' });
    }

    const patient = await this.patients.findMatch(trx, details.dto);
    if (patient) {
      await trx.updateTable('conversations').set({ verified_patient_id: patient.id }).where('id', '=', runtime.conversationId).execute();
      await writeAuditLog(trx, {
        practiceId: runtime.practiceId,
        actorUserId: null,
        actorType: 'ai',
        action: 'patient.verified',
        targetType: 'patient',
        targetId: patient.id,
        requestId: runtime.meta.requestId,
        ip: runtime.meta.ip,
        metadata: { conversationId: runtime.conversationId },
      });
      // A caller who is identified almost always wants their appointments next: the system reads them out at once,
      // which saves a small model two steps (and the codes M1, M2... are ready for cancelling or moving).
      const listed = await this.listMine(trx, runtime, format);
      return {
        status: 'ok',
        result: { matched: true, ...listed.result, note: 'The caller is identified. The system reads them their appointments. Use the codes if they want to cancel or move one.' },
        // `matched` stays in the record: the practice-wide cap counts failed checks from it.
        stored: { matched: true, ...listed.stored },
      };
    }

    // Never says which detail was wrong.
    const after = await trx
      .updateTable('conversations')
      .set({ identity_failures: sql<number>`identity_failures + 1` })
      .where('id', '=', runtime.conversationId)
      .returning('identity_failures')
      .executeTakeFirstOrThrow();
    const locked = after.identity_failures >= MAX_IDENTITY_FAILURES;
    if (locked) {
      await writeAuditLog(trx, {
        practiceId: runtime.practiceId,
        actorUserId: null,
        actorType: 'system',
        action: 'conversation.identity_locked',
        targetType: 'conversation',
        targetId: runtime.conversationId,
        requestId: runtime.meta.requestId,
        ip: runtime.meta.ip,
        metadata: { failures: after.identity_failures },
      });
    }
    return {
      status: 'ok',
      result: locked
        ? { matched: false, locked: true, error: 'The caller could not be identified. Do not try again. Offer to take a message for the team with create_staff_task.' }
        : { matched: false, error: 'No match. Do not say which detail was wrong. Ask the caller to repeat their details once more, or offer to take a message.' },
    };
  }

  /** One audit event per hour when the practice-wide cap is first hit. */
  private async noteCapReached(trx: Trx, runtime: ToolRuntime, cap: number): Promise<void> {
    const already = await trx
      .selectFrom('audit_logs')
      .select('id')
      .where('action', '=', 'scheduling.identity_cap_reached')
      .where('occurred_at', '>', sql<Date>`now() - interval '1 hour'`)
      .limit(1)
      .executeTakeFirst();
    if (already) return;
    await writeAuditLog(trx, {
      practiceId: runtime.practiceId,
      actorUserId: null,
      actorType: 'system',
      action: 'scheduling.identity_cap_reached',
      targetType: 'conversation',
      targetId: runtime.conversationId,
      requestId: runtime.meta.requestId,
      ip: runtime.meta.ip,
      metadata: { capPerHour: cap },
    });
  }

  private async requireVerified(trx: Trx, runtime: ToolRuntime): Promise<{ patientId: string } | ToolResult> {
    const row = await trx.selectFrom('conversations').select('verified_patient_id').where('id', '=', runtime.conversationId).executeTakeFirstOrThrow();
    if (row.verified_patient_id === null) {
      return rejected({ error: 'The caller has not been identified. Ask for their first name, last name, date of birth and phone number, then use verify_patient.' });
    }
    return { patientId: row.verified_patient_id };
  }

  // ------------------------------------------------------------------ booking

  private async book(trx: Trx, runtime: ToolRuntime, args: Record<string, unknown>, format: TimeFormat): Promise<ToolResult> {
    const code = argText(args, 'slotCode');
    const offered = await this.issued<IssuedSlot>(trx, runtime.conversationId, SLOT_SOURCES, 'slots');
    const slot = code === undefined ? undefined : offered.find((candidate) => candidate.code.toLowerCase() === code.toLowerCase());
    if (!slot) {
      // Say exactly what to do next: small models otherwise tell the caller there are no times.
      if (offered.length === 0) {
        const types = (await this.bookableTypes(trx)).map((type) => type.name);
        return rejected({ error: `No times have been offered yet in this conversation. First call find_available_slots (the kinds of visit are: ${types.join(', ')}), read the caller the times it returns, and let them choose.` });
      }
      return rejected({ error: `That is not one of the times offered. Use one of these codes: ${offered.map((candidate) => `${candidate.code} = ${candidate.label}`).join('; ')}.` });
    }
    const details = this.details(args);
    if ('problems' in details) {
      return rejected({ error: 'Those details are not complete or not valid. Ask the caller again for the missing ones.', problems: details.problems });
    }
    // Never store a phone number the caller did not say (a patient record with a wrong number cannot be called back).
    const misheard = await this.phoneNotSaid(trx, runtime, details.dto.phone);
    if (misheard) return misheard;

    const outcome = await this.attempt(trx, async () => {
      const { patient } = await this.patients.findOrCreateInTransaction(trx, runtime.practiceId, { kind: 'ai' }, details.dto, runtime.meta);
      return this.appointments.bookInTransaction(
        trx,
        runtime.practiceId,
        { kind: 'ai' },
        {
          patientId: patient.id,
          providerId: slot.providerId,
          appointmentTypeId: slot.appointmentTypeId,
          startsAt: new Date(slot.startsAt),
          idempotencyKey: idempotencyKey(runtime.conversationId, 'book', slot.code),
          conversationId: runtime.conversationId,
        },
        runtime.meta,
        'caller',
      );
    });
    if (!outcome.ok) return this.refusal(outcome.error, 'booked');

    this.say(runtime, bookedSentence(await this.factsOf(trx, outcome.value.appointmentId), runtime.context.practice.timezone, format));
    return { status: 'ok', result: { booked: true, note: 'The system will tell the caller. Do not say anything about the booking yourself.' } };
  }

  // ------------------------------------------------- seeing and changing own

  private async listMine(trx: Trx, runtime: ToolRuntime, format: TimeFormat): Promise<ToolResult> {
    const who = await this.requireVerified(trx, runtime);
    if ('status' in who) return who;
    const rows = await trx
      .selectFrom('appointments')
      .select('id')
      .where('patient_id', '=', who.patientId)
      .where('status', '=', 'booked')
      .where('starts_at', '>', sql<Date>`now()`)
      .orderBy('starts_at')
      .orderBy('id')
      .limit(SLOTS_OFFERED)
      .execute();
    const timeZone = runtime.context.practice.timezone;
    // An appointment listed earlier in the conversation keeps its code, so "M1" never changes meaning.
    const earlier = await this.issued<IssuedAppointment>(trx, runtime.conversationId, APPOINTMENT_SOURCES, 'appointments');
    let next = earlier.reduce((highest, item) => Math.max(highest, Number(item.code.slice(1)) || 0), 0);
    const facts: AppointmentFacts[] = [];
    const issuedNow: IssuedAppointment[] = [];
    for (const [index, row] of rows.entries()) {
      facts.push(await this.factsOf(trx, row.id));
      const code = earlier.find((item) => item.appointmentId === row.id)?.code ?? `M${(next += 1)}`;
      issuedNow.push({ code, appointmentId: row.id, label: `${oneLine(facts[index]!.typeName)} with ${oneLine(facts[index]!.providerName)} on ${formatWhen(facts[index]!.startsAt, timeZone, format)}` });
    }
    this.say(runtime, listSentence(facts, timeZone, format));
    return {
      status: 'ok',
      result: {
        count: rows.length,
        appointments: facts.map((fact, index) => ({ code: issuedNow[index]!.code, visit: oneLine(fact.typeName), provider: oneLine(fact.providerName), when: formatWhen(fact.startsAt, timeZone, format) })),
        note: 'The system will read the list to the caller. Do not repeat it. Use the codes if the caller wants to cancel or move one.',
      },
      stored: { appointments: issuedNow },
    };
  }

  /** The appointment a code stands for, if it is one of the verified caller's own (anything else looks like "not found"). */
  private async ownAppointment(trx: Trx, runtime: ToolRuntime, patientId: string, code: string | undefined) {
    const issued = code === undefined ? undefined : (await this.issued<IssuedAppointment>(trx, runtime.conversationId, APPOINTMENT_SOURCES, 'appointments')).find((candidate) => candidate.code.toLowerCase() === code.toLowerCase());
    if (!issued) return null;
    const row = await trx.selectFrom('appointments').select(['id', 'patient_id', 'appointment_type_id']).where('id', '=', issued.appointmentId).executeTakeFirst();
    return row && row.patient_id === patientId ? row : null;
  }

  private async cancel(trx: Trx, runtime: ToolRuntime, args: Record<string, unknown>, format: TimeFormat): Promise<ToolResult> {
    const who = await this.requireVerified(trx, runtime);
    if ('status' in who) return who;
    const own = await this.ownAppointment(trx, runtime, who.patientId, argText(args, 'appointmentCode'));
    if (!own) {
      return rejected({ error: 'That is not one of the caller\'s appointments listed in this conversation. Use list_my_appointments first.' });
    }
    const facts = await this.factsOf(trx, own.id);
    const outcome = await this.attempt(trx, () =>
      this.appointments.cancelInTransaction(trx, runtime.practiceId, { kind: 'ai' }, own.id, 'Cancelled by the caller through the AI receptionist', runtime.meta, 'caller'),
    );
    if (!outcome.ok) return this.refusal(outcome.error, 'cancelled');
    this.say(runtime, cancelledSentence(facts, runtime.context.practice.timezone, format));
    return { status: 'ok', result: { cancelled: true, note: 'The system will tell the caller. Do not say anything about the cancellation yourself.' } };
  }

  private async reschedule(trx: Trx, runtime: ToolRuntime, args: Record<string, unknown>, format: TimeFormat): Promise<ToolResult> {
    const who = await this.requireVerified(trx, runtime);
    if ('status' in who) return who;
    const own = await this.ownAppointment(trx, runtime, who.patientId, argText(args, 'appointmentCode'));
    if (!own) {
      return rejected({ error: 'That is not one of the caller\'s appointments listed in this conversation. Use list_my_appointments first.' });
    }
    const code = argText(args, 'slotCode');
    const slot = code === undefined ? undefined : (await this.issued<IssuedSlot>(trx, runtime.conversationId, SLOT_SOURCES, 'slots')).find((candidate) => candidate.code.toLowerCase() === code.toLowerCase());
    if (!slot) {
      return rejected({ error: 'That is not one of the times offered in this conversation. Use find_available_slots for the same kind of visit and offer one of those.' });
    }
    if (slot.appointmentTypeId !== own.appointment_type_id) {
      return rejected({ error: 'That time is for a different kind of visit. Search again for the same kind of visit as the appointment being moved.' });
    }
    const outcome = await this.attempt(trx, () =>
      this.appointments.rescheduleInTransaction(
        trx,
        runtime.practiceId,
        { kind: 'ai' },
        own.id,
        { startsAt: new Date(slot.startsAt), providerId: slot.providerId, idempotencyKey: idempotencyKey(runtime.conversationId, 'move', own.id, slot.code), conversationId: runtime.conversationId },
        runtime.meta,
        'caller',
      ),
    );
    if (!outcome.ok) return this.refusal(outcome.error, 'moved');
    this.say(runtime, movedSentence(await this.factsOf(trx, outcome.value.appointmentId), runtime.context.practice.timezone, format));
    return { status: 'ok', result: { moved: true, note: 'The system will tell the caller. Do not say anything about the change yourself.' } };
  }

  // ---------------------------------------------------------------- helpers

  /** The backend's own words for this turn. The same sentence twice (a repeated tool call) is said once. */
  private say(runtime: ToolRuntime, sentence: string): void {
    if (!runtime.state.lines.includes(sentence)) runtime.state.lines.push(sentence);
  }

  /**
   * What the conversation has already settled, in the system's own words, for the model's instructions: whether the
   * caller is identified, and what each code issued so far stands for. Without it the model could not know on a later
   * turn what "S2" was. Written by the backend, so nothing a caller says can appear in it.
   */
  async notes(trx: Trx, conversationId: string): Promise<string> {
    const row = await trx.selectFrom('conversations').select(['verified_patient_id', 'identity_failures']).where('id', '=', conversationId).executeTakeFirst();
    const identified = row?.verified_patient_id ? 'yes' : (row?.identity_failures ?? 0) >= MAX_IDENTITY_FAILURES ? 'no, and identification is locked: do not try again, offer to take a message' : 'no';
    const slots = (await this.issued<IssuedSlot>(trx, conversationId, SLOT_SOURCES, 'slots')).slice(-10);
    const listed = (await this.issued<IssuedAppointment>(trx, conversationId, APPOINTMENT_SOURCES, 'appointments')).slice(-10);
    const lines = [`Booking state of this conversation (written by the system, trusted):`, `- Caller identified: ${identified}`];
    if (slots.length > 0) lines.push(`- Times already offered (use these codes with the tools): ${slots.map((slot) => `${slot.code} = ${slot.label}`).join('; ')}`);
    if (listed.length > 0) lines.push(`- The caller's appointments already listed (use these codes): ${listed.map((item) => `${item.code} = ${item.label}`).join('; ')}`);
    return lines.join('\n');
  }

  /**
   * A refusal when the phone number the model passed is not one the caller said anywhere in this conversation
   * (models drop or repeat digits when copying numbers); null when it was said.
   */
  private async phoneNotSaid(trx: Trx, runtime: ToolRuntime, phone: string): Promise<ToolResult | null> {
    const said = await trx.selectFrom('conversation_turns').select('text').where('conversation_id', '=', runtime.conversationId).where('speaker', '=', 'caller').execute();
    if (phoneWasSaid(phone, said.map((turn) => turn.text).join(' '))) return null;
    return rejected({
      error: `The phone number ${phone} is not what the caller said. Copy the caller's phone number exactly, digit by digit, with the country code, or ask them to say it again.`,
    });
  }

  private details(args: Record<string, unknown>): { dto: CreatePatientDto } | { problems: string[] } {
    const dto = plainToInstance(CreatePatientDto, {
      firstName: argText(args, 'firstName'),
      lastName: argText(args, 'lastName'),
      dateOfBirth: argText(args, 'dateOfBirth'),
      phone: normalizePhone(argText(args, 'phone') ?? ''),
    });
    const problems = validateSync(dto, { whitelist: true, forbidUnknownValues: true });
    return problems.length > 0 ? { problems: problems.flatMap((problem) => Object.values(problem.constraints ?? {})) } : { dto };
  }

  /**
   * Runs a change that may be refused and undoes all of it (and nothing else) if it is. A database refusal
   * (two bookings for one time at the same instant) would otherwise cancel the whole tool transaction.
   */
  private async attempt<T>(trx: Trx, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    await sql`savepoint scheduling_step`.execute(trx);
    try {
      const value = await work();
      await sql`release savepoint scheduling_step`.execute(trx);
      return { ok: true, value };
    } catch (error) {
      await sql`rollback to savepoint scheduling_step`.execute(trx);
      return { ok: false, error };
    }
  }

  /**
   * What the model is told when a change is refused. Reasons that would reveal something about another
   * patient (for instance that the patient already has a visit at that time) are all the same words.
   */
  private refusal(error: unknown, action: 'booked' | 'cancelled' | 'moved'): ToolResult {
    if (error instanceof CancellationWindowError) {
      return rejected({
        reason: 'inside_cancellation_window',
        error: `Appointments cannot be cancelled or moved within ${error.minHours} hours of the visit. Tell the caller that, and offer to take a message so the team can help, using create_staff_task.`,
      });
    }
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
    if (error instanceof ConflictException || code === '23P01') {
      return rejected({ reason: 'not_available', error: 'That time is no longer available, or that change cannot be made. Nothing was changed. Offer the caller other times with find_available_slots, or offer to take a message.' });
    }
    if (error instanceof NotFoundException || error instanceof BadRequestException || error instanceof HttpException) {
      return rejected({ reason: 'not_possible', error: `That could not be ${action}. Nothing was changed. Offer to take a message for the team.` });
    }
    throw error;
  }

  private async factsOf(trx: Trx, appointmentId: string): Promise<AppointmentFacts> {
    const appointment = await this.appointments.load(trx, appointmentId);
    return { typeName: appointment.appointmentTypeName, providerName: appointment.providerName, startsAt: new Date(appointment.startsAt) };
  }

  /** Everything of one kind that this conversation's earlier tool results issued, oldest first. */
  private async issued<T>(trx: Trx, conversationId: string, tools: readonly string[], key: string): Promise<T[]> {
    const rows = await trx
      .selectFrom('tool_invocations')
      .select('result')
      .where('conversation_id', '=', conversationId)
      .where('tool_name', 'in', [...tools])
      .where('status', '=', 'ok')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.flatMap((row) => {
      const list = (row.result as Record<string, unknown> | null)?.[key];
      return Array.isArray(list) ? (list as T[]) : [];
    });
  }
}
