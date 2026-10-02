// Récap du matin pour le médecin : liste des RDV du jour (push FCM).
// Lancé par .github/workflows/send-doctor-digest.yml (quotidien).
const { db, todayTunis, sendToDoctor } = require('./_doctor-push');

(async () => {
  const today = todayTunis();
  const snap = await db.collection('appointments').where('date', '==', today).get();
  const list = snap.docs
    .map(d => d.data())
    .filter(a => !a.deleted)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  let title, body;
  if (!list.length) {
    title = 'Aujourd\'hui : aucun rendez-vous';
    body = 'Planning libre.';
  } else {
    title = `Aujourd'hui : ${list.length} RDV`;
    const lines = list.slice(0, 6).map(a => `${a.time || '--:--'} ${a.name || 'Patient'}`);
    if (list.length > 6) lines.push(`… +${list.length - 6} autres`);
    body = lines.join('\n');
  }
  const sent = await sendToDoctor({ title, body, data: { type: 'digest', date: today } });
  console.log(`Récap ${today} : ${list.length} RDV, envoyé à ${sent} appareil(s).`);
})().catch(e => { console.error(e); process.exit(1); });
