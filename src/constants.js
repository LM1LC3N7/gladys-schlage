// -----------------------------------------------------------------------------
// Constants of the Schlage cloud and of the integration.
//
// The cloud values are those of dknowles2/pyschlage (Apache-2.0, see
// THIRD_PARTY_NOTICES.md), which reads them out of the Schlage Home app: the
// AWS Cognito user pool and app client of the app, the API base URL and its
// static API key, the lock states and the device types. They are the app's
// own public constants, not secrets of the user.
// -----------------------------------------------------------------------------

/** The manifest action keys. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  REQUEST_CODE: 'request_code',
  VERIFY_CODE: 'verify_code',
};

/** The manifest scene trigger keys. */
export const SCENE_TRIGGERS = {
  UNLOCKED: 'lock_unlocked',
  JAMMED: 'lock_jammed',
};

/** AWS Cognito, as pyschlage.auth signs in (SRP, then refresh tokens). */
export const COGNITO = {
  region: 'us-west-2',
  poolId: 'us-west-2_2zhrVs9d4',
  clientId: 't5836cptp2s1il0u9lki03j5',
  clientSecret: '1kfmt18bgaig51in4j4v1j3jbe7ioqtjhle5o6knqc5dat0tpuvo',
  url: 'https://cognito-idp.us-west-2.amazonaws.com/',
};

/** The Schlage (Allegion "thinCloud") API, pyschlage.auth BASE_URL and API_KEY. */
export const API = {
  url: 'https://api.allegion.yonomi.cloud/v1',
  key: 'hnuu9jbbJr7MssFDWm5nU2Z7nG5Q5rxsaqWsE7e9',
  userAgent: 'gladys-schlage',
};

/** `attributes.lockState` (pyschlage.lock, PROTOCOL.md "Enumerations"). */
export const LOCK_STATE = {
  INVALID: -1,
  UNLOCKED: 0,
  LOCKED: 1,
  JAMMED: 2,
  UNKNOWN: 3,
  MOTOR_JAMMED: 4,
  PASSAGE_MODE: 5,
  DEADLOCKED: 6,
};

export const LOCKED_STATES = [LOCK_STATE.LOCKED, LOCK_STATE.DEADLOCKED];
export const UNLOCKED_STATES = [LOCK_STATE.UNLOCKED, LOCK_STATE.PASSAGE_MODE];
export const JAMMED_STATES = [LOCK_STATE.JAMMED, LOCK_STATE.MOTOR_JAMMED];

/** `attributes.doorState` (pyschlage.device.DoorState). */
export const DOOR_STATE = { UNKNOWN: 0, OPEN: 1, CLOSED: 2, FAULTY: 3 };

/**
 * `devicetypeId` prefixes of the Wi-Fi lock families (pyschlage
 * `Lock._is_wifi_lock`): they are locked and unlocked with
 * `PUT devices/{id}` `{ attributes: { lockState } }`. The others (Sense
 * behind its bridge, unknown types) are read only here.
 */
export const WIFI_PREFIXES = [
  'be459',
  'be489',
  'be499',
  'fe789',
  'be889',
  'gselent',
  'gselsec',
  'sselent',
  'sselsec',
];

/** Families without the one-touch locking setting (PROTOCOL.md "Model capabilities"). */
export const NO_LOCK_AND_LEAVE_PREFIXES = ['be889', 'gselent', 'gselsec', 'sselent', 'sselsec'];

/** `lockStateMetadata.actionType` -> the method of the scene trigger and the text. */
export const METHODS = {
  accesscode: 'keypad',
  virtualKey: 'app',
  AppleHomeNFC: 'apple_home',
  thumbTurn: 'manual',
  '1touchLocking': 'one_touch',
};
export const METHOD_VALUES = ['keypad', 'app', 'apple_home', 'manual', 'one_touch', 'other'];

/** Gladys values (server/utils/constants.js of the core). */
export const GLADYS = {
  LOCK_BINARY: { UNLOCKED: 0, LOCKED: 1 },
  LOCK_STATE: { UNLOCKED: 0, LOCKED: 1, ACTIVITY: 2, ERROR: 3 },
  OPENING: { OPEN: 0, CLOSED: 1 },
  ON: 1,
  OFF: 0,
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = { default: 60, min: 60, max: 900 };

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** A read of the lock list, a sign-in step. */
  requestTimeout: 15_000,
  /** The buttons wait for Gladys; their requests are shorter. */
  quickTimeout: 10_000,
  /**
   * Gladys gives up on a set_value after 5 s and shows a failure: a command
   * not sent 3.5 s after it arrived is refused, never sent after the failure.
   */
  commandDeadline: 3_500,
  /** The command request may last until 4.6 s after the arrival, 1.2 s at least. */
  commandAnswerBy: 4_600,
  commandTimeout: 1_200,
  /** The shortest timeout worth a request, inside the command deadline. */
  minRequestTimeout: 300,
  /** The read just before a command: 3 s at most. */
  commandReadTimeout: 3_000,
  /**
   * After a command is sent (or may have been): every command of the lock is
   * refused until a read shows the expected state (or a jam), or for 45 s at
   * most; meanwhile the lock is shown moving (LOCK.STATE 2).
   */
  commandGuard: 45_000,
  /** The re-reads of the lock list after a command, to show its end. */
  followUps: [4_000, 10_000, 20_000, 46_000],
  /** Renew the access token this long before it expires. */
  tokenMargin: 5 * MINUTE,
  /** Lifetime assumed when Cognito gives none (its default: 1 h). */
  tokenLifetime: HOUR,
  /** A Cognito MFA session lasts 3 minutes. */
  codeLifetime: 3 * MINUTE,
  /** One new code a minute at most. */
  codeCooldown: MINUTE,
  /** Pauses after failures, never shorter than the poll interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE],
  /** After refused credentials: one new sign-in after 1 h, 6 h, then every 24 h. */
  refusedRetry: [HOUR, 6 * HOUR, 24 * HOUR],
  /** 429 (or Cognito TooManyRequests): a pause between 60 s and 6 h, Retry-After when given. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** A 403 of the API that is not an authentication error (a WAF or CDN block). */
  forbiddenPause: 30 * MINUTE,
  /** The test button and the Discovery scan read the cloud at most every 30 s. */
  testCooldown: 30_000,
  /** States flushed to Gladys every second; unchanged ones again every 30 min. */
  flushInterval: 1_000,
  stateHeartbeat: 30 * MINUTE,
};

export const LIMITS = {
  /** Gladys accepts 300 states and 300 scene events per minute. */
  statesPerMinute: 280,
  statesPerRequest: 100,
  sceneEventsPerMinute: 280,
  queuedEvents: 200,
  /** The biggest answer read: a lock document is ~3 KB. */
  responseBytes: 1024 * 1024,
  /** Locks kept from one answer. */
  locks: 50,
  nameLength: 80,
  textLength: 120,
};
