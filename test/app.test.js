// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, a fake Cognito (real SRP check) and a fake Schlage API behind the
// transport. Timers and Date are mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SchlageApp } from '../src/app.js';
import { accountKey } from '../src/config.js';
import { ACTIONS, SCENE_TRIGGERS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import {
  CODE,
  EMAIL,
  HOUR,
  IDS,
  MINUTE,
  NOW,
  PASSWORD,
  SECRETS,
  SECOND,
} from './fixtures/schlage.js';
import { API_URL, COGNITO_URL, fakeSchlage, memoryStore, settle } from './helpers/fakeSchlage.js';

const CONFIG = { email: EMAIL, password: PASSWORD };
const dev = (id) => `ext:test-integration:schlage:${id}`;

async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    server = fakeSchlage(),
    create = true,
    logs = [],
    timers = true,
  } = {},
) {
  if (timers) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  }
  const gladys = createFakeGladys({ config });
  const app = new SchlageApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
    cognitoUrl: COGNITO_URL,
    apiUrl: API_URL,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = 5 * SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
    await settle();
  }
  return { gladys, app, server, store, advance, logs };
}

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const deviceOf = (gladys, id) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === dev(id));
const set = (gladys, id, value) => {
  const device = deviceOf(gladys, id);
  const feature = device.features.find((f) => f.external_id === `${dev(id)}:lock`);
  return gladys.fake.setValue(device, feature, value);
};
const last = (gladys, id, role) => gladys.fake.lastState(`${dev(id)}:${role}`);
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const badgeOf = (gladys, id) =>
  gladys.fake.transports.filter((b) => b.device_external_id === dev(id)).at(-1);

function assertNoSecret(where, text, server) {
  for (const secret of [PASSWORD, ...SECRETS, ...server.secrets]) {
    assert.ok(!text.includes(secret), `${where} holds a secret`);
  }
}

test('without credentials, the status asks for them and nothing is requested', async (t) => {
  const { gladys, server } = await setup(t, { config: { email: '', password: '' } });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /e-mail and the password of your Schlage account/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /e-mail et le mot de passe/);
});

test('start: an SRP sign-in checked by Cognito, the lock list, devices, states, status', async (t) => {
  const { gladys, server, store, logs } = await setup(t);
  assert.deepEqual(
    server.requests.map((r) => r.target ?? `${r.method} ${r.path}`),
    ['InitiateAuth', 'RespondToAuthChallenge', 'GET /v1/devices'],
  );
  assert.match(
    server.lastTimestamp,
    /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d UTC \d{4}$/,
  );
  const [read] = server.api();
  assert.equal(read.headers['X-Api-Key'], 'hnuu9jbbJr7MssFDWm5nU2Z7nG5Q5rxsaqWsE7e9');
  assert.match(read.headers.Authorization, /^Bearer /);
  assert.ok(
    !JSON.stringify(server.requests).includes(PASSWORD),
    'SRP: the password itself is never sent',
  );

  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'Connected to Schlage: 3 locks. Open Discovery to add them.',
      fr: 'Connecté à Schlage : 3 serrures. Ouvrez Découverte pour les ajouter.',
    },
  });
  const front = deviceOf(gladys, IDS.front);
  assert.equal(front.name, 'Porte d’entrée');
  assert.deepEqual(
    front.features.map((f) => f.external_id.split(':').pop()),
    ['lock', 'state', 'jammed', 'battery', 'door', 'last-action', 'lock-and-leave'],
  );
  const lock = front.features.find((f) => f.external_id.endsWith(':lock'));
  assert.equal(lock.read_only, false);
  assert.deepEqual(
    deviceOf(gladys, IDS.back).features.map((f) => f.external_id.split(':').pop()),
    ['lock', 'state', 'jammed', 'battery', 'last-action', 'lock-and-leave'],
  );

  assert.equal(last(gladys, IDS.front, 'lock'), 1);
  assert.equal(last(gladys, IDS.front, 'state'), 1);
  assert.equal(last(gladys, IDS.front, 'jammed'), 0);
  assert.equal(last(gladys, IDS.front, 'battery'), 87);
  assert.equal(last(gladys, IDS.front, 'door'), 1);
  assert.equal(last(gladys, IDS.front, 'lock-and-leave'), 1);
  assert.equal(last(gladys, IDS.front, 'last-action'), 'Verrouillée à la main (tourniquet)');
  assert.equal(last(gladys, IDS.back, 'lock'), 0);
  assert.equal(last(gladys, IDS.back, 'last-action'), 'Déverrouillée au clavier (Jean)');
  assert.equal(badgeOf(gladys, IDS.front).transport, 'cloud');

  // Never in Gladys, /data or the logs: the password, the tokens, CAT/SAT, MAC, e-mails.
  assertNoSecret('the devices', JSON.stringify(gladys.fake.discoveredDevices), server);
  assertNoSecret('the states', JSON.stringify(gladys.fake.states), server);
  assertNoSecret('the logs', logs.join('\n'), server);
  const kept = JSON.stringify(store.data);
  assert.ok(!kept.includes(PASSWORD) && !kept.includes(EMAIL), 'no password nor e-mail in /data');
  assert.equal(store.data.account, accountKey(EMAIL));
  assert.ok(store.data.tokens.refreshToken.startsWith('refresh-'));
});

