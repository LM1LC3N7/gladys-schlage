// -----------------------------------------------------------------------------
// A fake AWS Cognito and a fake Schlage API behind the transport the
// integration is given (no network). The Cognito side runs the server half of
// SRP: it checks the password proof for real (v = g^x, S = (A v^u)^b), so a
// wrong SRP computation fails here. Optional SMS verification code, refresh
// tokens, and locks that move on `PUT devices/{id}`. Records every request.
// -----------------------------------------------------------------------------

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { COGNITO } from '../../src/constants.js';
import { G, K, N, hexHash, modPow, padHex, poolName, secretHash, toHex } from '../../src/srp.js';
import { CODE, EMAIL, HOUR, PASSWORD, USER_ID, locks } from '../fixtures/schlage.js';

export const COGNITO_URL = 'https://cognito.test/';
export const API_URL = 'https://api.test/v1';
export const API_KEY = 'hnuu9jbbJr7MssFDWm5nU2Z7nG5Q5rxsaqWsE7e9';

const json = (status, body, headers = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : JSON.stringify(body),
});
const cognitoError = (type, message, status = 400) => json(status, { __type: type, message });

const big = (hex) => BigInt(`0x${hex}`);

function hkdf(ikm, salt) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const info = Buffer.concat([Buffer.from('Caldera Derived Key', 'utf8'), Buffer.from([1])]);
  return createHmac('sha256', prk).update(info).digest().subarray(0, 16);
}

const jwt = (claims) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

