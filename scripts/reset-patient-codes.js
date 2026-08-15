/* =======================================================================
   RÉINITIALISATION DES CODES PATIENTS
   -----------------------------------------------------------------------
   Firebase ne permet jamais de changer le mot de passe d'un AUTRE compte
   depuis le client (Admin ou app patient) — ça doit obligatoirement passer
   par le Admin SDK, côté serveur, avec la clé de compte de service.

   Ce script tourne exactement comme send-reminders.js : aucune Cloud
   Function, aucune facturation Firebase (pas de plan Blaze), juste un
   script Node exécuté sur un cron GitHub Actions gratuit.

   Flux :
   1. Le médecin clique "🔄 Réinitialiser le code" dans l'appli → un champ
      resetStatus:'pending' est déposé sur contacts/{phone}.
   2. Ce script (déclenché toutes les 5 min par le workflow associé) lit
      tous les contacts avec resetStatus:'pending', génère un nouveau code
      à 6 chiffres, met à jour le mot de passe du compte Firebase Auth
      correspondant, puis écrit ce code dans contacts/{phone}.lastCode.
   3. Le médecin le récupère ensuite normalement via 🔑 Code patient — même
      mécanisme que pour un compte fraîchement créé.
   ======================================================================= */
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const auth = admin.auth();

// Doit rester identique à patientEmailFor() dans app.js.
function patientEmailFor(e164) {
  return "p" + e164 + "@rdvcabinet.local";
}
function generatePatientCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function main() {
  const snap = await db
    .collection("contacts")
    .where("resetStatus", "==", "pending")
    .get();

  if (snap.empty) {
    console.log("Aucune demande de réinitialisation en attente.");
    return;
  }

  console.log(`${snap.size} demande(s) de réinitialisation à traiter.`);

  for (const docSnap of snap.docs) {
    const phone = docSnap.id; // clé du doc = numéro E.164, ex: +21622123456
    const email = patientEmailFor(phone);
    const newCode = generatePatientCode();

    try {
      const user = await auth.getUserByEmail(email);
      await auth.updateUser(user.uid, { password: newCode });
      await docSnap.ref.set(
        {
          lastCode: newCode,
          resetStatus: "done",
          resetCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.log(`✅ Code réinitialisé pour ${phone}`);
    } catch (e) {
      console.error(`❌ Échec réinitialisation pour ${phone} :`, e.message);
      await docSnap.ref.set(
        {
          resetStatus: "error",
          resetError: e.message,
        },
        { merge: true }
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Erreur fatale du script de réinitialisation :", err);
    process.exit(1);
  });
