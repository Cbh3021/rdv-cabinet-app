/* =======================================================================
   Script PONCTUEL — resynchronise currentStreak / longestStreak pour tous
   les patients, en rejouant chronologiquement leurs RDV honorés/non
   présentés (appointments + appointments_history).

   À lancer UNE FOIS après le correctif de archive-old-appointments.js,
   pour les patients dont la chaîne a divergé du score de fidélité (RDV
   comptés uniquement par l'ancien rattrapage automatique, qui ne touchait
   jamais la chaîne — voir le commit correspondant).

   Ne touche ni honoredCount, ni absentCount, ni totalCount — seulement
   currentStreak et longestStreak, recalculés de zéro à partir des faits.

   Exécution locale (nécessite service-account.json, comme les autres
   scripts de ce dossier) :
     FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" node scripts/recompute-loyalty-streaks.js
   ======================================================================= */
const admin = require("firebase-admin");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("Variable FIREBASE_SERVICE_ACCOUNT manquante.");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore();

async function fetchAll(collectionName) {
  const snap = await db.collection(collectionName).get();
  return snap.docs.map((d) => d.data());
}

async function run() {
  const [active, history] = await Promise.all([
    fetchAll("appointments"),
    fetchAll("appointments_history"),
  ]);
  const all = [...active, ...history];

  const byPhone = new Map();
  for (const a of all) {
    if (!a.phone || (a.honored !== true && a.honored !== false)) continue;
    if (!byPhone.has(a.phone)) byPhone.set(a.phone, []);
    byPhone.get(a.phone).push(a);
  }

  let updated = 0;
  for (const [phone, appts] of byPhone) {
    appts.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    let currentStreak = 0;
    let longestStreak = 0;
    for (const a of appts) {
      if (a.honored === true) {
        currentStreak += 1;
        if (currentStreak > longestStreak) longestStreak = currentStreak;
      } else {
        currentStreak = 0; // un RDV raté casse la chaîne
      }
    }
    await db.collection("patients").doc(phone).set(
      { currentStreak, longestStreak },
      { merge: true }
    );
    updated += 1;
    console.log(`${phone} -> chaîne actuelle ${currentStreak}, record ${longestStreak}`);
  }

  console.log(`Terminé : ${updated} patient(s) resynchronisé(s).`);
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
