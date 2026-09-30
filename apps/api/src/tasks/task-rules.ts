import { TASK_TRANSITIONS, type TaskStatus } from '@frontdesk/shared';

export type TransitionVerdict = { ok: true } | { ok: false; message: string };

/**
 * May a task move from one status to another? Moving to the status it already
 * has is not a move (and is always fine). A finished task can only be reopened.
 */
export function checkTransition(from: TaskStatus, to: TaskStatus): TransitionVerdict {
  if (from === to || TASK_TRANSITIONS[from].includes(to)) {
    return { ok: true };
  }
  const closed = from === 'done' || from === 'cancelled';
  return {
    ok: false,
    message: closed ? `A ${from} task can only be reopened` : `A task cannot move from ${from} to ${to}`,
  };
}

/** A finished task must be reopened before anything else about it changes. */
export function editBlockedByStatus(status: TaskStatus, changingFields: readonly string[]): string | null {
  const closed = status === 'done' || status === 'cancelled';
  return closed && changingFields.length > 0 ? 'Reopen the task before editing it' : null;
}
