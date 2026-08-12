/* =======================================================================
   FIREBASE — CONFIGURATION REQUISE
   1. https://console.firebase.google.com → créer un projet (gratuit)
   2. Build > Firestore Database > Créer une base (mode test au départ)
   3. Build > Authentication > Sign-in method > activer "E-mail/Mot de passe"
      ET "Téléphone".
   4. Authentication > Users > Add user → crée TON compte médecin (email+mdp)
   5. Copie son "User UID", puis dans Firestore Database > Data, crée
      manuellement une collection "admins" avec un document dont l'ID EST
      cet UID (n'importe quel champ dedans, ex: role: "admin").
   6. Paramètres du projet > Tes applications > Ajouter une app Web →
      copie les valeurs ci-dessous dans firebaseConfig.
   7. Pour l'APK (authentification téléphone native, sans reCAPTCHA) :
      - Paramètres du projet > Tes applications > Ajouter une app Android
        avec le package "com.belhoula.rdvcabinet".
      - Récupère le SHA-1 ET le SHA-256 de ta machine (Android Studio :
        panneau Gradle > app > Tasks > android > signingReport, ou
        `cd android && ./gradlew signingReport`) et ajoute-les dans les
        paramètres de cette app Android sur Firebase.
      - Télécharge google-services.json et place-le dans android/app/.
      - Dans Google Cloud Console (même projet), active l'API "Play Integrity".
   8. Dans Firestore Database > Règles, colle le contenu de firestore.rules
      (section "RÈGLES ACTIVES") puis Publier.
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
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, getDoc,
  onSnapshot, query, where
} from "firebase/firestore";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  RecaptchaVerifier, signInWithPhoneNumber
} from "firebase/auth";
import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";

const isNative = Capacitor.isNativePlatform();

let db=null, auth=null, apptsCol=null;
if(isConfigured){
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  apptsCol = collection(db, "appointments");
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
  "Autre"
];

let appointments = [];
let editingId = null;
let muted = false;
let role = null;
let patientPhoneE164 = null;
let unsubscribeAppts = null;
let confirmationResult = null;      // web fallback flow
let recaptchaVerifier = null;       // web fallback flow
let nativeVerificationId = null;    // native flow
let nativeListenersReady = false;

/* ---------------- helpers ---------------- */
function uid(){ return Math.random().toString(36).slice(2,10); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function toE164(raw){
  let digits = (raw||"").replace(/\D/g,"");
  if(digits.startsWith(COUNTRY_CODE)) digits = digits.slice(COUNTRY_CODE.length);
  digits = digits.replace(/^0+/,"");
  return "+" + COUNTRY_CODE + digits;
}
function fmtDate(d){ return new Date(d+"T00:00:00").toLocaleDateString('fr-FR',{weekday:'long',day:'2-digit',month:'long'}); }
function fmtDateShort(d){ return new Date(d+"T00:00:00").toLocaleDateString('fr-FR',{day:'2-digit',month:'short',year:'numeric'}); }
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function daysBetween(a,b){
  const d1=new Date(a+"T00:00:00"), d2=new Date(b+"T00:00:00");
  return Math.round((d2-d1)/86400000);
}
function statusOf(a){
  const diff = daysBetween(todayStr(), a.date);
  if(diff < 0) return {key:"past", label:"Passé", color:"#8a8d99"};
  if(diff === 0) return {key:"today", label:"Aujourd'hui", color:"#FF9142"};
  if(diff <= 3) return {key:"soon", label:"Bientôt", color:"var(--amber)"};
  return {key:"ok", label:"À venir", color:"var(--teal)"};
}

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
document.getElementById('switchRoleBtn').addEventListener('click', ()=>{
  teardownView();
  role=null;
  document.getElementById('appShell').style.display='none';
  document.getElementById('roleGate').style.display='flex';
});
document.getElementById('signOutBtn').addEventListener('click', async ()=>{
  if(isConfigured){
    if(isNative){ try{ await FirebaseAuthentication.signOut(); }catch(e){} }
    else { await signOut(auth); }
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
  document.getElementById('appTitle').textContent = r==='admin' ? 'Espace Médecin' : 'Mes rendez-vous';
  document.getElementById('signOutBtn').style.display = isConfigured ? '' : 'none';

  if(r==='admin'){
    if(!isConfigured){
      document.getElementById('adminLoginWrap').style.display='none';
      document.getElementById('adminContentWrap').style.display='';
      subscribeAdmin();
    } else if(auth.currentUser){
      checkAdminAndEnter();
    } else {
      document.getElementById('adminLoginWrap').style.display='';
      document.getElementById('adminContentWrap').style.display='none';
    }
  }
  if(r==='patient'){
    document.getElementById('patientResultWrap').style.display='none';
    if(!isConfigured || !auth.currentUser){
      document.getElementById('phoneGate').style.display='';
      document.getElementById('codeGate').style.display='none';
      document.getElementById('phoneInput').value='';
    } else {
      patientPhoneE164 = auth.currentUser.phoneNumber;
      document.getElementById('phoneGate').style.display='none';
      document.getElementById('codeGate').style.display='none';
      document.getElementById('patientResultWrap').style.display='';
      subscribePatient();
    }
  }
}

document.getElementById('muteBtn').addEventListener('click', ()=>{
  muted=!muted;
  document.getElementById('muteBtn').textContent = muted ? "🔇" : "🔊";
});

/* ---------------- ADMIN: auth (email/mot de passe — inchangé, natif ou web) ---------------- */
async function checkAdminAndEnter(){
  try{
    const snap = await getDoc(doc(db,"admins",auth.currentUser.uid));
    if(snap.exists()){
      document.getElementById('adminLoginWrap').style.display='none';
      document.getElementById('adminContentWrap').style.display='';
      subscribeAdmin();
    } else {
      showAdminError("Ce compte n'est pas autorisé comme médecin sur cette appli.");
      await signOut(auth);
    }
  }catch(e){
    showAdminError("Erreur de vérification du compte. Réessaie.");
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
    showAdminError("Identifiants incorrects.");
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
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if(!dot) return;
  dot.classList.toggle('off', !on);
  label.textContent = on ? "Connecté à Firebase" : (isConfigured ? "Connexion en cours…" : "Mode local (sans sync)");
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
function renderAdmin(){
  const list = document.getElementById('rdvList');
  const upcoming = [...appointments].sort((a,b)=> (a.date+a.time).localeCompare(b.date+b.time));
  const todayCount = upcoming.filter(a=>statusOf(a).key==='today').length;
  document.getElementById('summaryLine').textContent =
    upcoming.length===0 ? "Aucun rendez-vous programmé." : `${upcoming.length} RDV — ${todayCount} aujourd'hui`;

  if(upcoming.length===0){
    list.innerHTML = `<div class="empty"><div class="display">Aucun rendez-vous</div><div>Fixe un premier RDV pour démarrer.</div></div>`;
    return;
  }

  let html='', lastDate=null;
  upcoming.forEach(a=>{
    if(a.date!==lastDate){
      html += `<div class="day-heading">${fmtDate(a.date)}</div>`;
      lastDate=a.date;
    }
    const st = statusOf(a);
    html += `<div class="rdv-card">
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
  });
  list.innerHTML = html;
}

document.getElementById('rdvList').addEventListener('click', async (e)=>{
  const btn = e.target.closest('button[data-action]');
  if(!btn) return;
  const a = appointments.find(x=>x.id===btn.dataset.id);
  if(!a) return;
  if(btn.dataset.action==='edit') openModal(a);
  if(btn.dataset.action==='delete'){
    if(confirm(`Supprimer le RDV de ${a.name} ?`)){
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
  document.getElementById('modalTitle').textContent = a ? "Modifier le rendez-vous" : "Fixer un rendez-vous";
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
  closeModal();
});

/* ---------------- PATIENT: phone + SMS verification ---------------- */
/* NATIF (APK/iOS) : plugin @capacitor-firebase/authentication → Play Integrity,
   pas de reCAPTCHA, la vérification se fait au niveau du système Android.
   WEB (navigateur / test avant compilation) : SDK Firebase Web classique
   avec reCAPTCHA invisible. */

function setupNativePhoneListeners(){
  if(nativeListenersReady) return;
  nativeListenersReady = true;
  FirebaseAuthentication.addListener('phoneCodeSent', (event)=>{
    nativeVerificationId = event.verificationId;
    document.getElementById('phoneGate').style.display='none';
    document.getElementById('codeGate').style.display='';
    document.getElementById('codeSentTo').textContent = `Code envoyé par SMS`;
  });
  FirebaseAuthentication.addListener('phoneVerificationFailed', (event)=>{
    document.getElementById('phoneError').textContent = "Impossible d'envoyer le code (" + (event.message||'erreur') + ").";
    document.getElementById('phoneError').style.display='block';
  });
  FirebaseAuthentication.addListener('phoneVerificationCompleted', async (event)=>{
    // auto-vérification Android (détection automatique du SMS) — on saute l'étape code
    patientPhoneE164 = auth.currentUser ? auth.currentUser.phoneNumber : event.phoneNumber;
    document.getElementById('codeGate').style.display='none';
    document.getElementById('patientResultWrap').style.display='';
    subscribePatient();
  });
}

function ensureWebRecaptcha(){
  if(!recaptchaVerifier){
    recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
  }
  return recaptchaVerifier;
}

document.getElementById('phoneSubmit').addEventListener('click', async ()=>{
  const raw = document.getElementById('phoneInput').value.trim();
  document.getElementById('phoneError').style.display='none';
  if(!raw) return;
  const e164 = toE164(raw);

  if(!isConfigured){
    patientPhoneE164 = e164;
    document.getElementById('phoneGate').style.display='none';
    document.getElementById('patientResultWrap').style.display='';
    subscribePatient();
    return;
  }

  try{
    if(isNative){
      setupNativePhoneListeners();
      await FirebaseAuthentication.signInWithPhoneNumber({ phoneNumber: e164 });
      // la suite se passe dans les listeners (phoneCodeSent / phoneVerificationCompleted)
    } else {
      const verifier = ensureWebRecaptcha();
      confirmationResult = await signInWithPhoneNumber(auth, e164, verifier);
      document.getElementById('phoneGate').style.display='none';
      document.getElementById('codeGate').style.display='';
      document.getElementById('codeSentTo').textContent = `Code envoyé au ${e164}`;
    }
  }catch(e){
    console.error(e);
    document.getElementById('phoneError').textContent = "Impossible d'envoyer le code. Vérifie le numéro.";
    document.getElementById('phoneError').style.display='block';
  }
});
document.getElementById('phoneInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') document.getElementById('phoneSubmit').click(); });

document.getElementById('codeSubmit').addEventListener('click', async ()=>{
  const code = document.getElementById('codeInput').value.trim();
  document.getElementById('codeError').style.display='none';
  if(!code) return;
  try{
    if(isNative){
      if(!nativeVerificationId) throw new Error("no verification id");
      await FirebaseAuthentication.confirmVerificationCode({
        verificationId: nativeVerificationId, verificationCode: code
      });
      patientPhoneE164 = auth.currentUser ? auth.currentUser.phoneNumber : null;
    } else {
      if(!confirmationResult) throw new Error("no confirmation result");
      const result = await confirmationResult.confirm(code);
      patientPhoneE164 = result.user.phoneNumber;
    }
    document.getElementById('codeGate').style.display='none';
    document.getElementById('patientResultWrap').style.display='';
    subscribePatient();
  }catch(e){
    document.getElementById('codeError').textContent = "Code incorrect. Réessaie.";
    document.getElementById('codeError').style.display='block';
  }
});
document.getElementById('codeInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') document.getElementById('codeSubmit').click(); });

document.getElementById('backToPhoneBtn').addEventListener('click', async ()=>{
  if(isConfigured){
    if(isNative){ try{ await FirebaseAuthentication.signOut(); }catch(e){} }
    else if(auth.currentUser){ await signOut(auth); }
  }
  confirmationResult=null; nativeVerificationId=null;
  document.getElementById('codeGate').style.display='none';
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
      <div class="display">Aucun rendez-vous trouvé</div>
      <div>Contacte le cabinet si tu penses qu'un RDV devrait apparaître ici.</div></div>`;
    document.getElementById('otherRdvWrap').innerHTML='';
    return;
  }
  const next = mine.find(a=>daysBetween(todayStr(),a.date) >= 0) || mine[mine.length-1];
  showPatientHero(next);
  const rest = mine.filter(a=>a.id!==next.id);
  document.getElementById('otherRdvWrap').innerHTML = rest.length===0 ? '' :
    `<div class="day-heading">Autres rendez-vous</div>` +
    rest.map(a=>`<div class="rdv-card">
      <div class="rdv-time">${a.time}</div>
      <div class="rdv-info">
        <div class="name">${fmtDateShort(a.date)}</div>
        <div class="meta">${escapeHtml(a.reason)}</div>
      </div>
      <span class="status-pill" style="background:${statusOf(a).color};color:#fff">${statusOf(a).label}</span>
    </div>`).join('');
}

function showPatientHero(a){
  const st = statusOf(a);
  const diff = daysBetween(todayStr(), a.date);
  let big, label;
  if(diff<0){ big="Passé"; label = `le ${fmtDateShort(a.date)}`; }
  else if(diff===0){ big="Aujourd'hui"; label = `à ${a.time}`; }
  else { big=diff; label = diff===1 ? "jour avant ton RDV" : "jours avant ton RDV"; }

  document.getElementById('patientHeroWrap').innerHTML = `
    <div class="patient-hero">
      <div class="sun-wrap">${sunriseSVG(a)}</div>
      <h2 style="font-size:20px;margin:10px 0 2px;font-weight:600;">${escapeHtml(a.reason)}</h2>
      <div class="path-tag">avec Dr Hédi Belhoula</div>
      <div class="big-days">${big}</div>
      <div class="big-days-label">${label}</div>
      <div class="date-line">${fmtDate(a.date)} à ${a.time}</div>
      <span class="status-pill" style="background:${st.color}">${st.label}</span>
    </div>`;
  if(st.key==='today') chime();
}

/* ---------------- periodic reminder while patient view open ---------------- */
setInterval(()=>{
  if(role!=='patient' || !patientPhoneE164) return;
  const dueToday = appointments.some(a=>statusOf(a).key==='today');
  if(dueToday) chime();
}, 60000);

/* ---------------- init ---------------- */
fillReasonSelect();
