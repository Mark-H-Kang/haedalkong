import { id } from './events.mjs';

export function selectRoomLane(config, requested) {
  const primary = config.primaryRoom ?? (config.rooms.size === 1 ? [...config.rooms.keys()][0] : undefined);
  if (!config.rooms.has(primary)) throw Error('primary-room-required');
  const room = requested === undefined ? primary : id(requested);
  if (!config.rooms.has(room)) throw Error('room-not-allowed');
  return { room, primary, rooms: new Map([[room, config.rooms.get(room)]]) };
}
