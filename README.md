# gladys-schlage

[Gladys Assistant](https://gladysassistant.com) external integration for
**Schlage** Wi-Fi locks (Encode, Encode Plus, Encode Lever, and the Wi-Fi
models of the Arrive, Sense Pro and Selene families), through the Schlage cloud
(the unofficial API of the Schlage Home app, accounts of the US and Canada):
lock state, jam, battery, door, last action and by whom, scene triggers on
unlocking and on a jam. Locking is always allowed; unlocking is off until the
user allows it. Unofficial, not affiliated with Schlage or Allegion.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress (milestone 1).** Unofficial API, tested against a fake
> Schlage cloud only, never with a real account or lock.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SchlageApp) ⇄ src/client.js ⇄ api.allegion.yonomi.cloud/v1
                                   │                           └─ src/cognito.js + src/srp.js ⇄ cognito-idp.us-west-2
                                   ├─ src/schlage.js    lock documents (pure)
                                   ├─ src/devices.js    -> Gladys devices and states (pure)
                                   ├─ src/store.js      /data: tokens, pauses, stops
                                   └─ src/publisher.js  300 states and scene events/min
```

- **Sign-in** (as pyschlage with pycognito): AWS Cognito `USER_SRP_AUTH` on
  the user pool of the Schlage Home app, then `PASSWORD_VERIFIER` (SRP-6a,
  3072-bit group, "Caldera Derived Key"; checked against pycognito in
  `test/srp.test.js`), with the app client secret (`SECRET_HASH`). A code
  challenge (`SMS_MFA`, `SOFTWARE_TOKEN_MFA`, `EMAIL_OTP`) is answered through
  the two buttons, within the 3 minutes of the Cognito session.
- **Tokens**: `Authorization: Bearer <access token>` and the static
  `X-Api-Key` of the app. The access token is renewed 5 minutes before it
  expires with `REFRESH_TOKEN_AUTH` (`SECRET_HASH` from the e-mail, then from
  the Cognito user name if Cognito says it does not match); a refused refresh
  token is dropped and the password signs in once (never on an account that
  asked for a code once: it then waits for the buttons). A timer renews the
  token at its expiry minus 5 minutes, whatever the poll interval, after the
  end of a 429/403 pause and never during a stop. Tokens are kept in
  `/data/schlage-state.json` (0600) with a hash of the e-mail, never the
  e-mail nor the password.
- **Reading**: `GET devices?archetype=lock` every 60 s (60 to 900), plus 4,
  10, 20 and 46 s after a command. A 401 renews the token once and retries
  once (again: `session_refused`, spaced new tries). Refused credentials, a
  new password asked, an unknown challenge: stop, new try after 1 h, 6 h, then
  every 24 h. A code asked: stop until the buttons (a sign-in would send a new
  code). 429 (or Cognito `TooManyRequestsException`): a pause of Retry-After
  between 60 s and 6 h for every path, the next read after the pause and the
  interval; 403 (reads, commands, renewal): 30 min; both kept in `/data` and
  capped when read back (6 h, 30 min). Network errors: 1, 2, 5, 10, 15 min, never under the
  interval.
- **Devices**: `ext:<selector>:schlage:<deviceId>`. Features by role: `lock`
  (lock/binary, writable), `state` (lock/state: 0 unlocked, 1 locked, 2 command
  in progress, 3 jammed), `jammed` (unknown/binary), `battery` (%), `door`
  (opening-sensor, when `doorState` is reported), `last-action` (text),
  `lock-and-leave` (unknown/binary, read only). A republished device keeps the
  features it was created with.
- **Commands** (one chain per lock; Wi-Fi families only, as pyschlage
  `_is_wifi_lock`): unlock needs `allow_unlock`; the access token must be
  fresh (no renewal inside the deadline); `GET devices/{id}` just before
  acting; refused when that read fails, or the lock is offline, jammed or in
  an unknown state, or when the command is not sent within 3.5 s of its
  arrival (the PUT itself by 3.4 s; `allow_unlock` checked again right
  before). Only 0, 1, '0', '1' are commands. `PUT devices/{id}`
  `{ attributes: { lockState } }`, answered by 4.6 s after the arrival. A
  command uses the access token when it is valid 60 s more. After a command (or a maybe-sent
  one), a guard refuses any command and shows the lock in progress until a
  later read (never the PUT answer, nor a read within 4 s of it) shows the
  expected state or a new jam, 45 s at most.
- **Scene triggers**: `lock_unlocked` (`lock`, `method`, `by`) on a locked ->
  unlocked change between two reads at most two intervals apart, `lock_jammed` (`lock`) on a new jam;
  never on the first read.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/schlage.js` holds lock documents shaped like those pyschlage
describes (made-up values); `test/helpers/fakeSchlage.js` is a fake Cognito
(it runs the server half of SRP and checks the proof) and a fake Schlage API
behind the transport.

## Credits

- [dknowles2/pyschlage](https://github.com/dknowles2/pyschlage) (Apache-2.0),
  the library of the Home Assistant integration: the API, the Cognito pool and
  client, the lock states and device types are ported to JavaScript.
- [pvizeli/pycognito](https://github.com/pvizeli/pycognito) (Apache-2.0): the
  SRP computation.
- The Schlage integration of
  [Home Assistant](https://github.com/home-assistant/core) (Apache-2.0).
- Notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store
(added at the first real release).

## License

Apache-2.0 (see [LICENSE](LICENSE)); the ported logic is Apache-2.0 too (see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Schlage is a trademark of
Allegion; this project is not affiliated with Schlage or Allegion.
