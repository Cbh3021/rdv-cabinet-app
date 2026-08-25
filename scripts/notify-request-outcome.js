/* =======================================================================
   Script de notification — VERSION GRATUITE (pas de Cloud Functions).

   Envoie une notification push au patient dès que le médecin a
   accepté/refusé sa demande d'annulation ou de décalage (contacts/{phone}.
   lastRequestOutcome.pushed === false, écrit par l'app médecin). Tourne
   toutes les 10 minutes via cron GitHub Actions — voir
   .github/workflows/notify-request-outcome.yml.

   Exécution locale (test) :
     FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" node scripts/notify-request-outcome.js
   ======================================================================= */
const admin = require("firebase-admin");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("Variable FIREBASE_SERVICE_ACCOUNT manquante.");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore();

const MESSAGES = {
  fr: {
    accepted_cancel: "Votre demande d'annulation a été acceptée par le cabinet.",
    refused_cancel: "Votre demande d'annulation a été refusée. Votre rendez-vous reste inchangé.",
    accepted_reschedule: "Votre demande de décalage a été acceptée par le cabinet.",
    refused_reschedule: "Votre demande de décalage a été refusée. Votre rendez-vous reste inchangé.",
  },
  ar: {
    accepted_cancel: "تم قبول طلب إلغاء موعدك من طرف العيادة.",
    refused_cancel: "تم رفض طلب إلغاء موعدك. يبقى موعدك كما هو.",
    accepted_reschedule: "تم قبول طلب تغيير موعدك من طرف العيادة.",
    refused_reschedule: "تم رفض طلب تغيير موعدك. يبقى موعدك كما هو.",
  },
};

async function run() {
  const snap = await db
    .collection("contacts")
    .where("lastRequestOutcome.pushed", "==", false)
    .get();

  console.log(`${snap.size} notification(s) de décision en attente.`);

  for (const docSnap of snap.docs) {
    const contact = docSnap.data();
    const outcome = contact.lastRequestOutcome;
    if (!outcome) continue;

    const lang = contact.lang === "ar" ? "ar" : "fr";
    const key = `${outcome.status}_${outcome.type}`;
    const body = MESSAGES[lang][key] || MESSAGES.fr[key];
    const title = lang === "ar" ? "تحديث بخصوص موعدك" : "Mise à jour de votre demande";

    if (contact.fcmToken) {
      try {
        await admin.messaging().send({
          token: contact.fcmToken,
          notification: { title, body },
        });
        console.log(`Push envoyé → ${docSnap.id}`);
      } catch (e) {
        console.error(`Push échoué pour ${docSnap.id}: ${e.message}`);
        if (e.code === "messaging/registration-token-not-registered") {
          await docSnap.ref.update({ fcmToken: admin.firestore.FieldValue.delete() }).catch(() => {});
        }
      }
    } else {
      console.log(`Pas de push pour ${docSnap.id} (notifications non activées) — la bannière dans l'appli prendra le relais à l'ouverture.`);
    }

    // Marqué comme traité dans tous les cas : la bannière temps réel dans
    // l'appli (showRequestOutcomeBanner) reste indépendante de ce flag et
    // fonctionnera même si le push a échoué.
    await docSnap.ref.update({ "lastRequestOutcome.pushed": true });
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