test('the tokens are renewed from the refresh token, never a new sign-in each cycle', async (t) => {
  const { server, advance, gladys } = await setup(t);
  await advance(3 * HOUR, 30 * SECOND);
  assert.equal(server.srpStarts().length, 1, 'one sign-in only');
  assert.ok(server.refreshes().length >= 3, 'renewed about every hour');
  assert.ok(server.refreshes().length <= 4, 'not at each cycle');
  assert.ok(server.of('/v1/devices').length >= 170, 'read every minute');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a restart reuses the tokens kept in /data: no new sign-in', async (t) => {
  const store = memoryStore();
  const server = fakeSchlage();
  const first = await setup(t, { store, server });
  first.app.stop();
  const before = server.srpStarts().length;
  const gladys = createFakeGladys({ config: CONFIG });
  const app = new SchlageApp({
    gladys,
    logger: recorder([]),
    transport: server.transport,
    now: () => Date.now(),
    store,
    cognitoUrl: COGNITO_URL,
    apiUrl: API_URL,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  await settle();
  assert.equal(server.srpStarts().length, before);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('another e-mail drops the tokens of the previous account', async (t) => {
  const { gladys, server } = await setup(t);
  server.email = 'other@example.com';
  await gladys.fake.configUpdated({ email: 'other@example.com', password: PASSWORD });
  await settle();
  assert.equal(server.srpStarts().length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a refused refresh token signs in once with the password, never in a loop', async (t) => {
  const { server, advance, gladys } = await setup(t);
  server.refresh.clear();
  await advance(HOUR, 30 * SECOND);
  assert.equal(server.srpStarts().length, 2);
  assert.equal(server.refreshes().length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the refresh SECRET_HASH falls back to the Cognito user name', async (t) => {
  const { server, advance } = await setup(t);
  server.refreshHashUser = '7d9b2f30-1c4e-4a5b-9e8f-0a1b2c3d4e5f';
  await advance(HOUR, 30 * SECOND);
  assert.equal(server.refreshes().length, 2, 'the e-mail, then the user name');
  assert.equal(server.srpStarts().length, 1, 'no new sign-in');
});

test('a refused password stops; one try after 1 h; a reconnection keeps the stop; saving retries', async (t) => {
  const server = fakeSchlage();
  server.password = 'something else';
  const { gladys, app, advance, store } = await setup(t, { server });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /refused the e-mail or the password/);
  assert.equal(store.data.block.kind, 'refused');
  await app.connected(CONFIG);
  await advance(50 * MINUTE, MINUTE);
  assert.equal(server.srpStarts().length, 1, 'no new try within the hour, reconnection included');
  await advance(15 * MINUTE, MINUTE);
  assert.equal(server.srpStarts().length, 2, 'one spaced new try');
  await advance(5 * HOUR, 10 * MINUTE);
  assert.equal(server.srpStarts().length, 2, 'then 6 h');
  server.password = 'new password';
  await gladys.fake.configUpdated({ email: EMAIL, password: 'new password' });
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.block, null);
});

test('a stop and a 429 pause survive a restart of the container', async (t) => {
  const store = memoryStore({
    account: accountKey(EMAIL),
    tokens: null,
    pause: { kind: 'rate', until: NOW + 30 * MINUTE },
    block: null,
  });
  const { server, gladys, advance } = await setup(t, { store });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).en, /slow down/);
  await advance(29 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 0);
  await advance(2 * MINUTE, MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a pause read back from /data is capped at 6 h', async (t) => {
  const store = memoryStore({
    account: accountKey(EMAIL),
    pause: { kind: 'rate', until: NOW + 400 * 24 * HOUR },
  });
  const { server, advance } = await setup(t, { store });
  await advance(6 * HOUR + MINUTE, 10 * MINUTE);
  assert.ok(server.requests.length > 0);
});

test('429 on the lock list: a bounded pause for every path, kept in /data', async (t) => {
  const { gladys, server, advance, store, app } = await setup(t);
  server.queue.push({
    match: (r) => r.path === '/v1/devices',
    status: 429,
    body: { message: 'Too Many Requests' },
    headers: { 'retry-after': '1200' },
  });
  await advance(MINUTE);
  assert.match(message(gladys).en, /pausing for 20 min/);
  assert.equal(store.data.pause.kind, 'rate');
  const count = server.requests.length;
  const lock = await set(gladys, IDS.front, 1);
  assert.equal(lock.success, false);
  assert.match(lock.error, /ralentir/);
  const test = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(test.data.message.en, /slow down/);
  await app.connected(CONFIG);
  await gladys.fake.scanRequest();
  await advance(18 * MINUTE, MINUTE);
  assert.equal(server.requests.length, count, 'nothing during the pause');
  await advance(3 * MINUTE, MINUTE);
  assert.ok(server.requests.length > count);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a network failure backs off, never faster than the interval', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.down = true;
  await advance(MINUTE);
  assert.match(message(gladys).en, /cannot be reached/);
  const count = server.requests.length;
  await advance(59 * SECOND, SECOND);
  assert.equal(server.requests.length, count);
  server.down = false;
  await advance(10 * MINUTE, 10 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a 401 renews the token once and retries; refused again it stops, spaced', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.access.clear();
  await advance(MINUTE);
  assert.equal(server.refreshes().length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  server.queue.push(
    { match: (r) => r.path === '/v1/devices', status: 401, body: {} },
    { match: (r) => r.path === '/v1/devices', status: 401, body: {} },
  );
  await advance(MINUTE);
  assert.match(message(gladys).en, /refused the session again/);
  const count = server.requests.length;
  await advance(55 * MINUTE, MINUTE);
  assert.equal(server.requests.length, count);
});

test('a verification code: never asked again by itself, then the code connects', async (t) => {
  const server = fakeSchlage({ mfa: true });
  const { gladys, advance, store, app } = await setup(t, { server });
  assert.equal(server.codesSent, 1);
  assert.match(message(gladys).en, /asks for a verification code/);
  assert.equal(store.data.block.kind, 'two_factor');
  await app.connected(CONFIG);
  await advance(2 * HOUR, 10 * MINUTE);
  assert.equal(server.codesSent, 1, 'no new code by itself');
  // The pending sign-in of the start expired (3 min): a new one with the button.
  let ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /expired|No sign-in is waiting/);
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE);
  assert.match(ack.data.message.en, /sent a code \(\+\*{7}1234\)/);
  assert.equal(server.codesSent, 2);
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE);
  assert.match(ack.data.message.en, /less than a minute ago/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: '000000' });
  assert.match(ack.data.message.en, /refused the code/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: 'abc' });
  assert.match(ack.data.message.en, /6 to 8 digits/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, {
    code: ` ${CODE.slice(0, 3)}-${CODE.slice(3)} `,
  });
  assert.match(ack.data.message.en, /Code accepted/);
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.block, null);
  assertNoSecret(
    '/data',
    JSON.stringify(store.data)
      .replace(store.data.tokens.accessToken, '')
      .replace(store.data.tokens.refreshToken, ''),
    { secrets: [...server.sessions.keys()] },
  );
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE);
  assert.match(ack.data.message.en, /Already connected/);
});

