/* =======================================================================
   FIREBASE — CONFIGURATION REQUISE
   1. https://console.firebase.google.com → créer un projet (gratuit)
   2. Build > Firestore Database > Créer une base (mode test au départ)
   3. Build > Authentication > Sign-in method > activer "E-mail/Mot de passe"
      (utilisé à la fois pour le médecin et pour les patients — plus besoin
      d'activer "Téléphone", ni de facturation Blaze, ni de SHA/Play
      Integrity : le code patient est un mot de passe permanent généré
      automatiquement, aucun SMS n'est envoyé).
   4. Authentication > Users > Add user → crée TON compte médecin (email+mdp)
   5. Copie son "User UID", puis dans Firestore Database > Data, crée
      manuellement une collection "admins" avec un document dont l'ID EST
      cet UID (n'importe quel champ dedans, ex: role: "admin").
   6. Paramètres du projet > Tes applications > Ajouter une app Web →
      copie les valeurs ci-dessous dans firebaseConfig.
   7. Pour l'APK : Paramètres du projet > Tes applications > Ajouter une
      app Android avec le package "com.belhoula.rdvcabinet", télécharge
      google-services.json et place-le dans android/app/.
   8. Dans Firestore Database > Règles, colle le contenu de firestore.rules
      puis Publier.
   9. Le patient ne crée plus lui-même son compte : c'est le médecin qui le
      crée depuis l'appli au moment du 1er RDV (bouton "Enregistrer"), et le
      code s'affiche dans une popup à recopier/donner au patient.
   10. Notifications push (optionnel, 100% gratuit — pas de plan Blaze) :
      a. Project Settings > Cloud Messaging > Web configuration > générer
         une paire de clés VAPID, coller la clé publique dans VAPID_KEY
         ci-dessous. (Cloud Messaging est gratuit sur le plan Spark.)
      b. Project Settings > Comptes de service > "Générer une nouvelle clé
         privée" → enregistrer ce JSON comme secret GitHub
         FIREBASE_SERVICE_ACCOUNT (jamais dans le dépôt).
      c. Le workflow .github/workflows/send-reminders.yml exécute chaque
         jour scripts/send-reminders.js sur un cron GitHub Actions gratuit
         (aucune Cloud Function, aucune facturation Firebase) : il envoie
         un rappel J-3, J-1 et jour J à tout patient ayant activé les
         notifications.
      d. Placer public/firebase-messaging-sw.js à la racine du site déployé
         (même config que firebaseConfig ci-dessous).
   ======================================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyBLCg0Wnu52-QziLAcU2qIjj7iR8JwUMsk",
  authDomain: "rdv-cabinet-belhoula.firebaseapp.com",
  projectId: "rdv-cabinet-belhoula",
  storageBucket: "rdv-cabinet-belhoula.firebasestorage.app",
  messagingSenderId: "783489025252",
  appId: "1:783489025252:web:e4612030b334faf34fd8f1"
};
const COUNTRY_CODE = "216"; // Tunisie

const isConfigured = firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY";

import { initializeApp, deleteApp } from "firebase/app";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, addDoc, updateDoc, deleteDoc, doc, getDoc, setDoc,
  onSnapshot, query, where
} from "firebase/firestore";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "firebase/auth";
import { getMessaging, getToken as getFcmToken, isSupported as isMessagingSupported } from "firebase/messaging";
import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";

const isNative = Capacitor.isNativePlatform();

// Clé VAPID publique du projet Firebase (Console > Project Settings > Cloud
// Messaging > Web configuration > "Generate key pair"). Nécessaire pour les
// notifications push web. Laisser vide désactive juste ce bouton, le reste
// de l'appli fonctionne normalement.
const VAPID_KEY = "";

let db=null, auth=null, apptsCol=null, contactsCol=null, messaging=null;
if(isConfigured){
  const app = initializeApp(firebaseConfig);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
    experimentalForceLongPolling: true,
    useFetchStreams: false
  });
  auth = getAuth(app);
  apptsCol = collection(db, "appointments");
  // Carnet de contacts (nom lié au numéro de téléphone), rempli/mis à jour
  // automatiquement à chaque enregistrement de RDV. Dans firestore.rules,
  // donne à la collection "contacts" les mêmes règles (lecture/écriture
  // réservées au médecin) que la collection "appointments", plus le droit
  // pour le patient propriétaire de mettre à jour uniquement son fcmToken.
  contactsCol = collection(db, "contacts");

  // Messaging (push web) : optionnel, ne bloque jamais le reste de l'appli
  // s'il n'est pas supporté (Safari ancien, contexte non sécurisé, etc.)
  isMessagingSupported().then(supported=>{
    if(supported){ try{ messaging = getMessaging(app); }catch(e){ console.warn("FCM indisponible", e); } }
  });
} else {
  document.getElementById('configBanner').style.display = 'block';
}

/* ---------------- config: reasons (liste officielle APCI - CNAM) ---------------- */
const REASONS = [
  "Consultation générale",
  "APCI 001 – Diabète",
  "APCI 002 – Dysthyroïdies",
  "APCI 003 – Affections hypophysaires",
  "APCI 004 – Affections surrénaliennes",
  "APCI 005 – HTA sévère",
  "APCI 006 – Cardiopathies congénitales et valvulopathies",
  "APCI 007 – Insuffisance cardiaque et troubles du rythme",
  "APCI 008 – Affections coronariennes",
  "APCI 009 – Phlébites",
  "APCI 010 – Tuberculose active",
  "APCI 011 – Insuffisance respiratoire chronique (BPCO)",
  "APCI 012 – Sclérose en plaques",
  "APCI 013 – Épilepsie",
  "APCI 014 – Maladie de Parkinson",
  "APCI 015 – Psychoses et névroses",
  "APCI 016 – Insuffisance rénale chronique",
  "APCI 017 – Rhumatismes inflammatoires chroniques",
  "APCI 018 – Maladies auto-immunes",
  "APCI 019 – Tumeurs et hémopathies malignes",
  "APCI 020 – Maladies inflammatoires chroniques de l'intestin",
  "APCI 021 – Hépatites chroniques actives",
  "APCI 022 – Cirrhose et insuffisance hépatique",
  "APCI 023 – Glaucome",
  "APCI 024 – Mucoviscidose",
  "Suivi grossesse",
  "Suivi post-opératoire",
  "Vaccination",
  "Homéopathie",
  "Rappel Bilan",
  "Autre"
];

