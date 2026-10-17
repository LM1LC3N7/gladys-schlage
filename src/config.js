// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  // Unlocking is off until the user turns it on (Louis's rule for locks).
  allow_unlock: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** A checkbox may arrive as a boolean or as a string from a form; absent = its default. */
const flag = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value === true || value === 'true' || value === 1 || value === '1';
};

/**
 * The key of an account in /data: a hash of the e-mail, never the e-mail
 * itself. Only tells whether what is kept there belongs to this account.
 */
export const accountKey = (email) =>
  email ? createHash('sha256').update(`schlage:${email}`, 'utf8').digest('hex').slice(0, 32) : '';

export function normalizeConfig(raw = {}) {
  const given = raw?.poll_interval;
  const interval = given === undefined || given === null || given === '' ? NaN : Number(given);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  // The Schlage app signs in with the e-mail in lower case (Home Assistant does the same).
  const email = String(raw?.email ?? '')
    .trim()
    .toLowerCase();
  // The password is kept as typed: spaces may be part of it.
  const password = typeof raw?.password === 'string' ? raw.password : String(raw?.password ?? '');
  return {
    email,
    password,
    account: accountKey(email),
    allowUnlock: flag(raw?.allow_unlock, DEFAULTS.allow_unlock),
    pollInterval: Number.isFinite(interval)
      ? Math.round(Math.max(POLL_INTERVAL.min, Math.min(POLL_INTERVAL.max, interval)))
      : DEFAULTS.poll_interval,
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
