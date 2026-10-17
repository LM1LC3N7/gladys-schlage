// -----------------------------------------------------------------------------
// The pure parts: the lock documents, the Gladys devices and states, the
// Cognito and API error mapping.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CognitoClient, cognitoCode } from '../src/cognito.js';
import { apiError } from '../src/client.js';
import { buildDevice, lastAction, parseFeatureId, rolesOf, statesOf } from '../src/devices.js';
import { isJammed, isStill, isWifiLock, lockedOf, parseLock, parseLocks } from '../src/schlage.js';
import { normalizeMemory } from '../src/store.js';
import { IDS, NOW, HOUR, SECRETS, locks } from './fixtures/schlage.js';

const [FRONT, BACK, SENSE] = locks();

test('a lock document: state, battery, door, setting, actor; never CAT, MAC or e-mails', () => {
  const lock = parseLock(FRONT);
  assert.deepEqual(lock, {
    id: IDS.front,
    name: 'Porte d’entrée',
    model: 'BE489WB1 619',
    type: 'be489wifi',
    connected: true,
    lockState: 1,
    battery: 87,
    door: 2,
    lockAndLeave: true,
    method: 'manual',
    by: undefined,
  });
  for (const secret of SECRETS) {
    assert.ok(!JSON.stringify(lock).includes(secret));
  }
  assert.equal(parseLock(BACK).by, 'Jean');
  assert.equal(parseLock(BACK).method, 'keypad');
  assert.equal(parseLock(SENSE).lockAndLeave, undefined);
});

test('a name that looks like an e-mail is never "by whom"', () => {
  const app = parseLock({
    ...FRONT,
    users: [{ identityId: 'u1', friendlyName: 'louis@example.com' }],
    attributes: { lockState: 0, lockStateMetadata: { actionType: 'virtualKey', UUID: 'u1' } },
  });
  assert.equal(app.method, 'app');
  assert.equal(app.by, undefined);
  const code = parseLock({
    ...FRONT,
    attributes: { lockState: 0, lockStateMetadata: { actionType: 'accesscode', name: 'a@b.c' } },
  });
  assert.equal(code.by, undefined);
});

test('a Cognito user name with an @ is never kept in /data', () => {
  const memory = normalizeMemory(
    { account: 'abc', tokens: { refreshToken: 'r', username: 'louis@example.com' } },
    NOW,
  );
  assert.equal(memory.tokens.username, undefined);
  assert.equal(
    normalizeMemory({ account: 'abc', tokens: { refreshToken: 'r', username: 'sub-1' } }, NOW)
      .tokens.username,
    'sub-1',
  );
});

test('lock states as pyschlage maps them', () => {
  const at = (lockState) => ({ ...parseLock(FRONT), lockState });
  assert.equal(lockedOf(at(1)), true);
  assert.equal(lockedOf(at(6)), true, 'deadlocked');
  assert.equal(lockedOf(at(0)), false);
  assert.equal(lockedOf(at(5)), false, 'passage mode');
  for (const state of [2, 3, 4, -1, undefined]) {
    assert.equal(lockedOf(at(state)), undefined, String(state));
    assert.equal(isStill(at(state)), false);
  }
  assert.equal(isJammed(at(2)), true);
  assert.equal(isJammed(at(4)), true);
});

test('Wi-Fi families: Encode, Encode Plus, Lever…; Sense is not', () => {
  assert.equal(isWifiLock(parseLock(FRONT)), true);
  assert.equal(isWifiLock(parseLock(BACK)), true);
  assert.equal(isWifiLock(parseLock(SENSE)), false);
  assert.equal(isWifiLock({ type: 'fe789wifi2' }), true);
});

