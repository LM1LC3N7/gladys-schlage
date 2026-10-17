# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below, all under the Apache License
2.0 as well: the full text of that licence is the `LICENSE` file shipped with
this integration (and copied into its Docker image). None of these projects
ships a `NOTICE` file.

The ported parts were rewritten in JavaScript; they are changed from the
originals (another language, another structure, only what this integration
needs). None of the original code is copied as is.

## pyschlage

- Project: [dknowles2/pyschlage](https://github.com/dknowles2/pyschlage), the
  Python library for the Schlage Wi-Fi locks, by David Knowles (the one of
  the Home Assistant integration).
- What is ported (in `src/constants.js`, `src/cognito.js`, `src/client.js`
  and `src/schlage.js`): the AWS Cognito user pool, app client and secret of
  the Schlage Home app, the API base URL and its key, the sign-in flow (SRP
  through pycognito), the lock list (`GET devices?archetype=lock`), the lock
  state change of the Wi-Fi locks (`PUT devices/{id}`), the meaning of the
  lock states, door states and device types, the actor of the last change
  (`lockStateMetadata`), and the protocol notes of its `PROTOCOL.md`.
- Licence: Apache License 2.0 (`license = {text = "Apache-2.0"}` in its
  `pyproject.toml`, the standard Apache 2.0 text in its `LICENSE` file).

## pycognito

- Project: [pvizeli/pycognito](https://github.com/pvizeli/pycognito), by
  Pascal Vizeli (the Cognito client pyschlage uses), itself following
  [amazon-cognito-identity-js](https://github.com/amazon-archives/amazon-cognito-identity-js).
- What is ported (in `src/srp.js` and `src/cognito.js`): the SRP computation
  of `aws_srp.py` (the 3072-bit group, `k`, `pad_hex`, the "Caldera Derived
  Key" HKDF, the timestamp format, the PASSWORD_VERIFIER claim, the
  SECRET_HASH) and the refresh token flow. `test/srp.test.js` checks the
  result against values computed by pycognito 2024.5.1.
- Licence: Apache License 2.0.

## Home Assistant — Schlage integration

- Project: [home-assistant/core](https://github.com/home-assistant/core),
  `homeassistant/components/schlage`, by the Home Assistant authors.
- What is ported: the choice of entities (lock, battery, last change by), the
  e-mail in lower case at sign-in, and the handling of a refused sign-in
  (stop and ask the user, never a loop).
- Licence: Apache License 2.0.
