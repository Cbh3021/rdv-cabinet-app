// Helpers partagés par send-doctor-digest.js et notify-doctor-alerts.js.
const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Secret FIREBASE_SERVICE_ACCOUNT manquant.');
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

// Date du jour (YYYY-MM-DD) à l'heure de Tunis, quel que soit le fuseau du runner GitHub (UTC).
function todayTunis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
}
function fmtDateFr(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Envoie une notification à tous les appareils des comptes admin et purge les tokens périmés.
async function sendToDoctor({ title, body, data = {} }) {
  const adminsSnap = await db.collection('admins').get();
  const targets = []; // { ref, token }
  adminsSnap.forEach(d => {
    (d.data().fcmTokens || []).forEach(token => targets.push({ ref: d.ref, token }));
  });
  if (!targets.length) {
    console.log('Aucun token médecin enregistré — ouvre l\'appli en mode médecin pour en créer un.');
    return 0;
  }
  const res = await admin.messaging().sendEachForMulticast({
    tokens: targets.map(t => t.token),
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: { priority: 'high', notification: { sound: 'default' } }
  });
  let ok = 0;
  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) { ok++; return; }
    const code = r.error && r.error.code;
    console.warn('Échec envoi :', code);
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      dead.push(targets[i]);
    }
  });
  for (const t of dead) {
    await t.ref.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(t.token) });
  }
  if (ok === 0) throw new Error('Aucune notification envoyée (voir les échecs ci-dessus).');
  return ok;
}

module.exports = { admin, db, todayTunis, fmtDateFr, sendToDoctor };