test('hostile documents are dropped or bounded', () => {
  assert.equal(parseLock(null), undefined);
  assert.equal(parseLock({ deviceId: '../x' }), undefined);
  assert.equal(parseLock({ deviceId: 'ok', attributes: [] }).lockState, undefined);
  const long = parseLock({
    deviceId: 'ok',
    name: `a\u0000${'b'.repeat(500)}`,
    attributes: { batteryLevel: 300 },
  });
  assert.equal(long.name.length, 80);
  assert.ok(!long.name.includes('\u0000'));
  assert.equal(long.battery, undefined);
  const many = parseLocks(Array.from({ length: 80 }, (_, i) => ({ deviceId: `id${i}` })));
  assert.equal(many.size, 50);
  assert.equal(parseLocks({}).size, 0);
});

test('the devices: roles, external ids, read-only state, no secret', () => {
  const gladys = createFakeGladys();
  const device = buildDevice(gladys, parseLock(FRONT), 'fr');
  assert.equal(device.external_id, `ext:test-integration:schlage:${IDS.front}`);
  assert.deepEqual(
    device.features.map((f) => [f.external_id.split(':').pop(), f.category, f.type, f.read_only]),
    [
      ['lock', 'lock', 'binary', false],
      ['state', 'lock', 'state', true],
      ['jammed', 'unknown', 'binary', true],
      ['battery', 'battery', 'integer', true],
      ['door', 'opening-sensor', 'binary', true],
      ['last-action', 'text', 'text', true],
      ['lock-and-leave', 'unknown', 'binary', true],
    ],
  );
  assert.equal(device.features.find((f) => f.type === 'integer').unit, 'percent');
  for (const secret of SECRETS) {
    assert.ok(!JSON.stringify(device).includes(secret));
  }
  assert.deepEqual(parseFeatureId(`${device.external_id}:last-action`), {
    id: IDS.front,
    role: 'last-action',
  });
  assert.equal(parseFeatureId(`${device.external_id}:other`), undefined);
});

test('a device keeps the roles it was created with', () => {
  const lock = parseLock({ ...BACK, attributes: { lockState: 1 } });
  assert.ok(!rolesOf(lock).includes('door'));
  assert.ok(rolesOf(lock, new Set(['door', 'lock-and-leave'])).includes('door'));
});

test('the states; a command in progress hides the position', () => {
  const lock = parseLock(FRONT);
  assert.deepEqual(statesOf(lock, 'en'), [
    { role: 'lock', state: 1 },
    { role: 'state', state: 1 },
    { role: 'jammed', state: 0 },
    { role: 'battery', state: 87 },
    { role: 'door', state: 1 },
    { role: 'lock-and-leave', state: 1 },
    { role: 'last-action', text: 'Locked by hand (thumbturn)' },
  ]);
  const moving = statesOf(lock, 'en', { moving: true });
  assert.ok(!moving.some((s) => s.role === 'lock' || s.role === 'last-action'));
  assert.deepEqual(
    moving.find((s) => s.role === 'state'),
    { role: 'state', state: 2 },
  );
  assert.deepEqual(statesOf({ ...lock, connected: false }, 'en'), []);
  const jammed = statesOf({ ...lock, lockState: 4 }, 'fr');
  assert.deepEqual(
    jammed.find((s) => s.role === 'state'),
    { role: 'state', state: 3 },
  );
  assert.equal(
    jammed.find((s) => s.role === 'lock'),
    undefined,
  );
  assert.equal(lastAction({ ...lock, lockState: 4, method: 'other' }, 'fr'), 'Bloquée (bourrage)');
  assert.equal(
    statesOf({ ...lock, door: 3 }, 'en').find((s) => s.role === 'door'),
    undefined,
  );
});

test('Cognito error types', () => {
  assert.equal(cognitoCode({ __type: 'NotAuthorizedException' }), 'NotAuthorizedException');
  assert.equal(
    cognitoCode({ __type: 'com.amazonaws.cognito#UserNotFoundException' }),
    'UserNotFoundException',
  );
  assert.equal(cognitoCode({ __type: '<script>' }), undefined);
});

