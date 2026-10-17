// -----------------------------------------------------------------------------
// The sign-in to the Schlage account through AWS Cognito, as pyschlage does
// with pycognito: USER_SRP_AUTH then PASSWORD_VERIFIER (src/srp.js), an
// optional verification code (SMS, e-mail or authenticator app), then
// REFRESH_TOKEN_AUTH to renew the access token without the password. Plain
// JSON calls to the public Cognito endpoint: no AWS signature is needed.
// -----------------------------------------------------------------------------

import { COGNITO, TIMINGS } from './constants.js';
import { SchlageError, httpRequest, parseJson, parseRetryAfter } from './http.js';
import { newEphemeral, passwordClaim, secretHash } from './srp.js';

/** Cognito errors meaning the e-mail, the password or the account itself (pyschlage.auth). */
const REFUSED = new Set([
  'NotAuthorizedException',
  'InvalidPasswordException',
  'PasswordResetRequiredException',
  'UserNotFoundException',
  'UserNotConfirmedException',
]);
const RATE = new Set(['TooManyRequestsException', 'LimitExceededException']);

/** The verification code challenges, and the key of the code in the answer. */
export const CODE_CHALLENGES = {
  SMS_MFA: 'SMS_MFA_CODE',
  SOFTWARE_TOKEN_MFA: 'SOFTWARE_TOKEN_MFA_CODE',
  EMAIL_OTP: 'EMAIL_OTP_CODE',
};

/** The `__type` of a Cognito error answer, without its namespace: a short identifier only. */
export function cognitoCode(json) {
  const raw = json && typeof json === 'object' ? (json.__type ?? json.code) : undefined;
  const code = typeof raw === 'string' ? raw.split('#').pop() : undefined;
  return code && /^[A-Za-z]{1,64}$/.test(code) ? code : undefined;
}

const decodeClaims = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
};

export class CognitoClient {
  constructor({ transport = httpRequest, now = Date.now, random, url = COGNITO.url } = {}) {
    this.transport = transport;
    this.now = now;
    this.random = random;
    this.url = url;
    /** Per-request timeout; undefined = TIMINGS.requestTimeout. */
    this.timeout = undefined;
  }

  hash(username) {
    return secretHash(username, COGNITO.clientId, COGNITO.clientSecret);
  }

