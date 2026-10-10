import type { Kysely } from 'kysely';
import type { Database } from '../database/database.types.js';

/** Everything the caller has said in this conversation, in order. Run inside the practice's transaction. */
export async function callerWords(db: Kysely<Database>, conversationId: string): Promise<string> {
  const turns = await db
    .selectFrom('conversation_turns')
    .select('text')
    .where('conversation_id', '=', conversationId)
    .where('speaker', '=', 'caller')
    .orderBy('seq')
    .execute();
  return turns.map((turn) => turn.text).join(' ');
}
