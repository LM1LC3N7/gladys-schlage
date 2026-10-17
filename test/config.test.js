import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, accountKey, normalizeConfig } from '../src/config.js';

test('defaults: unlocking off, 60 s, French', () => {
  const config = normalizeConfig();
  assert.equal(config.allowUnlock, false);
  assert.equal(config.pollInterval, 60);
  assert.equal(config.language, 'fr');
  assert.equal(config.email, '');
  assert.equal(config.account, '');
  assert.equal(DEFAULTS.allow_unlock, false);
});

test('the e-mail in lower case, the password as typed, the interval bounded', () => {
  const config = normalizeConfig({
    email: '  Louis@Example.COM ',
    password: ' pass word ',
    poll_interval: '5',
    allow_unlock: 'true',
    language: 'EN',
  });
  assert.equal(config.email, 'louis@example.com');
  assert.equal(config.password, ' pass word ');
  assert.equal(config.pollInterval, 60);
  assert.equal(config.allowUnlock, true);
  assert.equal(config.language, 'en');
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 900);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 60);
  assert.equal(normalizeConfig({ allow_unlock: '' }).allowUnlock, false);
  assert.equal(normalizeConfig({ allow_unlock: false }).allowUnlock, false);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('the account key is a hash, never the e-mail', () => {
  const key = accountKey('louis@example.com');
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.ok(!key.includes('louis'));
  assert.notEqual(key, accountKey('jean@example.com'));
});
