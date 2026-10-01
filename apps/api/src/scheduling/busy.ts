import type { Kysely } from 'kysely';
import type { Database } from '../database/database.types.js';
import type { Interval } from './availability.js';

/** The times already taken, per provider: every appointment that has not been cancelled and overlaps the window. */
export async function loadBusy(db: Kysely<Database>, providerIds: readonly string[], from: Date, to: Date): Promise<Map<string, Interval[]>> {
  const busy = new Map<string, Interval[]>();
  if (providerIds.length === 0) return busy;
  const rows = await db
    .selectFrom('appointments')
    .select(['provider_id', 'starts_at', 'ends_at'])
    .where('provider_id', 'in', [...providerIds])
    .where('status', '<>', 'cancelled')
    .where('starts_at', '<', to)
    .where('ends_at', '>', from)
    .execute();
  for (const row of rows) {
    const list = busy.get(row.provider_id) ?? [];
    list.push({ startsAt: row.starts_at, endsAt: row.ends_at });
    busy.set(row.provider_id, list);
  }
  return busy;
}
