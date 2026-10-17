// -----------------------------------------------------------------------------
// The Schlage account: the Cognito tokens (src/cognito.js), renewed from the
// refresh token before they expire (never a new sign-in at each cycle), a
// waiting sign-in when a verification code is asked for, and the three calls
// of the Schlage API the integration needs (pyschlage.api / pyschlage.lock):
// the lock list, one lock, and the lock state change of a Wi-Fi lock.
// -----------------------------------------------------------------------------

import { CognitoClient } from './cognito.js';
import { API, TIMINGS } from './constants.js';
import { SchlageError, httpRequest, parseJson, parseRetryAfter } from './http.js';

/** The error of a Schlage API answer, or undefined when it is a success. */
export function apiError({ status, headers = {} }, now) {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 401) {
    return new SchlageError('unauthorized', 'access token refused', { status });
  }
  if (status === 429) {
    return new SchlageError('rate_limited', 'too many requests', {
      status,
      retryAfter: parseRetryAfter(headers['retry-after'], now),
    });
  }
  if (status === 403) {
    return new SchlageError('forbidden', 'request refused', { status });
  }
  if (status === 404) {
    return new SchlageError('not_found', 'not found', { status });
  }
  if (status >= 500) {
    return new SchlageError('unavailable', 'Schlage is unavailable', { status });
  }
  return new SchlageError('http', 'request failed', { status });
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class SchlageClient {
  constructor({
    transport = httpRequest,
    now = Date.now,
    random,
    cognitoUrl,
    apiUrl = API.url,
    onChange,
  } = {}) {
    this.transport = transport;
    this.now = now;
    this.apiUrl = apiUrl;
    this.cognito = new CognitoClient({ transport, now, random, url: cognitoUrl });
    /** Called after the tokens changed (persist them; never throws). */
    this.onChange = onChange;
    this.email = '';
    this.password = '';
    /** { accessToken, refreshToken, expiresAt, username } | null */
    this.tokens = null;
    /** A sign-in waiting for its code: { challenge, session, username, at } (memory only). */
    this.pending = null;
    this.renewing = undefined;
    /** One new sign-in or forced renewal per cycle at most (beginCycle resets it). */
    this.renewedThisCycle = false;
    this.signedInThisCycle = false;
    /** Per-request timeout; undefined = TIMINGS.requestTimeout (shorter for the buttons). */
    this.timeout = undefined;
  }

  configure({ email, password, tokens = null }) {
    this.email = email;
    this.password = password;
    this.tokens = tokens?.accessToken || tokens?.refreshToken ? tokens : null;
    this.pending = null;
    this.beginCycle();
  }

  get hasCredentials() {
    return this.email !== '' && this.password !== '';
  }

  beginCycle() {
    this.renewedThisCycle = false;
    this.signedInThisCycle = false;
  }

  async changed() {
    try {
      await this.onChange?.();
    } catch {
      // Persisting is best effort: the tokens still work in memory.
    }
  }

  /** A shorter timeout for the buttons (undefined: the default again). */
  setTimeoutMs(value) {
    this.timeout = value;
    this.cognito.timeout = value;
  }

  /** The access token is valid for a few minutes more: a command needs no renewal. */
  get tokenFresh() {
    return (
      Boolean(this.tokens?.accessToken) && this.tokens.expiresAt - TIMINGS.tokenMargin > this.now()
    );
  }

  get pendingFresh() {
    return Boolean(this.pending) && this.now() - this.pending.at < TIMINGS.codeLifetime;
  }

  /** A full sign-in with the password; a code challenge is kept as `pending`. */
  async signIn() {
    if (!this.hasCredentials) {
      throw new SchlageError('no_credentials', 'no e-mail or password');
    }
    const { email } = this;
    try {
      const tokens = await this.cognito.signIn(email, this.password);
      if (this.email !== email) {
        throw new SchlageError('network', 'the account changed during the sign-in');
      }
      this.tokens = tokens;
      this.pending = null;
      await this.changed();
      return tokens;
    } catch (err) {
      if (err.kind === 'two_factor' && this.email === email) {
        this.pending = err.pending;
        if (this.tokens) {
          this.tokens = null;
          await this.changed();
        }
      }
      throw err;
    }
  }

  /** The code of the waiting sign-in; it then becomes the tokens. */
  async verifyCode(code) {
    if (!this.pending) {
      throw new SchlageError('no_pending', 'no sign-in is waiting for a code');
    }
    if (!this.pendingFresh) {
      this.pending = null;
      throw new SchlageError('code_expired', 'the sign-in waiting for its code expired');
    }
    const pending = this.pending;
    try {
      this.tokens = await this.cognito.verifyCode(pending, code);
    } catch (err) {
      if (err.kind === 'code_expired') {
        this.pending = null;
      }
      throw err;
    }
    this.pending = null;
    this.beginCycle();
    await this.changed();
    return this.tokens;
  }

  /**
   * A valid access token: the current one, else renewed from the refresh
   * token, else (once per cycle) a new sign-in. One renewal at a time.
   */
  token({ force = false, signIn = true } = {}) {
    if (!force && this.tokenFresh) {
      return Promise.resolve(this.tokens.accessToken);
    }
    if (!this.renewing) {
      this.renewing = this.renew({ signIn }).finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  async renew({ signIn }) {
    if (this.tokens?.refreshToken) {
      const before = this.tokens;
      try {
        const tokens = await this.cognito.refresh(before, this.email);
        if (this.tokens === before) {
          this.tokens = tokens;
          await this.changed();
        }
        return this.tokens.accessToken;
      } catch (err) {
        if (err.kind !== 'refresh_refused') {
          throw err;
        }
        // Never renewed again with a refused refresh token: the password signs in.
        this.tokens = null;
        await this.changed();
      }
    }
    if (!signIn) {
      throw new SchlageError('unauthorized', 'no valid token');
    }
    if (this.signedInThisCycle) {
      throw new SchlageError('session_refused', 'the session was refused after a new sign-in');
    }
    this.signedInThisCycle = true;
    const tokens = await this.signIn();
    return tokens.accessToken;
  }

  /** One request to the Schlage API with a given token. */
  async send(method, path, token, { payload, timeout, startBy } = {}) {
    if (startBy !== undefined && this.now() > startBy) {
      throw new SchlageError('late', 'the command deadline passed');
    }
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Api-Key': API.key,
      'User-Agent': API.userAgent,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const answer = await this.transport(`${this.apiUrl}/${path}`, {
      method,
      headers,
      body,
      timeout:
        (typeof timeout === 'function' ? timeout() : timeout) ??
        this.timeout ??
        TIMINGS.requestTimeout,
    });
    const error = apiError(answer, this.now());
    if (error) {
      throw error;
    }
    return parseJson(answer.body);
  }

  /**
   * An authenticated call. A refused access token is renewed once (refresh
   * token first) and the call tried once more; refused again it is
   * `session_refused` and the caller stops. `retry: false` (commands): a
   * refused token is never retried, the command is refused.
   */
  async call(method, path, { retry = true, signIn = true, ...options } = {}) {
    const token = await this.token({ signIn });
    try {
      return await this.send(method, path, token, options);
    } catch (err) {
      if (err.kind !== 'unauthorized' || !retry) {
        if (err.kind === 'unauthorized' && this.tokens?.accessToken === token) {
          // The next call renews it first.
          this.tokens = { ...this.tokens, expiresAt: 0 };
        }
        throw err;
      }
      if (this.renewedThisCycle) {
        throw new SchlageError('session_refused', 'the access token was refused again', {
          status: err.status,
        });
      }
    }
    this.renewedThisCycle = true;
    const renewed = await this.token({ force: true, signIn });
    try {
      return await this.send(method, path, renewed, options);
    } catch (err) {
      if (err.kind === 'unauthorized') {
        throw new SchlageError('session_refused', 'the access token was refused again', {
          status: err.status,
        });
      }
      throw err;
    }
  }

  /** Every lock of the account (`GET devices?archetype=lock`). */
  async locks() {
    const data = await this.call('GET', 'devices?archetype=lock');
    if (!Array.isArray(data)) {
      throw new SchlageError('bad_response', 'Schlage sent no lock list');
    }
    return data;
  }

  /** One lock, read again (the read before a command: never a new sign-in). */
  async lock(id, options = {}) {
    if (!ID.test(id)) {
      throw new SchlageError('not_found', 'not a lock id');
    }
    const data = await this.call('GET', `devices/${encodeURIComponent(id)}`, {
      retry: false,
      signIn: false,
      ...options,
    });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SchlageError('bad_response', 'Schlage sent no lock');
    }
    return data;
  }

  /** Locks (1) or unlocks (0) a Wi-Fi lock: `PUT devices/{id}` (pyschlage `Lock._toggle`). */
  async setLockState(id, state, options = {}) {
    if (!ID.test(id)) {
      throw new SchlageError('not_found', 'not a lock id');
    }
    return this.call('PUT', `devices/${encodeURIComponent(id)}`, {
      retry: false,
      signIn: false,
      payload: { attributes: { lockState: state } },
      ...options,
    });
  }
}
