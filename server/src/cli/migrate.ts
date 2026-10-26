import { loadConfig, prepareFilesystem } from '../config.js';
import { migrate } from '../migrate.js';

const config = loadConfig();
prepareFilesystem(config);

const result = migrate({
  databasePath: config.databasePath,
  migrationsDir: config.migrationsDir,
});

console.log(`Applied ${result.applied.length} migration(s).`);
if (result.applied.length > 0) {
  console.log(result.applied.join('\n'));
}
if (result.backupPath) {
  console.log(`Pre-migration backup: ${result.backupPath}`);
}
