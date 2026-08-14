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

import { initializeApp } from "firebase/app";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, addDoc, updateDoc, deleteDoc, doc, getDoc, setDoc,
  onSnapshot, query, where
} from "firebase/firestore";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "firebase/auth";
import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";

const isNative = Capacitor.isNativePlatform();

let db=null, auth=null, apptsCol=null, contactsCol=null;
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
  // réservées au médecin) que la collection "appointments".
  contactsCol = collection(db, "contacts");
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
let patientMode = null; // 'new' | 'existing'
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
    patient_intro_sub: "Entre ton numéro de téléphone pour accéder à tes rendez-vous.",
    phone_placeholder: "Ex: 22 123 456",
    first_visit_btn: "Première visite", have_code_btn: "J'ai déjà un code",
    code_new_title: "Ton code personnel", code_new_sub: "Note bien ce code — il te sera demandé à chaque visite.",
    code_continue: "J'ai noté mon code, continuer",
    code_enter_title: "Entre ton code", code_enter_sub: "Le code personnel à 6 chiffres reçu lors de ta première visite.",
    code_verify: "Vérifier", code_error: "Code incorrect. Réessaie.",
    code_change_number: "Changer de numéro",
    no_account_error: "Aucun compte pour ce numéro. Choisis \"Première visite\".",
    account_exists_error: "Ce numéro a déjà un code. Choisis \"J'ai déjà un code\".",
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
    patient_intro_sub: "أدخل رقم هاتفك للوصول إلى مواعيدك.",
    phone_placeholder: "مثال: 22 123 456",
    first_visit_btn: "أول زيارة", have_code_btn: "لدي رمز بالفعل",
    code_new_title: "رمزك الشخصي", code_new_sub: "احتفظ بهذا الرمز جيداً — سيُطلب منك في كل زيارة.",
    code_continue: "سجّلت رمزي، متابعة",
    code_enter_title: "أدخل رمزك", code_enter_sub: "الرمز الشخصي المكوّن من 6 أرقام الذي تحصلت عليه في أول زيارة.",
    code_verify: "تحقق", code_error: "رمز غير صحيح. حاول مجدداً.",
    code_change_number: "تغيير الرقم",
    no_account_error: "لا يوجد حساب لهذا الرقم. اختر \"أول زيارة\".",
    account_exists_error: "هذا الرقم لديه رمز بالفعل. اختر \"لدي رمز بالفعل\".",
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
  document.getElementById('firstVisitBtn').textContent = t('first_visit_btn');
  document.getElementById('haveCodeBtn').textContent = t('have_code_btn');
  document.getElementById('codeNewTitle').textContent = t('code_new_title');
  document.getElementById('codeNewSub').textContent = t('code_new_sub');
  document.getElementById('codeContinueBtn').textContent = t('code_continue');
  document.getElementById('codeEnterTitle').textContent = t('code_enter_title');
  document.getElementById('codeEnterSub').textContent = t('code_enter_sub');
  document.getElementById('codeSubmit').textContent = t('code_verify');
  document.getElementById('backToPhoneBtn').textContent = t('code_change_number');
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
      document.getElementById('codeGate').style.display='none';
      document.getElementById('codeDisplayGate').style.display='none';
      document.getElementById('phoneInput').value='';
    } else {
      patientPhoneE164 = existingPhone;
      document.getElementById('phoneGate').style.display='none';
      document.getElementById('codeGate').style.display='none';
      document.getElementById('codeDisplayGate').style.display='none';
      document.getElementById('patientResultWrap').style.display='';
      subscribePatient();
    }
  }
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
async function saveContact(name, phone){
  if(!name || !phone) return;
  if(isConfigured){
    try{ await setDoc(doc(db,"contacts", phone), {name, phone}); }
    catch(e){ console.error("Erreur sauvegarde contact", e); }
  } else {
    const i = contacts.findIndex(c=>c.phone===phone);
    if(i>=0) contacts[i].name = name; else contacts.push({id:phone, name, phone});
    localStorage.setItem('rdvContacts', JSON.stringify(contacts));
    refreshNameSuggestions();
  }
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
  const data = {name,phone,date,time,reason,notes};
  if(editingId) await editAppointment(editingId, data);
  else await createAppointment(data);
  await saveContact(name, phone);
  closeModal();
});

/* ---------------- PATIENT: phone + code permanent (sans SMS) ---------------- */
/* On réutilise l'authentification email/mot de passe de Firebase : l'email
   est dérivé du numéro de téléphone, et le "mot de passe" est le code à
   6 chiffres du patient. C'est réellement vérifié côté serveur Firebase,
   sans dépendre de SMS/Blaze/Play Integrity. */

document.getElementById('firstVisitBtn').addEventListener('click', ()=>{ startPatientFlow('new'); });
document.getElementById('haveCodeBtn').addEventListener('click', ()=>{ startPatientFlow('existing'); });

function startPatientFlow(mode){
  const raw = document.getElementById('phoneInput').value.trim();
  document.getElementById('phoneError').style.display='none';
  if(!raw) return;
  const e164 = toE164(raw);
  patientPhoneE164 = e164;
  patientMode = mode;

  if(!isConfigured){
    document.getElementById('phoneGate').style.display='none';
    document.getElementById('patientResultWrap').style.display='';
    subscribePatient();
    return;
  }

  if(mode==='new'){
    createPatientAccount(e164);
  } else {
    document.getElementById('phoneGate').style.display='none';
    document.getElementById('codeGate').style.display='';
    document.getElementById('codeInput').value='';
    document.getElementById('codeInput').focus();
  }
}
document.getElementById('phoneInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') startPatientFlow('existing'); });

async function createPatientAccount(e164){
  try{
    const code = generatePatientCode();
    await createUserWithEmailAndPassword(auth, patientEmailFor(e164), code);
    document.getElementById('phoneGate').style.display='none';
    document.getElementById('codeDisplayGate').style.display='';
    document.getElementById('codeDisplayValue').textContent = code;
  }catch(e){
    console.error(e);
    document.getElementById('phoneError').textContent =
      (e.code==='auth/email-already-in-use') ? t('account_exists_error') : t('code_error');
    document.getElementById('phoneError').style.display='block';
  }
}

document.getElementById('codeContinueBtn').addEventListener('click', ()=>{
  document.getElementById('codeDisplayGate').style.display='none';
  document.getElementById('patientResultWrap').style.display='';
  subscribePatient();
});

document.getElementById('codeSubmit').addEventListener('click', async ()=>{
  const code = document.getElementById('codeInput').value.trim();
  document.getElementById('codeError').style.display='none';
  if(!code) return;
  try{
    await signInWithEmailAndPassword(auth, patientEmailFor(patientPhoneE164), code);
    document.getElementById('codeGate').style.display='none';
    document.getElementById('patientResultWrap').style.display='';
    subscribePatient();
  }catch(e){
    document.getElementById('codeError').textContent =
      (e.code==='auth/user-not-found') ? t('no_account_error') : t('code_error');
    document.getElementById('codeError').style.display='block';
  }
});
document.getElementById('codeInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') document.getElementById('codeSubmit').click(); });

document.getElementById('backToPhoneBtn').addEventListener('click', async ()=>{
  if(isConfigured && auth.currentUser){ try{ await signOut(auth); }catch(e){} }
  document.getElementById('codeGate').style.display='none';
  document.getElementById('codeDisplayGate').style.display='none';
  document.getElementById('phoneGate').style.display='';
  document.getElementById('phoneInput').value='';
});

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
