import { TASK_STATUSES, type TaskStatus } from '@frontdesk/shared';
import { checkTransition, editBlockedByStatus } from './task-rules.js';

describe('checkTransition', () => {
  it.each<[TaskStatus, TaskStatus]>([
    ['open', 'in_progress'],
    ['open', 'done'],
    ['open', 'cancelled'],
    ['in_progress', 'open'],
    ['in_progress', 'done'],
    ['in_progress', 'cancelled'],
    ['done', 'open'],
    ['cancelled', 'open'],
  ])('allows %s -> %s', (from, to) => {
    expect(checkTransition(from, to)).toEqual({ ok: true });
  });

  it.each<[TaskStatus, TaskStatus]>([
    ['done', 'in_progress'],
    ['done', 'cancelled'],
    ['cancelled', 'done'],
    ['cancelled', 'in_progress'],
  ])('refuses %s -> %s: a finished task can only be reopened', (from, to) => {
    const verdict = checkTransition(from, to);
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok === false && verdict.message).toContain('reopened');
  });

  it('treats staying in the same status as fine (it is not a move)', () => {
    for (const status of TASK_STATUSES) {
      expect(checkTransition(status, status)).toEqual({ ok: true });
    }
  });

  it('decides every pairing', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(typeof checkTransition(from, to).ok).toBe('boolean');
      }
    }
  });
});

describe('editBlockedByStatus', () => {
  it.each<TaskStatus>(['done', 'cancelled'])('blocks any edit of a %s task', (status) => {
    expect(editBlockedByStatus(status, ['title'])).toBe('Reopen the task before editing it');
    expect(editBlockedByStatus(status, ['assignedTo'])).toBe('Reopen the task before editing it');
  });

  it.each<TaskStatus>(['done', 'cancelled'])('does not block reopening a %s task (no other fields change)', (status) => {
    expect(editBlockedByStatus(status, [])).toBeNull();
  });

  it.each<TaskStatus>(['open', 'in_progress'])('never blocks edits of a %s task', (status) => {
    expect(editBlockedByStatus(status, ['title', 'priority'])).toBeNull();
  });
});
