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
   10. Notifications push (optionnel, 100% gratuit — pas de plan Blaze).
       Appli distribuée UNIQUEMENT en APK (pas de version web) → on utilise
       le push NATIF Android via le plugin @capacitor-firebase/messaging,
       pas le VAPID/service-worker web :
      a. npm install @capacitor-firebase/messaging puis npx cap sync android.
      b. google-services.json déjà requis à l'étape 7 (Firebase Console >
         Project Settings > Tes applications > app Android) doit être
         présent dans android/app/ — c'est lui qui active le push natif,
         aucune clé VAPID n'est nécessaire côté Android.
      c. Project Settings > Comptes de service > "Générer une nouvelle clé
         privée" → enregistrer ce JSON comme secret GitHub
         FIREBASE_SERVICE_ACCOUNT (jamais dans le dépôt).
      d. Le workflow .github/workflows/send-reminders.yml exécute chaque
         jour scripts/send-reminders.js sur un cron GitHub Actions gratuit
         (aucune Cloud Function, aucune facturation Firebase) : il envoie
         un rappel J-3, J-1 et jour J à tout patient ayant activé les
         notifications. admin.messaging().send() accepte aussi bien un
         token natif Android qu'un token web, donc ce script ne change pas.
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
  onSnapshot, query, where, orderBy, limit, startAfter, getDocs, serverTimestamp, increment
} from "firebase/firestore";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "firebase/auth";
import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import { FirebaseMessaging } from "@capacitor-firebase/messaging";

const isNative = Capacitor.isNativePlatform();

let db=null, auth=null, apptsCol=null, contactsCol=null, apptsHistoryCol=null, patientsCol=null;
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
  // Archive : RDV de plus de 90 jours, déplacés ici chaque nuit par le script
  // scripts/archive-old-appointments.js (voir GUIDE_ARCHIVAGE.md). Jamais
  // écoutée en temps réel — uniquement lue par page, à la demande.
  apptsHistoryCol = collection(db, "appointments_history");
  // Compteurs agrégés par patient (honoredCount/absentCount/totalCount),
  // maintenus par le même script au moment de l'archivage, pour ne plus
  // jamais avoir à scanner tout l'historique côté client.
  patientsCol = collection(db, "patients");
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
let theme = localStorage.getItem('rdvTheme') || 'light';

/* ---------------- helpers ---------------- */
function uid(){ return Math.random().toString(36).slice(2,10); }
function patientEmailFor(e164){ return "p" + e164 + "@rdvcabinet.local"; }
function generatePatientCode(){ return String(Math.floor(100000 + Math.random()*900000)); }
function phoneFromPatientEmail(email){
  if(!email || !email.startsWith("p+") || !email.endsWith("@rdvcabinet.local")) return null;
  return email.slice(1, email.length - "@rdvcabinet.local".length);
}
function todayStr(){ return new Date().toISOString().slice(0,10); }

/* ---------------- PATIENT: salutation à l'ouverture (Bonjour/Bonsoir + prénom + retour) ----------------
   Bonjour avant 18h, Bonsoir après. "Ravi de vous revoir" s'affiche si ce
   patient s'est déjà connecté sur cet appareil (mémorisé en local). */
function getGreeting(name, e164){
  const hour = new Date().getHours();
  const base = hour < 18 ? t('greeting_morning') : t('greeting_evening');
  const firstName = (name || '').trim().split(/\s+/)[0] || '';
  const visitKey = `patientVisited_${e164}`;
  const isReturning = !!localStorage.getItem(visitKey);
  if(e164) localStorage.setItem(visitKey, '1');
  let msg = firstName ? `${base} ${escapeHtml(firstName)}` : base;
  msg += isReturning ? `, ${t('greeting_returning')} 👋` : ' 👋';
  return msg;
}

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

/* ---------------- PATIENT: activer les notifications push (FCM natif Android) ----------------
   Appli 100% APK : on passe par le plugin @capacitor-firebase/messaging, qui
   utilise google-services.json (pas de VAPID/service-worker web ici). */