let appointments = [];
let contacts = []; // carnet {id, name, phone(E164)} — lié nom ↔ téléphone
let unsubscribeContacts = null;
let editingId = null;
let muted = false;
let role = null;
let patientPhoneE164 = null;
let unsubscribeAppts = null;
let syncOn = false;
let lang = localStorage.getItem('rdvLang') || 'fr';

/* ---------------- helpers ---------------- */
function uid(){ return Math.random().toString(36).slice(2,10); }
function patientEmailFor(e164){ return "p" + e164 + "@rdvcabinet.local"; }
function generatePatientCode(){ return String(Math.floor(100000 + Math.random()*900000)); }
function phoneFromPatientEmail(email){
  if(!email || !email.startsWith("p+") || !email.endsWith("@rdvcabinet.local")) return null;
  return email.slice(1, email.length - "@rdvcabinet.local".length);
}
function todayStr(){ return new Date().toISOString().slice(0,10); }

/* ---------------- ADMIN: création de compte patient (remis en main propre) ----------------
   Le patient ne peut plus s'auto-inscrire : ça évitait qu'un tiers connaissant
   son numéro crée le compte à sa place et intercepte ensuite ses RDV.
   Le médecin crée le compte au cabinet et communique le code directement au
   patient. On utilise une 2e instance Firebase ("scratch app") pour que la
   création de compte ne déconnecte pas la session admin en cours — le SDK
   Firebase Auth "signIn" automatiquement l'utilisateur nouvellement créé, ce
   qui écraserait sinon la session du médecin. */
async function createPatientAccountAsAdmin(e164){
  const scratchApp = initializeApp(firebaseConfig, "patientCreate_"+Date.now()+"_"+uid());
  const scratchAuth = getAuth(scratchApp);
  try{
    const code = generatePatientCode();
    await createUserWithEmailAndPassword(scratchAuth, patientEmailFor(e164), code);
    await signOut(scratchAuth).catch(()=>{});
    return code;
  } finally {
    await deleteApp(scratchApp).catch(()=>{});
  }
}

/* ---------------- PATIENT: activer les notifications push (FCM) ---------------- */
async function enableNotifications(){
  if(!messaging || !VAPID_KEY){ return {ok:false, reason:'unsupported'}; }
  try{
    const perm = await Notification.requestPermission();
    if(perm !== 'granted') return {ok:false, reason:'denied'};
    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    const token = await getFcmToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if(!token) return {ok:false, reason:'no-token'};
    // Écrit uniquement le champ fcmToken sur SON PROPRE contact — voir la
    // règle dédiée dans firestore.rules (le patient ne peut pas toucher aux
    // autres champs ni aux contacts d'autrui).
    await setDoc(doc(db,"contacts", patientPhoneE164), { fcmToken: token, lang }, { merge:true });
    return {ok:true};
  }catch(e){
    console.error("Erreur activation notifications", e);
    return {ok:false, reason:'error'};
  }
}
function toE164(raw){
  let digits = (raw||"").replace(/\D/g,"");
  if(digits.startsWith(COUNTRY_CODE)) digits = digits.slice(COUNTRY_CODE.length);
  digits = digits.replace(/^0+/,"");
  return "+" + COUNTRY_CODE + digits;
}
function fmtDate(d){ return new Date(d+"T00:00:00").toLocaleDateString(lang==='ar'?'ar-TN':'fr-FR',{weekday:'long',day:'2-digit',month:'long'}); }
function fmtDateShort(d){ return new Date(d+"T00:00:00").toLocaleDateString(lang==='ar'?'ar-TN':'fr-FR',{day:'2-digit',month:'short',year:'numeric'}); }
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function daysBetween(a,b){
  const d1=new Date(a+"T00:00:00"), d2=new Date(b+"T00:00:00");
  return Math.round((d2-d1)/86400000);
}
function statusOf(a){
  const diff = daysBetween(todayStr(), a.date);
  if(diff < 0) return {key:"past", label:t('status_past'), color:"#8a8d99"};
  if(diff === 0) return {key:"today", label:t('status_today'), color:"#FF9142"};
  if(diff <= 3) return {key:"soon", label:t('status_soon'), color:"var(--amber)"};
  return {key:"ok", label:t('status_ok'), color:"var(--teal)"};
}

