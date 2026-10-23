# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-17

### Added

- Schlage Wi-Fi locks of a Schlage Home account (US, Canada: Encode, Encode
  Plus, Encode Lever, and the Wi-Fi models of Arrive, Sense Pro, Selene), through the Schlage cloud (unofficial API, ported from pyschlage).
- Sign-in with the e-mail and the password through AWS Cognito SRP (the
  password itself is never sent); the access token is renewed from the
  refresh token, without a new sign-in at each read; the tokens are kept in
  `/data` so a restart does not sign in again.
- Verification code, when Schlage asks for one (SMS, e-mail or authenticator
  app): "Send the verification code" and "Verify the code" buttons; never
  asked again by itself.
- Lock (lock and unlock), lock state (unlocked, locked, command in progress,
  jammed), jam alert, battery, door (locks with a door position sensor), last
  action and by whom (text), one-touch locking setting (read only).
- Scene triggers "Schlage lock unlocked" (with the method: keypad, app, Apple
  Home, manual, one-touch, and by whom) and "Schlage lock jammed".
- Unlocking is off by default (`allow_unlock`); locking is always allowed.
  Commands run one at a time per lock, after a fresh read of the lock; refused
  when that read fails, when the lock is offline, jammed or in an unknown
  state, or when the command cannot be sent within 3.5 s of its arrival. After
  a command, the lock is shown "command in progress" and any new command
  refused until a later read shows the expected state (45 s at most).
- The locks are read every 60 s (60 to 900); refused credentials stop the
  integration with a new try after 1 h, 6 h, then every 24 h; a 429 pauses
  every path for 60 s to 6 h, kept across restarts; a 403 pauses 30 minutes.
- Badges: cloud; unreachable and degraded for a lock Schlage reports offline;
  unreachable when the cloud does not answer or the account is stopped.
- "Test the connection" button; the status and the Discovery list are sent
  again at each reconnection to Gladys.
- The access token is renewed by a timer 5 minutes before it expires,
  whatever the interval; an account that asked for a code never signs in by
  itself again.
- Feature names and texts in French or English.

[Unreleased]: https://github.com/LM1LC3N7/gladys-schlage/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-schlage/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-schlage/releases/tag/v0.1.1
