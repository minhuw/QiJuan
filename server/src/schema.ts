import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const schemaMigrations = sqliteTable('schema_migrations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  appliedAt: text('applied_at').notNull(),
});

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'reader'] }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const libraries = sqliteTable('libraries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  mode: text('mode', { enum: ['managed', 'indexed'] }).notNull(),
  rootPath: text('root_path').notNull(),
  createdAt: text('created_at').notNull(),
});

export const libraryGrants = sqliteTable(
  'library_grants',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.libraryId] })],
);

export const series = sqliteTable('series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  libraryId: integer('library_id')
    .notNull()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sortName: text('sort_name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const editions = sqliteTable('editions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  libraryId: integer('library_id')
    .notNull()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  language: text('language'),
  publisher: text('publisher'),
  publishedDate: text('published_date'),
  description: text('description'),
  seriesId: integer('series_id').references(() => series.id, { onDelete: 'set null' }),
  seriesOrder: real('series_order'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  trashedAt: text('trashed_at'),
});

export const alternateTitles = sqliteTable('alternate_titles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sortTitle: text('sort_title'),
});

export const persons = sqliteTable('persons', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  sortName: text('sort_name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const editionContributors = sqliteTable(
  'edition_contributors',
  {
    editionId: integer('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    personId: integer('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['author', 'translator'] }).notNull(),
    position: integer('position').notNull().default(0),
    displayName: text('display_name'),
  },
  (table) => [primaryKey({ columns: [table.editionId, table.personId, table.role] })],
);

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const identifiers = sqliteTable('identifiers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  scheme: text('scheme').notNull(),
  value: text('value').notNull(),
});

export const fileAssets = sqliteTable('file_assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  format: text('format', { enum: ['epub', 'pdf'] }).notNull(),
  sha256: text('sha256').notNull(),
  bytes: integer('bytes').notNull(),
  originalFilename: text('original_filename').notNull(),
  storage: text('storage', { enum: ['managed', 'indexed'] }).notNull(),
  relativePath: text('relative_path').notNull(),
  availability: text('availability', { enum: ['present', 'missing'] }).notNull().default('present'),
  trashedAt: text('trashed_at'),
  createdAt: text('created_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  libraryId: integer('library_id')
    .notNull()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  source: text('source', { enum: ['upload', 'folder', 'lookup', 'apply', 'refresh', 'rescan'] }).notNull(),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] }).notNull(),
  payload: text('payload'),
  result: text('result'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});

export const jobItems = sqliteTable('job_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  filename: text('filename').notNull(),
  sourcePath: text('source_path').notNull(),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'duplicate'] }).notNull(),
  error: text('error'),
  editionId: integer('edition_id').references(() => editions.id, { onDelete: 'set null' }),
  assetId: integer('asset_id').references(() => fileAssets.id, { onDelete: 'set null' }),
  sha256: text('sha256'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const covers = sqliteTable('covers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  sha256: text('sha256').notNull(),
  bytes: integer('bytes').notNull(),
  mediaType: text('media_type').notNull(),
  relativePath: text('relative_path').notNull(),
  createdAt: text('created_at').notNull(),
});

export const fieldLocks = sqliteTable(
  'field_locks',
  {
    editionId: integer('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    lockedAt: text('locked_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.editionId, table.field] })],
);

export const editionSuggestions = sqliteTable('edition_suggestions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  libraryId: integer('library_id')
    .notNull()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  matchedEditionId: integer('matched_edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  dismissedAt: text('dismissed_at'),
});

export const metadataPreviews = sqliteTable('metadata_previews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  proposal: text('proposal').notNull(),
  createdAt: text('created_at').notNull(),
});

export const shelves = sqliteTable('shelves', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const shelfItems = sqliteTable(
  'shelf_items',
  {
    shelfId: integer('shelf_id')
      .notNull()
      .references(() => shelves.id, { onDelete: 'cascade' }),
    editionId: integer('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    addedAt: text('added_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.shelfId, table.editionId] })],
);

export const favorites = sqliteTable(
  'favorites',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    editionId: integer('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.editionId] })],
);

export const readingQueues = sqliteTable(
  'reading_queues',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    editionId: integer('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    addedAt: text('added_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.editionId] })],
);

export const ratings = sqliteTable(
  'ratings',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    editionId: integer('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.editionId] })],
);

export const readingStatuses = sqliteTable(
  'reading_statuses',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    editionId: integer('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['want', 'reading', 'finished', 'on_hold'] }).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.editionId] })],
);

export const bookmarks = sqliteTable('bookmarks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').references(() => fileAssets.id, { onDelete: 'set null' }),
  locator: text('locator').notNull(),
  label: text('label'),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const highlights = sqliteTable('highlights', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').references(() => fileAssets.id, { onDelete: 'set null' }),
  locator: text('locator').notNull(),
  quote: text('quote'),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  editionId: integer('edition_id')
    .notNull()
    .references(() => editions.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').references(() => fileAssets.id, { onDelete: 'set null' }),
  locator: text('locator'),
  body: text('body').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const readingPositions = sqliteTable(
  'reading_positions',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    editionId: integer('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    assetId: integer('asset_id').references(() => fileAssets.id, { onDelete: 'set null' }),
    locator: text('locator').notNull(),
    revision: integer('revision').notNull().default(1),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.editionId] })],
);

export const opdsTokens = sqliteTable('opds_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
});

export const backupSettings = sqliteTable('backup_settings', {
  id: integer('id').primaryKey(),
  scheduleEnabled: integer('schedule_enabled').notNull(),
  intervalHours: integer('interval_hours').notNull(),
  nextRunAt: text('next_run_at'),
  retentionDaily: integer('retention_daily').notNull(),
  retentionWeekly: integer('retention_weekly').notNull(),
  retentionMonthly: integer('retention_monthly').notNull(),
  scope: text('scope', { enum: ['metadata-only', 'managed'] }).notNull(),
  indexedLibraryIds: text('indexed_library_ids').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const backupJobs = sqliteTable('backup_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['backup'] }).notNull(),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] }).notNull(),
  scope: text('scope').notNull(),
  phase: text('phase'),
  reason: text('reason'),
  snapshotId: text('snapshot_id'),
  detail: text('detail').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});