  /** One Cognito call; rejects a SchlageError of the error `kind` the caller chose for refusals. */
  async call(target, payload, { refusal = 'refused' } = {}) {
    const body = JSON.stringify(payload);
    const answer = await this.transport(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      timeout: this.timeout ?? TIMINGS.requestTimeout,
    });
    let json;
    try {
      json = parseJson(answer.body);
    } catch (err) {
      if (answer.status >= 200 && answer.status < 300) {
        throw err;
      }
    }
    if (answer.status >= 200 && answer.status < 300) {
      if (!json || typeof json !== 'object') {
        throw new SchlageError('bad_response', 'Cognito sent no answer');
      }
      return json;
    }
    const code = cognitoCode(json);
    const message = typeof json?.message === 'string' ? json.message : '';
    const status = answer.status;
    if (RATE.has(code) || status === 429) {
      throw new SchlageError('rate_limited', 'too many sign-in requests', {
        status,
        code,
        retryAfter: parseRetryAfter(answer.headers?.['retry-after'], this.now()),
      });
    }
    if (code === 'TooManyFailedAttemptsException') {
      throw new SchlageError('rate_limited', 'too many failed attempts', {
        status,
        code,
        retryAfter: TIMINGS.refusedRetry[0],
      });
    }
    if (code === 'CodeMismatchException') {
      throw new SchlageError('code_refused', 'verification code refused', { status, code });
    }
    if (code === 'ExpiredCodeException') {
      throw new SchlageError('code_expired', 'verification code expired', { status, code });
    }
    if (REFUSED.has(code)) {
      // SecretHash mismatches are told apart for the refresh fallback (never the message itself).
      const kind = /secret ?hash/i.test(message) ? 'secret_hash' : refusal;
      throw new SchlageError(kind, 'refused by Cognito', { status, code });
    }
    if (status >= 500 || code === 'InternalErrorException') {
      throw new SchlageError('unavailable', 'Cognito is unavailable', { status, code });
    }
    throw new SchlageError('http', 'Cognito request failed', { status, code });
  }

  /** The tokens of an AuthenticationResult; `previous`: the refresh token kept on a refresh. */
  tokensOf(result, username, previousRefresh) {
    const accessToken = result?.AccessToken;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new SchlageError('bad_response', 'Cognito sent no access token');
    }
    const refreshToken =
      typeof result.RefreshToken === 'string' && result.RefreshToken !== ''
        ? result.RefreshToken
        : previousRefresh;
    const seconds = Number(result.ExpiresIn);
    const exp = Number(decodeClaims(accessToken)?.exp);
    // ExpiresIn counts from now on our own clock (a host clock ahead or behind
    // does not matter); the `exp` of the JWT only when Cognito gives no ExpiresIn.
    const expiresAt =
      Number.isFinite(seconds) && seconds > 0
        ? this.now() + seconds * 1000
        : Number.isFinite(exp) && exp > 0
          ? exp * 1000
          : this.now() + TIMINGS.tokenLifetime;
    return { accessToken, refreshToken, expiresAt, username };
  }

  /**
   * A full sign-in with the password. Resolves the tokens; rejects
   * `two_factor` with `pending` (the Cognito session, 3 min) when a code is needed.
   */
  async signIn(email, password) {
    try {
      return await this.srpSignIn(email, password);
    } catch (err) {
      if (err.kind === 'secret_hash') {
        // The app client of the Schlage app changed: a refusal, never a loop.
        throw new SchlageError('refused', 'refused by Cognito', {
          status: err.status,
          code: err.code,
        });
      }
      throw err;
    }
  }

  async srpSignIn(email, password) {
    const ephemeral = newEphemeral(this.random);
    const start = await this.call('InitiateAuth', {
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: COGNITO.clientId,
      AuthParameters: { USERNAME: email, SRP_A: ephemeral.srpA, SECRET_HASH: this.hash(email) },
    });
    if (start.ChallengeName !== 'PASSWORD_VERIFIER' || !start.ChallengeParameters) {
      throw new SchlageError('bad_response', 'Cognito did not ask for the password proof');
    }
    const challenge = start.ChallengeParameters;
    const username = String(challenge.USERNAME ?? challenge.USER_ID_FOR_SRP ?? email);
    let claim;
    try {
      claim = passwordClaim({
        ephemeral,
        challenge,
        password,
        poolId: COGNITO.poolId,
        date: new Date(this.now()),
      });
    } catch (err) {
      throw new SchlageError('bad_response', err.message);
    }
    const answer = await this.call('RespondToAuthChallenge', {
      ChallengeName: 'PASSWORD_VERIFIER',
      ClientId: COGNITO.clientId,
      ChallengeResponses: {
        USERNAME: username,
        TIMESTAMP: claim.timestamp,
        PASSWORD_CLAIM_SECRET_BLOCK: challenge.SECRET_BLOCK,
        PASSWORD_CLAIM_SIGNATURE: claim.signature,
        SECRET_HASH: this.hash(username),
      },
    });
    return this.outcome(answer, username);
  }

  /** The end of a sign-in step: tokens, or the next challenge as an error. */
  outcome(answer, username) {
    if (answer.AuthenticationResult) {
      return this.tokensOf(answer.AuthenticationResult, username);
    }
    const name = String(answer.ChallengeName ?? '');
    if (CODE_CHALLENGES[name] && typeof answer.Session === 'string') {
      const destination = answer.ChallengeParameters?.CODE_DELIVERY_DESTINATION;
      const error = new SchlageError('two_factor', 'Schlage asks for a verification code', {
        challenge: name,
        destination:
          typeof destination === 'string' && /^[\w*+@. -]{1,40}$/.test(destination)
            ? destination
            : undefined,
      });
      error.pending = { challenge: name, session: answer.Session, username, at: this.now() };
      throw error;
    }
    if (name === 'NEW_PASSWORD_REQUIRED') {
      throw new SchlageError('new_password', 'Cognito asks for a new password', {
        challenge: name,
      });
    }
    throw new SchlageError('unsupported_challenge', 'unsupported Cognito challenge', {
      challenge: /^[A-Z_]{1,40}$/.test(name) ? name : undefined,
    });
  }

  /** The verification code of a waiting sign-in. */
  async verifyCode(pending, code) {
    const key = CODE_CHALLENGES[pending.challenge];
    let answer;
    try {
      answer = await this.call(
        'RespondToAuthChallenge',
        {
          ChallengeName: pending.challenge,
          ClientId: COGNITO.clientId,
          Session: pending.session,
          ChallengeResponses: {
            USERNAME: pending.username,
            [key]: code,
            SECRET_HASH: this.hash(pending.username),
          },
        },
        { refusal: 'code_expired' },
      );
    } catch (err) {
      // "Invalid session for the user, session is expired": the 3 minutes are over.
      if (err.kind === 'secret_hash') {
        throw new SchlageError('code_expired', 'verification session refused', {
          status: err.status,
          code: err.code,
        });
      }
      throw err;
    }
    return this.outcome(answer, pending.username);
  }

  /**
   * New tokens from the refresh token, without the password. The SECRET_HASH
   * is made with the e-mail (as pycognito does), then once with the Cognito
   * user name when Cognito says it does not match.
   */
  async refresh(tokens, email) {
    const names = [email, tokens.username].filter((n, i, all) => n && all.indexOf(n) === i);
    let last;
    for (const name of names) {
      try {
        const answer = await this.call(
          'InitiateAuth',
          {
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            ClientId: COGNITO.clientId,
            AuthParameters: { REFRESH_TOKEN: tokens.refreshToken, SECRET_HASH: this.hash(name) },
          },
          { refusal: 'refresh_refused' },
        );
        return this.tokensOf(answer.AuthenticationResult, tokens.username, tokens.refreshToken);
      } catch (err) {
        if (err.kind !== 'secret_hash') {
          throw err;
        }
        last = err;
      }
    }
    throw new SchlageError('refresh_refused', 'refresh token refused', {
      status: last?.status,
      code: last?.code,
    });
  }
}
