// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to AWS Cognito and to the Schlage
// API, and the errors they end with. The body read is bounded; the messages
// never hold a secret (no password, token, code or e-mail).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed call. `kind`:
 * - `no_credentials`: no e-mail or password (never sent);
 * - `refused`: Cognito refused the e-mail or the password (or the account:
 *   not confirmed, password reset required…);
 * - `two_factor`: the sign-in needs a verification code (`challenge`, `destination`);
 * - `new_password`: Cognito asks for a new password (done in the Schlage app);
 * - `unsupported_challenge`: another Cognito challenge (`challenge`);
 * - `code_refused`, `code_expired`, `no_pending`: the verification code steps;
 * - `refresh_refused`: the refresh token is no longer valid (sign in again);
 * - `unauthorized`: the API refused the access token (401);
 * - `session_refused`: refused again right after a new token;
 * - `forbidden`: a 403 of the API that is not an authentication error;
 * - `rate_limited`: 429 or Cognito TooManyRequests, `retryAfter` in ms when given;
 * - `unavailable`: 5xx;
 * - `network`, `timeout`: no answer; `late`: not sent, the command deadline passed;
 * - `bad_response`, `size`: not the expected JSON;
 * - `not_found`: 404 (a lock removed from the account);
 * - `http`: any other status.
 */
export class SchlageError extends Error {
  constructor(kind, message, { status, retryAfter, code, challenge, destination } = {}) {
    super(message);
    this.name = 'SchlageError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
    this.challenge = challenge;
    this.destination = destination;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> SchlageError (never the request: a sign-in carries the claim). */
export function networkError(err) {
  if (err instanceof SchlageError) {
    return err;
  }
  return new SchlageError('network', NETWORK_REASONS[err?.code] ?? err?.code ?? 'network error');
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof SchlageError) {
    const details = [err.code, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return String(err?.message ?? err);
}

/**
 * One request; resolves `{ status, headers, body }` whatever the status. The
 * promise settles once; the body read is bounded.
 */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new SchlageError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    timer = setTimeout(() => {
      settle(
        reject,
        new SchlageError('timeout', `no answer within ${Math.round(timeout / 1000)} s`),
      );
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body; `undefined` for an empty body. */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new SchlageError('bad_response', 'the answer is not JSON');
  }
}
