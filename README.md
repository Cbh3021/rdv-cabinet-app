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

## Sécurité avant usage réel avec de vraies données patients

Le projet Firestore doit être configuré avec de vraies règles de sécurité
(pas le "mode test" ouvert). À faire avant de mettre des données patients
réelles dans l'appli — demande-moi les règles quand tu es prêt.
