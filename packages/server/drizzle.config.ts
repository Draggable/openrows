import { defineConfig } from 'drizzle-kit';

// Migrations are generated with `npm run db:generate` and applied with `npm run db:migrate`
// (src/migrate.ts). Never `drizzle-kit push`: production schema changes go through migrations.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Drizzle owns only the metadata schema. Per-base record schemas (b_*) are managed by the
  // DDL manager (ADR-001) and must never be diffed.
  schemaFilter: ['public'],
  dbCredentials: {
    url:
      process.env['DATABASE_URL'] ?? 'postgresql://openrows:openrows_dev@localhost:5432/openrows',
  },
  verbose: true,
  strict: true,
});
