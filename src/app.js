// -----------------------------------------------------------------------------
// The integration: the Schlage account (e-mail, password, and the
// verification code when Schlage asks for one), one read of the lock list per
// cycle (60 s by default), the Gladys devices and their states, the scene
// triggers (unlocked, jammed), the transport badges and the commands of the
// locks under Louis's safety rules:
//
// - locking is always allowed; unlocking (allow_unlock) is off until the user
//   turns it on;
// - the commands of one lock run one at a time (a promise chain per lock);
// - the lock is read again (GET devices/{id}) just before acting, never
//   decided on a state in memory; refused when that read fails, or when the
//   lock is offline, jammed or in an unknown state;
// - a command not sent 3.5 s after it arrived is refused (Gladys shows a
//   failure after 5 s: nothing must move after that);
// - after a command (sent or maybe sent), a guard refuses every command of
//   the lock and shows it moving until a later read shows the expected state
//   or a jam, 45 s at most.
//
// The pauses (429, 403) and the stops (refused credentials, verification code)
// are kept in /data and hold for every path. index.js only wires the SDK
// handlers to this class.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { SchlageClient } from './client.js';
import { normalizeConfig } from './config.js';
import { LOCK_STATE, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  deviceName,
  parseFeatureId,
  statesOf,
} from './devices.js';
import { SchlageError, errorReason } from './http.js';
import { T, age, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { isJammed, isStill, isWifiLock, lockedOf, parseLock, parseLocks } from './schlage.js';
import { fileStore, normalizeMemory, safeUsername } from './store.js';

/** Errors after which Schlage did not answer usefully: every lock is unreachable. */
const OFFLINE = new Set(['network', 'timeout', 'unavailable', 'bad_response', 'size', 'http']);

/** Stops retried by themselves, spaced (1 h, 6 h, then every 24 h). */
const SPACED = new Set(['refused', 'new_password', 'unsupported_challenge', 'session_refused']);

/** Command errors after which Schlage may have executed it anyway. */
const MAYBE_SENT = new Set(['timeout', 'network', 'unavailable', 'bad_response', 'size']);

/** A refusal shown in the ack of the command (Gladys shows the message). */
class Refusal extends Error {}

export class SchlageApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'schlage' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    random,
    cognitoUrl,
    apiUrl,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new SchlageClient({
      transport,
      now,
      random,
      cognitoUrl,
      apiUrl,
      onChange: () => this.persist(),
    });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** id -> lock as read (src/schlage.js), plus `moving` while its guard holds */
    this.locks = new Map();
    this.readAt = undefined;
    this.published = undefined;
    /** deviceId -> badge last published (JSON) */
    this.badges = new Map();
    this.timer = undefined;
    this.followUpTimers = new Set();
    this.running = undefined;
    this.generation = 0;
    /**
     * undefined | 'refused' | 'new_password' | 'unsupported_challenge' |
     * 'session_refused' (tried again at `retryAt`) | 'two_factor' (waits for
     * the code buttons: a new sign-in would send a new code).
     */
    this.blocked = undefined;
    this.blockDetail = undefined;
    this.retries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.failures = 0;
    this.pausedUntil = 0;
    /** 'rate' (429), 'forbidden' (403): every path waits; 'backoff': the polling only. */
    this.pauseKind = undefined;
    /** lockId -> tail of its command chain: one command at a time per lock */
    this.commandChains = new Map();
    /** lockId -> { expected, fromJammed, until }: see observe(). */
    this.guards = new Map();
    this.lastStatus = undefined;
    this.lastTestAt = -Infinity;
    this.lastCodeAt = -Infinity;
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** `fresh`: the user changed the credentials, the stops are lifted. */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    const { account } = this.config;
    if (this.memory.account !== account) {
      // Another account: its tokens and its stops are not this one's. A 429 pause stays.
      this.memory = { ...this.memory, account, tokens: null, block: null };
    }
    if (fresh) {
      this.memory.block = null;
    }
    const { pause, block } = this.memory;
    if (pause && pause.until > this.now()) {
      this.pausedUntil = pause.until;
      this.pauseKind = pause.kind;
    }
    if (block) {
      this.blocked = block.kind;
      this.blockDetail = block.detail;
      this.retries = block.retries;
      this.retryAt = block.retryAt ?? 0;
    }
    if (!this.config.email || !this.config.password) {
      // A missing e-mail or password: the tokens of the account go too.
      this.memory.tokens = null;
    }
    this.client.configure({
      email: this.config.email,
      password: this.config.password,
      tokens: this.memory.tokens,
      codeRequired: this.memory.codeRequired,
    });
    await this.saveMemory();
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    this.scheduleRenew();
    if (this.blocked) {
      await this.setStatus(false, this.blockedMessage());
      this.scheduleNext();
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.clearRenewTimer();
    for (const handle of this.followUpTimers) {
      this.timers.clearTimeout(handle);
    }
    this.followUpTimers.clear();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clearRenewTimer() {
    if (this.renewTimer) {
      this.timers.clearTimeout(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  /** A 429 or 403 pause holds now (every path waits). */
  get hardPaused() {
    return (
      (this.pauseKind === 'rate' || this.pauseKind === 'forbidden') && this.now() < this.pausedUntil
    );
  }

  /**
   * The renewal of the access token, at its expiry minus the margin, whatever
   * the poll interval: a command never meets an expired token. It waits for
   * the end of a 429/403 pause and never runs during a stop.
   */
  scheduleRenew(delay) {
    this.clearRenewTimer();
    const renewAt = this.client.renewAt;
    if (!this.client.hasCredentials || this.blocked || renewAt === undefined) {
      return;
    }
    let at = delay === undefined ? renewAt : this.now() + delay;
    if (this.hardPaused) {
      at = Math.max(at, this.pausedUntil);
    }
    const generation = this.generation;
    this.renewTimer = this.timers.setTimeout(
      () => {
        this.renewTimer = undefined;
        if (generation !== this.generation) {
          return;
        }
        if (this.blocked) {
          return;
        }
        if (this.hardPaused || this.now() < (this.client.renewAt ?? Infinity) - 1_000) {
          this.scheduleRenew();
          return;
        }
        // A success persists the new tokens, which schedules the next renewal.
        this.client
          .token({ force: true, signIn: false })
          .catch((err) => this.renewFailed(err, generation));
      },
      Math.max(0, at - this.now()),
    );
  }

  /** A renewal outside a read failed: a pause, or a new try in a minute; never a sign-in. */
  async renewFailed(err, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    this.logger.info(`Schlage: token renewal failed (${errorReason(err)})`);
    if (err.kind === 'rate_limited') {
      this.pause(err);
      await this.persist();
      return;
    }
    if (err.kind === 'forbidden') {
      this.forbid();
      await this.persist();
      return;
    }
    if (err.kind === 'unauthorized') {
      // The refresh token was refused: the next read signs in (or waits for a code).
      return;
    }
    this.scheduleRenew(TIMINGS.renewRetry);
  }

  /** Forgets the locks and the failures: a new account, or a restart. A 429 pause stays. */
  reset() {
    this.locks.clear();
    this.guards.clear();
    this.readAt = undefined;
    this.published = undefined;
    this.badges.clear();
    this.blocked = undefined;
    this.blockDetail = undefined;
    this.retries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.failures = 0;
    if (this.pauseKind !== 'rate' || this.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (Discovery list,
   * status, badges). The pauses, the stops and the tokens stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges.clear();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** New credentials restart (and lift the stops); the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.email !== previous.email || next.password !== previous.password) {
      return this.start(raw, { fresh: true });
    }
    this.config = next;
    if (next.pollInterval !== previous.pollInterval && this.timer) {
      this.scheduleNext();
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
      this.queueAll();
      await this.flush();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The message of the last status (multi-language), or undefined. */
  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** The tokens, the pause and the stop, with the account they belong to. */
  async persist() {
    this.memory.account = this.config.account;
    const tokens = this.client.tokens;
    this.memory.tokens = tokens ? { ...tokens, username: safeUsername(tokens.username) } : null;
    this.memory.codeRequired = this.client.codeRequired;
    this.memory.pause = this.hardPaused ? { kind: this.pauseKind, until: this.pausedUntil } : null;
    this.memory.block = this.blocked
      ? {
          kind: this.blocked,
          retries: this.retries,
          retryAt: this.retryAt || undefined,
          detail: this.blockDetail,
        }
      : null;
    await this.saveMemory();
    // New tokens, a new pause or a stop: the renewal follows.
    this.scheduleRenew();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  /** The next read: after the pause or the spaced retry, else the interval. */
  scheduleNext() {
    this.clearTimer();
    if (!this.client.hasCredentials) {
      return;
    }
    const now = this.now();
    let delay;
    if (this.blocked === 'two_factor') {
      return;
    } else if (this.blocked) {
      delay = Math.max(this.retryAt, this.pausedUntil) - now;
    } else if (now < this.pausedUntil) {
      // Never read again faster than the interval, a pause included.
      delay = Math.max(this.pausedUntil - now, this.config.pollInterval * 1000);
    } else {
      delay = this.config.pollInterval * 1000;
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Schlage refresh failed: ${err.message}`));
        }
      },
      Math.max(0, delay),
    );
  }

  /** One run at a time: a tick during a run joins it. `quick`: for a button. */
  tick({ quick = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false } = {}) {
    const generation = this.generation;
    if (!this.client.hasCredentials) {
      return;
    }
    if (this.blocked && SPACED.has(this.blocked) && this.now() >= this.retryAt) {
      // The spaced new try: one sign-in at most.
      this.logger.info(`Schlage: trying again after a stop (${this.blocked})`);
      this.blocked = undefined;
    }
    if (this.blocked || this.now() < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    this.client.beginCycle();
    this.client.setTimeoutMs(quick ? TIMINGS.quickTimeout : undefined);
    try {
      const list = await this.client.locks();
      if (generation !== this.generation) {
        return;
      }
      await this.apply(list);
      const hadStop = this.retries > 0 || this.pauseKind !== undefined;
      this.failures = 0;
      this.retries = 0;
      this.retryAt = 0;
      this.offline = false;
      // A 429 met meanwhile by a command (its read) still holds.
      if (this.pauseKind === 'backoff' || this.now() >= this.pausedUntil) {
        this.pauseKind = undefined;
        this.pausedUntil = 0;
      }
      if (hadStop || this.memory.block || this.memory.pause) {
        await this.persist();
      }
      await this.setStatus(true, T.connected(this.locks.size));
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.client.setTimeoutMs(undefined);
    }
    await this.publishBadges();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  /** The message of a stop. */
  blockedMessage() {
    const wait = age(Math.max(TIMINGS.rateLimitMin, this.retryAt - this.now()));
    switch (this.blocked) {
      case 'two_factor':
        return T.twoFactor;
      case 'new_password':
        return T.newPassword;
      case 'unsupported_challenge':
        return T.unsupportedChallenge(this.blockDetail, wait);
      case 'session_refused':
        return T.sessionRefused(wait);
      default:
        return T.refused(wait);
    }
  }

  /** A failure: a stop, a pause, or a backoff. Never a dead integration but for a code. */
  async failed(err) {
    const reason = errorReason(err);
    if (err.kind === 'no_credentials') {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (err.kind === 'two_factor') {
      // Never signed in again by itself: each sign-in would send a new code.
      this.blocked = 'two_factor';
      this.logger.warn('Schlage asks for a verification code: waiting for the buttons');
      await this.persist();
      await this.setStatus(false, T.twoFactor);
      return;
    }
    if (SPACED.has(err.kind)) {
      const wait = TIMINGS.refusedRetry[Math.min(this.retries, TIMINGS.refusedRetry.length - 1)];
      this.retries += 1;
      this.blocked = err.kind;
      this.blockDetail = err.challenge;
      this.retryAt = this.now() + wait;
      this.logger.warn(
        `Schlage stopped: ${reason}; one new try in ${Math.round(wait / 60_000)} min`,
      );
      await this.persist();
      await this.setStatus(false, this.blockedMessage());
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited') {
      wait = this.pause(err);
      message = T.rateLimited(age(wait));
    } else if (err.kind === 'forbidden') {
      wait = this.forbid();
      this.offline = true;
      message = T.forbidden(age(wait));
    } else {
      // Never read again faster than the poll interval.
      wait = Math.max(
        this.config.pollInterval * 1000,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.pauseKind = 'backoff';
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.offline = OFFLINE.has(err.kind) || this.offline;
      message = T.unreachable(reason, age(wait));
    }
    this.failures += 1;
    await this.persist();
    const connected = err.kind === 'rate_limited' && this.readAt !== undefined;
    await this.setStatus(connected, message);
    this.logger.warn(`Schlage: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** 429: a pause of Retry-After, between 60 s and 6 h, for every path (kept in /data). */
  pause(err) {
    const asked = err.retryAfter ?? TIMINGS.rateLimitDefault;
    const wait = Math.max(TIMINGS.rateLimitMin, Math.min(TIMINGS.rateLimitMax, asked));
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.pauseKind = 'rate';
    return wait;
  }

  /** 403 of the API: a 30-minute pause for every path (kept in /data); a 429 pause stays. */
  forbid() {
    const wait = TIMINGS.forbiddenPause;
    if (!(this.pauseKind === 'rate' && this.pausedUntil > this.now() + wait)) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.pauseKind = 'forbidden';
    }
    return wait;
  }

  /** The lock list read: every lock through ingest(), the removed ones forgotten. */
  async apply(list) {
    const locks = parseLocks(list);
    for (const id of [...this.locks.keys()]) {
      if (!locks.has(id)) {
        this.locks.delete(id);
        this.guards.delete(id);
      }
    }
    const created = this.createdFeatures();
    for (const lock of locks.values()) {
      this.ingest(lock, created);
    }
    this.readAt = this.now();
    await this.publishDevices();
  }

  /**
   * One lock as read: the scene events of its change since the previous read
   * (never on the first one), the guard of a command, its states queued.
   */
  ingest(read, created = this.createdFeatures()) {
    const lock = { ...read, seenAt: this.now() };
    const previous = this.locks.get(lock.id);
    // A previous read too old (a pause, an outage) tells no "change": no trigger then.
    const recent =
      previous?.seenAt !== undefined &&
      lock.seenAt - previous.seenAt <= 2 * this.config.pollInterval * 1000;
    if (previous && recent && previous.connected && lock.connected) {
      const name = deviceName(lock, this.config.language);
      if (lockedOf(previous) === true && lockedOf(lock) === false) {
        this.publisher.pushSceneEvent(SCENE_TRIGGERS.UNLOCKED, {
          lock: name,
          method: lock.method ?? 'other',
          by: lock.by ?? '',
        });
        this.logger.info(`${deviceName(lock, 'en')}: unlocked (${lock.method ?? 'other'})`);
      }
      if (!isJammed(previous) && isJammed(lock)) {
        this.publisher.pushSceneEvent(SCENE_TRIGGERS.JAMMED, { lock: name });
        this.logger.warn(`${deviceName(lock, 'en')}: jammed`);
      }
    }
    const shown = this.observe(lock);
    this.locks.set(lock.id, shown);
    this.queue(shown, created);
    return shown;
  }

  // --- Gladys ----------------------------------------------------------------

  /** The roles of the device already created in Gladys for a lock. */
  createdRoles(id) {
    const externalId = deviceIds(this.gladys, id).device;
    const device = (this.gladys.devices ?? []).find((d) => d.external_id === externalId);
    return new Set(
      (device?.features ?? [])
        .map((f) => parseFeatureId(f.external_id)?.role)
        .filter((role) => role !== undefined),
    );
  }

  async publishDevices() {
    if (this.readAt === undefined) {
      return;
    }
    const devices = [...this.locks.values()].map((lock) =>
      buildDevice(this.gladys, lock, this.config.language, this.createdRoles(lock.id)),
    );
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** Queues the states of one lock (the features created in Gladys only). */
  queue(lock, created = this.createdFeatures()) {
    const ids = deviceIds(this.gladys, lock.id);
    for (const { role, ...value } of statesOf(lock, this.config.language, {
      moving: lock.moving === true,
    })) {
      const id = ids.feature(role);
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  queueAll(created = this.createdFeatures()) {
    for (const lock of this.locks.values()) {
      this.queue(lock, created);
    }
  }

  badge(lock) {
    if (this.blocked || this.offline) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (!lock.connected) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE, degraded: true, message: T.lockOffline };
    }
    return { transport: DEVICE_TRANSPORTS.CLOUD };
  }

  async publishBadges() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    for (const lock of this.locks.values()) {
      const externalId = deviceIds(this.gladys, lock.id).device;
      if (!created.has(externalId)) {
        continue;
      }
      const entry = { external_id: externalId, ...this.badge(lock) };
      const json = JSON.stringify(entry);
      if (this.badges.get(externalId) !== json) {
        entries.push([externalId, json, entry]);
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries.map(([, , entry]) => entry));
      for (const [externalId, json] of entries) {
        this.badges.set(externalId, json);
      }
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badges.delete(device?.external_id);
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueAll(created);
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    this.badges.delete(device?.external_id);
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: a fresh read if the last one is old enough. */
  async scan() {
    if (
      this.client.hasCredentials &&
      !this.blocked &&
      this.now() >= this.pausedUntil &&
      (this.readAt === undefined || this.now() - this.readAt >= TIMINGS.testCooldown)
    ) {
      await this.tick({ quick: true });
      return;
    }
    await this.publishDevices();
  }

  // --- Commands --------------------------------------------------------------

  refusal(text, cause) {
    return new Refusal(word(text, this.config.language), cause ? { cause } : undefined);
  }

  async setValue(_gladysDevice, feature, value) {
    // The ack deadline counts from the arrival of the command, before any wait.
    const receivedAt = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw new Error(`${feature?.external_id} cannot be set`);
    }
    // Only 0, 1, '0' and '1': null, '', ' ', false or [] would read as 0 (unlock).
    const number = value === 1 || value === '1' ? 1 : value === 0 || value === '0' ? 0 : undefined;
    if (number === undefined) {
      throw this.refusal(T.denied.badValue);
    }
    return this.serialized(target.id, () => this.command(target.id, number, receivedAt));
  }

  /** Runs `task` after the previous task of the same key (a promise chain per key). */
  serialized(key, task) {
    const previous = this.commandChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.commandChains.set(key, tail);
    tail.then(() => {
      if (this.commandChains.get(key) === tail) {
        this.commandChains.delete(key);
      }
    });
    return run;
  }

  /** Time left before the deadline of a command that arrived at `receivedAt`. */
  remaining(receivedAt) {
    return receivedAt + TIMINGS.commandDeadline - this.now();
  }

  async command(id, value, receivedAt) {
    const generation = this.generation;
    const unlocking = value === 0;
    if (!this.client.hasCredentials) {
      throw this.refusal(T.denied.noConfig);
    }
    if (unlocking && !this.config.allowUnlock) {
      throw this.refusal(T.denied.unlock);
    }
    if (this.blocked) {
      throw this.refusal(T.denied.stopped);
    }
    if (this.hardPaused) {
      throw this.refusal(this.pauseKind === 'forbidden' ? T.denied.forbidden : T.denied.paused);
    }
    const known = this.locks.get(id);
    if (!known) {
      throw this.refusal(T.denied.unknownDevice);
    }
    if (!isWifiLock(known)) {
      throw this.refusal(T.denied.notWifi);
    }
    if (!this.client.tokenValidFor(TIMINGS.commandTokenValidity)) {
      // A renewal inside the 3.5 s would leave too little time: renewed now, refused.
      // (The renewal timer makes this rare: the token is renewed 5 min before its end.)
      this.client
        .token({ signIn: false, validity: TIMINGS.commandTokenValidity })
        .catch((err) => this.renewFailed(err, generation));
      throw this.refusal(T.denied.session);
    }
    if (this.remaining(receivedAt) <= TIMINGS.minRequestTimeout) {
      throw this.refusal(T.denied.late);
    }

    // The state just before acting, never the one in memory.
    const lock = await this.readLock(id, receivedAt);
    if (this.guardActive(id)) {
      // The previous command may still be moving the lock: never "already done".
      throw this.refusal(T.denied.inProgress);
    }
    if (this.remaining(receivedAt) <= 0) {
      throw this.refusal(T.denied.late);
    }
    if (!lock.connected) {
      throw this.refusal(T.denied.offline);
    }
    if (isJammed(lock)) {
      throw this.refusal(T.denied.jammed);
    }
    if (!isStill(lock)) {
      throw this.refusal(T.denied.unknown);
    }
    const expected = !unlocking;
    if (lockedOf(lock) === expected) {
      return;
    }
    // The options may have changed during the read: checked again right before sending.
    if (generation !== this.generation || this.blocked) {
      throw this.refusal(T.denied.stopped);
    }
    if (unlocking && !this.config.allowUnlock) {
      throw this.refusal(T.denied.unlock);
    }
    try {
      await this.client.setLockState(id, unlocking ? LOCK_STATE.UNLOCKED : LOCK_STATE.LOCKED, {
        // Sent 3.4 s after the arrival at the latest; answered by 4.6 s after it.
        startBy: receivedAt + TIMINGS.commandStartBy,
        timeout: () =>
          Math.max(TIMINGS.minRequestTimeout, receivedAt + TIMINGS.commandAnswerBy - this.now()),
      });
    } catch (err) {
      if (err.kind === 'late') {
        throw this.refusal(T.denied.late, err);
      }
      if (err.kind === 'rate_limited') {
        this.pause(err);
        await this.persist();
      }
      if (err.kind === 'forbidden') {
        this.forbid();
        await this.persist();
      }
      if (MAYBE_SENT.has(err.kind)) {
        // The request may have reached Schlage: the lock may move anyway.
        this.guard(lock, expected);
        this.followUp();
        throw new Error(word(T.maybeSent(errorReason(err)), this.config.language), {
          cause: err,
        });
      }
      if (err.kind === 'unauthorized') {
        throw this.refusal(T.denied.session, err);
      }
      throw new Error(word(T.commandFailed(errorReason(err)), this.config.language), {
        cause: err,
      });
    }
    this.logger.info(`${deviceName(lock, 'en')}: ${unlocking ? 'unlock' : 'lock'} sent`);
    // The answer may already carry the requested state before the bolt moved:
    // only a later read ends the guard.
    this.guard(lock, expected);
    this.followUp();
  }

  /** Sets the guard of a lock after a command, and shows it moving. */
  guard(lock, expected) {
    this.guards.set(lock.id, {
      expected,
      fromJammed: isJammed(lock),
      sentAt: this.now(),
      until: this.now() + TIMINGS.commandGuard,
    });
    // `seenAt` of the last read is kept (the triggers compare with it).
    const shown = { ...this.locks.get(lock.id), ...lock, moving: true };
    this.locks.set(lock.id, shown);
    this.queue(shown);
    this.flush();
  }

  guardActive(id) {
    const guard = this.guards.get(id);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(id);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A lock as read, through its guard. The guard ends, besides its expiry, on
   * the expected position (always other than the one read before the
   * command, which was returned "already done"), or on a new jam. Never on an
   * unknown or offline state. Meanwhile the lock is shown moving.
   */
  observe(lock) {
    if (!this.guardActive(lock.id)) {
      return lock;
    }
    const guard = this.guards.get(lock.id);
    // A read right after the command may answer from before the bolt moved.
    const settled = this.now() - guard.sentAt >= TIMINGS.guardMinAge;
    const jamEnds = isJammed(lock) && !guard.fromJammed;
    if (settled && lock.connected && (jamEnds || lockedOf(lock) === guard.expected)) {
      this.guards.delete(lock.id);
      return lock;
    }
    return { ...lock, moving: true };
  }

  /** GET devices/{id} within the command deadline; refused on any failure. */
  async readLock(id, receivedAt) {
    let raw;
    try {
      raw = await this.client.lock(id, {
        startBy: receivedAt + TIMINGS.commandDeadline - TIMINGS.minRequestTimeout,
        timeout: () =>
          Math.max(
            TIMINGS.minRequestTimeout,
            Math.min(TIMINGS.commandReadTimeout, this.remaining(receivedAt)),
          ),
      });
    } catch (err) {
      if (err.kind === 'late') {
        throw this.refusal(T.denied.late, err);
      }
      if (err.kind === 'rate_limited') {
        this.pause(err);
        await this.persist();
      }
      if (err.kind === 'forbidden') {
        this.forbid();
        await this.persist();
      }
      this.logger.info(`Schlage lock: no state before the command (${errorReason(err)})`);
      throw this.refusal(T.denied.unreadable, err);
    }
    const lock = parseLock(raw);
    if (!lock || lock.id !== id) {
      throw this.refusal(T.denied.unreadable, new SchlageError('bad_response', 'not this lock'));
    }
    this.ingest(lock);
    this.flush();
    return lock;
  }

  /** A few reads of the lock list after a command, to show its end. */
  followUp() {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        this.followUpTimers.delete(handle);
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.warn(`Schlage refresh failed: ${err.message}`));
        }
      }, delay);
      this.followUpTimers.add(handle);
    }
  }

  // --- Configuration buttons -------------------------------------------------

  /** A 429 or 403 pause holds for every path, buttons included. */
  pauseMessage() {
    const left = this.pausedUntil - this.now();
    if (left <= 0) {
      return undefined;
    }
    if (this.pauseKind === 'rate') {
      return T.rateLimited(age(left));
    }
    return this.pauseKind === 'forbidden' ? T.forbidden(age(left)) : undefined;
  }

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.blocked === 'two_factor') {
      return T.twoFactor;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    // At most one read (and one sign-in) per 30 s from this button.
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastTestAt = this.now();
    // The button is how a stopped account is retried at once.
    this.blocked = undefined;
    this.retryAt = 0;
    this.pausedUntil = 0;
    this.pauseKind = undefined;
    await this.tick({ quick: true });
    return this.lastMessage ?? T.noCredentials;
  }

  /** An error of the code buttons -> the message under the button. */
  async codeFailure(err) {
    switch (err.kind) {
      case 'two_factor':
        return T.code.sent(err.destination);
      case 'code_refused':
        return T.code.refused;
      case 'code_expired':
        await this.setStatus(false, T.twoFactor);
        return T.code.expired;
      case 'no_pending':
        return T.code.noPending;
      case 'rate_limited':
      case 'forbidden':
        await this.failed(err);
        return this.pauseMessage();
      default:
        if (SPACED.has(err.kind) || err.kind === 'no_credentials') {
          await this.failed(err);
          return this.lastMessage;
        }
        this.logger.warn(`Schlage verification: ${errorReason(err)}`);
        return T.code.failed(errorReason(err));
    }
  }

  /** Step 1: sign in with the password; Schlage then sends a code (or needs none). */
  async requestCode() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.client.tokens && !this.blocked) {
      // Connected: a new sign-in would only risk the working session.
      return T.code.alreadyConnected;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.now() - this.lastCodeAt < TIMINGS.codeCooldown) {
      return T.code.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastCodeAt = this.now();
    this.client.setTimeoutMs(TIMINGS.quickTimeout);
    try {
      await this.client.signIn();
    } catch (err) {
      if (err.kind === 'two_factor') {
        this.blocked = 'two_factor';
        this.clearTimer();
        await this.persist();
        await this.setStatus(false, T.twoFactor);
        this.logger.info('Schlage verification code requested');
      }
      return this.codeFailure(err);
    } finally {
      this.client.setTimeoutMs(undefined);
    }
    this.blocked = undefined;
    this.retries = 0;
    this.retryAt = 0;
    await this.persist();
    await this.tick({ quick: true });
    return T.code.notNeeded;
  }

  /** Step 2: the code received; the waiting sign-in becomes the session. */
  async verifyCode(fields) {
    if (!fields || typeof fields !== 'object' || !('code' in fields)) {
      return T.code.needsFields;
    }
    const code = String(fields.code ?? '').replace(/[\s-]/g, '');
    if (!/^\d{6,8}$/.test(code)) {
      return T.code.badFormat;
    }
    if (!this.client.pending) {
      return T.code.noPending;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.running) {
      return T.busy;
    }
    this.client.setTimeoutMs(TIMINGS.quickTimeout);
    try {
      await this.client.verifyCode(code);
    } catch (err) {
      return this.codeFailure(err);
    } finally {
      this.client.setTimeoutMs(undefined);
    }
    this.logger.info('Schlage verification code accepted');
    this.blocked = undefined;
    this.retries = 0;
    this.retryAt = 0;
    this.failures = 0;
    await this.persist();
    await this.tick({ quick: true });
    return T.code.verified;
  }
}
