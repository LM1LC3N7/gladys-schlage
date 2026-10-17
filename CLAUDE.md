# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "unlock"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js, before connect())
src/handlers.js                   the SDK handlers -> SchlageApp (shared with the e2e tests)
src/app.js                        SchlageApp: polling, devices, triggers, badges, code buttons, commands and their safety rules
src/client.js                     Schlage API client: tokens (renewal, one sign-in per cycle), lock list, lock, lock state
src/cognito.js                    AWS Cognito: SRP sign-in, code challenges, refresh token, error kinds
src/srp.js                        the SRP computation (pure), checked against pycognito
src/http.js                       HTTPS transport (bounded answers), SchlageError, errorReason
src/schlage.js                    lock documents -> locks (pure)
src/devices.js                    locks -> Gladys devices and states (pure)
src/store.js                      /data: tokens, pauses and stops (bounded when read back)
src/publisher.js                  states and scene events to Gladys within 300/min
src/config.js                     DEFAULTS (mirror the manifest defaults) + normalization
src/constants.js, src/i18n.js     cloud constants, timings; en/fr texts
gladys-assistant-integration.json manifest: name, config_schema, actions, scene triggers, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: SDK fake Gladys + fake Cognito/Schlage behind the transport
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
TODO.md                           status, things to check on a real account, decisions
THIRD_PARTY_NOTICES.md            Apache-2.0 notices of pyschlage, pycognito, Home Assistant
```

## Safety rules (locks)

Locking is always allowed. Unlocking (`allow_unlock`) stays off by default.
Commands of one lock are serialized, the lock is read again just before
acting, and a command is refused when that read fails, when the lock is
offline, jammed or in an unknown state, when it cannot be sent within 3.5 s of
its arrival, when the access token would need a renewal first, while the
account is stopped or paused, or while the guard of the previous command
holds (until a later read shows the expected state, a new jam, or 45 s). The
answer of the command never lifts the guard. Never weaken these rules.

## Account rules

- Never sign in at each cycle: the access token is renewed from the refresh
  token; one sign-in with the password per cycle at most; a refused refresh
  token is dropped, never retried.
- Refused credentials stop the polling, with spaced new tries (1 h, 6 h,
  24 h). A verification code stops it until the buttons: never a sign-in by
  itself while a code is awaited (each one would send a code).
- Pauses (429, 403) and stops are kept in `/data`, capped when read back, and
  hold for every path (reads, commands, buttons). A reconnection to Gladys
  clears neither them nor the tokens; it only resends the status, the
  Discovery list and the badges.
- Never log or publish the password, the tokens, the Cognito session, the
  code, an e-mail, nor the CAT/SAT keys and MAC addresses of the documents.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Text files** are UTF-8 without BOM; `test/encoding.test.js` refuses
  mojibake.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (fake transport).