// Récupère le token FCM courant et l'enregistre sur le contact du patient.
// Suppose que la permission est déjà accordée (à vérifier par l'appelant).
async function saveFcmToken(){
  try{
    const { token } = await FirebaseMessaging.getToken();
    if(!token) return {ok:false, reason:'no-token'};
    // Écrit uniquement le champ fcmToken sur SON PROPRE contact — voir la
    // règle dédiée dans firestore.rules (le patient ne peut pas toucher aux
    // autres champs ni aux contacts d'autrui).
    await setDoc(doc(db,"contacts", patientPhoneE164), { fcmToken: token, lang }, { merge:true });
    return {ok:true};
  }catch(e){
    console.error("Erreur enregistrement token FCM", e);
    return {ok:false, reason:'error'};
  }
}
async function enableNotifications(){
  if(!isNative){ return {ok:false, reason:'unsupported'}; }
  try{
    let perm = await FirebaseMessaging.checkPermissions();
    if(perm.receive !== 'granted'){
      perm = await FirebaseMessaging.requestPermissions();
    }
    if(perm.receive !== 'granted') return {ok:false, reason:'denied'};
    return await saveFcmToken();
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
// Centralise la règle "8 chiffres tunisiens après l'indicatif +216", reprise
// à plusieurs endroits (fiche RDV, recherche/suppression/blocage patient) —
// évite qu'une future évolution de la règle (ex: passage à 9 chiffres) doive
// être répétée à chaque copie.
function phoneDigits(e164){ return (e164||"").replace('+'+COUNTRY_CODE,''); }
function isValidPhone(e164){ return phoneDigits(e164).length === 8; }
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
    app_name: "Maw3id", brand_line: "Cabinet Dr. Hédi Belhoula",
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
    network_error: "Impossible de contacter le serveur. Vérifie ta connexion internet et réessaie.",
    too_many_requests_error: "Trop de tentatives. Réessaie dans quelques minutes.",
    config_error: "Erreur de configuration de l'application. Contacte le cabinet.",
    next_rdv_created: "Prochain RDV de {name} créé automatiquement le {date} à {time}.",
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
    footer_address: "Route de Tunis km9, Cité El Ons",
    greeting_morning: "Bonjour", greeting_evening: "Bonsoir",
    greeting_returning: "ravi de vous revoir"
  },
  ar: {
    app_name: "موعد", brand_line: "عيادة الدكتور الهادي بلحولة",
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
    network_error: "تعذّر الاتصال بالخادم. تحقّق من اتصالك بالإنترنت وأعد المحاولة.",
    too_many_requests_error: "محاولات كثيرة جداً. أعد المحاولة بعد بضع دقائق.",
    config_error: "خطأ في إعدادات التطبيق. تواصل مع العيادة.",
    next_rdv_created: "تم إنشاء الموعد التالي لـ {name} تلقائياً في {date} على الساعة {time}.",
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
    footer_address: "طريق تونس، كم 9، حي الأنس",
    greeting_morning: "صباح الخير", greeting_evening: "مساء الخير",
    greeting_returning: "سعداء برؤيتك مجدداً"
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

/* ---------------- thème clair / sombre (mémorisé) ---------------- */
function applyTheme(){
  document.documentElement.setAttribute('data-theme', theme);
  const icon = theme === 'dark' ? '☀️' : '🌙';
  const btn1 = document.getElementById('themeToggleBtn');
  const btn2 = document.getElementById('themeBtnGate');
  if(btn1) btn1.textContent = icon;
  if(btn2) btn2.textContent = icon;
}
function toggleTheme(){
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('rdvTheme', theme);
  applyTheme();
}
document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
document.getElementById('themeBtnGate').addEventListener('click', toggleTheme);

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

/* ---------------- generic overflow menus (⋮) : toolbar, header, cartes RDV ---------------- */
function closeAllDropdowns(){
  document.querySelectorAll('.dropdown-menu.open').forEach(m=>m.classList.remove('open'));
}
document.addEventListener('click', (e)=>{
  const toggle = e.target.closest('[data-menu-toggle]');
  if(toggle){
    const menu = toggle.parentElement.querySelector('.dropdown-menu');
    const wasOpen = menu.classList.contains('open');
    closeAllDropdowns();
    if(!wasOpen) menu.classList.add('open');
    e.stopPropagation();
    return;
  }
  // clic sur un item du menu (ou en dehors) : on referme dans tous les cas
  closeAllDropdowns();
});
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeAllDropdowns(); });

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
async function maybeShowNotifBanner(){
  const banner = document.getElementById('notifBanner');
  if(!banner) return;
  const supported = isNative;
  let alreadyGranted = false;
  if(supported){
    try{ alreadyGranted = (await FirebaseMessaging.checkPermissions()).receive === 'granted'; }catch(e){}
  }
  if(!supported){ banner.style.display='none'; return; }
  if(alreadyGranted){
    // Correctif : permission déjà accordée (ex: Android <13, où il n'y a pas
    // de demande runtime — checkPermissions() renvoie "granted" d'office) mais
    // le token n'a jamais été enregistré faute de clic sur le bouton, qui ne
    // s'affichait jamais. On l'enregistre silencieusement ici.
    const res = await saveFcmToken();
    if(res.ok){
      banner.style.display='none';
      return;
    }
    // L'écriture Firestore a échoué (règle de sécurité, hors ligne, etc.) :
    // on ne cache pas la bannière silencieusement, sinon ce patient reste
    // sans notifications pour toujours sans jamais être re-sollicité. On
    // continue plus bas pour afficher le bouton (qui retentera l'écriture).
  }
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
  const btn = document.getElementById('adminLoginBtn');
  if(btn.disabled) return; // évite un double-clic pendant la requête en cours
  btn.disabled = true;
  try{
    await signInWithEmailAndPassword(auth, email, pwd);
    await checkAdminAndEnter();
  }catch(e){
    showAdminError(t('login_error'));
  }finally{
    btn.disabled = false;
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
  ensureHistorySection();
  unsubscribeAppts = onSnapshot(apptsCol, snap=>{
    appointments = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderAdmin();
  }, err=>console.error("Firestore admin listener error", err));
}

/* ---------------- data layer (writes) ---------------- */
// Calcule la date suivante d'une série récurrente. Pour les intervalles en
// mois, on avance mois par mois (utile pour un suivi APCI mensuel/trimestriel
// régulier) ; JS gère automatiquement les débordements de fin de mois
// (ex: 31 janvier + 1 mois → début mars), une petite approximation à
// connaître mais qui reste médicalement raisonnable pour un suivi.
function addInterval(dateStr, intervalKey){
  const d = new Date(dateStr + "T00:00:00");
  if(intervalKey === '4w') d.setDate(d.getDate() + 28);
  else if(intervalKey === 'monthly') d.setMonth(d.getMonth() + 1);
  else if(intervalKey === '2m') d.setMonth(d.getMonth() + 2);
  else if(intervalKey === '3m') d.setMonth(d.getMonth() + 3);
  else if(intervalKey === '6m') d.setMonth(d.getMonth() + 6);
  return d.toISOString().slice(0,10);
}

/* ---------------- petite notification "toast" non bloquante ----------------
   Contrairement à alert(), ne bloque pas l'UI et disparaît seule — utilisé
   pour des confirmations informatives (ex: prochain RDV auto-créé) qui ne
   nécessitent pas d'action du médecin, donc pas besoin d'un alert() intrusif. */
function showToast(msg){
  let el = document.getElementById('toastMsg');
  if(!el){
    el = document.createElement('div');
    el.id = 'toastMsg';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);'+
      'background:var(--ink);color:var(--cream);padding:12px 18px;border-radius:12px;'+
      'font-size:13px;font-weight:600;box-shadow:var(--shadow);z-index:9999;'+
      'max-width:88vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  clearTimeout(el._hideTimer);
  requestAnimationFrame(()=>{ el.style.opacity = '1'; });
  el._hideTimer = setTimeout(()=>{ el.style.opacity = '0'; }, 3200);
}

// Crée automatiquement le RDV suivant d'une chaîne récurrente, appelé quand
// le médecin marque un RDV "Honoré". Un seul RDV existe à la fois — pas de
// création en masse — donc la chaîne s'arrête d'elle-même si un RDV n'est
// jamais marqué Honoré (patient absent → pas de suite automatique).
async function continueRecurrence(prevAppt){
  const interval = prevAppt.recurrenceInterval;
  if(!interval || interval === 'none') return;
  const nextDate = addInterval(prevAppt.date, interval);
  const conflict = appointments.find(x=>!x.deleted && x.date===nextDate && x.time===prevAppt.time && x.id!==prevAppt.id);
  if(conflict){
    alert(
      "Suivi automatique : le prochain RDV de " + prevAppt.name + " (" + nextDate + " à " + prevAppt.time + ") " +
      "n'a pas pu être créé, ce créneau est déjà pris par " + conflict.name + ".\n\n" +
      "Ajoute-le manuellement à un autre horaire si besoin."
    );
    return;
  }
  await createAppointment({
    name: prevAppt.name, phone: prevAppt.phone, date: nextDate, time: prevAppt.time,
    reason: prevAppt.reason, notes: prevAppt.notes || '',
    recurrenceInterval: interval, seriesId: prevAppt.seriesId || uid()
  });
  showToast(t('next_rdv_created').replace('{name}', prevAppt.name).replace('{date}', fmtDateShort(nextDate)).replace('{time}', prevAppt.time));
}

async function createAppointment(data){
  if(isConfigured) await addDoc(apptsCol, data);
  else { appointments.push({id:uid(), ...data}); renderAdmin(); }
}
async function editAppointment(id, data){
  // Si la date/heure change réellement, c'est un report — on le
  // comptabilise sur la fiche patient (voir recordReschedule), qu'il vienne
  // d'une demande patient acceptée ou d'un décalage fait directement par le
  // médecin pour le compte du patient (cas fréquent : le patient appelle
  // plutôt que d'utiliser l'appli).
  const before = appointments.find(x=>x.id===id);
  if(before && data.date && data.time && (data.date!==before.date || data.time!==before.time)){
    await recordReschedule(before.phone, before.date, before.time);
  }
  if(isConfigured) await updateDoc(doc(db,"appointments",id), data);
  else { Object.assign(appointments.find(x=>x.id===id), data); renderAdmin(); }
}
async function removeAppointment(id, trackCancellation=true){
  // Suppression "douce" : le RDV est marqué supprimé mais reste en base,
  // récupérable depuis la Corbeille. Évite la perte définitive en cas de
  // clic accidentel.
  const a = appointments.find(x=>x.id===id);
  // Comptabilise l'annulation sur la fiche patient (voir recordCancellation)
  // — pour TOUTE suppression d'un RDV actif à venir/passé, que ce soit un
  // clic direct du médecin ou l'acceptation d'une demande patient. Exclu
  // volontairement lors d'une suppression de compte patient en masse
  // (trackCancellation=false) : ce n'est pas une vraie annulation.
  if(trackCancellation && a && !a.deleted) await recordCancellation(a.phone, a.date, a.time);
  if(isConfigured) await updateDoc(doc(db,"appointments",id), {deleted:true, deletedAt:new Date().toISOString()});
  else { if(a){ a.deleted=true; a.deletedAt=new Date().toISOString(); renderAdmin(); } }
}
async function restoreAppointment(id){
  if(isConfigured) await updateDoc(doc(db,"appointments",id), {deleted:false});
  else { const a = appointments.find(x=>x.id===id); if(a){ a.deleted=false; renderAdmin(); } }
}
async function permanentlyDeleteAppointment(id){
  if(isConfigured) await deleteDoc(doc(db,"appointments",id));
  else { appointments = appointments.filter(x=>x.id!==id); renderAdmin(); }
}

// Comptabilise une annulation sur la fiche patient (patients/{phone}), en
// distinguant une annulation "tardive" — moins de 48h avant le RDV, donc peu
// de temps pour reproposer le créneau — d'une annulation anticipée. Seuil
// facilement ajustable ici si 48h ne convient pas.
const LATE_NOTICE_HOURS = 48;
async function recordCancellation(phone, apptDate, apptTime){
  if(!isConfigured || !phone) return;
  const hoursBefore = (new Date(apptDate+'T'+apptTime+':00').getTime() - Date.now()) / 3600000;
  const isLate = hoursBefore < LATE_NOTICE_HOURS;
  try{
    await setDoc(doc(db,"patients", phone), {
      cancelCount: increment(1),
      lateCancelCount: increment(isLate ? 1 : 0),
    }, { merge:true });
  }catch(e){ console.error("Erreur comptage annulation", e); }
}
// Même principe pour un report — la lateness se mesure par rapport à la
// date D'ORIGINE du RDV décalé (pas la nouvelle date proposée).
async function recordReschedule(phone, originalDate, originalTime){
  if(!isConfigured || !phone) return;
  const hoursBefore = (new Date(originalDate+'T'+originalTime+':00').getTime() - Date.now()) / 3600000;
  const isLate = hoursBefore < LATE_NOTICE_HOURS;
  try{
    await setDoc(doc(db,"patients", phone), {
      rescheduleCount: increment(1),
      lateRescheduleCount: increment(isLate ? 1 : 0),
    }, { merge:true });
  }catch(e){ console.error("Erreur comptage report", e); }
}

/* ---------------- ADMIN: render list ---------------- */
// Enregistre la décision (acceptée/refusée) sur la fiche contact du patient
// — jamais sur le RDV lui-même, qui peut être supprimé ou déplacé entre
// temps. Le patient a déjà le droit de lire son propre contacts/{phone}
// (règles inchangées), donc aucune republication de firestore.rules requise.
// pushed:false permet au script scripts/notify-request-outcome.js d'envoyer
// une notification push même si le patient n'a pas l'appli ouverte.
async function notifyRequestOutcome(phone, outcome){
  if(!isConfigured || !phone) return;
  try{
    await setDoc(doc(db,"contacts", phone), {
      lastRequestOutcome: { ...outcome, decidedAt: new Date().toISOString(), pushed:false }
    }, { merge:true });
  }catch(e){ console.error("Erreur notification patient", e); }
}
async function setHonoredStatus(id, value){
  const a = appointments.find(x=>x.id===id);
  if(isConfigured && a){
    try{
      // Compte en temps réel (plus besoin d'attendre le passage nocturne du
      // script d'archivage) — statsCounted évite un double comptage le jour
      // où ce RDV sera archivé (voir archive-old-appointments.js).
      const wasCounted = a.statsCounted === true;
      const wasHonored = a.honored;
      const updates = {};
      if(value === true){
        if(!wasCounted || wasHonored !== true){
          updates.honoredCount = increment(1);
          if(wasCounted && wasHonored === false) updates.absentCount = increment(-1);
          updates.currentStreak = increment(1);
        }
      } else if(value === false){
        if(!wasCounted || wasHonored !== false){
          updates.absentCount = increment(1);
          if(wasCounted && wasHonored === true) updates.honoredCount = increment(-1);
        }
        updates.currentStreak = 0; // un RDV raté casse la chaîne
      } else if(value === null && wasCounted){
        // Annulation d'un marquage précédent (bouton "Modifier" sur le badge).
        if(wasHonored === true) updates.honoredCount = increment(-1);
        else if(wasHonored === false) updates.absentCount = increment(-1);
      }
      if(Object.keys(updates).length) await setDoc(doc(db,"patients", a.phone), updates, {merge:true});
      // Suivi du record de la plus longue chaîne, pour référence.
      if(value === true){
        const snap = await getDoc(doc(db,"patients", a.phone));
        const cur = snap.exists() ? (snap.data().currentStreak||0) : 0;
        const longest = snap.exists() ? (snap.data().longestStreak||0) : 0;
        if(cur > longest) await setDoc(doc(db,"patients", a.phone), {longestStreak: cur}, {merge:true});
      }
    }catch(e){ console.error("Erreur mise à jour stats fidélité", e); }
    await updateDoc(doc(db,"appointments",id), {honored:value, statsCounted: value!==null});
  }
  else if(a){ a.honored=value; renderAdmin(); }
}
// Cache mémoire (le temps de la session) des stats de fidélité par patient,
// pour éviter de relire Firestore à chaque carte affichée. getCachedLoyalty
// retourne la valeur en cache si dispo (synchrone), sinon lance la lecture
// en arrière-plan et redessine une fois prête via onReady.
const patientStatsCache = new Map();
function getCachedLoyalty(phone, onReady){
  if(!phone) return null;
  if(patientStatsCache.has(phone)) return patientStatsCache.get(phone);
  if(isConfigured){
    getArchivedPatientStats(phone).then(stats=>{
      patientStatsCache.set(phone, stats);
      onReady();
    });
  }
  return null;
}

function rdvCardHtml(a, loyaltyShown){
  const st = statusOf(a);
  const req = a.patientRequest;
  let reqBanner = '';
  if(req && req.type==='cancel'){
    reqBanner = `<div class="pending-request" style="margin-top:10px;">
      🔔 Le patient demande à <b>annuler</b>.
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-secondary" data-req-action="accept-cancel" data-id="${a.id}" style="flex:1;padding:6px;font-size:12.5px;">Accepter</button>
        <button class="btn-secondary" data-req-action="refuse" data-id="${a.id}" style="flex:1;padding:6px;font-size:12.5px;">Refuser</button>
      </div></div>`;
  } else if(req && req.type==='reschedule'){
    reqBanner = `<div class="pending-request" style="margin-top:10px;">
      🔔 Le patient demande à <b>décaler</b> vers ${escapeHtml(req.requestedDate)} à ${escapeHtml(req.requestedTime)}.
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-secondary" data-req-action="accept-reschedule" data-id="${a.id}" style="flex:1;padding:6px;font-size:12.5px;">Accepter</button>
        <button class="btn-secondary" data-req-action="refuse" data-id="${a.id}" style="flex:1;padding:6px;font-size:12.5px;">Refuser</button>
      </div></div>`;
  }
  let honoredBanner = '';
  let loyaltyHtml = '';
  if(st.key === 'past'){
    if(a.honored === true){
      honoredBanner = `<div class="honor-badge honor-yes">✅ Honoré <button class="mini-link" data-honor-action="clear" data-id="${a.id}">Modifier</button></div>`;
    } else if(a.honored === false){
      honoredBanner = `<div class="honor-badge honor-no">❌ Non présenté <button class="mini-link" data-honor-action="clear" data-id="${a.id}">Modifier</button></div>`;
    } else {
      honoredBanner = `<div style="display:flex;gap:6px;margin-top:10px;">
        <button class="btn-secondary" data-honor-action="yes" data-id="${a.id}" style="flex:1;padding:6px;font-size:12.5px;">✅ Honoré</button>
        <button class="btn-secondary" data-honor-action="no" data-id="${a.id}" style="flex:1;padding:6px;font-size:12.5px;">❌ Non présenté</button>
      </div>`;
    }
  }
  // Score de fidélité global (Firestore, patients/{phone}) : un seul par
  // patient dans la liste rendue, pas un par carte. On réserve la place
  // sur la première carte rencontrée pour ce téléphone — comme upcoming
  // est parcouru avant past (voir renderAdmin), ça revient à l'afficher
  // sur son prochain RDV à venir, et seulement à défaut sur son dernier
  // RDV passé. loyaltyShown est un Set neuf à chaque appel de renderAdmin.
  if(loyaltyShown && !loyaltyShown.has(a.phone)){
    const stats = getCachedLoyalty(a.phone, renderAdmin);
    if(stats){
      const score = computeLoyaltyScore(stats);
      if(score!==null){
        loyaltyHtml = loyaltyBarHtml(score, stats.currentStreak||0);
        loyaltyShown.add(a.phone);
      }
    }
  }
  return `<div class="rdv-card">
      <div class="rdv-row">
        <div class="rdv-time">${a.time}</div>
        <div class="rdv-info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="meta">${escapeHtml(a.reason)} · ${escapeHtml(a.phone)}</div>
        </div>
        <span class="status-pill" style="background:${st.color};color:#fff">${st.label}</span>
        <div class="dropdown">
          <button class="menu-btn" data-menu-toggle title="Actions">⋮</button>
          <div class="dropdown-menu">
            <button class="dropdown-item" data-action="edit" data-id="${a.id}">✎ Modifier</button>
            <button class="dropdown-item danger" data-action="delete" data-id="${a.id}">🗑️ Supprimer</button>
          </div>
        </div>
      </div>
      ${reqBanner}
      ${honoredBanner}
      ${loyaltyHtml}
    </div>`;
}
// Carte dédiée à l'historique : contrairement à rdvCardHtml() (RDV actifs),
// pas de "Modifier" ni de demandes patient (n'a plus de sens sur un RDV déjà
// passé et archivé) — seulement la suppression définitive.
function historyCardHtml(a, loyaltyShown){
  let honorTag = '';
  if(a.honored === true) honorTag = `<span class="honor-tag honor-yes">✅ Honoré</span>`;
  else if(a.honored === false) honorTag = `<span class="honor-tag honor-no">❌ Non présenté</span>`;
  let loyaltyHtml = '';
  if(loyaltyShown && !loyaltyShown.has(a.phone)){
    const stats = getCachedLoyalty(a.phone, renderHistoryList);
    if(stats){
      const score = computeLoyaltyScore(stats);
      if(score!==null){
        loyaltyHtml = loyaltyBarHtml(score, stats.currentStreak||0);
        loyaltyShown.add(a.phone);
      }
    }
  }
  return `<div class="rdv-card">
      <div class="rdv-row">
        <div class="rdv-time">${a.time}</div>
        <div class="rdv-info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="meta">${escapeHtml(a.reason)} · ${escapeHtml(a.phone)}</div>
          ${honorTag}
        </div>
        <button data-history-edit="${a.id}" title="Modifier"
          style="border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:8px;padding:6px 10px;cursor:pointer;">✎</button>
        <button data-history-delete="${a.id}" title="Supprimer définitivement"
          style="border:1px solid var(--line);background:transparent;color:var(--alert);border-radius:8px;padding:6px 10px;cursor:pointer;">🗑️</button>
      </div>
      ${loyaltyHtml}
    </div>`;
}

// Correction ponctuelle d'un RDV archivé (typo dans le nom, le motif ou les
// notes). Volontairement minimaliste (pas la modale complète utilisée pour
// les RDV actifs) : sur un RDV déjà archivé, on ne change ni la date/heure
// ni le patient concerné — seulement les champs texte, en cas d'erreur de
// saisie constatée après coup.
async function editHistoryAppointment(id){
  const item = historyItems.find(x=>x.id===id);
  if(!item) return;
  const name = prompt("Nom du patient :", item.name);
  if(name===null) return;
  const reason = prompt("Motif :", item.reason);
  if(reason===null) return;
  const notes = prompt("Notes :", item.notes || '');
  if(notes===null) return;
  try{
    await updateDoc(doc(db,"appointments_history", id), {
      name: name.trim(), reason: reason.trim(), notes: notes.trim()
    });
    Object.assign(item, {name: name.trim(), reason: reason.trim(), notes: notes.trim()});
    renderHistoryList();
    showToast('RDV archivé modifié.');
  }catch(e){
    console.error("Erreur modification RDV archivé", e);
    alert("Impossible de modifier ce RDV. Réessaie.");
  }
}

// Suppression définitive d'un RDV archivé (pas de corbeille pour l'archive :
// il a déjà été conservé 90+ jours avant d'arriver ici). Corrige aussi les
// compteurs patients/{phone} pour que le taux de présence reste exact.
async function permanentlyDeleteHistoryAppointment(id){
  const item = historyItems.find(x=>x.id===id);
  if(!confirm('Supprimer définitivement ce RDV archivé ? Cette action est irréversible.')) return;
  try{
    await deleteDoc(doc(db,"appointments_history", id));
    if(item && item.phone){
      const updates = { totalCount: increment(-1) };
      if(item.honored === true) updates.honoredCount = increment(-1);
      else if(item.honored === false) updates.absentCount = increment(-1);
      await setDoc(doc(db,"patients", item.phone), updates, { merge:true }).catch(e=>console.error("Correction stats patient échouée", e));
    }
    historyItems = historyItems.filter(x=>x.id!==id);
    renderHistoryList();
    showToast('RDV archivé supprimé.');
  }catch(e){
    console.error("Erreur suppression RDV archivé", e);
    alert("Impossible de supprimer ce RDV. Réessaie.");
  }
}

let adminSearchTerm = '';

/* ---------------- ADMIN: historique paginé (appointments_history) ----------------
   Contrairement à "appointments" (écouté en temps réel), l'historique n'est
   jamais chargé d'un bloc : il grossit indéfiniment avec les années, donc on
   le lit par pages de 30, uniquement quand le médecin ouvre la section. */
const HISTORY_PAGE_SIZE = 30;
let historyItems = [];
let historyLastDoc = null;
let historyHasMore = true;
let historyLoading = false;

async function loadHistoryPage(reset){
  if(!isConfigured || historyLoading) return;
  if(reset){ historyItems = []; historyLastDoc = null; historyHasMore = true; }
  if(!historyHasMore) return;
  historyLoading = true;
  renderHistoryList(); // affiche l'état "chargement…"
  try{
    // Un seul orderBy (date) : indexé automatiquement par Firestore, aucun
    // index composé à créer. On passe le docSnapshot complet à startAfter
    // (pas juste la valeur du champ), ce qui permet une pagination fiable
    // même avec plusieurs RDV à la même date.
    const clauses = [orderBy('date','desc'), limit(HISTORY_PAGE_SIZE)];
    const q = historyLastDoc
      ? query(apptsHistoryCol, orderBy('date','desc'), startAfter(historyLastDoc), limit(HISTORY_PAGE_SIZE))
      : query(apptsHistoryCol, ...clauses);
    const snap = await getDocs(q);
    historyLastDoc = snap.docs[snap.docs.length-1] || historyLastDoc;
    historyHasMore = snap.docs.length === HISTORY_PAGE_SIZE;
    historyItems = historyItems.concat(snap.docs.map(d=>({id:d.id, ...d.data()})));
    // La requête ne trie que par date ; on affine par heure décroissante à
    // l'intérieur d'une même date (pas besoin d'index composé pour ça).
    historyItems.sort((a,b)=> (b.date+b.time).localeCompare(a.date+a.time));
  }catch(e){
    console.error("Erreur chargement historique", e);
  }
  historyLoading = false;
  renderHistoryList();
}

// Recherche ciblée dans l'archive par téléphone (utilise l'index composite
// phone ASC + date DESC, voir firestore.indexes.json).
async function searchHistoryByPhone(phone){
  if(!isConfigured || !phone) return [];
  const q = query(apptsHistoryCol, where('phone','==', phone), orderBy('date','desc'), limit(100));
  const snap = await getDocs(q);
  return snap.docs.map(d=>({id:d.id, ...d.data()}));
}

// Injecte la section "historique" sous la liste des RDV, une seule fois —
// aucune modification d'index.html n'est nécessaire. Le style reprend
// simplement les classes existantes ; adapte-les si besoin dans ton thème.
function ensureHistorySection(){
  if(document.getElementById('historySection')) return;
  const rdvList = document.getElementById('rdvList');
  if(!rdvList || !rdvList.parentNode) return;
  const section = document.createElement('div');
  section.id = 'historySection';
  section.style.marginTop = '40px';
  section.innerHTML = `
    <button id="historyToggleBtn" type="button" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--ink);font-weight:600;cursor:pointer;">
      📜 Voir tout l'historique archivé
    </button>
    <div id="historyPanel" style="display:none;margin-top:16px;">
      <div id="historyList"></div>
      <button id="historyLoadMoreBtn" type="button" style="width:100%;margin-top:12px;padding:10px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer;">
        Charger plus
      </button>
    </div>`;
  rdvList.parentNode.insertBefore(section, rdvList.nextSibling);
  document.getElementById('historyToggleBtn').addEventListener('click', ()=>{
    const panel = document.getElementById('historyPanel');
    const show = panel.style.display === 'none';
    panel.style.display = show ? '' : 'none';
    if(show && historyItems.length===0) loadHistoryPage(true);
  });
  document.getElementById('historyLoadMoreBtn').addEventListener('click', ()=> loadHistoryPage(false));
  document.getElementById('historyList').addEventListener('click', (e)=>{
    const delBtn = e.target.closest('button[data-history-delete]');
    if(delBtn) permanentlyDeleteHistoryAppointment(delBtn.dataset.historyDelete);
    const editBtn = e.target.closest('button[data-history-edit]');
    if(editBtn) editHistoryAppointment(editBtn.dataset.historyEdit);
  });
}

function renderHistoryList(){
  const list = document.getElementById('historyList');
  const moreBtn = document.getElementById('historyLoadMoreBtn');
  if(!list) return; // section pas encore ajoutée dans index.html sur cette install
  if(historyItems.length===0 && historyLoading){
    list.innerHTML = `<div class="empty"><div>Chargement de l'historique…</div></div>`;
  } else if(historyItems.length===0){
    list.innerHTML = `<div class="empty"><div>Aucun rendez-vous archivé pour l'instant.</div></div>`;
  } else {
    let html='', lastDate=null;
    const loyaltyShown = new Set();
    historyItems.forEach(a=>{
      if(a.date!==lastDate){ html += `<div class="day-heading">${fmtDate(a.date)}</div>`; lastDate=a.date; }
      html += historyCardHtml(a, loyaltyShown);
    });
    list.innerHTML = html;
  }
  if(moreBtn) moreBtn.style.display = historyHasMore ? '' : 'none';
}
function renderAdmin(){
  const list = document.getElementById('rdvList');
  let all = appointments.filter(a=>!a.deleted);
  if(adminSearchTerm){
    const q = adminSearchTerm.toLowerCase();
    const qDigits = q.replace(/\D/g,'');
    all = all.filter(a=>{
      const nameMatch = (a.name||'').toLowerCase().includes(q);
      // ne vérifie le téléphone que si la recherche contient au moins un
      // chiffre — sinon "".includes('') vaudrait toujours vrai et
      // court-circuiterait le filtre par nom (bug corrigé ici)
      const phoneMatch = qDigits.length > 0 && (a.phone||'').replace(/\D/g,'').includes(qDigits);
      return nameMatch || phoneMatch;
    });
  }
  const todayCount = all.filter(a=>statusOf(a).key==='today').length;
  document.getElementById('summaryLine').textContent =
    all.length===0 ? (adminSearchTerm ? "Aucun résultat pour «"+adminSearchTerm+"»" : t('no_rdv_prog')) : `${all.length} RDV — ${todayCount} ${t('status_today').toLowerCase()}`;

  if(all.length===0){
    list.innerHTML = `<div class="empty"><div class="display">${t('no_rdv_admin_title')}</div><div>${t('no_rdv_admin_sub')}</div></div>`;
    return;
  }

  const upcoming = all.filter(a=>statusOf(a).key!=='past').sort((a,b)=> (a.date+a.time).localeCompare(b.date+b.time));
  const past = all.filter(a=>statusOf(a).key==='past').sort((a,b)=> (b.date+b.time).localeCompare(a.date+a.time));

  // Un seul Set par rendu : réserve la barre de fidélité au premier RDV
  // rencontré pour chaque patient (upcoming d'abord, donc priorité au
  // prochain RDV à venir ; à défaut, son dernier RDV passé).
  const loyaltyShown = new Set();

  let html='', lastDate=null;
  if(upcoming.length===0){
    html += `<div class="empty"><div class="display">${t('no_rdv_admin_title')}</div><div>${t('no_rdv_admin_sub')}</div></div>`;
  } else {
    upcoming.forEach(a=>{
      if(a.date!==lastDate){
        html += `<div class="day-heading">${fmtDate(a.date)}</div>`;
        lastDate=a.date;
      }
      html += rdvCardHtml(a, loyaltyShown);
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
      html += rdvCardHtml(a, loyaltyShown);
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
  if(match) document.getElementById('fPhone').value = phoneDigits(match.phone);
});

document.getElementById('rdvList').addEventListener('click', async (e)=>{
  const btn = e.target.closest('button[data-action]');
  const reqBtn = e.target.closest('button[data-req-action]');
  const honorBtn = e.target.closest('button[data-honor-action]');
  if(honorBtn){
    if(honorBtn.dataset.honorAction==='yes'){
      const a = appointments.find(x=>x.id===honorBtn.dataset.id);
      await setHonoredStatus(honorBtn.dataset.id, true);
      if(a) await continueRecurrence(a);
    }
    else if(honorBtn.dataset.honorAction==='no') await setHonoredStatus(honorBtn.dataset.id, false);
    else if(honorBtn.dataset.honorAction==='clear') await setHonoredStatus(honorBtn.dataset.id, null);
    return;
  }
  if(reqBtn){
    const a = appointments.find(x=>x.id===reqBtn.dataset.id);
    if(!a) return;
    const req = a.patientRequest;
    if(reqBtn.dataset.reqAction==='accept-cancel'){
      await removeAppointment(a.id); // passe en Corbeille, récupérable + comptabilise l'annulation
      await notifyRequestOutcome(a.phone, {type:'cancel', status:'accepted', requestedDate:a.date, requestedTime:a.time});
    } else if(reqBtn.dataset.reqAction==='accept-reschedule'){
      const conflict = appointments.find(x=>!x.deleted && x.date===req.requestedDate && x.time===req.requestedTime && x.id!==a.id);
      if(conflict && !confirm("⚠️ Ce créneau est déjà pris par "+conflict.name+". Accepter quand même ?")) return;
      await editAppointment(a.id, {name:a.name, phone:a.phone, date:req.requestedDate, time:req.requestedTime, reason:a.reason, notes:a.notes||'', recurrenceInterval:a.recurrenceInterval||'none', patientRequest:{}});
      await notifyRequestOutcome(a.phone, {type:'reschedule', status:'accepted', requestedDate:req.requestedDate, requestedTime:req.requestedTime});
    } else if(reqBtn.dataset.reqAction==='refuse'){
      await updateDoc(doc(db,"appointments",a.id), {patientRequest:{}});
      await notifyRequestOutcome(a.phone, {type:req?.type||'cancel', status:'refused', requestedDate:req?.requestedDate||a.date, requestedTime:req?.requestedTime||a.time});
    }
    return;
  }
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
  document.getElementById('fPhone').value = a ? phoneDigits(a.phone) : '';
  document.getElementById('fDate').value = a ? a.date : todayStr();
  document.getElementById('fTime').value = a ? a.time : '09:00';
  document.getElementById('fReason').value = a ? a.reason : REASONS[0];
  document.getElementById('fNotes').value = a ? (a.notes||'') : '';
  document.getElementById('phoneFieldHint').style.color = '';
  document.getElementById('phoneFieldHint').textContent = t('phone_hint');
  // La récurrence est maintenant "à la volée" : un seul RDV est créé à la
  // fois, le suivant apparaît automatiquement quand celui-ci est marqué
  // Honoré. Éditable aussi bien à la création qu'en modification, pour
  // pouvoir arrêter ou changer la cadence d'une chaîne en cours.
  document.getElementById('fRecurrenceInterval').value = a ? (a.recurrenceInterval || 'none') : 'none';
  document.getElementById('overlay').classList.add('open');
}
function closeModal(){ document.getElementById('overlay').classList.remove('open'); }

document.getElementById('addBtn').addEventListener('click', ()=>openModal(null));
document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('overlay').addEventListener('click',(e)=>{ if(e.target.id==='overlay') closeModal(); });

document.getElementById('saveBtn').addEventListener('click', async ()=>{
  const saveBtnEl = document.getElementById('saveBtn');
  if(saveBtnEl.disabled) return; // évite un double-clic pendant l'enregistrement
  saveBtnEl.disabled = true;
  try{
  const name = document.getElementById('fName').value.trim();
  const phone = toE164(document.getElementById('fPhone').value.trim());
  const date = document.getElementById('fDate').value;
  const time = document.getElementById('fTime').value;
  const reason = document.getElementById('fReason').value;
  const notes = document.getElementById('fNotes').value.trim();
  if(!name || !phone || phone===("+"+COUNTRY_CODE) || !date) return;
  if(!isValidPhone(phone)){
    document.getElementById('phoneFieldHint').style.color = 'var(--alert)';
    document.getElementById('phoneFieldHint').textContent = t('phone_hint_invalid');
    return;
  }
  const data = {name,phone,date,time,reason,notes,recurrenceInterval: document.getElementById('fRecurrenceInterval').value};

  // Alerte si un autre RDV (non supprimé, autre patient) existe déjà au
  // même jour/heure — évite le double-booking par inattention.
  const conflict = appointments.find(a=>
    !a.deleted && a.date===date && a.time===time && a.id!==editingId
  );
  if(conflict){
    const ok = confirm(
      "⚠️ Ce créneau (" + date + " à " + time + ") est déjà pris par " + conflict.name + ".\n\n" +
      "Créer quand même ce rendez-vous en double ?"
    );
    if(!ok) return;
  }

  // Si on modifie un RDV existant et que le numéro a changé, on prévient :
  // le compte de connexion du patient reste lié à l'ANCIEN numéro (Firebase
  // ne permet pas de le renommer côté client). Sans ce message, le médecin
  // pourrait casser silencieusement l'accès du patient à ses rendez-vous.
  if(editingId){
    const original = appointments.find(x=>x.id===editingId);
    if(original && original.phone && original.phone !== phone){
      const ok = confirm(
        "Tu changes le numéro de téléphone de " + name + ".\n\n" +
        "Son compte de connexion existant reste lié à l'ancien numéro (" + original.phone + ") — " +
        "il ne pourra plus voir ses rendez-vous avec le nouveau numéro tant qu'un nouveau code ne " +
        "lui aura pas été généré (via un futur RDV avec ce nouveau numéro).\n\n" +
        "Continuer quand même ?"
      );
      if(!ok) return;
    }
  }

  const isNewPhone = isConfigured && !contactHasAccount(phone);

  if(editingId) await editAppointment(editingId, data);
  else await createAppointment(data);

  if(isNewPhone){
    // Nouveau patient (au sens: pas encore de compte) → on crée son compte
    // ici même, et on lui remet le code en main propre. On ne le fait qu'une
    // fois par numéro : les visites suivantes n'en créent pas un nouveau.
    try{
      const code = await createPatientAccountAsAdmin(phone);
      // On garde une trace du code (lecture réservée au médecin via
      // firestore.rules) pour pouvoir le redonner au patient s'il l'égare —
      // Firebase ne permet pas de relire un mot de passe existant, donc
      // c'est la seule façon de "récupérer" un code déjà généré.
      await saveContact(name, phone, {hasAccount:true, lastCode:code});
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
  }finally{
    saveBtnEl.disabled = false;
  }
});

function showPatientCodeModal(code, subtitle){
  document.getElementById('patientCodeSub').textContent = subtitle || t('patient_code_sub');
  document.getElementById('patientCodeValue').textContent = code;
  document.getElementById('patientCodeOverlay').classList.add('open');
}
document.getElementById('patientCodeOkBtn').addEventListener('click', ()=>{
  document.getElementById('patientCodeOverlay').classList.remove('open');
});

/* ---------------- ADMIN: retrouver le code d'un patient déjà créé ----------------
   Firebase ne permet jamais de relire un mot de passe existant ; on garde
   donc une copie du dernier code généré dans contacts/{phone}.lastCode
   (lecture réservée au médecin, voir firestore.rules) pour pouvoir le
   redonner au patient s'il l'a perdu. Pour un patient créé avant l'ajout de
   ce champ, lastCode sera absent : il faudra alors réinitialiser le mot de
   passe manuellement depuis la console Firebase (Authentication → chercher
   l'email p+<numéro>@rdvcabinet.local). */
document.getElementById('adminSearchInput').addEventListener('input', (e)=>{
  adminSearchTerm = e.target.value.trim();
  renderAdmin();
});
document.getElementById('findCodeBtn').addEventListener('click', ()=>{
  document.getElementById('findCodePhone').value = '';
  document.getElementById('findCodeError').style.display = 'none';
  document.getElementById('deletePatientBtn').style.display = 'none';
  document.getElementById('resetCodeSection').style.display = 'none';
  document.getElementById('resetCodeStatusMsg').textContent = '';
  document.getElementById('blockSection').style.display = 'none';
  document.getElementById('findCodeOverlay').classList.add('open');
});
document.getElementById('findCodeCancelBtn').addEventListener('click', ()=>{
  document.getElementById('findCodeOverlay').classList.remove('open');
});
document.getElementById('findCodeOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='findCodeOverlay') document.getElementById('findCodeOverlay').classList.remove('open');
});
document.getElementById('findCodeSubmitBtn').addEventListener('click', async ()=>{
  const errEl = document.getElementById('findCodeError');
  errEl.style.display = 'none';
  const raw = document.getElementById('findCodePhone').value.trim();
  const phone = toE164(raw);
  if(!isValidPhone(phone)){
    errEl.textContent = t('phone_hint_invalid');
    errEl.style.display = 'block';
    return;
  }
  if(!isConfigured){
    errEl.textContent = "Firebase n'est pas configuré (mode local).";
    errEl.style.display = 'block';
    return;
  }
  try{
    const snap = await getDoc(doc(db,"contacts", phone));
    if(!snap.exists() || !snap.data().lastCode){
      errEl.textContent = "Aucun code enregistré pour ce numéro. Utilise 🔄 Réinitialiser le code juste en dessous pour en générer un.";
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('findCodeOverlay').classList.remove('open');
    const foundName = snap.data().name || raw;
    const subtitle = snap.data().resetStatus === 'pending'
      ? "Code actuel de " + foundName + " (réinitialisation en cours, ce code va bientôt changer) :"
      : "Code existant retrouvé pour " + foundName + " :";
    showPatientCodeModal(snap.data().lastCode, subtitle);
  }catch(e){
    console.error("Erreur recherche code patient", e);
    errEl.textContent = "Erreur de connexion. Réessaie.";
    errEl.style.display = 'block';
  }
});

// Le bouton "Supprimer ce patient" apparaît dès qu'un numéro valide (8
// chiffres) est saisi dans la fenêtre "Code patient" — pas besoin d'avoir
// cherché le code au préalable.
document.getElementById('findCodePhone').addEventListener('input', ()=>{
  const show = isValidPhone(toE164(document.getElementById('findCodePhone').value));
  document.getElementById('deletePatientBtn').style.display = show ? 'block' : 'none';
  document.getElementById('resetCodeSection').style.display = show ? 'block' : 'none';
  document.getElementById('blockSection').style.display = show ? 'block' : 'none';
  document.getElementById('blockStatusMsg').textContent = '';
  document.getElementById('resetCodeStatusMsg').textContent = '';
  if(show){
    document.getElementById('blockFromDate').value = todayStr();
    refreshBlockStatus();
    refreshResetStatus();
  }
});

/* ---------------- ADMIN: réinitialiser le code d'un patient ----------------
   Firebase ne permet pas de changer le mot de passe d'un AUTRE utilisateur
   depuis le client — ça doit passer par le Admin SDK, côté serveur. On dépose
   donc une "demande" dans contacts/{phone} (resetStatus:'pending'), et un
   script planifié (scripts/reset-patient-codes.js, exécuté toutes les 5 min
   via GitHub Actions — même principe que send-reminders.js, gratuit, sans
   plan Blaze) la traite : il génère un nouveau code, met à jour le mot de
   passe Firebase Auth du patient, puis écrit le nouveau code dans lastCode.
   Le médecin peut ensuite le récupérer via 🔑 Code patient, comme d'habitude. */
async function refreshResetStatus(){
  const raw = document.getElementById('findCodePhone').value.trim();
  const phone = toE164(raw);
  const msgEl = document.getElementById('resetCodeStatusMsg');
  const btn = document.getElementById('resetCodeBtn');
  if(!isConfigured){ msgEl.textContent=''; btn.disabled=false; return; }
  try{
    const snap = await getDoc(doc(db,"contacts", phone));
    const status = snap.exists() ? snap.data().resetStatus : null;
    if(status === 'pending'){
      msgEl.textContent = '⏳ Réinitialisation en cours — nouveau code disponible sous peu via 🔑 Code patient.';
      btn.disabled = true;
    } else if(status === 'error'){
      msgEl.textContent = '⚠️ Échec de la dernière réinitialisation. Réessaie.';
      btn.disabled = false;
    } else {
      msgEl.textContent = '';
      btn.disabled = false;
    }
  }catch(e){ console.error("Erreur lecture statut réinitialisation", e); }
}
document.getElementById('resetCodeBtn').addEventListener('click', async ()=>{
  const raw = document.getElementById('findCodePhone').value.trim();
  const phone = toE164(raw);
  if(!confirm(
    "Réinitialiser le code de connexion de ce patient (" + raw + ") ?\n\n" +
    "Son code actuel cessera de fonctionner. Le nouveau sera généré automatiquement " +
    "dans les minutes qui suivent et récupérable via 🔑 Code patient."
  )) return;
  try{
    await setDoc(doc(db,"contacts", phone), {
      resetStatus: 'pending',
      resetRequestedAt: serverTimestamp()
    }, { merge:true });
    await refreshResetStatus();
  }catch(e){
    console.error("Erreur demande de réinitialisation", e);
    document.getElementById('resetCodeStatusMsg').textContent = "Erreur d'envoi. Vérifie ta connexion et réessaie.";
  }
});
// Pondérations du score de fidélité — ajustables ici sans toucher au reste.
// honoré = plein point ; absence = zéro ; annulation/report anticipé (avant
// LATE_NOTICE_HOURS) = pénalité légère ; tardif = pénalité plus lourde.
const LOYALTY_WEIGHTS = { honored:1, absent:0, cancelEarly:0.5, cancelLate:0.15, reschedEarly:0.7, reschedLate:0.35 };

function computeLoyaltyScore(stats){
  const honored = stats.honoredCount||0, absent = stats.absentCount||0;
  const cancelLate = stats.lateCancelCount||0, cancelEarly = Math.max((stats.cancelCount||0)-cancelLate,0);
  const reschedLate = stats.lateRescheduleCount||0, reschedEarly = Math.max((stats.rescheduleCount||0)-reschedLate,0);
  const totalEvents = honored+absent+cancelEarly+cancelLate+reschedEarly+reschedLate;
  if(totalEvents===0) return null;
  const weighted = honored*LOYALTY_WEIGHTS.honored + absent*LOYALTY_WEIGHTS.absent
    + cancelEarly*LOYALTY_WEIGHTS.cancelEarly + cancelLate*LOYALTY_WEIGHTS.cancelLate
    + reschedEarly*LOYALTY_WEIGHTS.reschedEarly + reschedLate*LOYALTY_WEIGHTS.reschedLate;
  return Math.round((weighted/totalEvents)*100);
}

function loyaltyBarHtml(score, streak){
  if(score===null) return '';
  const color = score>=75 ? 'var(--teal)' : score>=45 ? 'var(--amber)' : 'var(--alert)';
  const streakLine = streak>0
    ? `🔥 ${streak} RDV honoré${streak>1?'s':''} d'affilée depuis la dernière absence.`
    : `Aucune chaîne en cours.`;
  return `<div style="margin-top:8px;">
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
      <span>Fidélité</span><span>${score}%</span>
    </div>
    <div style="height:8px;border-radius:5px;background:var(--line);overflow:hidden;">
      <div style="height:100%;width:${score}%;background:${color};border-radius:5px;"></div>
    </div>
    <div style="font-size:12px;margin-top:6px;color:var(--ink);opacity:.75;">${streakLine}</div>
  </div>`;
}

async function refreshBlockStatus(){
  const raw = document.getElementById('findCodePhone').value.trim();
  const phone = toE164(raw);
  const attendanceEl = document.getElementById('attendanceStatusMsg');

  // patients/{phone} est désormais la SEULE source de vérité pour
  // honoré/absent/annulé/reporté : mis à jour en temps réel dès que le
  // médecin marque un RDV, annule ou décale (voir setHonoredStatus,
  // recordCancellation, recordReschedule) — plus besoin de re-scanner les
  // RDV en mémoire (ça les compterait deux fois).
  const stats = isConfigured ? await getArchivedPatientStats(phone)
    : { honoredCount:0, absentCount:0, cancelCount:0, lateCancelCount:0, rescheduleCount:0, lateRescheduleCount:0, currentStreak:0 };
  const score = computeLoyaltyScore(stats);

  let lines = [];
  if(stats.honoredCount||stats.absentCount) lines.push('📊 ' + stats.honoredCount + '/' + (stats.honoredCount+stats.absentCount) + ' RDV honorés.');
  if(stats.cancelCount) lines.push('🔁 ' + stats.cancelCount + ' annulation(s), dont ' + (stats.lateCancelCount||0) + ' tardive(s).');
  if(stats.rescheduleCount) lines.push('📅 ' + stats.rescheduleCount + ' report(s), dont ' + (stats.lateRescheduleCount||0) + ' tardif(s).');
  attendanceEl.innerHTML = lines.join('<br>') + loyaltyBarHtml(score, stats.currentStreak||0);

  if(!isConfigured){ document.getElementById('blockStatusMsg').textContent = ''; return; }
  const msgEl = document.getElementById('blockStatusMsg');
  try{
    const snap = await getDoc(doc(db,"contacts", phone));
    const blockedFrom = snap.exists() ? snap.data().blockedFrom : null;
    if(!blockedFrom){ msgEl.textContent = 'Accès actuellement non bloqué.'; return; }
    const d = blockedFrom.toDate ? blockedFrom.toDate() : new Date(blockedFrom);
    const future = d.getTime() > Date.now();
    msgEl.textContent = future
      ? '📅 Blocage programmé à partir du ' + d.toLocaleDateString('fr-FR') + '.'
      : '🚫 Bloqué depuis le ' + d.toLocaleDateString('fr-FR') + '.';
  }catch(e){ console.error("Erreur lecture statut blocage", e); }
}
document.getElementById('blockPatientBtn').addEventListener('click', async ()=>{
  const raw = document.getElementById('findCodePhone').value.trim();
  const phone = toE164(raw);
  const dateVal = document.getElementById('blockFromDate').value;
  if(!dateVal) return;
  const fromDate = new Date(dateVal + "T00:00:00");
  const isFuture = fromDate.getTime() > Date.now();
  if(!confirm(
    (isFuture ? "Programmer le blocage" : "Bloquer immédiatement l'accès") +
    " de ce patient (" + raw + ") à partir du " + fromDate.toLocaleDateString('fr-FR') + " ?\n\n" +
    "Il ne pourra plus voir ses rendez-vous à partir de cette date. Réversible à tout moment."
  )) return;
  try{
    await setDoc(doc(db,"contacts", phone), {blockedFrom: fromDate}, {merge:true});
    refreshBlockStatus();
  }catch(e){
    console.error("Erreur blocage patient", e);
    alert("Erreur pendant le blocage. Réessaie.");
  }
});
document.getElementById('unblockPatientBtn').addEventListener('click', async ()=>{
  const raw = document.getElementById('findCodePhone').value.trim();
  const phone = toE164(raw);
  try{
    await setDoc(doc(db,"contacts", phone), {blockedFrom: null}, {merge:true});
    refreshBlockStatus();
  }catch(e){
    console.error("Erreur déblocage patient", e);
    alert("Erreur pendant le déblocage. Réessaie.");
  }
});
document.getElementById('deletePatientBtn').addEventListener('click', async ()=>{
  const raw = document.getElementById('findCodePhone').value.trim();
  const phone = toE164(raw);
  if(!isValidPhone(phone)) return;
  if(!confirm(
    "Supprimer définitivement ce patient (" + raw + ") ?\n\n" +
    "Ceci efface sa fiche contact et déplace tous ses RDV dans la Corbeille.\n\n" +
    "⚠️ Son compte de connexion (email/mot de passe Firebase) N'EST PAS supprimé "+
    "automatiquement — Firebase ne permet pas cette opération depuis l'appli. "+
    "S'il ne doit vraiment plus jamais se connecter, supprime aussi son compte "+
    "manuellement depuis la console Firebase (Authentication → chercher p" + phone + "@rdvcabinet.local)."
  )) return;
  try{
    // Déplace ses RDV dans la Corbeille plutôt que de les effacer d'un coup.
    const toDelete = appointments.filter(a=>a.phone===phone && !a.deleted);
    for(const a of toDelete) await removeAppointment(a.id, false);
    if(isConfigured) await deleteDoc(doc(db,"contacts", phone));
    document.getElementById('findCodeOverlay').classList.remove('open');
    alert("Patient supprimé. Ses " + toDelete.length + " RDV sont dans la Corbeille si besoin de les restaurer.");
  }catch(e){
    console.error("Erreur suppression patient", e);
    alert("Erreur pendant la suppression. Réessaie.");
  }
});

/* ---------------- ADMIN: Corbeille (RDV soft-deleted, restauration) ---------------- */
function renderTrash(){
  const box = document.getElementById('trashList');
  const deleted = appointments.filter(a=>a.deleted).sort((a,b)=> (b.deletedAt||'').localeCompare(a.deletedAt||''));
  if(deleted.length===0){
    box.innerHTML = `<p style="color:#6b6f80;font-size:13px;text-align:center;padding:20px 0;">Corbeille vide.</p>`;
    return;
  }
  box.innerHTML = deleted.map(a=>`
    <div style="border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <div>
        <div style="font-weight:700;font-size:14px;">${escapeHtml(a.name)}</div>
        <div style="font-size:12.5px;color:#6b6f80;">${escapeHtml(a.date)} ${escapeHtml(a.time)} · ${escapeHtml(a.reason)}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="mini-btn" data-trash-action="restore" data-id="${a.id}" title="Restaurer">↩️</button>
        <button class="mini-btn" data-trash-action="purge" data-id="${a.id}" title="Supprimer définitivement">🗑</button>
      </div>
    </div>`).join('');
}
document.getElementById('trashBtn').addEventListener('click', ()=>{
  renderTrash();
  document.getElementById('trashOverlay').classList.add('open');
});
document.getElementById('trashCloseBtn').addEventListener('click', ()=>{
  document.getElementById('trashOverlay').classList.remove('open');
});
document.getElementById('trashOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='trashOverlay') document.getElementById('trashOverlay').classList.remove('open');
});
document.getElementById('trashList').addEventListener('click', async (e)=>{
  const btn = e.target.closest('button[data-trash-action]');
  if(!btn) return;
  const id = btn.dataset.id;
  if(btn.dataset.trashAction==='restore'){
    await restoreAppointment(id);
    renderTrash();
  } else if(btn.dataset.trashAction==='purge'){
    if(confirm("Supprimer définitivement ce RDV ? Cette action est irréversible.")){
      await permanentlyDeleteAppointment(id);
      renderTrash();
    }
  }
});

/* ---------------- ADMIN: export CSV (filet de sécurité indépendant de Firebase) ---------------- */
function buildCsv(){
  const rows = [["Nom","Téléphone","Date","Heure","Motif","Notes","Statut"]];
  appointments.filter(a=>!a.deleted).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).forEach(a=>{
    rows.push([a.name, a.phone, a.date, a.time, a.reason, a.notes||'', statusOf(a).label]);
  });
  return rows.map(r=>r.map(v=>'"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\r\n');
}
document.getElementById('exportCsvBtn').addEventListener('click', ()=>{
  try{
    const csv = "\uFEFF" + buildCsv(); // BOM pour un bon affichage des accents dans Excel
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "rdv-cabinet-" + todayStr() + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }catch(e){
    console.error("Erreur export CSV", e);
    alert("Le téléchargement automatique a échoué. Voici le contenu à copier manuellement :\n\n" + buildCsv());
  }
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
  const btn = document.getElementById('patientLoginBtn');
  if(btn.disabled) return; // évite un double-clic/double-Enter pendant la requête en cours
  btn.disabled = true;
  try{
    await signInWithEmailAndPassword(auth, patientEmailFor(e164), code);
    document.getElementById('phoneGate').style.display='none';
    document.getElementById('patientResultWrap').style.display='';
    subscribePatient();
    maybeShowNotifBanner();
  }catch(e){
    // On distingue les erreurs réseau/serveur des erreurs d'identifiants :
    // sinon un patient sans connexion voit "code incorrect" et ressaisit
    // son code en boucle au lieu de vérifier sa connexion internet.
    document.getElementById('phoneError').textContent = patientLoginErrorMessage(e);
    document.getElementById('phoneError').style.display='block';
  }finally{
    btn.disabled = false;
  }
}
function patientLoginErrorMessage(e){
  switch(e.code){
    case 'auth/user-not-found':
      return t('no_account_error');
    case 'auth/network-request-failed':
      return t('network_error');
    case 'auth/too-many-requests':
      return t('too_many_requests_error');
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
    case 'auth/invalid-api-key':
    case 'auth/app-not-authorized':
      return t('config_error');
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
      return t('code_error');
    default:
      return t('code_error');
  }
}

/* ---------------- PATIENT: data subscription (own appointments only) ---------------- */
// Compteurs maintenus par scripts/archive-old-appointments.js : totalCount,
// honoredCount, absentCount. Couvre tout l'historique déjà archivé ; on
// l'additionne avec ce qui est encore dans la fenêtre active en mémoire.
const EMPTY_PATIENT_STATS = { honoredCount:0, absentCount:0, totalCount:0, cancelCount:0, lateCancelCount:0, rescheduleCount:0, lateRescheduleCount:0, currentStreak:0, longestStreak:0 };
async function getArchivedPatientStats(phone){
  if(!isConfigured || !phone) return {...EMPTY_PATIENT_STATS};
  try{
    const snap = await getDoc(doc(db,"patients", phone));
    return snap.exists() ? {...EMPTY_PATIENT_STATS, ...snap.data()} : {...EMPTY_PATIENT_STATS};
  }catch(e){
    console.error("Erreur lecture stats patient", e);
    return {...EMPTY_PATIENT_STATS};
  }
}

async function subscribePatient(){
  if(unsubscribeAppts) unsubscribeAppts();
  if(!isConfigured){
    appointments = appointments.filter(a=>a.phone===patientPhoneE164);
    refreshPatientResults();
    return;
  }
  // Vérifie si le médecin a programmé un blocage d'accès avant de charger
  // ses rendez-vous, pour afficher un message clair plutôt qu'un écran vide.
  try{
    const contactSnap = await getDoc(doc(db,"contacts", patientPhoneE164));
    const blockedFrom = contactSnap.exists() ? contactSnap.data().blockedFrom : null;
    if(blockedFrom){
      const d = blockedFrom.toDate ? blockedFrom.toDate() : new Date(blockedFrom);
      if(d.getTime() <= Date.now()){
        document.getElementById('patientHeroWrap').innerHTML = `<div class="empty">
          <div class="display">Accès bloqué</div>
          <div>Ton accès a été suspendu depuis le ${d.toLocaleDateString('fr-FR')}. Contacte le cabinet pour plus d'informations.</div></div>`;
        document.getElementById('otherRdvWrap').innerHTML='';
        return;
      }
    }
  }catch(e){ console.error("Erreur vérification statut blocage", e); }

  const q = query(apptsCol, where('phone','==', patientPhoneE164));
  unsubscribeAppts = onSnapshot(q, snap=>{
    appointments = snap.docs.map(d=>({id:d.id, ...d.data()})).filter(a=>!a.deleted);
    refreshPatientResults();
  }, err=>{
    // Avant, une erreur ici restait invisible (juste console.error) et
    // laissait une page vide sans explication. On l'affiche maintenant
    // avec son code technique pour pouvoir diagnostiquer précisément
    // (permission refusée, réseau, etc.) au lieu de deviner.
    console.error("Firestore patient listener error", err);
    document.getElementById('patientHeroWrap').innerHTML = `<div class="empty">
      <div class="display">⚠️ Erreur de connexion</div>
      <div>Impossible de charger tes rendez-vous. Vérifie ta connexion internet et réessaie.
      <br><span style="font-size:11px;opacity:.6;">Code technique : ${escapeHtml(err.code || err.message || 'inconnu')}</span>
      <br><span style="font-size:11px;opacity:.6;">Compte connecté : ${escapeHtml((auth.currentUser && auth.currentUser.email) || 'aucun')}</span>
      <br><span style="font-size:11px;opacity:.6;">Numéro recherché : ${escapeHtml(patientPhoneE164 || 'aucun')}</span></div></div>`;
    document.getElementById('otherRdvWrap').innerHTML = '';
  });

  // Écoute la fiche contact du patient pour afficher, en temps réel, la
  // décision du médecin sur une demande d'annulation/décalage — jamais
  // affichée deux fois grâce à un horodatage mémorisé en local.
  onSnapshot(doc(db,"contacts", patientPhoneE164), snap=>{
    const outcome = snap.exists() ? snap.data().lastRequestOutcome : null;
    showRequestOutcomeBanner(outcome);
  });
}

function showRequestOutcomeBanner(outcome){
  const el = document.getElementById('requestOutcomeBanner');
  if(!outcome || !outcome.decidedAt){ if(el) el.remove(); return; }
  const seenKey = 'rdvOutcomeSeen_' + patientPhoneE164;
  if(localStorage.getItem(seenKey) === outcome.decidedAt){ if(el) el.remove(); return; }
  const accepted = outcome.status === 'accepted';
  const verb = outcome.type === 'cancel' ? "d'annulation" : "de décalage";
  const msg = accepted
    ? `✅ Votre demande ${verb} a été <b>acceptée</b> par le cabinet.`
    : `❌ Votre demande ${verb} a été <b>refusée</b> — votre RDV du ${fmtDateShort(outcome.requestedDate)} reste inchangé. Contactez le cabinet si besoin.`;
  const wrap = document.getElementById('patientHeroWrap');
  if(!wrap || !wrap.parentNode) return;
  let banner = document.getElementById('requestOutcomeBanner');
  if(!banner){
    banner = document.createElement('div');
    banner.id = 'requestOutcomeBanner';
    banner.style.cssText = 'margin:0 0 14px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--ink);font-size:13.5px;';
    wrap.parentNode.insertBefore(banner, wrap);
  }
  banner.innerHTML = `${msg} <button id="dismissOutcomeBtn" class="mini-link" style="margin-left:6px;">OK</button>`;
  document.getElementById('dismissOutcomeBtn').addEventListener('click', ()=>{
    localStorage.setItem(seenKey, outcome.decidedAt);
    banner.remove();
  });
}

async function refreshPatientResults(){
  const mine = [...appointments].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  const greetingName = mine.length ? mine[0].name : null;
  const greetingEl = document.getElementById('patientGreeting');
  if(greetingEl) greetingEl.innerHTML = `<div class="patient-greeting">${getGreeting(greetingName, patientPhoneE164)}</div>`;
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

  const cardHtml = a => {
    let honorTag = '';
    if(a.honored === true) honorTag = `<span class="honor-tag honor-yes">✅ Effectué</span>`;
    else if(a.honored === false) honorTag = `<span class="honor-tag honor-no">❌ Non présenté</span>`;
    return `<div class="rdv-card">
      <div class="rdv-time">${a.time}</div>
      <div class="rdv-info">
        <div class="name">${fmtDateShort(a.date)}</div>
        <div class="meta">${escapeHtml(a.reason)}</div>
        ${a.notes ? `<div class="meta" style="margin-top:3px;font-style:italic;">${escapeHtml(a.notes)}</div>` : ''}
        ${honorTag}
      </div>
      <span class="status-pill" style="background:${statusOf(a).color};color:#fff">${statusOf(a).label}</span>
    </div>`;
  };

  let otherHtml = '';
  if(restUpcoming.length>0){
    otherHtml += `<div class="day-heading">${t('other_rdv')}</div>` + restUpcoming.map(cardHtml).join('');
  }
  if(restPast.length>0){
    // Petit résumé motivant, factuel et sans jugement — juste un rappel
    // que la présence aux RDV compte, sans culpabiliser. patients/{phone}
    // est la seule source de vérité désormais (mise à jour en temps réel),
    // plus besoin d'ajouter un scan en mémoire (double comptage sinon).
    const stats = await getArchivedPatientStats(patientPhoneE164);
    const totalMarked = (stats.honoredCount||0) + (stats.absentCount||0);
    let attendanceLine = '';
    if(totalMarked > 0){
      attendanceLine = `<div style="font-size:12.5px;color:#6b6f80;margin:-6px 0 14px;">
        📊 ${stats.honoredCount||0}/${totalMarked} rendez-vous honorés — merci de prévenir le cabinet en cas d'empêchement.</div>`;
    }
    otherHtml += `<div class="day-heading" style="margin-top:32px;">${t('archived_rdv')}</div>${attendanceLine}` + restPast.map(cardHtml).join('');
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

  const isPast = daysBetween(todayStr(), a.date) < 0;
  const req = a.patientRequest;
  let actionsHtml = '';
  if(isPast){
    actionsHtml = '';
  } else if(req && req.type){
    const reqLabel = req.type==='cancel' ? "Demande d'annulation envoyée — en attente du cabinet."
      : "Demande de décalage envoyée (vers " + fmtDateShort(req.requestedDate) + " " + req.requestedTime + ") — en attente du cabinet.";
    actionsHtml = `<div class="pending-request">⏳ ${reqLabel}
      <button class="mini-link" id="cancelRequestBtn" data-id="${a.id}">Retirer la demande</button></div>`;
  } else {
    actionsHtml = `<div style="display:flex;gap:8px;margin-top:14px;">
      <button class="btn-secondary" id="requestCancelBtn" data-id="${a.id}" style="flex:1;">Annuler</button>
      <button class="btn-secondary" id="requestRescheduleBtn" data-id="${a.id}" style="flex:1;">Décaler</button>
    </div>`;
  }
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
      ${actionsHtml}
    </div>`;
  if(st.key==='today') chime();
}

// Modale auto-injectée (aucune modification d'index.html requise) pour
// choisir une nouvelle date + heure via de vrais sélecteurs natifs
// (<input type=date>/<input type=time>), plutôt que des prompt() en texte
// libre. "min" empêche physiquement de sélectionner une date passée ou
// aujourd'hui — seules les dates strictement futures sont proposées.
function openRescheduleModal(apptId){
  document.getElementById('rescheduleModal')?.remove();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const minDate = tomorrow.toISOString().slice(0,10);
  const overlay = document.createElement('div');
  overlay.id = 'rescheduleModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;';
  overlay.innerHTML = `
    <div style="background:var(--cream);color:var(--ink);border-radius:16px;padding:22px;max-width:340px;width:100%;box-shadow:var(--shadow);">
      <h3 style="margin:0 0 14px;font-size:17px;">Nouvelle date souhaitée</h3>
      <label style="display:block;font-size:13px;margin-bottom:4px;">Date</label>
      <input type="date" id="reschedDateInput" min="${minDate}" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);margin-bottom:12px;">
      <label style="display:block;font-size:13px;margin-bottom:4px;">Heure</label>
      <input type="time" id="reschedTimeInput" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);margin-bottom:18px;">
      <div style="display:flex;gap:8px;">
        <button id="reschedCancelBtn" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer;">Annuler</button>
        <button id="reschedConfirmBtn" style="flex:1;padding:10px;border-radius:10px;border:none;background:var(--teal);color:#fff;cursor:pointer;">Envoyer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = ()=> overlay.remove();
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  document.getElementById('reschedCancelBtn').addEventListener('click', close);
  document.getElementById('reschedConfirmBtn').addEventListener('click', async ()=>{
    const newDate = document.getElementById('reschedDateInput').value;
    const newTime = document.getElementById('reschedTimeInput').value;
    if(!newDate){ alert("Choisis une date."); return; }
    if(newDate < minDate){ alert("Merci de choisir une date à partir de demain."); return; }
    if(!newTime){ alert("Choisis une heure."); return; }
    close();
    await submitPatientRequest(apptId, {type:'reschedule', requestedDate:newDate, requestedTime:newTime, requestedAt:new Date().toISOString()});
  });
}

async function submitPatientRequest(apptId, request){
  try{
    await updateDoc(doc(db,"appointments",apptId), {patientRequest: request});
  }catch(e){
    console.error("Erreur envoi demande patient", e);
    alert("Erreur d'envoi. Vérifie ta connexion et réessaie.");
  }
}
document.getElementById('patientHeroWrap').addEventListener('click', async (e)=>{
  const cancelBtn = e.target.closest('#requestCancelBtn');
  const reschedBtn = e.target.closest('#requestRescheduleBtn');
  const retractBtn = e.target.closest('#cancelRequestBtn');
  if(cancelBtn){
    if(confirm("Demander l'annulation de ce rendez-vous ? Le cabinet devra confirmer.")){
      await submitPatientRequest(cancelBtn.dataset.id, {type:'cancel', requestedAt:new Date().toISOString()});
    }
  } else if(reschedBtn){
    openRescheduleModal(reschedBtn.dataset.id);
  } else if(retractBtn){
    await submitPatientRequest(retractBtn.dataset.id, {});
  }
});

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
applyTheme();
