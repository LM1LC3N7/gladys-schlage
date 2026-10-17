// -----------------------------------------------------------------------------
// The Schlage locks -> Gladys devices, and their states (pure).
//
// One Gladys device per lock, `ext:<selector>:schlage:<deviceId>`, the
// deviceId being the one Schlage gives the lock (stable for the account).
// The features are keyed by their role (the last part of their external id):
// those keys are published forever, never rename them. A device already
// created keeps all its features when it is published again.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DOOR_STATE, GLADYS, LIMITS } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, METHOD_WORDS, STATE_WORDS, word } from './i18n.js';
import { hasDoorSensor, isJammed, lockedOf } from './schlage.js';

const binary = { min: 0, max: 1 };

/** The features, by role. */
export const FEATURES = {
  // Writable: 1 locks (always allowed), 0 unlocks (behind allow_unlock).
  lock: {
    category: C.LOCK,
    type: TYPES.LOCK.BINARY,
    ...binary,
    read_only: false,
    has_feedback: true,
  },
  // Read only LOCK.STATE: 0 unlocked, 1 locked, 2 a command in progress, 3 jammed.
  state: { category: C.LOCK, type: TYPES.LOCK.STATE, min: 0, max: 3 },
  // The jam alert: 1 jammed. A read-only state, never a switch.
  jammed: { category: C.UNKNOWN, type: TYPES.SENSOR.BINARY, ...binary },
  battery: { category: C.BATTERY, type: TYPES.BATTERY.INTEGER, unit: U.PERCENT, min: 0, max: 100 },
  // OPENING_SENSOR_STATE: 0 open, 1 closed (locks with a door position sensor).
  door: { category: C.OPENING_SENSOR, type: TYPES.SENSOR.BINARY, ...binary },
  // "Unlocked with the keypad (Jean)".
  'last-action': { category: C.TEXT, type: TYPES.TEXT.TEXT, min: 0, max: 0 },
  // The one-touch locking setting of the lock, read only: 1 on.
  'lock-and-leave': { category: C.UNKNOWN, type: TYPES.SENSOR.BINARY, ...binary },
};

export const ROLES = Object.keys(FEATURES);
export const COMMAND_ROLES = ['lock'];

export const deviceIds = (gladys, id) => gladys.externalIds('schlage', String(id));

/** The Schlage id and the role of a feature external id. */
export function parseFeatureId(externalId) {
  const match = /:schlage:([A-Za-z0-9_-]{1,64}):([a-z-]+)$/.exec(String(externalId ?? ''));
  return match && ROLES.includes(match[2]) ? { id: match[1], role: match[2] } : undefined;
}

export const deviceName = (lock, language) =>
  lock.name || `${word(DEVICE_NAME, language)} ${lock.id.slice(-4)}`;

/**
 * The roles of one lock: the ones it reports now, plus those of the device
 * already created in Gladys (`created`: its role set), so a republished
 * device never loses a feature.
 */
export function rolesOf(lock, created = new Set()) {
  const roles = new Set(['lock', 'state', 'jammed', 'battery', 'last-action']);
  if (hasDoorSensor(lock)) {
    roles.add('door');
  }
  if (lock.lockAndLeave !== undefined) {
    roles.add('lock-and-leave');
  }
  for (const role of created) {
    if (ROLES.includes(role)) {
      roles.add(role);
    }
  }
  return ROLES.filter((role) => roles.has(role));
}

const params = (entries) =>
  entries
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([name, value]) => ({ name, value: String(value) }));

/** The Gladys device of one lock. `created`: the roles of the device already in Gladys. */
export function buildDevice(gladys, lock, language, created) {
  const ids = deviceIds(gladys, lock.id);
  return {
    name: deviceName(lock, language),
    external_id: ids.device,
    model: lock.model,
    features: rolesOf(lock, created).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...FEATURES[role],
    })),
    params: params([
      ['schlage_id', lock.id],
      ['device_type', lock.type],
      ['model', lock.model],
    ]),
  };
}

/** The state word of the lock position (the last action starts with it). */
export function positionKey(lock) {
  if (isJammed(lock)) {
    return 'jammed';
  }
  const locked = lockedOf(lock);
  return locked === undefined ? 'unknown' : locked ? 'locked' : 'unlocked';
}

/** "Unlocked with the keypad (Jean)", in the language of the configuration. */
export function lastAction(lock, language) {
  const state = word(STATE_WORDS[positionKey(lock)], language);
  const method = lock.method && METHOD_WORDS[lock.method];
  const how = method ? ` ${word(method, language)}` : '';
  const who = lock.by ? ` (${lock.by})` : '';
  return `${state}${how}${who}`.slice(0, LIMITS.textLength);
}

/** Gladys LOCK.STATE: 0 unlocked, 1 locked, 2 a command in progress, 3 jammed. */
export function lockStateOf(lock, { moving = false } = {}) {
  if (moving) {
    return GLADYS.LOCK_STATE.ACTIVITY;
  }
  if (isJammed(lock)) {
    return GLADYS.LOCK_STATE.ERROR;
  }
  const locked = lockedOf(lock);
  if (locked === undefined) {
    return undefined;
  }
  return locked ? GLADYS.LOCK_STATE.LOCKED : GLADYS.LOCK_STATE.UNLOCKED;
}

/**
 * The Gladys states of one lock: `[{ role, state }]` or `[{ role, text }]`.
 * An offline lock keeps its last values (only its badge changes); `moving`:
 * a command is in progress, the position is not published until it ends.
 */
export function statesOf(lock, language, { moving = false } = {}) {
  const states = [];
  const add = (role, state) => {
    if (state !== undefined) {
      states.push({ role, state });
    }
  };
  if (!lock.connected) {
    return states;
  }
  const locked = lockedOf(lock);
  if (!moving) {
    add(
      'lock',
      locked === undefined
        ? undefined
        : locked
          ? GLADYS.LOCK_BINARY.LOCKED
          : GLADYS.LOCK_BINARY.UNLOCKED,
    );
  }
  add('state', lockStateOf(lock, { moving }));
  if (lock.lockState !== undefined) {
    add('jammed', isJammed(lock) ? GLADYS.ON : GLADYS.OFF);
  }
  add('battery', lock.battery);
  if (lock.door === DOOR_STATE.OPEN) {
    add('door', GLADYS.OPENING.OPEN);
  } else if (lock.door === DOOR_STATE.CLOSED) {
    add('door', GLADYS.OPENING.CLOSED);
  }
  if (lock.lockAndLeave !== undefined) {
    add('lock-and-leave', lock.lockAndLeave ? GLADYS.ON : GLADYS.OFF);
  }
  if (!moving && lock.lockState !== undefined) {
    states.push({ role: 'last-action', text: lastAction(lock, language) });
  }
  return states;
}