/* ---------------- i18n ---------------- */
const TRANSLATIONS = {
  fr: {
    app_name: "Reminder CBH", brand_line: "Cabinet Dr. Hédi Belhoula",
    role_title: "RDV Médical",
    role_admin: "Médecin", role_admin_desc: "Gérer les rendez-vous",
    role_patient: "Patient", role_patient_desc: "Consulter mes RDV",
    sync_connected: "Connecté à Firebase", sync_connecting: "Connexion en cours…", sync_local: "Mode local (sans sync)",
    switch_role: "Changer de vue", sign_out: "Se déconnecter",
    admin_title: "Espace Médecin", patient_title: "Mes rendez-vous",
    admin_login_title: "Connexion médecin", admin_login_sub: "Connecte-toi avec ton compte pour gérer les rendez-vous.",
    email_label: "Email", password_label: "Mot de passe", login_btn: "Se connecter",
    login_error: "Identifiants incorrects.",
    not_authorized_error: "Ce compte n'est pas autorisé comme médecin sur cette appli.",
    verify_error: "Erreur de vérification du compte. Réessaie.",
    rdv_title: "Rendez-vous", add_rdv: "+ Fixer un RDV",
    no_rdv_admin_title: "Aucun rendez-vous", no_rdv_admin_sub: "Fixe un premier RDV pour démarrer.",
    no_rdv_prog: "Aucun rendez-vous programmé.",
    status_past: "Passé", status_today: "Aujourd'hui", status_soon: "Bientôt", status_ok: "À venir",
    patient_intro_title: "Mes rendez-vous",
    patient_intro_sub: "Entre ton numéro et le code personnel remis par le cabinet pour accéder à tes rendez-vous.",
    phone_placeholder: "Ex: 22 123 456",
    code_field_label: "Code personnel",
    patient_login_btn: "Accéder à mes rendez-vous",
    code_error: "Numéro ou code incorrect.",
    no_account_error: "Aucun compte pour ce numéro. Demande ton code au cabinet.",
    patient_code_title: "Code patient généré",
    patient_code_sub: "Note ce code et donne-le au patient — il lui sera demandé à chaque connexion.",
    patient_code_ok: "OK, noté",
    phone_hint_invalid: "Numéro invalide — 8 chiffres tunisiens attendus.",
    notif_banner_title: "Active les rappels",
    notif_banner_sub: "Reçois une notification avant chaque rendez-vous, même sans ouvrir l'appli.",
    notif_banner_btn: "Activer les notifications",
    notif_banner_error: "Impossible d'activer les notifications sur cet appareil.",
    no_rdv_patient_title: "Aucun rendez-vous trouvé",
    no_rdv_patient_sub: "Contacte le cabinet si tu penses qu'un RDV devrait apparaître ici.",
    with_doctor: "avec Dr Hédi Belhoula",
    days_before_1: "jour avant ton RDV", days_before_n: "jours avant ton RDV",
    at_time: "à", other_rdv: "Autres rendez-vous",
    modal_add_title: "Fixer un rendez-vous", modal_edit_title: "Modifier le rendez-vous",
    patient_name: "Nom du patient", patient_name_ph: "Nom et prénom",
    phone_number: "Numéro de téléphone", phone_hint: "Format tunisien à 8 chiffres — sera enregistré comme +216XXXXXXXX",
    date_label: "Date", time_label: "Heure", reason_label: "Motif / pathologie",
    notes_label: "Notes (optionnel)", notes_ph: "Notes internes",
    cancel_btn: "Annuler", save_btn: "Enregistrer",
    footer_text: "Outil interne de gestion des rendez-vous",
    delete_confirm: "Supprimer le RDV de",
    reminder1_title: "Rappel de rendez-vous",
    reminder1_msg: "Petit rappel : tu as rendez-vous avec Dr Hédi Belhoula dans 3 jours.",
    reminder2_title: "Rendez-vous imminent",
    reminder2_msg_tomorrow: "Ton rendez-vous avec Dr Hédi Belhoula est demain, n'oublie pas !",
    reminder2_msg_today: "Ton rendez-vous avec Dr Hédi Belhoula est aujourd'hui !",
    reminder_ok: "Compris",
    respect_date_note: "Prière de respecter la date du RDV indiqué.",
    archived_rdv: "RDV archivés",
    phone_label: "N° Tél",
    footer_address: "Route de Tunis km9, Cité El Ons"
  },
  ar: {
    app_name: "Reminder CBH", brand_line: "عيادة الدكتور الهادي بلحولة",
    role_title: "موعد طبي",
    role_admin: "الطبيب", role_admin_desc: "إدارة المواعيد",
    role_patient: "المريض", role_patient_desc: "الاطلاع على مواعيدي",
    sync_connected: "متصل بقاعدة البيانات", sync_connecting: "جارٍ الاتصال…", sync_local: "وضع محلي (بدون مزامنة)",
    switch_role: "تغيير العرض", sign_out: "تسجيل الخروج",
    admin_title: "فضاء الطبيب", patient_title: "مواعيدي",
    admin_login_title: "تسجيل دخول الطبيب", admin_login_sub: "سجّل الدخول لحسابك لإدارة المواعيد.",
    email_label: "البريد الإلكتروني", password_label: "كلمة السر", login_btn: "تسجيل الدخول",
    login_error: "بيانات الدخول غير صحيحة.",
    not_authorized_error: "هذا الحساب غير مصرح له كطبيب في هذا التطبيق.",
    verify_error: "خطأ في التحقق من الحساب. حاول مجدداً.",
    rdv_title: "المواعيد", add_rdv: "+ تحديد موعد",
    no_rdv_admin_title: "لا يوجد أي موعد", no_rdv_admin_sub: "حدد أول موعد للبدء.",
    no_rdv_prog: "لا يوجد أي موعد مبرمج.",
    status_past: "منقضٍ", status_today: "اليوم", status_soon: "قريباً", status_ok: "قادم",
    patient_intro_title: "مواعيدي",
    patient_intro_sub: "أدخل رقمك والرمز الشخصي الذي سلّمته لك العيادة للاطلاع على مواعيدك.",
    phone_placeholder: "مثال: 22 123 456",
    code_field_label: "الرمز الشخصي",
    patient_login_btn: "الاطلاع على مواعيدي",
    code_error: "الرقم أو الرمز غير صحيح.",
    no_account_error: "لا يوجد حساب لهذا الرقم. اطلب رمزك من العيادة.",
    patient_code_title: "تم إنشاء رمز المريض",
    patient_code_sub: "احتفظ بهذا الرمز وسلّمه للمريض — سيُطلب منه في كل اتصال.",
    patient_code_ok: "تم الحفظ",
    phone_hint_invalid: "رقم غير صالح — يجب أن يتكوّن من 8 أرقام تونسية.",
    notif_banner_title: "فعّل التذكيرات",
    notif_banner_sub: "استلم إشعاراً قبل كل موعد، حتى دون فتح التطبيق.",
    notif_banner_btn: "تفعيل الإشعارات",
    notif_banner_error: "تعذّر تفعيل الإشعارات على هذا الجهاز.",
    no_rdv_patient_title: "لم يتم العثور على أي موعد",
    no_rdv_patient_sub: "تواصل مع العيادة إذا كنت تعتقد أن موعداً يجب أن يظهر هنا.",
    with_doctor: "مع الدكتور الهادي بلحولة",
    days_before_1: "يوم قبل موعدك", days_before_n: "أيام قبل موعدك",
    at_time: "على الساعة", other_rdv: "مواعيد أخرى",
    modal_add_title: "تحديد موعد", modal_edit_title: "تعديل الموعد",
    patient_name: "اسم المريض", patient_name_ph: "الاسم واللقب",
    phone_number: "رقم الهاتف", phone_hint: "صيغة تونسية من 8 أرقام — سيُسجَّل كـ +216XXXXXXXX",
    date_label: "التاريخ", time_label: "التوقيت", reason_label: "السبب / الحالة",
    notes_label: "ملاحظات (اختياري)", notes_ph: "ملاحظات داخلية",
    cancel_btn: "إلغاء", save_btn: "حفظ",
    footer_text: "أداة داخلية لإدارة المواعيد",
    delete_confirm: "حذف موعد",
    reminder1_title: "تذكير بالموعد",
    reminder1_msg: "تذكير بسيط: لديك موعد مع الدكتور الهادي بلحولة بعد 3 أيام.",
    reminder2_title: "موعد وشيك",
    reminder2_msg_tomorrow: "موعدك مع الدكتور الهادي بلحولة غداً، لا تنسَ!",
    reminder2_msg_today: "موعدك مع الدكتور الهادي بلحولة اليوم!",
    reminder_ok: "فهمت",
    respect_date_note: "يرجى احترام تاريخ الموعد المحدد.",
    archived_rdv: "المواعيد المؤرشفة",
    phone_label: "الهاتف",
    footer_address: "طريق تونس، كم 9، حي الأنس"
  }
};
function t(key){ return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS.fr[key] || key; }

