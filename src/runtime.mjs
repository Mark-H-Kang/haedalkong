import { lstatSync } from 'node:fs';
import { mapFrame, maxFrameBytes } from './events.mjs';

export function stopped(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

async function* lines(stream) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let remainder = Buffer.alloc(0);
  for await (const chunk of stream) {
    const data = Buffer.concat([remainder, chunk]);
    let start = 0;
    for (let end; (end = data.indexOf(10, start)) !== -1; start = end + 1) {
      if (end - start > maxFrameBytes) throw Error('frame-too-large');
      yield decoder.decode(data.subarray(start, end));
    }
    remainder = data.subarray(start);
    if (remainder.length > maxFrameBytes) throw Error('frame-too-large');
  }
  if (remainder.length) yield decoder.decode(remainder);
}

export async function ingest(store, stream, { backfill = false, isStopped = () => false } = {}) {
  const counts = { applied: 0, duplicate: 0, ignored: 0 };
  try {
    for await (const line of lines(stream)) {
      if (isStopped()) return { ...counts, stopped: true };
      if (!line.trim()) continue;
      const result = store.apply(mapFrame(line, store.rooms), { backfill });
      counts[result]++;
    }
  } catch (error) {
    store.halt();
    throw error;
  }
  return counts;
}

// Dedicated contract for a future approved writer intake. There is no direct Iris send.
export function writerClient(address, token, request = fetch) {
  const url = new URL(address);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash ||
      typeof token !== 'string' || !/^[!-~]{32,512}$/.test(token)) throw Error('invalid-writer-config');
  return async payload => {
    const response = await request(new URL('/v1/haedalkong/enqueue', url), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status !== 202 || !response.body) {
      await response.body?.cancel();
      throw Error('writer-unconfirmed');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 4096) throw Error('writer-receipt-too-large');
      chunks.push(chunk);
    }
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (reply?.status !== 'accepted' || reply.key !== payload.key || reply.roomId !== payload.roomId ||
        reply.profileRef !== payload.profileRef || typeof reply.receipt !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(reply.receipt)) throw Error('writer-unconfirmed');
    return reply.receipt;
  };
}

export async function dispatch(store, send, isStopped, clock = () => Math.floor(Date.now() / 1000)) {
  let accepted = 0;
  while (!isStopped()) {
    const row = store.claim(clock());
    if (!row) break;
    if (isStopped() || store.halted) {
      store.finish(row.key, 'pending');
      break;
    }
    const { profileRef, verificationRef } = store.rooms.get(row.room);
    let receipt;
    try {
      receipt = await send({
        key: row.key, roomId: row.room, profileRef, verificationRef,
        text: row.body, expiresAt: row.expires,
      });
    } catch {
      store.finish(row.key, 'uncertain');
      throw Error('writer-unconfirmed');
    }
    store.finish(row.key, 'accepted', receipt);
    accepted++;
  }
  return { accepted };
}
