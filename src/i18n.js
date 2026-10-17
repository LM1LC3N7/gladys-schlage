// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, buttons, command refusals,
// feature names, the last action of a lock), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 120) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Schlage lock', 'Serrure Schlage');

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  lock: both('Lock', 'Verrou'),
  state: both('Lock state', 'État de la serrure'),
  jammed: both('Jammed', 'Bourrage'),
  battery: both('Battery', 'Batterie'),
  door: both('Door', 'Porte'),
  'last-action': both('Last action', 'Dernière action'),
  'lock-and-leave': both('Lock and leave (1-Touch)', 'Verrouiller en partant (1-Touch)'),
};

/** The state part of the last action. */
export const STATE_WORDS = {
  locked: both('Locked', 'Verrouillée'),
  unlocked: both('Unlocked', 'Déverrouillée'),
  jammed: both('Jammed', 'Bloquée (bourrage)'),
  unknown: both('Unknown state', 'État inconnu'),
};

/** How the last change was made (the scene trigger `method` values). */
export const METHOD_WORDS = {
  keypad: both('with the keypad', 'au clavier'),
  app: both('from the app', "par l'application"),
  apple_home: both('with Apple Home (NFC)', 'par Apple Home (NFC)'),
  manual: both('by hand (thumbturn)', 'à la main (tourniquet)'),
  one_touch: both('with the Schlage button (1-Touch)', 'par le bouton Schlage (1-Touch)'),
  other: undefined,
};

