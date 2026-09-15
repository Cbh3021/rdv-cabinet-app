# RDV Cabinet — Dr Hédi Belhoula

App Capacitor (web + Android) : gestion des rendez-vous par le médecin,
consultation par le patient via son numéro de téléphone, sync temps réel
Firebase Firestore, rappel visuel (thème sunrise) et sonore.

## Avant de compiler

1. **Créer le projet Firebase** (console.firebase.google.com) si ce n'est pas
   déjà fait, avec Firestore Database activé.
2. **Activer l'authentification** : Build > Authentication > Sign-in method →
   active **E-mail/Mot de passe** ET **Téléphone**. La méthode Téléphone peut
   nécessiter le plan Blaze (pay-as-you-go, quota gratuit selon la région).
3. **Créer ton compte médecin** : Authentication > Users > Add user (email + mot
   de passe). Copie son *User UID*.
4. **Autoriser ce compte comme admin** : Firestore Database > Data → crée
   manuellement une collection `admins` avec un document dont l'**ID est cet
   UID** (n'importe quel champ dedans, ex. `role: "admin"`). Sans ce document,
   même connecté, le compte ne pourra pas gérer les rendez-vous.
5. **Configurer l'appli** : ouvre `www/index.html`, remplis l'objet
   `firebaseConfig` en haut du `<script type="module">` avec les clés de ton
   projet Firebase (Paramètres du projet > Tes applications > Ajouter une app Web).
6. **Publier les règles de sécurité** : Firestore Database > Règles → colle le
   contenu de `firestore.rules` (section du haut, "RÈGLES ACTIVES") → Publier.
7. Refais un `npx cap sync android` après toute modification de `www/index.html`
   pour répercuter les changements dans le projet Android.

### Comment ça marche côté utilisateurs

- **Médecin** : écran de connexion email/mot de passe. Seul un compte listé
  dans la collection `admins` peut gérer les rendez-vous.
- **Patient** : saisit son numéro → reçoit un code par SMS (Firebase Phone
  Auth) → une fois vérifié, ne voit que ses propres rendez-vous (comparaison
  exacte sur le numéro vérifié, format +216XXXXXXXX). Il reste connecté sur
  son téléphone pour les visites suivantes (pas besoin de revalider le SMS
  à chaque fois), sauf s'il choisit "Changer de numéro".

## IMPORTANT — authentification par SMS dans l'APK

La première version envoyait le SMS via le SDK Web de Firebase (reCAPTCHA),
qui échoue silencieusement dans une WebView Android packagée (aucune erreur,
aucun SMS). Cette version utilise désormais le plugin natif
`@capacitor-firebase/authentication` : sur l'APK, la vérification passe par
Play Integrity (système Android), plus de reCAPTCHA. Dans un navigateur
classique (test avant compilation, ou déploiement web), l'appli bascule
automatiquement sur le SDK Web avec reCAPTCHA — aucune action de ta part,
la détection est automatique (`Capacitor.isNativePlatform()`).

**Étapes supplémentaires obligatoires côté Firebase / Google Cloud pour
que le SMS natif fonctionne :**

1. Firebase Console > Paramètres du projet > Tes applications > **Ajouter une
   application Android**, package `com.belhoula.rdvcabinet`.
2. Récupère le SHA-1 **et** le SHA-256 de ta machine :
   ```bash
   cd android && ./gradlew signingReport
   ```
   (ou dans Android Studio : panneau Gradle > app > Tasks > android > signingReport)
   Ajoute les deux empreintes dans les paramètres de cette app Android sur Firebase.
3. Télécharge le fichier **google-services.json** généré et place-le dans
   `android/app/google-services.json` (à côté de `build.gradle`).
4. Dans **Google Cloud Console** (même projet que Firebase) → API et services
   → active l'API **"Play Integrity API"**.
5. Refais `npx cap sync android` puis recompile.

Sans le fichier `google-services.json` en place, l'app compile quand même
mais l'authentification Firebase ne s'initialisera pas côté natif.

## Compiler l'APK (sur ta machine, avec Android Studio installé)

```bash
# 1. Installer les dépendances (une seule fois)
npm install

# 1bis. Si tu modifies src/main.js, recompile le bundle avant de synchroniser
npx esbuild src/main.js --bundle --minify --format=iife --platform=browser --outfile=www/app.js

# 2. Synchroniser le web dans le projet natif Android
npx cap sync android

# 3a. Ouvrir dans Android Studio (recommandé — plus simple pour signer l'APK)
npx cap open android
# Puis dans Android Studio : Build > Build Bundle(s) / APK(s) > Build APK(s)

# 3b. OU compiler en ligne de commande (nécessite le SDK Android installé)
cd android
./gradlew assembleDebug
# L'APK debug se trouve dans :
# android/app/build/outputs/apk/debug/app-debug.apk
```

## Infos du projet

- **App ID (package)** : `com.belhoula.rdvcabinet`
- **Nom affiché** : RDV Cabinet
- **Icône / splash** : générés depuis `assets/icon.svg` (thème sunrise), via
  `npx capacitor-assets generate --android`. Pour changer l'icône, remplace
  `assets/icon.svg` puis relance cette commande.
- **webDir** : `www` (contient `index.html`, l'appli complète en un seul fichier)

## Pour publier sur le téléphone d'un patient / le tien

- **APK debug** (le plus rapide, pour tester) : `app-debug.apk` généré ci-dessus,
  à transférer et installer directement (activer "sources inconnues" sur le
  téléphone Android).
- **APK/AAB release** (signé, pour une vraie distribution) : dans Android Studio,
  Build > Generate Signed Bundle / APK, puis suis l'assistant pour créer ou
  utiliser un keystore.

## Secret GitHub `FIREBASE_SERVICE_ACCOUNT`

5 scripts dans `scripts/` utilisent le **Admin SDK** Firebase (accès complet,
qui contourne `firestore.rules`) parce qu'ils tournent en dehors du
navigateur, sur un cron GitHub Actions ou en local :

| Script | Déclenché par | Rôle |
|---|---|---|
| `send-reminders.js` | `.github/workflows/send-reminders.yml` (quotidien) | Rappels push J-3/J-1/jour J |
| `archive-old-appointments.js` | `.github/workflows/archive-old-appointments.yml` (quotidien) | Archive les RDV de +90 jours |
| `notify-request-outcome.js` | `.github/workflows/notify-request-outcome.yml` (toutes les 10 min) | Notifie le patient d'une décision (annulation/décalage) |
| `reset-patient-codes.js` | `.github/workflows/reset-patient-codes.yml` (toutes les 5 min) | Régénère le code patient sur demande |
| `recompute-loyalty-streaks.js` | **Aucun** — à lancer manuellement en local | Resynchronise les séries de fidélité |

Les 4 premiers ont besoin du secret configuré sur GitHub pour fonctionner en
automatique ; le 5ème n'a pas de workflow et se lance à la main quand
nécessaire.

### 1. Générer la clé de compte de service

1. [Console Firebase](https://console.firebase.google.com) → ton projet →
   icône ⚙️ (roue crantée) → **Paramètres du projet**.
2. Onglet **Comptes de service**.
3. Clique **"Générer une nouvelle clé privée"** → confirme → un fichier
   `.json` se télécharge (ex: `rdv-cabinet-belhoula-firebase-adminsdk-xxxxx.json`).

⚠️ **Ne jamais committer ce fichier dans le dépôt** (il donne un accès total
à la base de données, sans passer par les règles de sécurité). S'il traîne
sur ton disque après l'étape suivante, ajoute-le à `.gitignore` ou
supprime-le.

### 2. L'ajouter comme secret GitHub

1. Sur `https://github.com/Cbh3021/rdv-cabinet-app` → **Settings** → menu de
   gauche **Secrets and variables** → **Actions**.
2. Onglet **Secrets** → **New repository secret**.
3. **Name** : `FIREBASE_SERVICE_ACCOUNT` (exactement, en majuscules).
4. **Secret** : ouvre le fichier `.json` téléchargé, copie **tout son
   contenu** (l'objet JSON complet, accolades comprises), colle-le dans le
   champ.
5. **Add secret**.

Les 4 workflows planifiés lisent automatiquement ce secret via
`${{ secrets.FIREBASE_SERVICE_ACCOUNT }}` — aucune autre configuration
nécessaire, ils tourneront dès le prochain déclenchement planifié (ou en
lançant manuellement via l'onglet **Actions** → workflow concerné → **Run
workflow**).

### 3. Lancer `recompute-loyalty-streaks.js` en local (pas de workflow)

```powershell
$env:FIREBASE_SERVICE_ACCOUNT = Get-Content -Raw "chemin\vers\service-account.json"
node scripts/recompute-loyalty-streaks.js
```

### 4. Si la clé fuite (repo cloné publiquement avec le fichier dedans, etc.)

1. Console Firebase → Paramètres du projet → Comptes de service → gère les
   clés existantes (lien vers Google Cloud Console) → **supprime** la clé
   compromise.
2. Regénère-en une nouvelle (étape 1) et remplace la valeur du secret GitHub
   (étape 2 — un secret existant s'écrase en le recréant avec le même nom).

## App Check — protéger Firestore/Auth contre les accès hors appli

### Pourquoi

`firestore.rules` protège déjà les données par **identité** (un patient ne
voit que ses propres RDV, seul un `admin` peut tout gérer). Mais rien
n'empêche aujourd'hui un script extérieur d'utiliser la clé `apiKey` visible
dans `src/main.js`/`www/app.js` (normal pour Firebase, elle n'est pas
secrète) pour taper directement l'API Firebase depuis un simple script
Node — par exemple pour créer des comptes en masse, ou tenter de deviner en
boucle le code à 6 chiffres d'un patient (`brute-force`).

**App Check** ajoute une seconde vérification : Firebase refuse toute
requête qui ne prouve pas venir de l'appli légitime (le vrai `index.html`
servi par ton domaine, ou le vrai APK signé) — même avec une `apiKey`
valide.

### État actuel dans ce dépôt

- **Web** : code déjà en place dans `src/main.js` (reCAPTCHA v3), **inactif
  par défaut**. Pour l'activer, remplace `APP_CHECK_SITE_KEY` (juste après
  `firebaseConfig`) par ta vraie clé — voir étapes ci-dessous.
- **Android/APK** : **pas encore implémenté** dans ce dépôt. Nécessite le
  plugin `@capacitor-firebase/app-check` (Play Integrity) — voir "Étape
  suivante" plus bas si tu veux l'ajouter.

### Configuration (web)

1. Console Firebase → menu de gauche **App Check**.
2. Onglet **Apps** → sélectionne ton application Web (celle ajoutée à
   l'étape 6 de "Avant de compiler") → **reCAPTCHA v3** comme fournisseur.
3. Si demandé, crée une clé reCAPTCHA v3 sur
   [google.com/recaptcha/admin](https://www.google.com/recaptcha/admin) —
   ajoute le domaine où l'appli web sera servie (ou `localhost` pour tester).
4. Copie la **clé de site** (site key) obtenue → colle-la dans
   `src/main.js`, constante `APP_CHECK_SITE_KEY`.
5. Recompile : `npx esbuild src/main.js --bundle --minify --format=iife --platform=browser --outfile=www/app.js`

### ⚠️ Ordre obligatoire pour ne pas casser l'appli : Monitor avant Enforced

Dans Console Firebase → App Check → onglet **APIs**, pour **Firestore** et
**Authentication**, deux modes existent :

- **Monitor (non appliqué)** : App Check observe et remonte des métriques,
  mais **laisse passer toutes les requêtes**, même sans token valide.
- **Enforced (appliqué)** : **bloque** toute requête sans token App Check
  valide.

**Reste en mode Monitor plusieurs jours après avoir déployé le code
ci-dessus**, et vérifie dans le tableau de bord App Check que le
pourcentage de requêtes "vérifiées" grimpe vers 100 % (ça couvre le temps
que tous les patients/le médecin rouvrent l'appli avec le nouveau code).
**Ne passe en Enforced que quand ce pourcentage est proche de 100 %** —
sinon, tu bloques instantanément tout le monde, y compris le médecin, tant
que l'APK n'a pas été recompilé et réinstallé avec le support Android
(non fait dans ce dépôt, voir ci-dessous).

### Étape suivante (non faite ici) : Android/Play Integrity

Pour protéger aussi l'APK (pas seulement un usage web), il faudrait :
1. `npm install @capacitor-firebase/app-check` puis `npx cap sync android`.
2. Suivre la config native Android du plugin (réutilise normalement les
   mêmes empreintes SHA-1/SHA-256 déjà ajoutées pour Firebase — voir section
   "IMPORTANT — authentification par SMS dans l'APK" plus haut) :
   [capawesome.io/docs/plugins/firebase/app-check](https://capawesome.io/docs/plugins/firebase/app-check/)
3. Activer Play Integrity API dans Google Cloud Console (probablement déjà
   fait si le SMS natif est configuré).
4. Adapter l'initialisation dans `src/main.js` pour appeler ce plugin natif
   quand `isNative` est vrai (au lieu du `ReCaptchaV3Provider` web).

Tant que ce n'est pas fait, **ne passe jamais Firestore/Auth en mode
Enforced tant que l'app tourne aussi en APK** — sinon l'APK (qui n'envoie
aucun token App Check) sera bloqué en totalité.

## Sécurité avant usage réel avec de vraies données patients

Le projet Firestore doit être configuré avec de vraies règles de sécurité
(pas le "mode test" ouvert). À faire avant de mettre des données patients
réelles dans l'appli — demande-moi les règles quand tu es prêt.
