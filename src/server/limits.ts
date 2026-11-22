import { and, count, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./db/client";

/**
 * Limits that hold when requests arrive together.
 *
 * Counting rows and then inserting one is not a limit: requests sent at the
 * same moment all count before any of them has written, and all pass. So a
 * limit is checked after the insert, by position. A row is within a limit of
 * N when it is one of the first N of its kind, in the order the database
 * stored them. Whoever comes later than that takes their row back out:
 *
 *   await db.insert(things).values(row);
 *   if ((await positionOf(db, things, row.id, ofThisWorkspace)) > limit) {
 *     await db.delete(things).where(eq(things.id, row.id));
 *     throw tooMany();
 *   }
 *
 * Counting first is still worth doing where the insert is expensive to get
 * to: it turns away the ordinary case early. This is what makes it exact.
 */
export async function positionOf(
  db: Db,
  table: SQLiteTable,
  id: string,
  among: SQL | undefined,
): Promise<number> {
  // SQLite numbers rows in the order they are inserted (`rowid`), so "at or
  // before this row" does not depend on clocks or on ids.
  const upToThisRow = sql`${table}.rowid <= (select rowid from ${table} where id = ${id})`;
  const [row] = await db.select({ n: count() }).from(table).where(and(among, upToThisRow));
  return row?.n ?? 0;
}
