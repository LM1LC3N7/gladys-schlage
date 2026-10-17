# Schlage

Unofficial integration, not affiliated with Schlage or Allegion. It brings
the Wi-Fi locks of a **Schlage Home** account into Gladys (**Schlage Encode**,
**Encode Plus** and **Encode Lever**, and, as pyschlage lists them, the Wi-Fi
models of the **Arrive**, **Sense Pro** and **Selene** families, Schlage and
Gainsborough), through the Schlage cloud (the one the
Schlage Home app uses, accounts of the United States and Canada).

> **Warning: unofficial API. This integration has
> never been tested with a real account nor a real lock.** It was written from the pyschlage library
> (the one of the Home Assistant integration) and tested against a fake
> Schlage cloud only. Schlage may change its API at any time. Feedback is
> welcome.

## What you get

For each lock:

| Feature                  | Detail                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Lock                     | Command: 1 locks, 0 unlocks (when allowed). Shows 1 locked, 0 unlocked.                         |
| Lock state               | 0 unlocked, 1 locked, 2 a command in progress, 3 jammed.                                        |
| Jammed                   | 1 when the lock reports a jam (bolt or motor), 0 otherwise.                                     |
| Battery                  | In %.                                                                                           |
| Door                     | Opening sensor (0 open, 1 closed), only on locks with a door position sensor that reports it.   |
| Last action              | Text, for example "Unlocked with the keypad (Jean)": how, and by whom when Schlage gives it.    |
| Lock and leave (1-Touch) | 1 when the one-touch locking setting of the lock is on (read only), on the models that have it. |

"By whom" is the name of the access code (keypad), or the name of the Schlage
Home user (app, Apple Home); never an e-mail, never a code.

Scene triggers:

- **Schlage lock unlocked**: when a read shows unlocked a lock that was locked
  at the previous read. Variables: `lock` (its name), `method` (`keypad`,
  `app`, `apple_home`, `manual` for the thumbturn, `one_touch`, `other`) and
  `by` (code name or user, empty when unknown). An unlock from Gladys counts
  too (usually `app`).
- **Schlage lock jammed**: when a read shows jammed a lock that was not.

The locks are read every minute: a lock unlocked and locked again between two
reads is not seen, and a trigger arrives up to a minute late.

The badge of each lock shows "cloud", "unreachable" (with an orange dot) when
Schlage reports the lock offline (its Wi-Fi), and "unreachable" for all when
the Schlage cloud does not answer or the account is stopped. An offline lock
keeps its last values.

Other models (Schlage Sense behind its Wi-Fi adapter, unknown types) show
read only: no command is sent to them.

## Setup

1. Your locks must work in the **Schlage Home** app, over Wi-Fi.
2. In Gladys, install the Schlage integration and enter the **e-mail** and the
   **password** of your Schlage Home account. Save.
3. If Schlage asks for a **verification code** (the status says so): click
   **Send the verification code**, then type the code you received in
   **Verify the code**, within 3 minutes. A code that has just arrived after
   saving can be typed at once.
4. Add the locks from the **Discovery** tab.

## Safety

- **Locking is always possible.**
- **Unlocking** is off by default: turn on **Allow unlocking the locks from
  Gladys** to allow it. Then a scene, a dashboard or a voice assistant
  connected to Gladys can open your door.
- Before each command, the integration **reads the lock again** in the
  Schlage cloud. The command is refused when that read fails, when Schlage
  reports the lock offline, jammed, or in an unknown state.
- The commands of one lock run **one at a time**.
- A command that cannot be sent within **3.5 seconds** of its arrival is
  refused: Gladys shows a failure after 5 seconds, and nothing must move after
  that failure.
- After a command, any new command of the same lock is refused ("still in
  progress") until a later read shows the expected state (or a jam), for 45
  seconds at most; the lock shows "a command in progress" meanwhile. The
  answer of the command itself does not count: it may show the requested
  state before the bolt moved.
- When Schlage does not answer a command in time, Gladys shows a failure, but
  the lock may still move: check its state.
- Commands are refused while the account is stopped (refused password, code
  awaited) and during a pause asked by Schlage.

## Password, tokens and privacy

- The password is **kept by Gladys in its database, never shown again, and
  used only to sign in to Schlage**. The sign-in is AWS Cognito SRP (as the
  Schlage Home app does): the password itself never travels, only a proof.
- The sign-in gives tokens: the access token (about an hour) is renewed with
  the refresh token, without the password, so the integration does not sign
  in again at each read. Both tokens are kept in the `/data` volume of the
  integration so that a restart neither signs in again nor asks for a new
  code. On the Gladys host, that volume is the folder
  `<Gladys base folder>/external-integrations/<selector>`: readable by root
  and by the uid 1000 (the user of the container), **not in the Gladys
  backups**, deleted when the integration is uninstalled. **The refresh
  token gives control of the locks** (unlocking included) for as long as it
  is valid, without the password: protect that host as you protect your
  keys. The e-mail and the password are never written there; changing the
  e-mail, or emptying the e-mail or the password, drops the tokens.
- Nothing appears in the logs: no password, token, code, e-mail, nor the
  internal keys (CAT/SAT) and MAC addresses the Schlage answers contain.
- Everything goes over HTTPS to `cognito-idp.us-west-2.amazonaws.com` (the
  sign-in) and `api.allegion.yonomi.cloud` (the locks).

## Refresh

The locks are read every 60 seconds by default (60 to 900), one request for
the whole account, plus a few reads during the 45 seconds after a command.

## Errors

- **Password refused** (or account not confirmed, password reset asked): the
  integration stops; one new try after 1 h, 6 h, then every 24 h, or at once
  when you save the configuration or click **Test the connection**.
- **Verification code**: the integration never asks for a new code by itself
  (each sign-in would send one); it waits for the buttons. Once the code is
  accepted, the session is kept. An account that asked for a code once is
  remembered: when its refresh token expires or is refused, the integration
  does not sign in again by itself, it stops and waits for the buttons.
- **New password required**: choose it in the Schlage Home app, then enter it
  here.
- **Session refused right after a new sign-in**: new try after 1 h, 6 h, then
  every 24 h.
- **Schlage asks to slow down** (429, or too many sign-ins): a pause of at
  least 1 minute (Retry-After when given, at most 6 h), for every path
  (reads, commands, buttons), kept across restarts.
- **HTTP 403**: a 30-minute pause.
- **Schlage unreachable**: tried again after 1, 2, 5, 10 then every 15
  minutes, never faster than the refresh interval.

## Limits

- Accounts of the United States and Canada only (the only Schlage cloud).
- Never tested with a real account: the shape of the answers comes from
  pyschlage.
- A sign-in step other than the code (SMS, e-mail or authenticator app) is
  not handled: the status says which one.
- The locks are polled: no live events (the push channel of Schlage allows
  one consumer per account, the Schlage Home app being one).
- Access codes, auto-lock, beeper and alarm settings are not handled.

## Credits

- [pyschlage](https://github.com/dknowles2/pyschlage) by David Knowles
  (Apache-2.0): the cloud API, the sign-in and the meaning of the lock states
  are ported to JavaScript.
- [pycognito](https://github.com/pvizeli/pycognito) (Apache-2.0): the SRP
  computation.
- The Schlage integration of [Home Assistant](https://github.com/home-assistant/core)
  (Apache-2.0).
- See `THIRD_PARTY_NOTICES.md`.

Schlage is a trademark of Allegion; this project is not affiliated with
Schlage or Allegion.
