import { buildApp } from './app.js';
import { loadConfig, prepareFilesystem } from './config.js';
import { migrate } from './migrate.js';

const config = loadConfig();
prepareFilesystem(config);

const migration = migrate({
  databasePath: config.databasePath,
  migrationsDir: config.migrationsDir,
});

// Scanned PDFs are recognized automatically unless QIJUAN_OCR_AUTO=0.
const app = await buildApp({ config, ocr: { auto: process.env.QIJUAN_OCR_AUTO?.trim() !== '0' } });

if (migration.backupPath) {
  app.log.info({ backupPath: migration.backupPath }, 'wrote pre-migration backup');
}
if (migration.applied.length > 0) {
  app.log.info({ applied: migration.applied }, 'applied migrations');
}

const close = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => {
  void close('SIGINT');
});
process.once('SIGTERM', () => {
  void close('SIGTERM');
});

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info({ port: config.port }, 'qijuan listening');
