import { templates } from './membership.mjs';

const actions = new Map([
  ['NEWMEM', { kind: 'join', feed: '4' }],
  ['DELMEM', { kind: 'leave', feed: '2' }],
  ['KICKMEM', { kind: 'kick', feed: '6' }],
]);

export const maxFrameBytes = 1024 * 1024;
export function id(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) ||
      BigInt(value) > 9223372036854775807n) throw Error('invalid-id');
  return value;
}

function exact(text) {
  return JSON.parse(text, (_, value, context) =>
    typeof value === 'number' ? context.source : value);
}

function nickname(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 120 || !value.isWellFormed() ||
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u.test(value)) {
    throw Error('invalid-nickname');
  }
  return value;
}

export function mapFrame(text, rooms) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxFrameBytes) throw Error('invalid-frame');
  const frame = exact(text);
  const row = frame?.json;
  const room = id(row?.chat_id);
  if (!rooms.has(room)) return null;
  if (typeof row.v !== 'string') throw Error('invalid-origin');
  const action = actions.get(exact(row.v)?.origin);
  if (!action) return null;
  if (row.type !== '0' || typeof frame.msg !== 'string') throw Error('invalid-member-frame');
  const feed = exact(frame.msg);
  if (feed?.feedType !== action.feed) throw Error('invalid-feed-type');
  const subjects = action.kind === 'join' ? feed.members : [feed.member];
  if (!Array.isArray(subjects) || !subjects.length || subjects.length > 1000) throw Error('invalid-subjects');
  const members = subjects.map(subject => ({ id: id(subject?.userId), name: nickname(subject.nickName) }));
  if (new Set(members.map(member => member.id)).size !== members.length) throw Error('duplicate-subject');
  members.sort((a, b) => a.id.localeCompare(b.id));
  const seconds = Number(id(row.created_at));
  if (seconds > 253402300799) throw Error('invalid-source-time');
  return { room, event: id(row.id), sequence: id(row._id), kind: action.kind, seconds, members };
}

export function loadConfig(text) {
  const config = JSON.parse(text);
  if (typeof config?.liveEnabled !== 'boolean' || !config.rooms ||
      typeof config.rooms !== 'object' || Array.isArray(config.rooms)) throw Error('invalid-config');
  const rooms = new Map();
  for (const [room, options] of Object.entries(config.rooms)) {
    id(room);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('invalid-room');
    const custom = options.templates ?? {};
    if (typeof custom !== 'object' || Array.isArray(custom)) throw Error('invalid-template');
    for (const [kind, value] of Object.entries(custom)) {
      if ((kind !== 'kick' && !Object.hasOwn(templates, kind)) || typeof value !== 'string' || !value.trim() ||
          value.length > 400 || /[{}]/u.test(value.replaceAll('{name}', ''))) throw Error('invalid-template');
    }
    if (/강제\s*퇴장|강퇴/u.test(custom.leave ?? '')) throw Error('invalid-exit-template');
    const { profileRef, verificationRef } = options;
    if (config.liveEnabled && ![profileRef, verificationRef].every(value =>
      typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value))) throw Error('unverified-binding');
    rooms.set(room, { templates: { ...templates, ...custom }, profileRef, verificationRef });
  }
  if (!rooms.size) throw Error('empty-room-allowlist');
  return { liveEnabled: config.liveEnabled, rooms };
}