test('a code that has just arrived can be typed at once', async (t) => {
  const server = fakeSchlage({ mfa: true });
  const { gladys } = await setup(t, { server });
  const ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /Code accepted/);
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(server.codesSent, 1);
});

// --- Commands ------------------------------------------------------------------

test('locking is always allowed, after a fresh read; shown moving until a read ends it', async (t) => {
  const server = fakeSchlage({ effect: 'none' });
  const { gladys, advance } = await setup(t, { server });
  server.requests.length = 0;
  const ack = await set(gladys, IDS.back, 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    server.requests.map((r) => `${r.method} ${r.path}`),
    [`GET /v1/devices/${IDS.back}`, `PUT /v1/devices/${IDS.back}`],
  );
  assert.deepEqual(server.puts()[0].body, { attributes: { lockState: 1 } });
  await settle();
  assert.equal(last(gladys, IDS.back, 'state'), 2, 'moving');
  // The answer carried lockState 1, but the lock has not moved: still moving.
  await advance(5 * SECOND, SECOND);
  assert.equal(last(gladys, IDS.back, 'state'), 2);
  server.lock(IDS.back).attributes.lockState = 1;
  await advance(10 * SECOND, SECOND);
  assert.equal(last(gladys, IDS.back, 'state'), 1);
  assert.equal(last(gladys, IDS.back, 'lock'), 1);
});

