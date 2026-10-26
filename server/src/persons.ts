import { eq } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { persons } from './schema.js';
import { isUniqueConstraint } from './sql-errors.js';

export function upsertPerson(db: AppDatabase, name: string, now: string): number {
  const existing = db.select({ id: persons.id }).from(persons).where(eq(persons.name, name)).get();
  if (existing) return existing.id;
  try {
    const inserted = db
      .insert(persons)
      .values({ name, sortName: name, createdAt: now })
      .returning({ id: persons.id })
      .get();
    if (!inserted) throw new Error('person insert failed');
    return inserted.id;
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    const again = db.select({ id: persons.id }).from(persons).where(eq(persons.name, name)).get();
    if (!again) throw error;
    return again.id;
  }
}