function applyLanguage(){
  document.documentElement.lang = lang==='ar' ? 'ar' : 'fr';
  document.documentElement.dir = lang==='ar' ? 'rtl' : 'ltr';
  document.getElementById('langBtnGate').textContent = lang==='ar' ? 'FR' : 'AR';

  document.getElementById('roleGateTitle').textContent = t('role_title');
  document.getElementById('roleGateBadge').textContent = t('brand_line');
  document.getElementById('footerPhoneLabel').textContent = t('phone_label');
  document.getElementById('footerAddress').textContent = t('footer_address');
  document.getElementById('roleAdminLabel').textContent = t('role_admin');
  document.getElementById('roleAdminDesc').textContent = t('role_admin_desc');
  document.getElementById('rolePatientLabel').textContent = t('role_patient');
  document.getElementById('rolePatientDesc').textContent = t('role_patient_desc');
  document.getElementById('switchRoleBtn').textContent = t('switch_role');
  document.getElementById('signOutBtn').textContent = t('sign_out');
  document.getElementById('adminLoginTitle').textContent = t('admin_login_title');
  document.getElementById('adminLoginSub').textContent = t('admin_login_sub');
  document.getElementById('emailLabel').textContent = t('email_label');
  document.getElementById('passwordLabel').textContent = t('password_label');
  document.getElementById('adminLoginBtn').textContent = t('login_btn');
  document.getElementById('rdvTitleLabel').textContent = t('rdv_title');
  document.getElementById('addBtn').textContent = t('add_rdv');
  document.getElementById('patientIntroTitle').textContent = t('patient_intro_title');
  document.getElementById('patientIntroSub').textContent = t('patient_intro_sub');
  document.getElementById('respectDateNote').textContent = t('respect_date_note');
  document.getElementById('phoneInput').placeholder = t('phone_placeholder');
  document.getElementById('codeFieldLabel').textContent = t('code_field_label');
  document.getElementById('codeInput').placeholder = '123456';
  document.getElementById('patientLoginBtn').textContent = t('patient_login_btn');
  document.getElementById('patientCodeTitle').textContent = t('patient_code_title');
  document.getElementById('patientCodeSub').textContent = t('patient_code_sub');
  document.getElementById('patientCodeOkBtn').textContent = t('patient_code_ok');
  document.getElementById('modalTitle').textContent = editingId ? t('modal_edit_title') : t('modal_add_title');
  document.getElementById('nameLabel').textContent = t('patient_name');
  document.getElementById('fName').placeholder = t('patient_name_ph');
  document.getElementById('phoneFieldLabel').textContent = t('phone_number');
  document.getElementById('fPhone').placeholder = t('phone_placeholder');
  document.getElementById('phoneFieldHint').textContent = t('phone_hint');
  document.getElementById('dateLabel').textContent = t('date_label');
  document.getElementById('timeLabel').textContent = t('time_label');
  document.getElementById('reasonLabel').textContent = t('reason_label');
  document.getElementById('notesLabel').textContent = t('notes_label');
  document.getElementById('fNotes').placeholder = t('notes_ph');
  document.getElementById('cancelBtn').textContent = t('cancel_btn');
  document.getElementById('saveBtn').textContent = t('save_btn');
  document.getElementById('footerSub').textContent = t('footer_text');
  document.getElementById('reminderOkBtn').textContent = t('reminder_ok');
  document.getElementById('appTitle').textContent = role==='admin' ? t('admin_title') : (role==='patient' ? t('patient_title') : t('app_name'));

  setSyncStatus(syncOn);
  if(role==='admin') renderAdmin();
  if(role==='patient' && document.getElementById('patientResultWrap').style.display!=='none') refreshPatientResults();
}

function toggleLang(){
  lang = lang==='ar' ? 'fr' : 'ar';
  localStorage.setItem('rdvLang', lang);
  applyLanguage();
}
document.getElementById('langBtnGate').addEventListener('click', toggleLang);

