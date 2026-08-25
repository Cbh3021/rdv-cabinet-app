/* =======================================================================
   Script d'archivage — VERSION GRATUITE (pas de Cloud Functions / Blaze).

   Chaque nuit, déplace les RDV de plus de ACTIVE_WINDOW_DAYS jours de
   "appointments" vers "appointments_history", et met à jour un compteur
   agrégé par patient dans "patients/{phone}" (honoredCount, absentCount,
   totalCount) pour que le taux de présence reste exact même une fois les
   vieux RDV archivés, sans jamais avoir à les recharger.

   Exactement le même principe que send-reminders.js : tourne sur le cron
   GitHub Actions gratuit (.github/workflows/archive-old-appointments.yml),
   utilise la même clé de compte de service Firebase (FIREBASE_SERVICE_ACCOUNT).

   Exécution locale (test) :
     FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" node scripts/archive-old-appointments.js
   ======================================================================= */
const admin = require("firebase-admin");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("Variable FIREBASE_SERVICE_ACCOUNT manquante.");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const ACTIVE_WINDOW_DAYS = 90; // fenêtre glissante des RDV "actifs"
const BATCH_SIZE = 400;        // marge sous la limite Firestore de 500/batch

function cutoffDateKeyInTunis() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ACTIVE_WINDOW_DAYS);
  // Tunisie = UTC+1 toute l'année (pas de changement d'heure depuis 2019),
  // même logique que dateKeyInTunis() dans send-reminders.js.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis" }).format(d);
}

// Incrémente les compteurs patients/{phone} pour un lot de RDV migrés.
// Regroupe par téléphone avant d'écrire, pour minimiser les écritures.
async function updatePatientStats(batchAppts) {
  const deltas = new Map(); // phone -> {honored, absent, total}
  for (const appt of batchAppts) {
    if (!appt.phone) continue;
    const d = deltas.get(appt.phone) || { honored: 0, absent: 0, total: 0 };
    d.total += 1;
    if (appt.honored === true) d.honored += 1;
    else if (appt.honored === false) d.absent += 1;
    deltas.set(appt.phone, d);
  }
  for (const [phone, d] of deltas) {
    await db.collection("patients").doc(phone).set(
      {
        totalCount: FieldValue.increment(d.total),
        honoredCount: FieldValue.increment(d.honored),
        absentCount: FieldValue.increment(d.absent),
      },
      { merge: true }
    );
  }
}

async function run() {
  const cutoff = cutoffDateKeyInTunis();
  let totalMigrated = 0;
  let snap;

  do {
    snap = await db.collection("appointments").where("date", "<", cutoff).limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const batch = db.batch();
    const migratedData = [];
    snap.docs.forEach((docSnap) => {
      const data = docSnap.data();
      migratedData.push(data);
      batch.set(db.collection("appointments_history").doc(docSnap.id), {
        ...data,
        archivedAt: FieldValue.serverTimestamp(),
      });
      batch.delete(docSnap.ref);
    });
    await batch.commit();
    await updatePatientStats(migratedData);

    totalMigrated += snap.size;
    console.log(`Lot migré : ${snap.size} RDV (avant le ${cutoff}).`);
  } while (snap.size === BATCH_SIZE);

  console.log(`Terminé : ${totalMigrated} RDV archivés au total (cutoff ${cutoff}).`);
}

run()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
