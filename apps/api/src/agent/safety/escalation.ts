import type { AiConfiguration, TransferTarget, UrgentAction } from '@frontdesk/shared';
import type { UrgencyClassification } from './classifier.js';

/** Fixed wording. Only the emergency message is the practice's own; it is added, never replaced. */
export const URGENT_REPLY_TRANSFER = 'I am connecting you with a member of our team now.';
export const URGENT_REPLY_TASK = 'I have passed this to our team as urgent, and someone will contact you as soon as possible.';
export const URGENT_REPLY_BOTH = 'I am connecting you with a member of our team now, and I have flagged this to them as urgent.';
export const EMERGENCY_REPLY_ALERT = 'I have also alerted our team.';
export const SAFETY_NET = 'If you feel this could be an emergency, please follow this:';
/**
 * Added after an emergency or urgent reply when the call is NOT handed to a person.
 * The caller is not dropped: the receptionist stays on to take a callback request
 * (and nothing else), so "I have chest pain and I need an appointment" still ends
 * with a staff task that carries the appointment request.
 */
export const CALLBACK_OFFER = 'If you would like our team to call you back, tell me your name and phone number.';

/** Does an escalation at `next` need a new staff task, given what this conversation already raised? */
export function needsNewTask(alreadyRaised: 'urgent' | 'emergency' | null, next: 'urgent' | 'emergency'): boolean {
  return alreadyRaised === null || (alreadyRaised === 'urgent' && next === 'emergency');
}

/** The more serious of two escalation levels (a conversation's level only ever goes up). */
export function higherEscalation(a: 'urgent' | 'emergency' | null, b: 'urgent' | 'emergency'): 'urgent' | 'emergency' {
  return a === 'emergency' || b === 'emergency' ? 'emergency' : 'urgent';
}

export type EscalationPlan =
  | { kind: 'none' }
  | {
      kind: 'emergency' | 'urgent';
      /** Exactly what the caller is told. Fixed text plus the practice's own messages: never model output. */
      reply: string;
      /** The practice's own message(s) inside `reply` (emergency and/or crisis), for repeating after a later reply. */
      notice: string;
      /** Make an urgent task for staff. */
      createTask: boolean;
      /** Hand the conversation to this number (null: no number to hand over to). */
      transferTargetId: string | null;
      /** Why (the matched phrases), for the record. */
      matches: string[];
    };

export interface EscalationContext {
  config: Pick<AiConfiguration, 'emergencyMessage' | 'crisisMessage' | 'urgentAction' | 'urgentTransferTargetId' | 'afterHoursAction' | 'afterHoursTransferTargetId'>;
  targets: ReadonlyArray<Pick<TransferTarget, 'id' | 'active'>>;
  /** Is the practice open right now (on its own clock)? */
  isOpen: boolean;
}

/**
 * Turns a classification into a concrete plan, using only fixed wording and
 * the practice's settings. The model has no say in it.
 *
 *  - Emergency: the caller hears the practice's emergency message (911 for a
 *    medical emergency), or its crisis message (988 for suicide or self-harm),
 *    or both when the call has both; staff are alerted with an urgent task, and
 *    the call is handed to the urgent number when there is one.
 *  - Urgent: the practice's "urgent" setting decides (hand over, task, or both);
 *    the emergency message is added as a safety net.
 */
export function planEscalation(classification: UrgencyClassification, context: EscalationContext): EscalationPlan {
  if (classification.level === 'none') {
    return { kind: 'none' };
  }

  const target = chooseTransferTarget(context);
  const emergencyMessage = context.config.emergencyMessage.trim();

  if (classification.level === 'emergency') {
    const notice = emergencyNotice(classification, emergencyMessage, context.config.crisisMessage.trim());
    return {
      kind: 'emergency',
      reply: [notice, EMERGENCY_REPLY_ALERT].filter(Boolean).join(' '),
      notice,
      createTask: true,
      transferTargetId: target,
      matches: classification.matches,
    };
  }

  const action: UrgentAction = context.config.urgentAction;
  const transfer = action !== 'urgent_task' && target !== null;
  // Asked to transfer but nowhere to send the call: an urgent task must still be made.
  const createTask = action !== 'transfer' || !transfer;
  const base = transfer && createTask ? URGENT_REPLY_BOTH : transfer ? URGENT_REPLY_TRANSFER : URGENT_REPLY_TASK;
  return {
    kind: 'urgent',
    reply: [base, emergencyMessage ? `${SAFETY_NET} ${emergencyMessage}` : ''].filter(Boolean).join(' '),
    notice: emergencyMessage,
    createTask,
    transferTargetId: transfer ? target : null,
    matches: classification.matches,
  };
}

/**
 * Which of the practice's own messages an emergency call hears. Suicide and
 * self-harm get the crisis message; a medical or safety threat gets the
 * emergency message; both together get both. A crisis call never hears nothing:
 * if the crisis message is somehow empty, the emergency message is used instead.
 */
function emergencyNotice(classification: UrgencyClassification, emergencyMessage: string, crisisMessage: string): string {
  if (!classification.crisis) {
    return emergencyMessage;
  }
  const crisis = crisisMessage || emergencyMessage;
  if (!classification.medical || crisis === emergencyMessage) {
    return crisis;
  }
  return [emergencyMessage, crisis].filter(Boolean).join(' ');
}

/** Out of hours the after-hours number is preferred (when calls are transferred then); otherwise the urgent number. */
export function chooseTransferTarget({ config, targets, isOpen }: EscalationContext): string | null {
  const active = (id: string | null): string | null => (id !== null && targets.some((target) => target.id === id && target.active) ? id : null);
  if (!isOpen && config.afterHoursAction === 'transfer') {
    return active(config.afterHoursTransferTargetId) ?? active(config.urgentTransferTargetId);
  }
  return active(config.urgentTransferTargetId);
}