test('Cognito answers -> error kinds; the message of Cognito is never carried', async () => {
  const answer =
    (status, body, headers = {}) =>
    async () => ({
      status,
      headers,
      body: JSON.stringify(body),
    });
  const kindOf = async (transport, options) => {
    const client = new CognitoClient({ transport, url: 'https://cognito.test/' });
    try {
      await client.call('InitiateAuth', {}, options);
      return 'ok';
    } catch (err) {
      return [err.kind, err.message, err.retryAfter];
    }
  };
  assert.deepEqual(
    await kindOf(
      answer(400, {
        __type: 'NotAuthorizedException',
        message: 'Incorrect username or password for louis@example.com',
      }),
    ),
    ['refused', 'refused by Cognito', undefined],
  );
  assert.equal((await kindOf(answer(400, { __type: 'UserNotConfirmedException' })))[0], 'refused');
  assert.equal(
    (
      await kindOf(answer(400, { __type: 'NotAuthorizedException' }), {
        refusal: 'refresh_refused',
      })
    )[0],
    'refresh_refused',
  );
  assert.equal(
    (
      await kindOf(
        answer(400, { __type: 'NotAuthorizedException', message: 'SecretHash does not match' }),
      )
    )[0],
    'secret_hash',
  );
  assert.deepEqual(
    await kindOf(answer(400, { __type: 'TooManyRequestsException' }, { 'retry-after': '120' })),
    ['rate_limited', 'too many sign-in requests', 120_000],
  );
  assert.equal((await kindOf(answer(400, { __type: 'CodeMismatchException' })))[0], 'code_refused');
  assert.equal((await kindOf(answer(500, { __type: 'InternalErrorException' })))[0], 'unavailable');
  assert.equal((await kindOf(answer(400, { __type: 'InvalidParameterException' })))[0], 'http');
  assert.equal((await kindOf(async () => ({ status: 200, body: 'nope' })))[0], 'bad_response');
});

test('Cognito challenges: code, new password, others', () => {
  const client = new CognitoClient({ now: () => NOW });
  assert.throws(
    () => client.outcome({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 's' }, 'u'),
    (err) => err.kind === 'two_factor' && err.pending.challenge === 'SOFTWARE_TOKEN_MFA',
  );
  assert.throws(
    () => client.outcome({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' }, 'u'),
    (err) => err.kind === 'new_password',
  );
  assert.throws(
    () => client.outcome({ ChallengeName: 'SELECT_MFA_TYPE', Session: 's' }, 'u'),
    (err) => err.kind === 'unsupported_challenge' && err.challenge === 'SELECT_MFA_TYPE',
  );
});

test('API statuses -> error kinds', () => {
  assert.equal(apiError({ status: 200 }), undefined);
  assert.equal(apiError({ status: 401 }).kind, 'unauthorized');
  assert.equal(apiError({ status: 403 }).kind, 'forbidden');
  assert.equal(apiError({ status: 404 }).kind, 'not_found');
  assert.equal(apiError({ status: 429, headers: { 'retry-after': '30' } }).retryAfter, 30_000);
  assert.equal(apiError({ status: 502 }).kind, 'unavailable');
  assert.equal(apiError({ status: 418 }).kind, 'http');
});

test('the memory of /data is repaired and its pauses capped', () => {
  assert.deepEqual(normalizeMemory(null, NOW), {
    account: '',
    tokens: null,
    pause: null,
    block: null,
    codeRequired: false,
  });
  const memory = normalizeMemory(
    {
      account: 'abc',
      tokens: { refreshToken: 'r', expiresAt: 'soon' },
      pause: { kind: 'rate', until: NOW + 1000 * HOUR },
      block: { kind: 'refused', retries: 99, retryAt: NOW + 1000 * HOUR },
    },
    NOW,
  );
  assert.equal(memory.tokens.expiresAt, 0);
  assert.equal(memory.pause.until, NOW + 6 * HOUR);
  assert.equal(memory.block.retryAt, NOW + 24 * HOUR);
  assert.equal(memory.block.retries, 10);
  assert.equal(normalizeMemory({ account: 'abc', block: { kind: 'other' } }, NOW).block, null);
  assert.equal(normalizeMemory({ tokens: { accessToken: 'a' } }, NOW).tokens, null, 'no account');
});
