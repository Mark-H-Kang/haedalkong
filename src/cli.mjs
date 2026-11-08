import { createReadStream, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './events.mjs';
import { Store } from './store.mjs';
import { dispatch, ingest, stopped, writerClient } from './runtime.mjs';

const root = realpathSync(dirname(fileURLToPath(new URL('../package.json', import.meta.url))));
const [command, ...args] = process.argv.slice(2);
const live = args[0] === '--live';
if (live) args.shift();

async function run() {
  const valid = live
    ? { ingest: 1, backfill: 1, status: 0, dispatch: 0, resume: 0, resolve: 2, migrate: 0 }
    : { replay: 1, backfill: 1, status: 0, resume: 0, migrate: 0 };
  if (!Object.hasOwn(valid, command) || args.length !== valid[command]) throw Error('invalid-command');
  const config = loadConfig(readFileSync(join(root, 'config.local.json'), 'utf8'));
  if (live && !config.liveEnabled && command !== 'migrate') throw Error('live-disabled');
  const dir = join(root, 'var');
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) throw Error('unsafe-data-directory');
  const isStopped = () => live && stopped(join(dir, 'STOP'));
  if (['backfill', 'resolve', 'resume', 'migrate'].includes(command) && live && !isStopped()) throw Error('stop-required');
  if (['ingest', 'dispatch'].includes(command) && isStopped()) throw Error('stop-active');
  const store = new Store(join(dir, live ? 'live.sqlite' : 'replay.sqlite'), config.rooms,
    { live, migrate: command === 'migrate' });
  try {
    switch (command) {
      case 'replay':
      case 'ingest':
      case 'backfill': {
        if (command !== 'backfill' && (store.halted || store.unresolved().length)) throw Error('store-halted');
        const input = args[0] === '-' ? process.stdin : createReadStream(args[0]);
        return await ingest(store, input, { backfill: command === 'backfill',
          isStopped: live && command === 'backfill' ? () => !isStopped() : isStopped });
      }
      case 'dispatch':
        return await dispatch(store, writerClient(process.env.OPENCHAT_WRITER_URL, process.env.OPENCHAT_WRITER_TOKEN),
          isStopped);
      case 'resolve':
        store.resolve(...args);
        return { resolved: true };
      case 'resume':
        store.resume();
        return { resumed: true };
      case 'status':
        return store.status();
      case 'migrate':
        return { migrated: Boolean(store.migrationBackup), backup: store.migrationBackup ?? null };
    }
  } finally {
    store.close();
  }
}

try {
  console.log(JSON.stringify(await run(), null, 2));
} catch (error) {
  // Parser, file, and network exceptions can contain input data. Print controlled error codes only.
  const code = /^[a-z]+(?:-[a-z]+)+$/.test(error.message) ? error.message : 'operation-failed';
  console.error(code);
  process.exitCode = 1;
}
