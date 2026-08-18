/**
 * Your database tables live here.
 *
 * This is a Drizzle schema: each table is described once, in TypeScript, and
 * that description gives you both the SQL to create it and the types your
 * queries return. Change a column here and your editor tells you which queries
 * broke — that is the whole point of keeping it in one file.
 *
 * The `posts` table below is an example to start from. Rename it, change it, or
 * delete it once you have your own tables.
 *
 * After ANY change here, generate and apply a migration:
 *
 *   npm run db:generate     # writes the SQL into drizzle/
 *   npm run db:migrate      # applies it to your LOCAL database
 *
 * Commit the generated SQL. A schema nobody can reproduce is a schema that
 * breaks on the next machine.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const posts = pgTable(
  "posts",
  {
    // `text` ids from crypto.randomUUID() keep inserts simple and avoid
    // depending on the database to hand out numbers.
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    author: text("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Index anything you filter or sort by. Without this, finding one author's
  // posts means reading every row — fine with 10 rows, painful with 100,000.
  (t) => [index("posts_author_idx").on(t.author)],
);

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
