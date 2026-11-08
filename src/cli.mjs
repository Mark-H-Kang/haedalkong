import { createReadStream, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './events.mjs';
import { Store } from './store.mjs';
import { dispatch, ingest, stopped, writerClient } from './runtime.mjs';
import { Gateway, gatewayServer, irisSender, secret } from './gateway.mjs';
import { Relay, runRelay } from './relay.mjs';

const root = realpathSync(dirname(fileURLToPath(new URL('../package.json', import.meta.url))));
const [command, ...args] = process.argv.slice(2);
const live = args[0] === '--live';
if (live) args.shift();

async function run() {
  const valid = live
    ? { ingest: 1, backfill: 1, status: 0, dispatch: 0, resume: 0, resolve: 2, migrate: 0, relay: 0, gateway: 0 }
    : { replay: 1, backfill: 1, status: 0, resume: 0, migrate: 0, observe: 0, 'observe-status': 0, 'gateway-probe': 0 };
  if (!Object.hasOwn(valid, command) || args.length !== valid[command]) throw Error('invalid-command');
  const configPath = join(root, 'config.local.json');
  const config = loadConfig(readFileSync(configPath, 'utf8'));
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
  if (['gateway', 'relay', 'observe', 'observe-status', 'gateway-probe'].includes(command)) {
    const observing = command.startsWith('observe');
    const probing = command === 'gateway-probe';
    const mainStop = process.env.CHILGAP_GLOBAL_STOP ?? '';
    if (basename(mainStop) !== 'STOP' || realpathSync(dirname(mainStop)) !== dirname(mainStop)) {
      throw Error('global-stop-path-required');
    }
    const permit = join(dirname(mainStop), 'send-permit.json');
    const mainPidFile = join(dirname(mainStop), 'runner.pid');
    const main = JSON.parse(readFileSync(process.env.CHILGAP_MAIN_BINDING, 'utf8'));
    const permitted = () => {
      try {
        const current = loadConfig(readFileSync(configPath, 'utf8'));
        const mainPermit = JSON.parse(readFileSync(permit, 'utf8'));
        const mainPid = Number(readFileSync(mainPidFile, 'utf8').trim());
        if (!Number.isSafeInteger(mainPid) || mainPid < 1 || mainPid === process.pid) return false;
        process.kill(mainPid, 0);
        return !stopped(join(dir, 'STOP')) && !stopped(mainStop) && current.liveEnabled === !(observing || probing) &&
          current.rooms.size === 1 &&
          current.rooms.size === config.rooms.size && [...config.rooms].every(([room, binding]) =>
            current.rooms.get(room)?.profileRef === binding.profileRef &&
            current.rooms.get(room)?.verificationRef === binding.verificationRef) &&
          mainPermit.enabled === true && mainPermit.roomFingerprint === main.fingerprint;
      } catch { return false; }
    };
    if (config.rooms.size !== 1 || config.rooms.has(main.roomId) || !permitted()) throw Error('service-scope-unverified');
    if ((observing || probing) && ![...config.rooms.values()].every(({ profileRef, verificationRef }) =>
      [profileRef, verificationRef].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)))) {
      throw Error('unverified-observation-room');
    }
    const controller = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
    const irisPort = Number(process.env.HAEDALKONG_IRIS_PORT ?? 3000);
    if (command === 'relay' || observing) {
      const send = observing ? undefined : writerClient(process.env.OPENCHAT_WRITER_URL, process.env.OPENCHAT_WRITER_TOKEN);
      const store = new Store(join(dir, observing ? 'observe.sqlite' : 'live.sqlite'), config.rooms, { live });
      try {
        const relay = new Relay(store);
        if (command === 'observe-status') return { anchored: Boolean(relay.cursor()), ...store.status() };
        await runRelay(relay, irisPort, () => dispatch(store, send,
          () => !permitted() || controller.signal.aborted), permitted, controller.signal, { notify: !observing });
      } finally { store.close(); }
      return;
    }
    const port = Number(process.env.HAEDALKONG_GATEWAY_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === irisPort) throw Error('invalid-gateway-port');
    const irisToken = secret(process.env.HAEDALKONG_IRIS_TOKEN);
    const probe = probing ? { key: process.env.HAEDALKONG_PROBE_KEY, text: process.env.HAEDALKONG_PROBE_TEXT } : undefined;
    if (probe && (!probe.key || !probe.text)) throw Error('probe-binding-required');
    let ready = false;
    const gateway = new Gateway(join(dir, probing ? 'probe-writer.sqlite' : 'writer.sqlite'), {
      mainRoom: main.roomId, rooms: config.rooms, token: process.env.OPENCHAT_WRITER_TOKEN, irisToken,
      permitted: () => ready && permitted(), send: irisSender(irisPort, irisToken), probe,
      onProgress: event => console.log(JSON.stringify(event)),
    });
    const server = gatewayServer(gateway);
    try {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      gateway.db.exec(`UPDATE outbox SET state='discarded' WHERE state='pending';
        UPDATE outbox SET state='uncertain' WHERE state IN ('sending','authorized');`);
      ready = true;
      while (!controller.signal.aborted) {
        await gateway.sendNext();
        await delay(250);
      }
    } finally {
      ready = false;
      if (server.listening) await new Promise(resolve => server.close(resolve));
      gateway.db.close();
    }
    return;
  }
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
