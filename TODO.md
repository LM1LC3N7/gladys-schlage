# TODO — Schlage v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session.

## Status

- [x] **Milestone 1 — core** (2026-10-17): Cognito SRP sign-in (checked
      against pycognito), code challenges with two buttons, refresh token
      renewal (one sign-in per cycle at most), tokens in `/data`; lock list
      every 60 s (60–900); features lock/state/jammed/battery/door/
      last-action/lock-and-leave; scene triggers unlocked (method, by) and
      jammed; safety rules (`allow_unlock` off, one command at a time per
      lock, fresh read before acting, refusals on offline/jammed/unknown,
      3.5 s deadline, guard after the command); stops and pauses persisted and
      capped; badges; test button; en/fr; docs; cover. Tested against a fake
      Cognito and a fake Schlage API only.
- [x] **Review fixes** (2026-10-17): renewal timer, command values,
      "may still move" message, code-required accounts, read after a pause,
      deadlines, re-checks, 403 pauses, texts, models in the docs, /data
      notes, fsync, e-mail-like names, guard and trigger timing.
- [ ] **Milestone 2 — real account**: run against a real account and lock,
      compare with the app (see "To check"); turn the answers (anonymized)
      into fixtures.
- [ ] **Milestone 3 — more**: the lock logs (`GET devices/{id}/logs`) for
      the triggers (an unlock and relock between two reads would no longer be
      missed, and the exact time), keypad disabled (event 11, as Home
      Assistant), access codes, auto-lock time, the MQTT push channel (one
      consumer per account: the app evicts it, see pyschlage PROTOCOL.md).
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real account

- The sign-in: Cognito answers `PASSWORD_VERIFIER` to `USER_SRP_AUTH` with
  the e-mail as USERNAME, and `USERNAME` / `USER_ID_FOR_SRP` in the
  challenge (a sub, assumed); whether a Schlage account ever gets a code
  challenge, and which one (`SMS_MFA`, `EMAIL_OTP`, `SOFTWARE_TOKEN_MFA`).
- The refresh: which user name the SECRET_HASH must be made with (e-mail
  first, as pycognito; then the Cognito user name). The lifetime of the
  refresh token (30 days by default in Cognito: a new sign-in after it).
- `Authorization: Bearer <access token>` on `api.allegion.yonomi.cloud`
  (pycognito default, PROTOCOL.md).
- `PUT devices/{id}` `{ attributes: { lockState } }`: its answer (the desired
  or the reported state?), the time the bolt takes to move, how fast the next
  `GET` shows it (the guard lasts 45 s).
- `connected` of a sleeping Encode: does it turn false between reports (then
  commands would be refused too often)?
- `doorState` on the Encode Plus (is there a door sensor at all?), the values
  of `lockStateMetadata.actionType` besides those of pyschlage (an unlock
  from Gladys: `virtualKey`?), `lockAndLeaveEnabled` presence.
- Rate limits: none documented; a 429 or a 403 of API Gateway may come.

## Decisions

- **Not a duplicate** (checked 2026-10-17): no Schlage service in the Gladys
  core, none in the integration store, the repository was reserved in post
  241 of the forum thread 10385.
- **Reference reused: dknowles2/pyschlage** (Apache-2.0, maintained, the one
  of Home Assistant), with **pycognito** (Apache-2.0) for SRP. Neither runs in
  a Node container: ported, credited in the README and
  `THIRD_PARTY_NOTICES.md`. No maintained JavaScript client exists on npm;
  `amazon-cognito-identity-js` would bring a large dependency tree for one
  computation: our own SRP (60 lines, `node:crypto` and BigInt), checked
  against a pycognito vector (`test/srp.test.js`) and against a fake Cognito
  running the server half. Only runtime dependency: the SDK.
- **2FA handled, not just noted**: Cognito code challenges (`SMS_MFA`,
  `SOFTWARE_TOKEN_MFA`, `EMAIL_OTP`) through two buttons like gladys-picnic.
  Since the code is sent by Cognito as soon as the password proof is
  accepted, "Send the verification code" is a new sign-in; the pending
  Cognito session (3 min) is kept in memory only (a restart in those
  3 minutes needs a new code). `SELECT_MFA_TYPE`, `MFA_SETUP` and the other
  challenges are not handled: a stop with the name of the challenge, and the
  spaced new tries. `NEW_PASSWORD_REQUIRED`: a stop asking to change it in
  the app.
- **No automatic sign-in while a code is awaited** (prudent choice): each
  sign-in would send an SMS. The stop is kept in `/data` and waits for the
  buttons or a change of the configuration; it is the one stop without a
  timer, as in gladys-picnic.
- **Tokens in /data** (prudent choice against the alternative "memory only"
  of gladys-yolink): without them every restart would sign in with the
  password, and ask for a new code on accounts with 2FA. The file is 0600,
  holds a hash of the e-mail (never the e-mail nor the password); another
  e-mail drops the tokens and the stops (a 429 pause stays).
- **Refused credentials**: stop with a new try after 1 h, 6 h, then every
  24 h (bounded, never a dead integration; repeated refusals may lock the
  account, so not more often); at once on a configuration change or the test
  button. Same schedule for `session_refused` (a token refused right after a
  fresh one), a new password asked and an unhandled challenge.
- **Refresh token**: renewed 5 min before the access token expires; refused
  (`NotAuthorizedException`) it is dropped and the password signs in once.
  SECRET_HASH of the refresh: the e-mail first (pycognito does so, and the
  Home Assistant integration works with it), then once the Cognito user name
  when Cognito answers "SecretHash does not match".
