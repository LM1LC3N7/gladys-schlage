# Schlage

Intégration non officielle, sans lien avec Schlage ni Allegion. Elle amène
dans Gladys les serrures Wi-Fi d'un compte **Schlage Home** (**Schlage Encode**,
**Encode Plus** et **Encode Lever**, et, telles que pyschlage les liste, les
versions Wi-Fi des familles **Arrive**, **Sense Pro** et **Selene**, Schlage et
Gainsborough), par le cloud Schlage (celui qu'utilise
l'application Schlage Home, comptes des États-Unis et du Canada).

> **Attention : API non officielle, cette intégration n'a jamais été testée
> avec un vrai compte ni une vraie serrure.** Elle a été écrite à partir de la
> bibliothèque pyschlage (celle de l'intégration Home Assistant) et testée
> contre un faux cloud Schlage seulement. Schlage peut changer son API à tout
> moment. Les retours sont les bienvenus.

## Ce que vous obtenez

Pour chaque serrure :

| Fonctionnalité                   | Détail                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Verrou                           | Commande : 1 verrouille, 0 déverrouille (si autorisé). Affiche 1 verrouillée, 0 déverrouillée.                         |
| État de la serrure               | 0 déverrouillée, 1 verrouillée, 2 commande en cours, 3 bourrage.                                                       |
| Bourrage                         | 1 quand la serrure signale un bourrage (pêne ou moteur), 0 sinon.                                                      |
| Batterie                         | En %.                                                                                                                  |
| Porte                            | Capteur d'ouverture (0 ouverte, 1 fermée), seulement sur les serrures dont le capteur de porte le remonte.             |
| Dernière action                  | Texte, par exemple « Déverrouillée au clavier (Jean) » : comment, et par qui quand Schlage le donne.                   |
| Verrouiller en partant (1-Touch) | 1 quand le réglage de verrouillage en une touche est activé sur la serrure (lecture seule), sur les modèles qui l'ont. |

« Par qui » est le nom du code d'accès (clavier), ou le nom de l'utilisateur
Schlage Home (application, Apple Home) ; jamais un e-mail, jamais un code.

Déclencheurs de scène :

- **Serrure Schlage déverrouillée** : quand une lecture montre déverrouillée
  une serrure qui était verrouillée à la lecture précédente. Variables :
  `lock` (son nom), `method` (`keypad` pour le clavier, `app` pour
  l'application, `apple_home`, `manual` pour le tourniquet, `one_touch`,
  `other`) et `by` (nom du code ou de l'utilisateur, vide si inconnu). Un
  déverrouillage depuis Gladys compte aussi (en général `app`).
- **Bourrage d'une serrure Schlage** : quand une lecture montre bloquée une
  serrure qui ne l'était pas.

Les serrures sont lues chaque minute : une serrure déverrouillée puis
reverrouillée entre deux lectures n'est pas vue, et un déclencheur peut
arriver jusqu'à une minute plus tard.

Le badge de chaque serrure affiche « cloud », « injoignable » (avec un point
orange) quand Schlage signale la serrure hors ligne (son Wi-Fi), et
« injoignable » pour toutes quand le cloud Schlage ne répond pas ou que le
compte est à l'arrêt. Une serrure hors ligne garde ses dernières valeurs.

Les autres modèles (Schlage Sense derrière son adaptateur Wi-Fi, types
inconnus) sont en lecture seule : aucune commande ne leur est envoyée.

## Installation

1. Vos serrures doivent fonctionner dans l'application **Schlage Home**, en
   Wi-Fi.
2. Dans Gladys, installez l'intégration Schlage et saisissez l'**e-mail** et
   le **mot de passe** de votre compte Schlage Home. Enregistrez.
3. Si Schlage demande un **code de vérification** (l'état le dit) : cliquez
   sur **Envoyer le code de vérification**, puis saisissez le code reçu dans
   **Vérifier le code**, dans les 3 minutes. Un code arrivé juste après
   l'enregistrement peut être saisi tout de suite.
4. Ajoutez les serrures depuis l'onglet **Découverte**.

## Sécurité

- **Le verrouillage est toujours possible.**
- **Le déverrouillage** est désactivé par défaut : activez **Autoriser le
  déverrouillage des serrures depuis Gladys** pour le permettre. Une scène, un
  tableau de bord ou un assistant vocal relié à Gladys peut alors ouvrir votre
  porte.
- Avant chaque commande, l'intégration **relit la serrure** dans le cloud
  Schlage. La commande est refusée si cette lecture échoue, si Schlage signale
  la serrure hors ligne, bloquée (bourrage) ou dans un état inconnu.
- Les commandes d'une même serrure passent **une à la fois**.
- Une commande qui ne peut pas être envoyée dans les **3,5 secondes** suivant
  son arrivée est refusée : Gladys affiche un échec au bout de 5 secondes, et
  rien ne doit bouger après cet échec.
- Après une commande, toute nouvelle commande de la même serrure est refusée
  (« encore en cours ») jusqu'à ce qu'une lecture suivante montre l'état
  attendu (ou un bourrage), 45 secondes au plus ; la serrure affiche
  « commande en cours » pendant ce temps. La réponse de la commande elle-même
  ne compte pas : elle peut montrer l'état demandé avant que le pêne ait bougé.
- Si Schlage ne répond pas à temps à une commande, Gladys affiche un échec,
  mais la serrure peut encore bouger : vérifiez son état.
- Les commandes sont refusées tant que le compte est à l'arrêt (mot de passe
  refusé, code attendu) et pendant une pause demandée par Schlage.

## Mot de passe, jetons et vie privée

- Le mot de passe est **gardé par Gladys dans sa base, jamais réaffiché, et
  utilisé seulement pour se connecter à Schlage**. La connexion se fait par
  AWS Cognito SRP (comme l'application Schlage Home) : le mot de passe
  lui-même ne circule jamais, seulement une preuve.
- La connexion donne des jetons : le jeton d'accès (environ une heure) est
  renouvelé avec le jeton de rafraîchissement, sans le mot de passe ;
  l'intégration ne se reconnecte donc pas à chaque lecture. Les deux jetons
  sont gardés dans le volume `/data` de l'intégration pour qu'un redémarrage
  ne se reconnecte pas et ne redemande pas de code. Sur l'hôte de Gladys, ce
  volume est le dossier `<dossier de base de Gladys>/external-integrations/<sélecteur>` :
  lisible par root et par l'uid 1000 (l'utilisateur du conteneur), **absent
  des sauvegardes de Gladys**, supprimé à la désinstallation de
  l'intégration. **Le jeton de rafraîchissement donne le contrôle des
  serrures** (déverrouillage compris) tant qu'il est valable, sans le mot de
  passe : protégez cet hôte comme vos clés. L'e-mail et le mot de passe n'y
  sont jamais écrits ; changer d'e-mail, ou vider l'e-mail ou le mot de passe,
  efface les jetons.
- Rien n'apparaît dans les journaux : ni mot de passe, ni jeton, ni code, ni
  e-mail, ni les clés internes (CAT/SAT) et adresses MAC que contiennent les
  réponses de Schlage.
- Tout passe en HTTPS vers `cognito-idp.us-west-2.amazonaws.com` (la
  connexion) et `api.allegion.yonomi.cloud` (les serrures).

## Rafraîchissement

Les serrures sont lues toutes les 60 secondes par défaut (60 à 900), une
requête pour tout le compte, plus quelques lectures dans les 45 secondes qui
suivent une commande.

## Erreurs

- **Mot de passe refusé** (ou compte non confirmé, réinitialisation demandée) :
  l'intégration s'arrête ; un nouvel essai après 1 h, 6 h, puis toutes les
  24 h, ou aussitôt quand vous enregistrez la configuration ou cliquez sur
  **Tester la connexion**.
- **Code de vérification** : l'intégration ne redemande jamais de code
  d'elle-même (chaque connexion en enverrait un) ; elle attend les boutons.
  Une fois le code accepté, la session est gardée. Un compte qui a demandé un
  code une fois est retenu : quand son jeton de rafraîchissement expire ou est
  refusé, l'intégration ne se reconnecte pas d'elle-même, elle s'arrête et
  attend les boutons.
- **Nouveau mot de passe demandé** : choisissez-le dans l'application Schlage
  Home, puis saisissez-le ici.
- **Session refusée juste après une nouvelle connexion** : nouvel essai après
  1 h, 6 h, puis toutes les 24 h.
- **Schlage demande de ralentir** (429, ou trop de connexions) : une pause d'au
  moins 1 minute (Retry-After s'il est donné, 6 h au plus), pour tous les
  chemins (lectures, commandes, boutons), gardée aux redémarrages.
- **HTTP 403** : une pause de 30 minutes.
- **Schlage injoignable** : nouvel essai après 1, 2, 5, 10 puis toutes les
  15 minutes, jamais plus vite que l'intervalle de rafraîchissement.

## Limites

- Comptes des États-Unis et du Canada seulement (le seul cloud Schlage).
- Jamais testée avec un vrai compte : la forme des réponses vient de
  pyschlage.
- Une étape de connexion autre que le code (SMS, e-mail ou application
  d'authentification) n'est pas gérée : l'état dit laquelle.
- Les serrures sont interrogées : pas d'événements en direct (le canal push de
  Schlage n'accepte qu'un client par compte, l'application Schlage Home en
  étant un).
- Codes d'accès, verrouillage automatique, bip et alarme ne sont pas gérés.

## Crédits

- [pyschlage](https://github.com/dknowles2/pyschlage) de David Knowles
  (Apache-2.0) : l'API du cloud, la connexion et le sens des états de la
  serrure sont portés en JavaScript.
- [pycognito](https://github.com/pvizeli/pycognito) (Apache-2.0) : le calcul
  SRP.
- L'intégration Schlage de [Home Assistant](https://github.com/home-assistant/core)
  (Apache-2.0).
- Voir `THIRD_PARTY_NOTICES.md`.

Schlage est une marque d'Allegion ; ce projet est sans lien avec Schlage ni
Allegion.