export function fakeSchlage({ mfa = false, effect = 'final', lifetime = HOUR } = {}) {
  const server = {
    email: EMAIL,
    password: PASSWORD,
    mfa,
    code: CODE,
    /** 'final': a PUT moves the lock at once; 'none': accepted, the lock moves later (move()). */
    effect,
    lifetime,
    locks: locks(),
    requests: [],
    /** Live access tokens -> expiry; refresh tokens. */
    access: new Map(),
    refresh: new Set(),
    srp: new Map(),
    sessions: new Map(),
    issued: [],
    /** Every token or session ever made, to check none reaches the logs. */
    secrets: [],
    down: false,
    /** One-shot answers: { match(request), status, body, headers, before() } */
    queue: [],
    /** The SECRET_HASH of a refresh must be made with this user name (null: any of both). */
    refreshHashUser: null,
    of(target) {
      return this.requests.filter((r) => r.target === target || r.path === target);
    },
    srpStarts() {
      return this.requests.filter((r) => r.flow === 'USER_SRP_AUTH');
    },
    refreshes() {
      return this.requests.filter((r) => r.flow === 'REFRESH_TOKEN_AUTH');
    },
    api() {
      return this.requests.filter((r) => r.host === 'api.test');
    },
    puts() {
      return this.requests.filter((r) => r.method === 'PUT');
    },
    lock(id) {
      return this.locks.find((l) => l.deviceId === id);
    },
    issue() {
      const exp = Math.floor((Date.now() + this.lifetime) / 1000);
      const access = jwt({ sub: USER_ID, username: USER_ID, exp, n: this.issued.length });
      const refresh = `refresh-${randomBytes(8).toString('hex')}`;
      this.access.set(access, exp * 1000);
      this.refresh.add(refresh);
      this.issued.push(access);
      this.secrets.push(access, refresh);
      return { access, refresh, exp };
    },
    /** Refuse every token issued so far (revoked on the server side). */
    revoke() {
      this.access.clear();
      this.refresh.clear();
    },
  };

  const result = ({ access, refresh }, withRefresh = true) => ({
    AuthenticationResult: {
      AccessToken: access,
      IdToken: jwt({ sub: USER_ID, email: EMAIL }),
      ...(withRefresh ? { RefreshToken: refresh } : {}),
      ExpiresIn: Math.round(server.lifetime / 1000),
      TokenType: 'Bearer',
    },
    ChallengeParameters: {},
  });

  function cognito(request) {
    const body = request.body ?? {};
    const target = request.target;
    if (body.ClientId !== COGNITO.clientId) {
      return cognitoError('ResourceNotFoundException', 'User pool client does not exist.');
    }
    const hash = (user) => secretHash(user, COGNITO.clientId, COGNITO.clientSecret);
    if (target === 'InitiateAuth' && body.AuthFlow === 'USER_SRP_AUTH') {
      const { USERNAME, SRP_A, SECRET_HASH } = body.AuthParameters ?? {};
      if (SECRET_HASH !== hash(USERNAME)) {
        return cognitoError('NotAuthorizedException', 'Unable to verify secret hash for client');
      }
      if (USERNAME !== server.email) {
        return cognitoError('UserNotFoundException', 'User does not exist.');
      }
      const salt = randomBytes(16).toString('hex');
      const b = big(randomBytes(64).toString('hex'));
      const identity = createHash('sha256')
        .update(`${poolName(COGNITO.poolId)}${USER_ID}:${server.password}`, 'utf8')
        .digest('hex');
      const x = big(hexHash(padHex(salt) + identity));
      const v = modPow(G, x, N);
      const B = (K * v + modPow(G, b, N)) % N;
      const secretBlock = randomBytes(24).toString('base64');
      server.srp.set(secretBlock, { A: big(SRP_A), B, b, v, salt });
      return json(200, {
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: {
          SALT: salt,
          SECRET_BLOCK: secretBlock,
          SRP_B: toHex(B),
          USERNAME: USER_ID,
          USER_ID_FOR_SRP: USER_ID,
        },
      });
    }
    if (target === 'RespondToAuthChallenge' && body.ChallengeName === 'PASSWORD_VERIFIER') {
      const r = body.ChallengeResponses ?? {};
      if (r.USERNAME !== USER_ID || r.SECRET_HASH !== hash(USER_ID)) {
        return cognitoError('NotAuthorizedException', 'Unable to verify secret hash for client');
      }
      const state = server.srp.get(r.PASSWORD_CLAIM_SECRET_BLOCK);
      server.srp.delete(r.PASSWORD_CLAIM_SECRET_BLOCK);
      if (!state) {
        return cognitoError('NotAuthorizedException', 'Incorrect username or password.');
      }
      const u = big(hexHash(padHex(state.A) + padHex(state.B)));
      const S = modPow(state.A * modPow(state.v, u, N), state.b, N);
      const key = hkdf(Buffer.from(padHex(S), 'hex'), Buffer.from(padHex(toHex(u)), 'hex'));
      const expected = createHmac('sha256', key)
        .update(
          Buffer.concat([
            Buffer.from(poolName(COGNITO.poolId), 'utf8'),
            Buffer.from(USER_ID, 'utf8'),
            Buffer.from(r.PASSWORD_CLAIM_SECRET_BLOCK, 'base64'),
            Buffer.from(r.TIMESTAMP ?? '', 'utf8'),
          ]),
        )
        .digest('base64');
      server.lastTimestamp = r.TIMESTAMP;
      if (expected !== r.PASSWORD_CLAIM_SIGNATURE) {
        return cognitoError('NotAuthorizedException', 'Incorrect username or password.');
      }
      if (server.mfa) {
        const session = `session-${randomBytes(8).toString('hex')}`;
        server.sessions.set(session, Date.now());
        server.secrets.push(session);
        server.codesSent = (server.codesSent ?? 0) + 1;
        return json(200, {
          ChallengeName: 'SMS_MFA',
          Session: session,
          ChallengeParameters: {
            CODE_DELIVERY_DELIVERY_MEDIUM: 'SMS',
            CODE_DELIVERY_DESTINATION: '+*******1234',
          },
        });
      }
      return json(200, result(server.issue()));
    }
    if (target === 'RespondToAuthChallenge' && body.ChallengeName === 'SMS_MFA') {
      const r = body.ChallengeResponses ?? {};
      const at = server.sessions.get(body.Session);
      if (at === undefined || Date.now() - at > 3 * 60_000) {
        return cognitoError(
          'NotAuthorizedException',
          'Invalid session for the user, session is expired.',
        );
      }
      if (r.USERNAME !== USER_ID || r.SECRET_HASH !== hash(USER_ID)) {
        return cognitoError('NotAuthorizedException', 'Unable to verify secret hash for client');
      }
      if (r.SMS_MFA_CODE !== server.code) {
        return cognitoError('CodeMismatchException', 'Invalid code or auth state for the user.');
      }
      server.sessions.delete(body.Session);
      return json(200, result(server.issue()));
    }
    if (target === 'InitiateAuth' && body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
      const { REFRESH_TOKEN, SECRET_HASH } = body.AuthParameters ?? {};
      const allowed = server.refreshHashUser ? [server.refreshHashUser] : [EMAIL, USER_ID];
      if (!allowed.some((user) => hash(user) === SECRET_HASH)) {
        return cognitoError('NotAuthorizedException', 'SecretHash does not match for the client');
      }
      if (!server.refresh.has(REFRESH_TOKEN)) {
        return cognitoError('NotAuthorizedException', 'Refresh Token has expired');
      }
      const issued = server.issue();
      server.refresh.delete(issued.refresh);
      return json(200, result(issued, false));
    }
    return cognitoError('InvalidParameterException', 'unexpected request');
  }

  function api(request) {
    const token = String(request.headers.Authorization ?? '').replace(/^Bearer /, '');
    if (request.headers['X-Api-Key'] !== API_KEY) {
      return json(403, { message: 'Forbidden' });
    }
    const exp = server.access.get(token);
    if (exp === undefined || Date.now() >= exp) {
      return json(401, { message: 'Unauthorized' });
    }
    const path = request.path.replace(/^\/v1\//, '');
    let match;
    if (request.method === 'GET' && path === 'devices' && request.query.archetype === 'lock') {
      return json(200, server.locks);
    }
    if ((match = /^devices\/([^/]+)$/.exec(path))) {
      const lock = server.lock(decodeURIComponent(match[1]));
      if (!lock) {
        return json(404, { message: 'Not found' });
      }
      if (request.method === 'GET') {
        return json(200, lock);
      }
      if (request.method === 'PUT') {
        const state = request.body?.attributes?.lockState;
        if (state !== 0 && state !== 1) {
          return json(400, { message: 'Bad request' });
        }
        if (server.effect === 'final') {
          lock.attributes.lockState = state;
          lock.attributes.lockStateMetadata = {
            actionType: 'virtualKey',
            UUID: 'identity-louis',
            name: null,
          };
        }
        // The answer carries the requested state, as the shadow's desired one.
        return json(200, { ...lock, attributes: { ...lock.attributes, lockState: state } });
      }
    }
    return json(404, { message: 'Not found' });
  }

  server.transport = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const target = new URL(url);
    const parsed = body === undefined ? undefined : JSON.parse(body);
    const request = {
      method,
      host: target.host,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers,
      body: parsed,
      target: headers['X-Amz-Target']?.replace('AWSCognitoIdentityProviderService.', ''),
      flow: parsed?.AuthFlow,
    };
    server.requests.push(request);
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [entry] = server.queue.splice(forced, 1);
      entry.before?.();
      if (entry.throws) {
        throw entry.throws;
      }
      if (entry.status) {
        return json(entry.status, entry.body, entry.headers);
      }
    }
    if (server.down) {
      const { SchlageError } = await import('../../src/http.js');
      throw new SchlageError('network', 'connection refused');
    }
    if (target.host === 'cognito.test') {
      return cognito(request);
    }
    if (target.host === 'api.test') {
      return api(request);
    }
    return json(404, {});
  };

  return server;
}

/** An in-memory store, in place of the /data file. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