test('locking a locked lock sends nothing', async (t) => {
  const { gladys, server } = await setup(t);
  const ack = await set(gladys, IDS.front, 1);
  assert.equal(ack.success, true);
  assert.equal(server.puts().length, 0);
  assert.equal(server.of(`/v1/devices/${IDS.front}`).length, 1);
});

test('unlocking is refused by default, without asking Schlage', async (t) => {
  const { gladys, server } = await setup(t);
  const count = server.requests.length;
  const ack = await set(gladys, IDS.front, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /déverrouillage depuis Gladys est désactivé/);
  assert.equal(server.requests.length, count);
});

test('unlocking with allow_unlock', async (t) => {
  const { gladys, server, advance } = await setup(t, { config: { ...CONFIG, allow_unlock: true } });
  const ack = await set(gladys, IDS.front, 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.puts()[0].body, { attributes: { lockState: 0 } });
  await advance(5 * SECOND, SECOND);
  assert.equal(last(gladys, IDS.front, 'lock'), 0);
  assert.equal(last(gladys, IDS.front, 'last-action'), "Déverrouillée par l'application (Louis)");
});

test('allow_unlock turned off applies at once', async (t) => {
  const { gladys, app, server } = await setup(t, { config: { ...CONFIG, allow_unlock: true } });
  await app.configUpdated({ ...CONFIG, allow_unlock: false });
  const ack = await set(gladys, IDS.front, 0);
  assert.equal(ack.success, false);
  assert.equal(server.puts().length, 0);
});

test('refused when the lock is offline, jammed, or in an unknown state', async (t) => {
  const { gladys, server } = await setup(t, { config: { ...CONFIG, allow_unlock: true } });
  const cases = [
    [{ connected: false }, {}, /hors ligne/],
    [{}, { lockState: 2 }, /bourrage/],
    [{}, { lockState: 4 }, /bourrage/],
    [{}, { lockState: 3 }, /inconnu/],
    [{}, { lockState: -1 }, /inconnu/],
    [{}, { lockState: undefined }, /inconnu/],
  ];
  for (const [top, attributes, pattern] of cases) {
    const lock = server.lock(IDS.back);
    Object.assign(lock, { connected: true }, top);
    Object.assign(lock.attributes, { lockState: 0 }, attributes);
    const ack = await set(gladys, IDS.back, 1);
    assert.equal(ack.success, false, JSON.stringify([top, attributes]));
    assert.match(ack.error, pattern, JSON.stringify([top, attributes]));
  }
  assert.equal(server.puts().length, 0);
});