- **Renewal timer** (review 1): the access token is renewed at its expiry
  minus 5 min by a timer of its own, whatever the poll interval (900 s
  included), after the end of a 429/403 pause, never during a stop; a failed
  renewal tries again after max(1 min, interval) (a 429/403 there pauses
  every path). Floor (approval round 1): at most one timer renewal per
  minute, so a token shorter than the margin never loops; the expiry counts
  from `ExpiresIn` on our clock (the `exp` of the JWT only without it), so a
  host clock ahead does not matter. A new account resets `codeRequired`. A
  command uses the current token when it is valid 60 s more; below that it is
  refused ("try again in a few seconds") and a renewal starts: no Cognito call
  inside the 3.5 s deadline.
- **An account that asked for a code is remembered** (review 4,
  `codeRequired` in /data): when its refresh token expires or is refused, no
  automatic sign-in (it would send an SMS), a `two_factor` stop until the
  buttons. Signing in without a code from the button forgets it; another
  e-mail too.
- **Command values** (review 2): only 0, 1, '0' and '1'; anything else (null,
  '', ' ', false, []) is refused, never read as 0 (unlock).
- **Re-checks before the PUT** (review 6, 7): `allow_unlock`, the stop and the
  generation are checked again after the read; the PUT starts by 3.4 s after
  the arrival, its timeout ends 4.6 s after it.
- **Guard** (review 17): a read less than 4 s after the PUT never ends it.
- **Triggers** (review 18): none when the previous read is more than two
  intervals old (a pause, an outage).
- **"By whom" never an e-mail** (review 16): a friendly name or code name
  containing "@" is dropped. The Cognito user name of the refresh fallback is
  not written to /data when it contains "@" (review 13).
- **403 on a command, its read or a renewal** (review 9): the same 30-minute
  pause as on the reads; read back from /data capped at 30 min.
- **No e-mail or no password** (review 14): the tokens are dropped at once.
- **/data on the host** (review 12, docs): `<base>/external-integrations/<selector>`,
  readable by root and uid 1000, not in the Gladys backups, deleted with the
  integration; the refresh token gives control of the locks (said in the
  docs). The state file is fsynced before its rename (review 15).
- **The answer of the PUT never lifts the guard** (prudent choice): it may be
  the desired state of the shadow, not the bolt. Only a later read (4, 10, 20,
  46 s) or the 45 s expiry ends it; a new jam ends it too; an unknown or
  offline state never does.
- **A 401 on a command is not retried**: the command is refused (nothing was
  executed), the token is marked to be renewed first by the next call.
- **Wi-Fi families only for the commands** (pyschlage `_is_wifi_lock`:
  Encode, Encode Plus, Encode Lever, Arrive, Sense Pro, Selene). A Sense
  behind its bridge would need `changelockstate` with its CAT and the user id:
  read only for now, with a clear refusal.
- **Jammed (lock states 2 and 4) refuses every command**, locking included:
  the position is unknown. The Schlage app is the way to clear it.
- **Gladys features**: `lock/binary` writable (LOCK.ACTION 1 lock, 0 unlock —
  a lock category, not a switch "turn everything off" reaches; the same
  choice as the approved gladys-tedee and gladys-yolink), `lock/state`
  (LOCK.STATE 0/1/2/3: 2 while a command is in progress, 3 jammed),
  `unknown/binary` for the jam alert and the one-touch locking setting (read
  only states, never a switch), `battery/integer` %, `opening-sensor/binary`
  (OPENING_SENSOR_STATE: 0 open, 1 closed; the door role only when
  `doorState` is 1, 2 or 3, faulty publishes nothing), `text/text` for the
  last action. Units: only `percent` on the battery
  (DEVICE_FEATURE_UNITS_BY_CATEGORY).
- **Republished devices keep their features**: the roles of the device
  already created in Gladys (`gladys.devices`) are added to the current ones.
- **Offline lock**: no state published (its last values stay), a degraded
  unreachable badge.
- **Scene triggers from the polling**: a locked -> unlocked change between two
  reads (60 s), never on the first read after a start; an unlock and relock
  within the interval is missed (noted in the docs and the trigger
  description). The logs endpoint would fix it (milestone 3).
- **"By whom"**: the access code name (`lockStateMetadata.name`) or the
  friendly name of the Schlage user of `users[]`; never an e-mail (the
  e-mails of `users[]` are dropped at parsing), never the code.
- **Interval 60 s (60–900)**: twice slower than Home Assistant (30 s), one
  request for the whole account; errors are never read again faster than it.
- **429**: Retry-After between 60 s and 6 h (5 min when absent), for every
  path (reads, commands, scan, buttons), persisted and capped at 6 h when
  read back; a reconnection to Gladys keeps it. Cognito
  `TooManyRequestsException` / `LimitExceededException` count as a 429;
  `TooManyFailedAttemptsException` as a 1-hour 429.
- **403 of the API**: a 30-minute pause (API Gateway or WAF), persisted, not a
  refusal of the account (Cognito tells that).
- **Status and Discovery at each `connected`**: the deduplication caches
  (last status, last Discovery list, badges) are cleared and sent again; the
  tokens, pauses and stops stay.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag: the one-time exception to "versions
  belong to the Release workflow" (the template's 1.0.0 had to be replaced);
  the first patch release gives 0.1.1.
- **LICENSE**: the standard Apache-2.0 text (copied from gladys-tedee, appendix
  placeholder, no personal name); `THIRD_PARTY_NOTICES.md` credits pyschlage,
  pycognito and Home Assistant (all Apache-2.0, no NOTICE file); both copied
  into the image.
- **The app's Cognito client secret and API key** are in `src/constants.js`,
  as in pyschlage: public constants of the Schlage Home app, not secrets of
  the user.
