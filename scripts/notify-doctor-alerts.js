// Alertes médecin (quasi temps réel, polling toutes les 10 min) :
//  - nouveau RDV créé ailleurs que dans l'appli médecin (ex. serveur rdv-paiement)
//  - nouvelle demande d'annulation / de décalage faite par un patient
// État conservé dans meta/doctorAlerts (accessible uniquement via l'Admin SDK).
// Lancé par .github/workflows/notify-doctor-alerts.yml.
const { admin, db, todayTunis, fmtDateFr, sendToDoctor } = require('./_doctor-push');

(async () => {
  const metaRef = db.collection('meta').doc('doctorAlerts');
  const meta = (await metaRef.get()).data() || {};
  const prevNotified = meta.notifiedRequests || {};
  const lastChecked = meta.lastCheckedAt || null; // Timestamp

  // Seuls les RDV à venir comptent (le passé n'a plus d'intérêt pour une alerte).
  const snap = await db.collection('appointments').where('date', '>=', todayTunis()).get();

  const events = [];
  const notified = {}; // reconstruit à chaque passage => purge automatique des demandes traitées
  snap.docs.forEach(d => {
    const a = d.data();
    if (a.deleted) return;

    const r = a.patientRequest;
    if (r && r.type) {
      const stamp = r.requestedAt || 'x';
      notified[d.id] = stamp;
      if (lastChecked && prevNotified[d.id] !== stamp) {
        events.push(r.type === 'reschedule'
          ? { title: 'Demande de décalage', body: `${a.name} : ${fmtDateFr(a.date)} ${a.time} → ${fmtDateFr(r.requestedDate)} ${r.requestedTime}` }
          : { title: 'Demande d\'annulation', body: `${a.name} — RDV du ${fmtDateFr(a.date)} à ${a.time}` });
      }
    }

    if (lastChecked && a.createdBy !== 'admin' && d.createTime && d.createTime.toMillis() > lastChecked.toMillis()) {
      events.push({ title: 'Nouveau rendez-vous', body: `${a.name} — ${fmtDateFr(a.date)} à ${a.time}${a.reason ? ' (' + a.reason + ')' : ''}` });
    }
  });

  if (!lastChecked) {
    console.log('Premier passage : état de référence enregistré, aucune alerte envoyée.');
  } else if (!events.length) {
    console.log('Rien de nouveau.');
  } else if (events.length <= 3) {
    for (const e of events) await sendToDoctor({ ...e, data: { type: 'alert' } });
    console.log(`${events.length} alerte(s) envoyée(s).`);
  } else {
    await sendToDoctor({
      title: `${events.length} nouveautés`,
      body: events.slice(0, 5).map(e => `${e.title} : ${e.body}`).join('\n'),
      data: { type: 'alert' }
    });
    console.log(`${events.length} alertes regroupées en une notification.`);
  }

  // On n'avance l'état qu'après un envoi réussi (une erreur ci-dessus relance l'alerte au prochain passage).
  // snap.readTime : aucun RDV créé pendant l'exécution n'est perdu ni compté deux fois.
  await metaRef.set({ lastCheckedAt: snap.readTime, notifiedRequests: notified });
})().catch(e => { console.error(e); process.exit(1); });