export const T = {
  noCredentials: both(
    'Enter the e-mail and the password of your Schlage account (the ones of the Schlage Home app).',
    "Saisissez l'e-mail et le mot de passe de votre compte Schlage (ceux de l'application Schlage Home).",
  ),
  connecting: both('Signing in to Schlage…', 'Connexion à Schlage…'),
  connected: (count) =>
    count === 0
      ? both(
          'Connected to Schlage, but the account has no lock.',
          "Connecté à Schlage, mais le compte n'a aucune serrure.",
        )
      : both(
          `Connected to Schlage: ${count} lock${count > 1 ? 's' : ''}. Open Discovery to add ${count > 1 ? 'them' : 'it'}.`,
          `Connecté à Schlage : ${count} serrure${count > 1 ? 's' : ''}. Ouvrez Découverte pour ${count > 1 ? 'les ' : "l'"}ajouter.`,
        ),
  refused: (wait) =>
    both(
      `Schlage refused the e-mail or the password (or the account). Check them in the configuration: saving, or the test button, tries again at once; otherwise one new try in ${wait.en}.`,
      `Schlage a refusé l'e-mail ou le mot de passe (ou le compte). Vérifiez-les dans la configuration : enregistrer, ou le bouton de test, réessaie aussitôt ; sinon un nouvel essai dans ${wait.fr}.`,
    ),
  twoFactor: both(
    'Schlage asks for a verification code. In this configuration screen: 1) "Send the verification code", 2) type the code you received in "Verify the code" within 3 minutes (a code that has just arrived can be typed at once). The integration waits: it never asks for a new code by itself.',
    "Schlage demande un code de vérification. Dans cet écran de configuration : 1) « Envoyer le code de vérification », 2) saisissez le code reçu dans « Vérifier le code » dans les 3 minutes (un code qui vient d'arriver peut être saisi tout de suite). L'intégration attend : elle ne redemande jamais de code d'elle-même.",
  ),
  newPassword: both(
    'Schlage asks for a new password: sign in to the Schlage Home app, choose it there, then enter it here.',
    "Schlage demande un nouveau mot de passe : connectez-vous à l'application Schlage Home, choisissez-le là, puis saisissez-le ici.",
  ),
  unsupportedChallenge: (name, wait) =>
    both(
      `Schlage asks for a sign-in step this integration does not handle (${name ?? 'unknown'}). One new try in ${wait.en} (then 6 h, then every 24 h), or at once when you save the configuration or click "Test the connection".`,
      `Schlage demande une étape de connexion que cette intégration ne gère pas (${name ?? 'inconnue'}). Un nouvel essai dans ${wait.fr} (puis 6 h, puis toutes les 24 h), ou aussitôt quand vous enregistrez la configuration ou cliquez sur « Tester la connexion ».`,
    ),
  sessionRefused: (wait) =>
    both(
      `Schlage refused the session again right after a new sign-in. New try in ${wait.en}, or click "Test the connection".`,
      `Schlage a de nouveau refusé la session juste après une nouvelle connexion. Nouvel essai dans ${wait.fr}, ou cliquez sur « Tester la connexion ».`,
    ),
  unreachable: (reason, wait) =>
    both(
      `Schlage cannot be reached (${reason}). Next try in ${wait.en}.`,
      `Schlage est injoignable (${reason}). Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `Schlage asks to slow down: pausing for ${wait.en}.`,
      `Schlage demande de ralentir : pause de ${wait.fr}.`,
    ),
  forbidden: (wait) =>
    both(
      `Schlage refuses the requests (HTTP 403): pausing for ${wait.en}.`,
      `Schlage refuse les requêtes (HTTP 403) : pause de ${wait.fr}.`,
    ),
  lockOffline: both(
    'Schlage reports this lock offline (Wi-Fi).',
    'Schlage signale cette serrure hors ligne (Wi-Fi).',
  ),
  busy: both(
    'A read of Schlage is in progress: try again in a minute.',
    'Une lecture de Schlage est en cours : réessayez dans une minute.',
  ),
  code: {
    sent: (destination) =>
      destination
        ? both(
            `Schlage sent a code (${destination}). Type it in "Verify the code" within 3 minutes.`,
            `Schlage a envoyé un code (${destination}). Saisissez-le dans « Vérifier le code » dans les 3 minutes.`,
          )
        : both(
            'Schlage asks for a code (SMS, e-mail or authenticator app). Type it in "Verify the code" within 3 minutes.',
            "Schlage demande un code (SMS, e-mail ou application d'authentification). Saisissez-le dans « Vérifier le code » dans les 3 minutes.",
          ),
    notNeeded: both(
      'Schlage accepted the sign-in without a code: connected.',
      'Schlage a accepté la connexion sans code : connecté.',
    ),
    alreadyConnected: both(
      'Already connected to Schlage: no code is needed.',
      "Déjà connecté à Schlage : aucun code n'est nécessaire.",
    ),
    cooldown: both(
      'A code was requested less than a minute ago: wait for it, or try again in a minute.',
      "Un code a été demandé il y a moins d'une minute : attendez-le, ou réessayez dans une minute.",
    ),
    needsFields: both(
      'This version of Gladys did not send the form of the button: update Gladys.',
      "Cette version de Gladys n'a pas envoyé le formulaire du bouton : mettez Gladys à jour.",
    ),
    badFormat: both('The code is made of 6 to 8 digits.', 'Le code est composé de 6 à 8 chiffres.'),
    noPending: both(
      'No sign-in is waiting for a code: click "Send the verification code" first.',
      "Aucune connexion n'attend de code : cliquez d'abord sur « Envoyer le code de vérification ».",
    ),
    expired: both(
      'The sign-in waiting for this code expired (3 minutes): click "Send the verification code" again.',
      'La connexion qui attendait ce code a expiré (3 minutes) : cliquez à nouveau sur « Envoyer le code de vérification ».',
    ),
    refused: both(
      'Schlage refused the code: check it and try again within the 3 minutes, or ask for a new one.',
      'Schlage a refusé le code : vérifiez-le et réessayez dans les 3 minutes, ou demandez-en un nouveau.',
    ),
    verified: both('Code accepted: connected to Schlage.', 'Code accepté : connecté à Schlage.'),
    failed: (reason) =>
      both(
        `Schlage could not be reached (${reason}): try again in a moment.`,
        `Schlage est injoignable (${reason}) : réessayez dans un moment.`,
      ),
  },
  test: {
    cooldown: both(
      'Already read less than 30 seconds ago.',
      'Déjà lu il y a moins de 30 secondes.',
    ),
  },
  denied: {
    noConfig: both(
      'The Schlage account is not configured.',
      "Le compte Schlage n'est pas configuré.",
    ),
    unlock: both(
      'Unlocking from Gladys is turned off: allow it in the configuration of the integration.',
      "Le déverrouillage depuis Gladys est désactivé : autorisez-le dans la configuration de l'intégration.",
    ),
    stopped: both(
      'The Schlage account is not connected (see the status of the integration): command refused.',
      "Le compte Schlage n'est pas connecté (voir l'état de l'intégration) : commande refusée.",
    ),
    paused: both(
      'Schlage asked to slow down: command refused during the pause.',
      'Schlage a demandé de ralentir : commande refusée pendant la pause.',
    ),
    forbidden: both(
      'Schlage refuses the requests (HTTP 403): command refused during the 30-minute pause.',
      'Schlage refuse les requêtes (HTTP 403) : commande refusée pendant la pause de 30 minutes.',
    ),
    badValue: both(
      'Unexpected value: 1 locks, 0 unlocks.',
      'Valeur inattendue : 1 verrouille, 0 déverrouille.',
    ),
    session: both(
      'The Schlage session is being renewed: try again in a few seconds.',
      'La session Schlage est en cours de renouvellement : réessayez dans quelques secondes.',
    ),
    unknownDevice: both(
      'This lock is not (or no longer) in the Schlage account.',
      "Cette serrure n'est pas (ou plus) dans le compte Schlage.",
    ),
    notWifi: both(
      'This Schlage model is read only in this integration (not a Wi-Fi lock).',
      'Ce modèle Schlage est en lecture seule dans cette intégration (pas une serrure Wi-Fi).',
    ),
    inProgress: both(
      'A command of this lock is still in progress: command refused.',
      'Une commande de cette serrure est encore en cours : commande refusée.',
    ),
    unreadable: both(
      'The state of the lock could not be read again just before acting: command refused.',
      "L'état de la serrure n'a pas pu être relu juste avant d'agir : commande refusée.",
    ),
    offline: both(
      'Schlage reports the lock offline: command refused.',
      'Schlage signale la serrure hors ligne : commande refusée.',
    ),
    jammed: both(
      'The lock reports a jam: command refused. Check the door and the bolt, then use the Schlage app.',
      "La serrure signale un bourrage : commande refusée. Vérifiez la porte et le pêne, puis utilisez l'application Schlage.",
    ),
    unknown: both(
      'The state of the lock is unknown: command refused.',
      "L'état de la serrure est inconnu : commande refusée.",
    ),
    late: both(
      'The lock answered too late: command refused before acting (nothing was sent).',
      "La serrure a répondu trop tard : commande refusée avant d'agir (rien n'a été envoyé).",
    ),
  },
  maybeSent: (reason) =>
    both(
      `The command may have reached Schlage, but it did not confirm it (${reason}): the lock may still move. Check its state.`,
      `La commande a pu atteindre Schlage, mais il ne l'a pas confirmée (${reason}) : la serrure peut encore bouger. Vérifiez son état.`,
    ),
  commandFailed: (reason) =>
    both(`Schlage refused the command (${reason}).`, `Schlage a refusé la commande (${reason}).`),
};
