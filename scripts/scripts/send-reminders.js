/* =======================================================================
   Script de rappels — VERSION GRATUITE (pas de Cloud Functions / Blaze).

   Fait exactement la même chose qu'une Cloud Function planifiée, mais tourne
   sur un cron externe gratuit (voir .github/workflows/send-reminders.yml)
   au lieu d'être hébergée par Firebase. Firestore, Auth et Cloud Messaging
   restent sur le plan Spark (gratuit) — seule l'hébergement de CE script
   change d'endroit.

   Utilise une clé de compte de service Firebase (gratuite, plan Spark) :
     Console Firebase > ⚙️ Paramètres du projet > Comptes de service
     > "Générer une nouvelle clé privée" → télécharge le JSON.
   Ne JAMAIS committer ce fichier JSON. Il est passé via la variable
   d'environnement FIREBASE_SERVICE_ACCOUNT (voir workflow GitHub Actions).

   Exécution locale (test) :
     FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" node scripts/send-reminders.js
   ======================================================================= */
const admin = require("firebase-admin");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("Variable FIREBASE_SERVICE_ACCOUNT manquante.");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore();

// Aligné sur checkReminderPopup() côté client : J-3 = stage 1, J-1/jour J = stage 2.
const REMINDER_STAGES = [
  { offsetDays: 3, stage: 1 },
  { offsetDays: 1, stage: 2 },
  { offsetDays: 0, stage: 2 },
];

function dateKeyInTunis(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  // Tunisie = UTC+1 toute l'année (pas de changement d'heure depuis 2019).
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis" }).format(d);
}

const MESSAGES = {
  fr: {
    1: (t) => `Petit rappel : rendez-vous avec Dr Hédi Belhoula le ${t}.`,
    2: (t) => `Rendez-vous imminent avec Dr Hédi Belhoula : ${t}.`,
  },
  ar: {
    1: (t) => `تذكير: لديك موعد مع الدكتور الهادي بلحولة يوم ${t}.`,
    2: (t) => `موعدك مع الدكتور الهادي بلحولة قريب جداً: ${t}.`,
  },
};

function buildMessage(stage, appt, lang) {
  const readable = `${appt.date} ${appt.time}`;
  const safeLang = lang === "ar" ? "ar" : "fr";
  return {
    title: safeLang === "ar" ? "تذكير بالموعد" : "Rappel de rendez-vous",
    body: MESSAGES[safeLang][stage](readable),
  };
}

async function sendOneReminder(apptDoc, stage) {
  const appt = apptDoc.data();
  const sentField = `stage${stage}`;

  // Idempotence : si le script tourne deux fois le même jour (rejeu manuel,
  // retry du cron), on n'envoie pas deux fois le même rappel.
  if (appt.remindersSent && appt.remindersSent[sentField]) return;

  const contactRef = db.collection("contacts").doc(appt.phone);
  const contactSnap = await contactRef.get();
  const contact = contactSnap.exists ? contactSnap.data() : null;
  const { title, body } = buildMessage(stage, appt, contact && contact.lang);

  let delivered = false;
  if (contact && contact.fcmToken) {
    try {
      await admin.messaging().send({
        token: contact.fcmToken,
        notification: { title, body },
        data: { apptId: apptDoc.id },
      });
      delivered = true;
      console.log(`Push envoyé → ${appt.phone} (stage ${stage})`);
    } catch (e) {
      console.error(`Push échoué pour ${appt.phone}: ${e.message}`);
      if (e.code === "messaging/registration-token-not-registered") {
        await contactRef.update({ fcmToken: admin.firestore.FieldValue.delete() }).catch(() => {});
      }
    }
  }

  if (!delivered) {
    // Patient sans notifications activées : rien de gratuit et fiable ne
    // remplace un vrai envoi SMS (les API SMS sont payantes). On se contente
    // de logger — le popup interne (app.js) prendra le relais si le patient
    // ouvre l'appli ce jour-là.
    console.log(`Pas de push pour ${appt.phone} — RDV du ${appt.date} (notifications non activées).`);
  }

  await apptDoc.ref.update({ [`remindersSent.${sentField}`]: true });
}

async function run() {
  for (const { offsetDays, stage } of REMINDER_STAGES) {
    const dateKey = dateKeyInTunis(offsetDays);
    const snap = await db.collection("appointments").where("date", "==", dateKey).get();
    console.log(`${snap.size} RDV le ${dateKey} (stage ${stage})`);
    for (const apptDoc of snap.docs) {
      await sendOneReminder(apptDoc, stage);
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

