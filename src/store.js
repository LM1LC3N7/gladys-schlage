// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never the e-mail nor the password:
//   - the Cognito tokens (access and refresh) with the account they belong
//     to (a hash of the e-mail): a restart neither signs in again nor asks
//     for a new verification code;
//   - the pauses (429, 403) and the stops (refused credentials and their next
//     try, a verification code awaited), bounded when read back;
//   - whether the account asks for a verification code (no sign-in by itself).
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/schlage-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        // Written and flushed to the disk before the rename: a power cut never
        // leaves an empty or half-written file in place of the tokens.
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
const text = (value) =>
  typeof value === 'string' && value !== '' && value.length < 8192 ? value : undefined;

/** The Cognito user name (a sub) of the refresh fallback; never an e-mail in /data. */
export const safeUsername = (value) =>
  typeof value === 'string' && value !== '' && !value.includes('@')
    ? value.slice(0, 128)
    : undefined;

const PAUSE_KINDS = ['rate', 'forbidden'];
export const BLOCK_KINDS = [
  'refused',
  'two_factor',
  'new_password',
  'unsupported_challenge',
  'session_refused',
];

/**
 * The persisted state, repaired; the end of a pause or of a stop is capped
 * from `now`, so a clock jump or a hand-edited file never stops for good.
 */
export function normalizeMemory(raw, now = Date.now()) {
  const account = typeof raw?.account === 'string' ? raw.account : '';
  const t = raw?.tokens;
  const tokens =
    account && t && (text(t.accessToken) || text(t.refreshToken))
      ? {
          accessToken: text(t.accessToken),
          refreshToken: text(t.refreshToken),
          expiresAt: time(t.expiresAt) ?? 0,
          username: safeUsername(t.username),
        }
      : null;
  const pause =
    PAUSE_KINDS.includes(raw?.pause?.kind) && time(raw.pause.until)
      ? {
          kind: raw.pause.kind,
          until: Math.min(
            raw.pause.until,
            now + (raw.pause.kind === 'forbidden' ? TIMINGS.forbiddenPause : TIMINGS.rateLimitMax),
          ),
        }
      : null;
  const b = raw?.block;
  const block =
    account && BLOCK_KINDS.includes(b?.kind)
      ? {
          kind: b.kind,
          retries: Number.isInteger(b.retries) && b.retries >= 0 ? Math.min(b.retries, 10) : 0,
          retryAt: time(b.retryAt)
            ? Math.min(b.retryAt, now + TIMINGS.refusedRetry.at(-1))
            : undefined,
          detail:
            typeof b.detail === 'string' && /^[A-Z_]{1,40}$/.test(b.detail) ? b.detail : undefined,
        }
      : null;
  return {
    account,
    tokens,
    pause,
    block,
    codeRequired: Boolean(account) && raw?.codeRequired === true,
  };
}
