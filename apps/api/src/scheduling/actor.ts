/** Who is making a change: a signed-in member of staff, or the AI receptionist (which never has a user). */
export type SchedulingActor = { kind: 'user'; userId: string } | { kind: 'ai' };

/** The actor as the audit log wants it. */
export function auditActor(actor: SchedulingActor): { actorUserId: string | null; actorType: 'user' | 'ai' } {
  return actor.kind === 'user' ? { actorUserId: actor.userId, actorType: 'user' } : { actorUserId: null, actorType: 'ai' };
}