test('the state in memory is never trusted: a failed read refuses', async (t) => {
  const { gladys, server } = await setup(t);
  server.queue.push({ match: (r) => r.path === `/v1/devices/${IDS.back}`, status: 503, body: {} });
  const ack = await set(gladys, IDS.back, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'a pas pu être relu/);
  assert.equal(server.puts().length, 0);
});

test('a command not sent within 3.5 s is refused, nothing sent', async (t) => {
  const { gladys, server } = await setup(t);
  server.queue.push({
    match: (r) => r.method === 'GET' && r.path === `/v1/devices/${IDS.back}`,
    before: () => t.mock.timers.tick(3_600),
  });
  const ack = await set(gladys, IDS.back, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /trop tard/);
  assert.equal(server.puts().length, 0);
});

test('one command at a time per lock: the second one is refused while the first moves', async (t) => {
  const server = fakeSchlage({ effect: 'none' });
  const { gladys } = await setup(t, { server });
  const [a, b] = await Promise.all([set(gladys, IDS.back, 1), set(gladys, IDS.back, 1)]);
  assert.equal(a.success, true, a.error);
  assert.equal(b.success, false);
  assert.match(b.error, /encore en cours/);
  assert.equal(server.puts().length, 1);
  assert.equal(server.of(`/v1/devices/${IDS.back}`).filter((r) => r.method === 'GET').length, 2);
});

test('the guard ends after 45 s without the expected state', async (t) => {
  const server = fakeSchlage({ effect: 'none' });
  const { gladys, advance } = await setup(t, { server });
  await set(gladys, IDS.back, 1);
  await advance(40 * SECOND, SECOND);
  let ack = await set(gladys, IDS.back, 1);
  assert.match(ack.error, /encore en cours/);
  await advance(10 * SECOND, SECOND);
  assert.equal(last(gladys, IDS.back, 'state'), 0, 'shown as read again');
  ack = await set(gladys, IDS.back, 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(server.puts().length, 2);
});

test('a timeout of the command keeps the guard: the lock may move anyway', async (t) => {
  const { SchlageError } = await import('../src/http.js');
  const { gladys, server } = await setup(t);
  server.queue.push({
    match: (r) => r.method === 'PUT',
    throws: new SchlageError('timeout', 'no answer'),
  });
  let ack = await set(gladys, IDS.back, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée mais Schlage n'a pas répondu/);
  ack = await set(gladys, IDS.back, 1);
  assert.match(ack.error, /encore en cours/);
});

test('a Sense lock (not Wi-Fi) is read only', async (t) => {
  const { gladys, server } = await setup(t);
  const ack = await set(gladys, IDS.sense, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /lecture seule/);
  assert.equal(server.of(`/v1/devices/${IDS.sense}`).length, 0);
});

test('commands are refused while the account is stopped', async (t) => {
  const server = fakeSchlage({ mfa: true });
  const { gladys, app } = await setup(t, { server });
  app.locks.set(IDS.front, { id: IDS.front, type: 'be489wifi', connected: true, lockState: 0 });
  const ack = await app
    .setValue(null, { external_id: `${dev(IDS.front)}:lock` }, 1)
    .catch((e) => e);
  assert.match(ack.message, /pas connecté/);
  assert.equal(server.api().length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
});

// --- Scene triggers, Gladys reconnection, republication ----------------------------

test('scene triggers: unlocked (method and by), jammed; never on the first read', async (t) => {
  const { gladys, server, advance } = await setup(t);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  Object.assign(server.lock(IDS.front).attributes, {
    lockState: 0,
    lockStateMetadata: { actionType: 'accesscode', UUID: 'code-9', name: 'Nounou' },
  });
  server.lock(IDS.back).attributes.lockState = 2;
  await advance(MINUTE);
  assert.deepEqual(gladys.fake.sceneEvents, [
    {
      key: SCENE_TRIGGERS.UNLOCKED,
      data: { lock: 'Porte d’entrée', method: 'keypad', by: 'Nounou' },
    },
    { key: SCENE_TRIGGERS.JAMMED, data: { lock: 'Back Door' } },
  ]);
  assert.equal(last(gladys, IDS.back, 'jammed'), 1);
  assert.equal(last(gladys, IDS.back, 'state'), 3);
  await advance(MINUTE);
  assert.equal(gladys.fake.sceneEvents.length, 2, 'once per change');
});

test('an unlock by the thumbturn is "manual", by the app names the user', async (t) => {
  const { gladys, server, advance } = await setup(t);
  Object.assign(server.lock(IDS.front).attributes, {
    lockState: 0,
    lockStateMetadata: { actionType: 'virtualKey', UUID: 'identity-jean', name: null },
  });
  await advance(MINUTE);
  assert.deepEqual(gladys.fake.sceneEvents.at(-1).data, {
    lock: 'Porte d’entrée',
    method: 'app',
    by: 'Jean',
  });
});

test('a Gladys reconnection republishes the status and the Discovery list', async (t) => {
  const { gladys, app, server } = await setup(t);
  const statuses = gladys.fake.connectionStatuses.length;
  const discovered = gladys.fake.bodies('POST', '/discovered_device').length;
  await app.connected(CONFIG);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discovered + 1);
  assert.equal(server.srpStarts().length, 1, 'the tokens stay');
});

test('a lock that stops reporting its door keeps its door feature', async (t) => {
  const { gladys, server, advance } = await setup(t);
  delete server.lock(IDS.front).attributes.doorState;
  server.lock(IDS.front).name = 'Entrée';
  await advance(MINUTE);
  const roles = deviceOf(gladys, IDS.front).features.map((f) => f.external_id.split(':').pop());
  assert.ok(roles.includes('door'));
});

test('an offline lock: degraded badge, its values kept', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.lock(IDS.front).connected = false;
  const count = gladys.fake.states.length;
  await advance(MINUTE);
  const badge = badgeOf(gladys, IDS.front);
  assert.equal(badge.transport, 'unreachable');
  assert.equal(badge.degraded, true);
  assert.ok(
    gladys.fake.states
      .slice(count)
      .every((s) => !s.device_feature_external_id.startsWith(dev(IDS.front))),
  );
});

test('the language of the configuration renames the features', async (t) => {
  const { gladys } = await setup(t, { config: { ...CONFIG, language: 'en' } });
  const names = deviceOf(gladys, IDS.front).features.map((f) => f.name);
  assert.ok(names.includes('Lock state'));
  assert.equal(last(gladys, IDS.front, 'last-action'), 'Locked by hand (thumbturn)');
});

test('the test button reads at most every 30 s', async (t) => {
  const { gladys, server } = await setup(t);
  const count = server.requests.length;
  let ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /Connected to Schlage: 3 locks/);
  ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /less than 30 seconds/);
  assert.equal(server.requests.length, count + 1);
});

