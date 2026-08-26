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
// IMPORTANT : depuis l'ajout du score de fidélité temps réel côté client
// (setHonoredStatus dans main.js), honoré/absent est déjà compté au moment
// où le médecin clique — statsCounted:true le signale. Ici on ne rattrape
// que les RDV jamais marqués avant leur archivage (statsCounted absent),
// pour ne jamais compter deux fois le même RDV.
//
// La chaîne (currentStreak/longestStreak) doit être rejouée dans le même
// ordre chronologique que le ferait un clic manuel — sinon elle se
// désynchronise du score (déjà vu : score 100% mais "aucune chaîne en
// cours" pour un RDV compté uniquement par ce rattrapage automatique).
// Comme la chaîne dépend de l'ordre des RDV (pas juste d'un delta additif),
// on part de l'état actuel du patient et on la rejoue RDV par RDV.
async function updatePatientStats(batchAppts) {
  const byPhone = new Map(); // phone -> appts[]
  for (const appt of batchAppts) {
    if (!appt.phone) continue;
    if (!byPhone.has(appt.phone)) byPhone.set(appt.phone, []);
    byPhone.get(appt.phone).push(appt);
  }

  for (const [phone, appts] of byPhone) {
    const totalDelta = appts.length;
    const uncounted = appts
      .filter((a) => !a.statsCounted && (a.honored === true || a.honored === false))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    const patientRef = db.collection("patients").doc(phone);

    if (uncounted.length === 0) {
      await patientRef.set({ totalCount: FieldValue.increment(totalDelta) }, { merge: true });
      continue;
    }

    const honoredDelta = uncounted.filter((a) => a.honored === true).length;
    const absentDelta = uncounted.filter((a) => a.honored === false).length;

    const snap = await patientRef.get();
    let currentStreak = snap.exists() ? snap.data().currentStreak || 0 : 0;
    let longestStreak = snap.exists() ? snap.data().longestStreak || 0 : 0;
    for (const a of uncounted) {
      if (a.honored === true) {
        currentStreak += 1;
        if (currentStreak > longestStreak) longestStreak = currentStreak;
      } else {
        currentStreak = 0; // un RDV raté casse la chaîne (même logique que main.js)
      }
    }

    await patientRef.set(
      {
        totalCount: FieldValue.increment(totalDelta),
        honoredCount: FieldValue.increment(honoredDelta),
        absentCount: FieldValue.increment(absentDelta),
        currentStreak,
        longestStreak,
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
