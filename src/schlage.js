// -----------------------------------------------------------------------------
// The locks of a Schlage API answer, read defensively (pure). Ported from
// pyschlage.lock.Lock.from_json (Apache-2.0): the state is under
// `attributes` (`lockState`, `batteryLevel`, `doorState`,
// `lockAndLeaveEnabled`, `lockStateMetadata`), the user's name of the lock and
// `connected` at the top level, and `users[]` names the mobile users.
// Never kept: the CAT/SAT tokens, the MAC address, the e-mails of the users.
// -----------------------------------------------------------------------------

import {
  DOOR_STATE,
  JAMMED_STATES,
  LIMITS,
  LOCKED_STATES,
  METHODS,
  NO_LOCK_AND_LEAVE_PREFIXES,
  UNLOCKED_STATES,
  WIFI_PREFIXES,
} from './constants.js';

/** An integer field (a number or a numeric string), else undefined. */
const intOf = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }
  const n = Number(value);
  return value !== '' && Number.isInteger(n) ? n : undefined;
};

/** A name: control characters turned into spaces, trimmed, bounded. */
const textOf = (value, max = LIMITS.nameLength) =>
  typeof value === 'string'
    ? [...value]
        .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
        .join('')
        .trim()
        .slice(0, max)
    : '';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The id of a device: the `deviceId` Schlage gives it (stable for the account). */
export const idOf = (raw) =>
  typeof raw?.deviceId === 'string' && ID.test(raw.deviceId) ? raw.deviceId : undefined;

const startsWithAny = (type, prefixes) => prefixes.some((p) => type.startsWith(p));

/** The actor of the last change, from `lockStateMetadata` and the users of the lock. */
function actorOf(metadata, users) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { method: undefined, by: undefined };
  }
  const type = typeof metadata.actionType === 'string' ? metadata.actionType : '';
  const method = Object.hasOwn(METHODS, type) ? METHODS[type] : 'other';
  let by;
  if (method === 'keypad') {
    // The name the user gave the access code (never the code itself).
    by = textOf(metadata.name) || undefined;
  } else if (method === 'app' || method === 'apple_home') {
    const uuid = typeof metadata.UUID === 'string' ? metadata.UUID : undefined;
    by = (uuid && users.get(uuid)) || undefined;
  }
  return { method, by };
}

/**
 * One lock of `GET devices?archetype=lock` (or `GET devices/{id}`, or the
 * answer of `PUT devices/{id}`), or undefined when it is not usable.
 */
export function parseLock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const id = idOf(raw);
  if (!id) {
    return undefined;
  }
  const attributes =
    raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)
      ? raw.attributes
      : {};
  const type =
    typeof raw.devicetypeId === 'string' ? raw.devicetypeId.toLowerCase().slice(0, 20) : '';
  const users = new Map();
  for (const user of Array.isArray(raw.users) ? raw.users.slice(0, 50) : []) {
    // The friendly name only: the e-mail of a user never leaves this function.
    const name = textOf(user?.friendlyName, 40);
    if (typeof user?.identityId === 'string' && name) {
      users.set(user.identityId, name);
    }
  }
  const lockState = intOf(attributes.lockState);
  const battery = intOf(attributes.batteryLevel);
  const door = intOf(attributes.doorState);
  const lockAndLeave = intOf(attributes.lockAndLeaveEnabled);
  const { method, by } = actorOf(attributes.lockStateMetadata, users);
  return {
    id,
    name: textOf(raw.name),
    model: textOf(raw.modelName ?? attributes.modelName, 40) || undefined,
    type,
    connected: raw.connected === true || raw.connected === 1,
    lockState,
    battery: battery !== undefined && battery >= 0 && battery <= 100 ? battery : undefined,
    door: Object.values(DOOR_STATE).includes(door) ? door : undefined,
    lockAndLeave:
      lockAndLeave === undefined || startsWithAny(type, NO_LOCK_AND_LEAVE_PREFIXES)
        ? undefined
        : lockAndLeave === 1,
    method,
    by,
  };
}

/** Every usable lock of a list answer, at most LIMITS.locks, ids unique. */
export function parseLocks(list) {
  const locks = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const lock = parseLock(raw);
    if (lock && !locks.has(lock.id) && locks.size < LIMITS.locks) {
      locks.set(lock.id, lock);
    }
  }
  return locks;
}

/** true locked, false unlocked, undefined otherwise (jammed, unknown, absent). */
export const lockedOf = (lock) =>
  LOCKED_STATES.includes(lock.lockState)
    ? true
    : UNLOCKED_STATES.includes(lock.lockState)
      ? false
      : undefined;

export const isJammed = (lock) => JAMMED_STATES.includes(lock.lockState);

/** A known, still position: a command may be sent from it. */
export const isStill = (lock) => lockedOf(lock) !== undefined;

/** A Wi-Fi family lock, commanded through `PUT devices/{id}` (pyschlage `_is_wifi_lock`). */
export const isWifiLock = (lock) => startsWithAny(lock.type, WIFI_PREFIXES);

/** The door position sensor reports something (the role is then created). */
export const hasDoorSensor = (lock) =>
  lock.door === DOOR_STATE.OPEN ||
  lock.door === DOOR_STATE.CLOSED ||
  lock.door === DOOR_STATE.FAULTY;

/** The key of the state word (src/i18n.js STATE_WORDS). */
export function stateKey(lock) {
  if (!lock.connected) {
    return 'offline';
  }
  if (isJammed(lock)) {
    return 'jammed';
  }
  const locked = lockedOf(lock);
  return locked === undefined ? 'unknown' : locked ? 'locked' : 'unlocked';
}