/* ---------------- sunrise signature ---------------- */
function sunriseSVG(a){
  const diff = daysBetween(todayStr(), a.date);
  const span = 30;
  let progress = 1 - Math.min(Math.max(diff,0),span)/span;
  let past = diff < 0;
  const w=230,h=70, horizonY=52;
  const sunX = 30 + progress*170;
  let sunY, skyTop, skyBottom, sunColor, glow;
  if(past){
    sunY = horizonY + 6;
    skyTop="#7C93C3"; skyBottom="#B9C6E0"; sunColor="#9AA5C0"; glow="rgba(154,165,192,0.4)";
  } else {
    sunY = horizonY - (progress*34);
    skyTop = mix("#7C93C3","#FFB26B",progress);
    skyBottom = mix("#FFE8CF","#FF7B54",progress);
    sunColor = mix("#FFE9B8","#FF7B54",progress);
    glow = "rgba(255,178,107,0.5)";
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="60" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="sky${a.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${skyTop}"/><stop offset="100%" stop-color="${skyBottom}"/>
    </linearGradient></defs>
    <rect x="0" y="0" width="${w}" height="${horizonY}" fill="url(#sky${a.id})" rx="10"/>
    <circle cx="${sunX}" cy="${sunY}" r="12" fill="${glow}"/>
    <circle cx="${sunX}" cy="${sunY}" r="7" fill="${sunColor}"/>
    <rect x="0" y="${horizonY}" width="${w}" height="${h-horizonY}" fill="#3D2B24"/>
  </svg>`;
}
function mix(hex1,hex2,t){
  const c1=hexToRgb(hex1), c2=hexToRgb(hex2);
  return `rgb(${Math.round(c1.r+(c2.r-c1.r)*t)},${Math.round(c1.g+(c2.g-c1.g)*t)},${Math.round(c1.b+(c2.b-c1.b)*t)})`;
}
function hexToRgb(hex){ const v=hex.replace('#',''); return {r:parseInt(v.substr(0,2),16),g:parseInt(v.substr(2,2),16),b:parseInt(v.substr(4,2),16)}; }

/* ---------------- audio chime ---------------- */
let audioCtx=null;
function chime(){
  if(muted) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    [523.25,659.25,783.99].forEach((freq,i)=>{
      const osc=audioCtx.createOscillator(), gain=audioCtx.createGain();
      osc.type="sine"; osc.frequency.value=freq;
      const start=audioCtx.currentTime+i*0.16;
      gain.gain.setValueAtTime(0,start);
      gain.gain.linearRampToValueAtTime(0.18,start+0.04);
      gain.gain.exponentialRampToValueAtTime(0.001,start+0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start); osc.stop(start+0.55);
    });
  }catch(e){}
}

/* ---------------- role gate ---------------- */
document.getElementById('chooseAdmin').addEventListener('click', ()=>enterRole('admin'));
document.getElementById('chooseAdminPatient').addEventListener('click', ()=>enterRole('patient'));
document.getElementById('switchRoleBtn').addEventListener('click', async ()=>{
  if(isConfigured){
    if(isNative){ try{ await FirebaseAuthentication.signOut(); }catch(e){} }
    try{ if(auth.currentUser){ await signOut(auth); } }catch(e){}
  }
  teardownView();
  role=null;
  document.getElementById('appShell').style.display='none';
  document.getElementById('roleGate').style.display='flex';
});
document.getElementById('signOutBtn').addEventListener('click', async ()=>{
  if(isConfigured){
    if(isNative){ try{ await FirebaseAuthentication.signOut(); }catch(e){} }
    try{ if(auth.currentUser){ await signOut(auth); } }catch(e){}
  }
  teardownView();
  role=null;
  document.getElementById('appShell').style.display='none';
  document.getElementById('roleGate').style.display='flex';
});

function teardownView(){
  if(unsubscribeAppts){ unsubscribeAppts(); unsubscribeAppts=null; }
  patientPhoneE164=null;
  appointments=[];
}

function enterRole(r){
  role=r;
  document.getElementById('roleGate').style.display='none';
  document.getElementById('appShell').style.display='block';
  document.getElementById('adminView').style.display = r==='admin' ? '' : 'none';
  document.getElementById('patientView').style.display = r==='patient' ? '' : 'none';
  document.getElementById('appTitle').textContent = r==='admin' ? t('admin_title') : t('patient_title');
  document.getElementById('signOutBtn').style.display = isConfigured ? '' : 'none';

  if(r==='admin'){
    if(!isConfigured){
      document.getElementById('adminLoginWrap').style.display='none';
      document.getElementById('adminContentWrap').style.display='';
      subscribeAdmin();
      subscribeContacts();
    } else if(auth.currentUser && !phoneFromPatientEmail(auth.currentUser.email)){
      checkAdminAndEnter();
    } else {
      document.getElementById('adminLoginWrap').style.display='';
      document.getElementById('adminContentWrap').style.display='none';
    }
  }
  if(r==='patient'){
    document.getElementById('patientResultWrap').style.display='none';
    const existingPhone = isConfigured && auth.currentUser ? phoneFromPatientEmail(auth.currentUser.email) : null;
    if(!isConfigured || !existingPhone){
      document.getElementById('phoneGate').style.display='';
      document.getElementById('phoneInput').value='';
      document.getElementById('codeInput').value='';
    } else {
      patientPhoneE164 = existingPhone;
      document.getElementById('phoneGate').style.display='none';
      document.getElementById('patientResultWrap').style.display='';
      subscribePatient();
      maybeShowNotifBanner();
    }
  }
}

/* ---------------- PATIENT: bannière d'activation des notifications ---------------- */
function maybeShowNotifBanner(){
  const banner = document.getElementById('notifBanner');
  if(!banner) return;
  const supported = !!(messaging && VAPID_KEY && 'Notification' in window);
  const alreadyGranted = supported && Notification.permission === 'granted';
  if(!supported || alreadyGranted){ banner.style.display='none'; return; }
  banner.style.display='';
  banner.innerHTML = `<div class="patient-hero" style="padding:16px 20px;text-align:left;">
    <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${t('notif_banner_title')}</div>
    <div style="font-size:12.5px;color:#6b6f80;margin-bottom:10px;">${t('notif_banner_sub')}</div>
    <button class="btn-primary" id="notifEnableBtn" style="width:100%;">${t('notif_banner_btn')}</button>
  </div>`;
  document.getElementById('notifEnableBtn').addEventListener('click', async ()=>{
    const res = await enableNotifications();
    if(res.ok){ banner.style.display='none'; }
    else { banner.querySelector('div').textContent = t('notif_banner_error'); }
  });
}

document.getElementById('muteBtn').addEventListener('click', ()=>{
  muted=!muted;
  document.getElementById('muteBtn').textContent = muted ? "🔇" : "🔊";
});

/* ---------------- ADMIN: auth (email/mot de passe) ---------------- */
async function checkAdminAndEnter(){
  try{
    const snap = await getDoc(doc(db,"admins",auth.currentUser.uid));
    if(snap.exists()){
      document.getElementById('adminLoginWrap').style.display='none';
      document.getElementById('adminContentWrap').style.display='';
      subscribeAdmin();
      subscribeContacts();
    } else {
      showAdminError(t('not_authorized_error'));
      await signOut(auth);
    }
  }catch(e){
    showAdminError(t('verify_error'));
  }
}
function showAdminError(msg){
  const el = document.getElementById('adminLoginError');
  el.textContent = msg; el.style.display='block';
}
document.getElementById('adminLoginBtn').addEventListener('click', async ()=>{
  const email = document.getElementById('adminEmail').value.trim();
  const pwd = document.getElementById('adminPassword').value;
  document.getElementById('adminLoginError').style.display='none';
  if(!email || !pwd) return;
  try{
    await signInWithEmailAndPassword(auth, email, pwd);
    await checkAdminAndEnter();
  }catch(e){
    showAdminError(t('login_error'));
  }
});

if(isConfigured){
  onAuthStateChanged(auth, (user)=>{
    setSyncStatus(true);
    if(role==='admin' && user){ checkAdminAndEnter(); }
  }, ()=> setSyncStatus(false));
} else {
  setSyncStatus(false);
}

function setSyncStatus(on){
  syncOn = on;
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if(!dot) return;
  dot.classList.toggle('off', !on);
  label.textContent = on ? t('sync_connected') : (isConfigured ? t('sync_connecting') : t('sync_local'));
}

/* ---------------- ADMIN: data subscription (all appointments) ---------------- */
function subscribeAdmin(){
  if(unsubscribeAppts) unsubscribeAppts();
  if(!isConfigured){ renderAdmin(); return; }
  unsubscribeAppts = onSnapshot(apptsCol, snap=>{
    appointments = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderAdmin();
  }, err=>console.error("Firestore admin listener error", err));
}

/* ---------------- data layer (writes) ---------------- */
async function createAppointment(data){
  if(isConfigured) await addDoc(apptsCol, data);
  else { appointments.push({id:uid(), ...data}); renderAdmin(); }
}
async function editAppointment(id, data){
  if(isConfigured) await updateDoc(doc(db,"appointments",id), data);
  else { Object.assign(appointments.find(x=>x.id===id), data); renderAdmin(); }
}
async function removeAppointment(id){
  if(isConfigured) await deleteDoc(doc(db,"appointments",id));
  else { appointments = appointments.filter(x=>x.id!==id); renderAdmin(); }
}

/* ---------------- ADMIN: render list ---------------- */
function rdvCardHtml(a){
  const st = statusOf(a);
  return `<div class="rdv-card">
      <div class="rdv-time">${a.time}</div>
      <div class="rdv-info">
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="meta">${escapeHtml(a.reason)} · ${escapeHtml(a.phone)}</div>
      </div>
      <span class="status-pill" style="background:${st.color};color:#fff">${st.label}</span>
      <div class="rdv-actions">
        <button class="mini-btn" data-action="edit" data-id="${a.id}" title="Modifier">✎</button>
        <button class="mini-btn" data-action="delete" data-id="${a.id}" title="Supprimer">🗑</button>
      </div>
    </div>`;
}
function renderAdmin(){
  const list = document.getElementById('rdvList');
  const all = [...appointments];
  const todayCount = all.filter(a=>statusOf(a).key==='today').length;
  document.getElementById('summaryLine').textContent =
    all.length===0 ? t('no_rdv_prog') : `${all.length} RDV — ${todayCount} ${t('status_today').toLowerCase()}`;

  if(all.length===0){
    list.innerHTML = `<div class="empty"><div class="display">${t('no_rdv_admin_title')}</div><div>${t('no_rdv_admin_sub')}</div></div>`;
    return;
  }

  const upcoming = all.filter(a=>statusOf(a).key!=='past').sort((a,b)=> (a.date+a.time).localeCompare(b.date+b.time));
  const past = all.filter(a=>statusOf(a).key==='past').sort((a,b)=> (b.date+b.time).localeCompare(a.date+a.time));

  let html='', lastDate=null;
  if(upcoming.length===0){
    html += `<div class="empty"><div class="display">${t('no_rdv_admin_title')}</div><div>${t('no_rdv_admin_sub')}</div></div>`;
  } else {
    upcoming.forEach(a=>{
      if(a.date!==lastDate){
        html += `<div class="day-heading">${fmtDate(a.date)}</div>`;
        lastDate=a.date;
      }
      html += rdvCardHtml(a);
    });
  }

  if(past.length>0){
    html += `<div class="day-heading" style="margin-top:32px;">${t('archived_rdv')}</div>`;
    let lastPastDate=null;
    past.forEach(a=>{
      if(a.date!==lastPastDate){
        html += `<div class="day-heading">${fmtDate(a.date)}</div>`;
        lastPastDate=a.date;
      }
      html += rdvCardHtml(a);
    });
  }

  list.innerHTML = html;
}

/* ---------------- ADMIN: carnet de contacts (nom lié au téléphone) ---------------- */
function subscribeContacts(){
  if(unsubscribeContacts) unsubscribeContacts();
  if(!isConfigured){
    try{ contacts = JSON.parse(localStorage.getItem('rdvContacts') || '[]'); }
    catch(e){ contacts = []; }
    refreshNameSuggestions();
    return;
  }
  unsubscribeContacts = onSnapshot(contactsCol, snap=>{
    contacts = snap.docs.map(d=>({id:d.id, ...d.data()}));
    refreshNameSuggestions();
  }, err=>console.error("Firestore contacts listener error", err));
}
function refreshNameSuggestions(){
  const dl = document.getElementById('nameSuggestions');
  if(!dl) return;
  const seen = new Set();
  dl.innerHTML = contacts
    .filter(c=>{ if(seen.has(c.name)) return false; seen.add(c.name); return true; })
    .map(c=>`<option value="${escapeHtml(c.name)}"></option>`).join('');
}
async function saveContact(name, phone, extra){
  if(!name || !phone) return;
  const data = Object.assign({name, phone}, extra||{});
  if(isConfigured){
    try{ await setDoc(doc(db,"contacts", phone), data, { merge:true }); }
    catch(e){ console.error("Erreur sauvegarde contact", e); }
  } else {
    const i = contacts.findIndex(c=>c.phone===phone);
    if(i>=0) Object.assign(contacts[i], data); else contacts.push({id:phone, ...data});
    localStorage.setItem('rdvContacts', JSON.stringify(contacts));
    refreshNameSuggestions();
  }
}
function contactHasAccount(phone){
  const c = contacts.find(c=>c.phone===phone);
  return !!(c && c.hasAccount);
}
document.getElementById('fName').addEventListener('input', ()=>{
  const name = document.getElementById('fName').value.trim();
  if(!name) return;
  const match = contacts.find(c => c.name.toLowerCase() === name.toLowerCase());
  if(match) document.getElementById('fPhone').value = match.phone.replace('+'+COUNTRY_CODE,'');
});

document.getElementById('rdvList').addEventListener('click', async (e)=>{
  const btn = e.target.closest('button[data-action]');
  if(!btn) return;
  const a = appointments.find(x=>x.id===btn.dataset.id);
  if(!a) return;
  if(btn.dataset.action==='edit') openModal(a);
  if(btn.dataset.action==='delete'){
    if(confirm(`${t('delete_confirm')} ${a.name} ?`)){
      await removeAppointment(a.id);
    }
  }
});

/* ---------------- ADMIN: modal ---------------- */
function fillReasonSelect(){
  document.getElementById('fReason').innerHTML = REASONS.map(r=>`<option value="${r}">${r}</option>`).join('');
}
function openModal(a){
  editingId = a ? a.id : null;
  document.getElementById('modalTitle').textContent = a ? t('modal_edit_title') : t('modal_add_title');
  document.getElementById('fName').value = a ? a.name : '';
  document.getElementById('fPhone').value = a ? a.phone.replace('+'+COUNTRY_CODE,'') : '';
  document.getElementById('fDate').value = a ? a.date : todayStr();
  document.getElementById('fTime').value = a ? a.time : '09:00';
  document.getElementById('fReason').value = a ? a.reason : REASONS[0];
  document.getElementById('fNotes').value = a ? (a.notes||'') : '';
  document.getElementById('phoneFieldHint').style.color = '';
  document.getElementById('phoneFieldHint').textContent = t('phone_hint');
  document.getElementById('overlay').classList.add('open');
}
function closeModal(){ document.getElementById('overlay').classList.remove('open'); }

document.getElementById('addBtn').addEventListener('click', ()=>openModal(null));
document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('overlay').addEventListener('click',(e)=>{ if(e.target.id==='overlay') closeModal(); });

document.getElementById('saveBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('fName').value.trim();
  const phone = toE164(document.getElementById('fPhone').value.trim());
  const date = document.getElementById('fDate').value;
  const time = document.getElementById('fTime').value;
  const reason = document.getElementById('fReason').value;
  const notes = document.getElementById('fNotes').value.trim();
  if(!name || !phone || phone===("+"+COUNTRY_CODE) || !date) return;
  const digitsOnly = phone.replace('+'+COUNTRY_CODE,'');
  if(digitsOnly.length !== 8){
    document.getElementById('phoneFieldHint').style.color = 'var(--alert)';
    document.getElementById('phoneFieldHint').textContent = t('phone_hint_invalid');
    return;
  }
  const data = {name,phone,date,time,reason,notes};
  const isNewPhone = isConfigured && !contactHasAccount(phone);
  if(editingId) await editAppointment(editingId, data);
  else await createAppointment(data);

  if(isNewPhone){
    // Nouveau patient (au sens: pas encore de compte) → on crée son compte
    // ici même, et on lui remet le code en main propre. On ne le fait qu'une
    // fois par numéro : les visites suivantes n'en créent pas un nouveau.
    try{
      const code = await createPatientAccountAsAdmin(phone);
      await saveContact(name, phone, {hasAccount:true});
      showPatientCodeModal(code);
    }catch(e){
      console.error("Erreur création compte patient", e);
      // Le RDV est quand même enregistré ; on retentera la création de
      // compte au prochain RDV pour ce numéro (hasAccount reste absent).
      await saveContact(name, phone, {hasAccount:false});
    }
  } else {
    await saveContact(name, phone);
  }
  closeModal();
});

function showPatientCodeModal(code){
  document.getElementById('patientCodeValue').textContent = code;
  document.getElementById('patientCodeOverlay').classList.add('open');
}
document.getElementById('patientCodeOkBtn').addEventListener('click', ()=>{
  document.getElementById('patientCodeOverlay').classList.remove('open');
});

/* ---------------- PATIENT: connexion téléphone + code (code remis par le médecin) ----------------
   Le patient ne crée plus lui-même son compte (voir createPatientAccountAsAdmin
   côté admin) : il ne fait qu'entrer le numéro + le code à 6 chiffres qu'on
   lui a communiqués au cabinet. On réutilise Firebase Auth email/mot de passe
   (email dérivé du numéro, "mot de passe" = code), vérifié côté serveur. */

document.getElementById('patientLoginBtn').addEventListener('click', async ()=>{ await patientLogin(); });
document.getElementById('codeInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') patientLogin(); });

async function patientLogin(){
  const raw = document.getElementById('phoneInput').value.trim();
  const code = document.getElementById('codeInput').value.trim();
  document.getElementById('phoneError').style.display='none';
  if(!raw || !code) return;
  const e164 = toE164(raw);
  patientPhoneE164 = e164;

  if(!isConfigured){
    document.getElementById('phoneGate').style.display='none';
    document.getElementById('patientResultWrap').style.display='';
    subscribePatient();
    return;
  }
  try{
    await signInWithEmailAndPassword(auth, patientEmailFor(e164), code);
    document.getElementById('phoneGate').style.display='none';
    document.getElementById('patientResultWrap').style.display='';
    subscribePatient();
    maybeShowNotifBanner();
  }catch(e){
    document.getElementById('phoneError').textContent =
      (e.code==='auth/user-not-found') ? t('no_account_error') : t('code_error');
    document.getElementById('phoneError').style.display='block';
  }
}

/* ---------------- PATIENT: data subscription (own appointments only) ---------------- */
function subscribePatient(){
  if(unsubscribeAppts) unsubscribeAppts();
  if(!isConfigured){
    appointments = appointments.filter(a=>a.phone===patientPhoneE164);
    refreshPatientResults();
    return;
  }
  const q = query(apptsCol, where('phone','==', patientPhoneE164));
  unsubscribeAppts = onSnapshot(q, snap=>{
    appointments = snap.docs.map(d=>({id:d.id, ...d.data()}));
    refreshPatientResults();
  }, err=>console.error("Firestore patient listener error", err));
}

function refreshPatientResults(){
  const mine = [...appointments].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  if(mine.length===0){
    document.getElementById('patientHeroWrap').innerHTML = `<div class="empty">
      <div class="display">${t('no_rdv_patient_title')}</div>
      <div>${t('no_rdv_patient_sub')}</div></div>`;
    document.getElementById('otherRdvWrap').innerHTML='';
    return;
  }
  const next = mine.find(a=>daysBetween(todayStr(),a.date) >= 0) || mine[mine.length-1];
  showPatientHero(next);
  checkReminderPopup(next);
  const rest = mine.filter(a=>a.id!==next.id);
  const restUpcoming = rest.filter(a=>statusOf(a).key!=='past');
  const restPast = rest.filter(a=>statusOf(a).key==='past')
    .sort((a,b)=> (b.date+b.time).localeCompare(a.date+a.time));

  const cardHtml = a => `<div class="rdv-card">
      <div class="rdv-time">${a.time}</div>
      <div class="rdv-info">
        <div class="name">${fmtDateShort(a.date)}</div>
        <div class="meta">${escapeHtml(a.reason)}</div>
        ${a.notes ? `<div class="meta" style="margin-top:3px;font-style:italic;">${escapeHtml(a.notes)}</div>` : ''}
      </div>
      <span class="status-pill" style="background:${statusOf(a).color};color:#fff">${statusOf(a).label}</span>
    </div>`;

  let otherHtml = '';
  if(restUpcoming.length>0){
    otherHtml += `<div class="day-heading">${t('other_rdv')}</div>` + restUpcoming.map(cardHtml).join('');
  }
  if(restPast.length>0){
    otherHtml += `<div class="day-heading" style="margin-top:32px;">${t('archived_rdv')}</div>` + restPast.map(cardHtml).join('');
  }
  document.getElementById('otherRdvWrap').innerHTML = otherHtml;
}

function showPatientHero(a){
  const st = statusOf(a);
  const diff = daysBetween(todayStr(), a.date);
  let big, label;
  if(diff<0){ big=t('status_past'); label = `${fmtDateShort(a.date)}`; }
  else if(diff===0){ big=t('status_today'); label = `${t('at_time')} ${a.time}`; }
  else { big=diff; label = diff===1 ? t('days_before_1') : t('days_before_n'); }

  document.getElementById('patientHeroWrap').innerHTML = `
    <div class="patient-hero">
      <div class="sun-wrap">${sunriseSVG(a)}</div>
      <h2 style="font-size:20px;margin:10px 0 2px;font-weight:600;">${escapeHtml(a.reason)}</h2>
      <div class="path-tag">${t('with_doctor')}</div>
      <div class="big-days">${big}</div>
      <div class="big-days-label">${label}</div>
      <div class="date-line">${fmtDate(a.date)} ${t('at_time')} ${a.time}</div>
      ${a.notes ? `<div class="date-line" style="font-style:italic;">${escapeHtml(a.notes)}</div>` : ''}
      <span class="status-pill" style="background:${st.color}">${st.label}</span>
    </div>`;
  if(st.key==='today') chime();
}

/* ---------------- reminder popup: 1er rappel (J-3) et 2eme rappel (J-1 / jour J) ---------------- */
function checkReminderPopup(a){
  if(!a) return;
  const diff = daysBetween(todayStr(), a.date);
  let stage = null;
  if(diff === 3) stage = 1;
  else if(diff === 1 || diff === 0) stage = 2;
  if(!stage) return;
  const key = `reminderShown_${a.id}_${a.date}_stage${stage}`;
  if(localStorage.getItem(key)) return;
  showReminderPopup(a, stage, diff);
  localStorage.setItem(key, '1');
}
function showReminderPopup(a, stage, diff){
  const title = document.getElementById('reminderTitle');
  const msg = document.getElementById('reminderMsg');
  const badge = document.getElementById('reminderBadge');
  if(stage===1){
    title.textContent = t('reminder1_title');
    msg.textContent = t('reminder1_msg');
    badge.textContent = '1';
  } else {
    title.textContent = t('reminder2_title');
    msg.textContent = diff===0 ? t('reminder2_msg_today') : t('reminder2_msg_tomorrow');
    badge.textContent = '2';
  }
  document.getElementById('reminderDate').textContent = `${fmtDate(a.date)} ${t('at_time')} ${a.time}`;
  document.getElementById('reminderOverlay').classList.add('open');
  chime();
}
document.getElementById('reminderOkBtn').addEventListener('click', ()=>{
  document.getElementById('reminderOverlay').classList.remove('open');
});
document.getElementById('reminderOverlay').addEventListener('click',(e)=>{
  if(e.target.id==='reminderOverlay') document.getElementById('reminderOverlay').classList.remove('open');
});


setInterval(()=>{
  if(role!=='patient' || !patientPhoneE164) return;
  const dueToday = appointments.some(a=>statusOf(a).key==='today');
  if(dueToday) chime();
}, 60000);

/* ---------------- init ---------------- */
fillReasonSelect();
applyLanguage();
