const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

const REGION = 'europe-west1';       // adapte si besoin
const ACTIVE_WINDOW_DAYS = 90;       // fenêtre glissante des RDV "actifs"
const BATCH_SIZE = 400;              // limite Firestore par batch = 500

/**
 * Tourne chaque nuit à 3h (heure de Tunis).
 * Déplace tout RDV dont la date < aujourd'hui - 90 jours
 * de "appointments" vers "appointments_history".
 * La collection "appointments" reste donc toujours petite,
 * quel que soit l'âge du cabinet.
 */
exports.archiveOldAppointments = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'Africa/Tunis', region: REGION },
  async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ACTIVE_WINDOW_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // format "AAAA-MM-JJ", identique au champ "date"

    let totalMigrated = 0;
    let snap;

    do {
      snap = await db
        .collection('appointments')
        .where('date', '<', cutoffStr)
        .limit(BATCH_SIZE)
        .get();

      if (snap.empty) break;

      const batch = db.batch();
      snap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        // On copie le RDV tel quel dans l'archive (même id, pour garder les liens éventuels)
        batch.set(db.collection('appointments_history').doc(docSnap.id), {
          ...data,
          archivedAt: FieldValue.serverTimestamp(),
        });
        batch.delete(docSnap.ref);
      });

      await batch.commit();
      totalMigrated += snap.size;
    } while (snap.size === BATCH_SIZE); // continue tant qu'il reste un batch plein

    console.log(`archiveOldAppointments : ${totalMigrated} RDV migrés vers appointments_history (cutoff ${cutoffStr}).`);
  }
);

/**
 * Se déclenche à chaque création/modification/suppression d'un document
 * dans "appointments" OU "appointments_history" (même trigger réutilisable).
 * Maintient un compteur agrégé par patient dans patients/{telephone},
 * pour ne plus jamais avoir à scanner tout l'historique côté client.
 *
 * Champs maintenus : honoredCount, absentCount, totalCount
 */
async function syncPatientStats(beforeData, afterData) {
  const phone = (afterData || beforeData)?.phone;
  if (!phone) return;

  const wasCreated = !beforeData && !!afterData;
  const wasDeleted = !!beforeData && !afterData;

  const updates = {};

  // totalCount/honoredCount/absentCount sont un cumul à vie : on incrémente
  // à la création, on ne décrémente JAMAIS sur une suppression, car une
  // suppression de "appointments" est presque toujours un archivage normal
  // vers "appointments_history" (le RDV existe toujours, juste ailleurs).
  if (wasCreated) updates.totalCount = FieldValue.increment(1);

  // Important : sur une suppression (archivage), on ignore le diff de "honored"
  // (afterHonored serait "undefined"), sinon on décrémenterait honoredCount/
  // absentCount à tort à chaque archivage nocturne alors que le RDV n'a pas
  // changé de statut, juste de collection.
  if (!wasDeleted) {
    const beforeHonored = beforeData ? beforeData.honored : undefined;
    const afterHonored = afterData ? afterData.honored : undefined;

    if (beforeHonored !== afterHonored) {
      if (beforeHonored === true) updates.honoredCount = FieldValue.increment(-1);
      if (beforeHonored === false) updates.absentCount = FieldValue.increment(-1);
      if (afterHonored === true) updates.honoredCount = FieldValue.increment(1);
      if (afterHonored === false) updates.absentCount = FieldValue.increment(1);
    }
  }

  if (Object.keys(updates).length === 0) return;

  await db.collection('patients').doc(phone).set(updates, { merge: true });
}

exports.onAppointmentWrite = onDocumentWritten(
  { document: 'appointments/{apptId}', region: REGION },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    await syncPatientStats(before, after);
  }
);

exports.onAppointmentHistoryWrite = onDocumentWritten(
  { document: 'appointments_history/{apptId}', region: REGION },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    // Ici on ne recalcule PAS totalCount (déjà compté au moment de la création dans "appointments"),
    // seulement les changements de statut "honored" faits après archivage, si jamais ça arrive.
    if (before && after && before.honored !== after.honored) {
      await syncPatientStats(before, after);
    }
  }
);