test('a refused-password stop survives a restart of the container', async (t) => {
  const store = memoryStore({
    account: accountKey(EMAIL),
    tokens: null,
    block: { kind: 'refused', retries: 1, retryAt: NOW + 30 * MINUTE },
  });
  const { server, gladys, advance } = await setup(t, { store });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).en, /refused the e-mail or the password/);
  await advance(29 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 0);
  await advance(2 * MINUTE, MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.block, null);
});

test('Cognito TooManyRequests at sign-in is a 429 pause', async (t) => {
  const server = fakeSchlage();
  server.queue.push({
    match: (r) => r.target === 'InitiateAuth',
    status: 400,
    body: { __type: 'TooManyRequestsException', message: 'Rate exceeded' },
  });
  const { gladys, store, advance } = await setup(t, { server });
  assert.match(message(gladys).en, /slow down: pausing for 5 min/);
  assert.equal(store.data.pause.kind, 'rate');
  await advance(4 * MINUTE, MINUTE);
  assert.equal(server.srpStarts().length, 1);
  await advance(2 * MINUTE, MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a 403 of the API pauses 30 minutes', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.queue.push({ match: (r) => r.path === '/v1/devices', status: 403, body: {} });
  await advance(MINUTE);
  assert.match(message(gladys).en, /HTTP 403/);
  assert.equal(badgeOf(gladys, IDS.front).transport, 'unreachable');
  const count = server.requests.length;
  await advance(29 * MINUTE, MINUTE);
  assert.equal(server.requests.length, count);
  await advance(2 * MINUTE, MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(badgeOf(gladys, IDS.front).transport, 'cloud');
});

test('a new password asked by Cognito stops with its message', async (t) => {
  const server = fakeSchlage();
  server.queue.push({
    match: (r) => r.target === 'RespondToAuthChallenge',
    status: 200,
    body: { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's', ChallengeParameters: {} },
  });
  const { gladys, store } = await setup(t, { server });
  assert.match(message(gladys).en, /asks for a new password/);
  assert.equal(store.data.block.kind, 'new_password');
});
