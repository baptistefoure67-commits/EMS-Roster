// ═══════════════════════════ DONNÉES DE RÉFÉRENCE ═══════════════════════════

const GRADE_ORDER = ["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","INF","A","STG","WDV"];
const GRADE_LABEL = {
  DG:"Directeur Général", D:"Directeur", CD:"Co-Directeur", ADD:"Assistant de Direction",
  MC:"Médecin Chef", RL:"Responsable Légiste", RF:"Responsable Formateur", RP:"Responsable Psychologue",
  MLP:"Médecin Légiste Pompier", MP:"Médecin Psychologue", MF:"Médecin Formateur", M:"Médecin",
  INF:"Infirmier", A:"Ambulancier", WDV:"WDV", STG:"Stagiaire",
};
// Libellés personnalisés (CD/D/OWNER) — appliqués PAR-DESSUS les valeurs
// ci-dessus dès qu'ils sont chargés. On mute l'objet existant (jamais
// remplacé) pour que toutes les fonctions qui lisent déjà GRADE_LABEL[x]
// voient le changement sans rien avoir à modifier ailleurs (09/09).
async function fetchGradeLabelsSilent(){
  try{
    const res = await fetch("/.netlify/functions/manage-labels");
    const data = await res.json().catch(()=>({}));
    if(data && data.labels) Object.assign(GRADE_LABEL, data.labels);
  }catch(err){ console.error("Chargement des libellés personnalisés impossible:", err); }
  renderAll();
  renderGradeLabelsEditor();
}

// Affiche/remplit l'éditeur de libellés — réservé à CD/D/OWNER (juste
// pour l'affichage ; la vraie vérification reste dans
// manage-labels.js, jamais ici).
function renderGradeLabelsEditor(){
  const card = document.getElementById("gradeLabelsCard");
  const canEdit = hasCap("modify_role_label");
  card.style.display = canEdit ? "" : "none";
  if(!canEdit) return;
  const box = document.getElementById("gradeLabelsEditor");
  box.innerHTML = GRADE_ORDER.map(g=>`
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <span class="grade-badge" style="background:${GRADE_COLOR[g]};color:${GRADE_TEXT_COLOR[g]};min-width:44px;text-align:center;">${g}</span>
      <input type="text" data-grade-label-input="${g}" value="${esc(GRADE_LABEL[g])}" style="flex:1;" maxlength="60">
      <button type="button" class="btn-ghost btn-small" data-grade-label-save="${g}">Enregistrer</button>
    </div>
  `).join("");
  box.querySelectorAll("[data-grade-label-save]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const g = btn.dataset.gradeLabelSave;
      const input = box.querySelector(`[data-grade-label-input="${g}"]`);
      const newLabel = input.value.trim();
      if(!newLabel) return;
      btn.disabled = true;
      try{
        const res = await fetch("/.netlify/functions/manage-labels", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ token: currentSessionToken, grade: g, label: newLabel }),
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(data.error || `${res.status}`);
        GRADE_LABEL[g] = newLabel;
        renderAll();
        toast(`✓ Libellé de ${g} mis à jour`);
      }catch(err){
        toast(`✕ Refusé : ${err.message}`);
      }finally{
        btn.disabled = false;
      }
    });
  });
}
// Couleur d'accent par grade : dégradé "échelle hiérarchique" du doré (haut gradé)
// vers le bleu-gris (stagiaire), calculé une fois au chargement.
const GRADE_COLOR = {
  WDV:"#000000", STG:"#40996c", A:"#b66339", INF:"#8c154f", M:"#1f232f",
  MP:"#64bffc", MF:"#ffffff", MLP:"#1b1b2c",
  RP:"#61b7f0", RF:"#d0d0d0", RL:"#191929",
  MC:"#95a5a6", ADD:"#e479ae", CD:"#ff4346", D:"#e74c3c", DG:"#e67e22",
};
// Certaines couleurs ci-dessus sont très sombres (WDV, M, MLP, RL) —
// un texte de badge toujours sombre y serait illisible. Calcule donc,
// pour chaque grade, s'il faut du texte clair ou sombre par-dessus,
// selon la luminance réelle de sa couleur (formule standard).
const GRADE_TEXT_COLOR = {};
Object.entries(GRADE_COLOR).forEach(([g,hex])=>{
  const r = parseInt(hex.slice(1,3),16), gr = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  const luminance = (0.299*r + 0.587*gr + 0.114*b) / 255;
  GRADE_TEXT_COLOR[g] = luminance > 0.55 ? "#04121f" : "#f5f5f5";
});

const ROLES_REF = [
  {name:"Haut Gradés", id:"1228333330865590293"},
  {name:"Averto 1", id:"1168605419149738068"},
  {name:"Averto 2", id:"1168605419149738067"},
  {name:"Averto 3", id:"1168605419149738066"},
  {name:"Employés", id:"1168614318846267492"},
];

// Liste de départ (pré-remplie depuis ta liste + grades relevés sur le tableau EMS).
// Ne sert que si le navigateur n'a encore rien en mémoire, ou après "Réinitialiser".
// Liste de départ VIDE (09/09) — plus aucune donnée d'employé réelle
// écrite en dur dans ce fichier public. Auparavant, 57 employés (nom,
// ID Discord, grade) étaient directement lisibles par n'importe qui via
// "Afficher le code source", sans connexion ni Firebase — faille
// corrigée en vidant cette liste. Le Roster se peuple désormais
// UNIQUEMENT via le cloud (voir loadState()) ou un import manuel — plus
// aucun repli automatique vers des données fictives ou réelles ici.
const SEED_EMPLOYEES = [
].map(([name,discordId,grade],i)=>({
  id:"seed-"+i, name, discordId, grade, role:"", licencie:false, licencieDate:null, idUnique:null,
}));

// ═══════════════════════════ ÉTAT + PERSISTENCE ═══════════════════════════
// (10/10, demandé) Plus de STORAGE_KEY local pour employees — le cloud
// est la seule source de vérité, voir loadState()/saveState() plus bas.

let employees = [];
// Vraie date de dernière modification du Roster (09/09) — vient
// TOUJOURS de Firebase (data.savedAt), jamais de new Date() au
// chargement de la page. Mise à jour à chaque lecture cloud ET à
// chaque écriture réussie (voir pushStateToCloudNow, refreshEmployeesFromCloud).
let rosterLastUpdatedAt = null;
function renderLastUpdated(){
  const el = document.getElementById("rosterLastUpdated");
  if(!el) return;
  const dirty = rosterEmployeesDirty ? " • ⚠ non sauvegardé" : "";
  if(!rosterLastUpdatedAt){ el.textContent = rosterEmployeesDirty ? "⚠ Modifications du Roster non sauvegardées" : ""; return; }
  const d = new Date(rosterLastUpdatedAt);
  const pad = n => String(n).padStart(2,"0");
  el.textContent = `🕐 Dernière mise à jour : ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} à ${pad(d.getHours())}:${pad(d.getMinutes())}${dirty}`;
}

async function loadState(){
  // (10/10, demandé) Plus aucun repli sur une copie locale — le cloud
  // est désormais la seule source de vérité. Le cloud n'est interrogé
  // QUE si un jeton Firebase authentifié est déjà disponible — depuis
  // que rosterEmsData.read exige une vraie connexion (09/09), un appel
  // sans jeton échouerait de toute façon.
  if(currentFirebaseIdToken){
    try{
      const res = await fetch(withFirebaseAuth(ROSTER_CLOUD_URL));
      if(res.ok){
        const data = await res.json();
        if(data && Array.isArray(data.employees) && data.employees.length){
          employees = data.employees;
          rosterLastUpdatedAt = data.savedAt || null;
          rosterEmployeesDirty = false;
          renderLastUpdated();
          return;
        }
      }
    }catch(e){ console.warn("Chargement cloud impossible :", e); }
  }
  // Rien dans le cloud (toute première utilisation) ou cloud injoignable
  // à cet instant — on part de la liste de départ, jamais d'une ancienne
  // copie locale qui pourrait avoir divergé silencieusement.
  employees = SEED_EMPLOYEES.map(e=>({...e}));
}

// (21/10) Sécurité anti-écrasement : les modifications du Roster restent
// locales jusqu'au clic explicite sur « Sauvegarder ». L'ancien envoi
// automatique pouvait pousser une liste vidée par un bug avant que la
// personne ne voie le problème. saveState() marque maintenant le Roster
// comme modifié sans écrire dans Firebase.
let _saveStateTimer = null; // conservé pour compatibilité avec les anciens tests/appels
let rosterEmployeesDirty = false;
let rosterSaveReviewOpen = false;
let rosterSaveInProgress = false;
function saveState(){
  rosterEmployeesDirty = true;
  if(_saveStateTimer){ clearTimeout(_saveStateTimer); _saveStateTimer = null; }
  renderLastUpdated();
  const statusEl=document.getElementById("saveAllStatus");
  if(statusEl && !rosterSaveInProgress){
    statusEl.innerHTML = `<span class="roster-unsaved-dot"></span>Modifications du Roster non sauvegardées`;
    statusEl.style.color = "var(--amber)";
  }
}
// Validation locale avant toute écriture réelle.
function findInvalidEmployees(){
  const GRADE_RE = /^(DG|D|CD|ADD|MC|RL|RF|RP|MLP|MP|MF|M|INF|A|WDV|STG)$/;
  const bad = [];
  employees.forEach((e,i)=>{
    const problems = [];
    if(typeof e.name !== "string" || !e.name.trim() || e.name.length>=100 || /[<>]/.test(e.name)) problems.push("nom invalide ou vide");
    if(typeof e.discordId !== "string" || !e.discordId.trim() || e.discordId.length>=30) problems.push("ID Discord vide ou invalide");
    if(typeof e.grade !== "string" || !GRADE_RE.test(e.grade)) problems.push(`grade invalide ("${e.grade}")`);
    if(problems.length) bad.push({ name: e.name || `(sans nom, position ${i})`, problems });
  });
  return bad;
}
function employeeDiffKey(e){
  if(!e) return "";
  const did=String(e.discordId||"").trim(); if(did) return `discord:${did}`;
  const uid=String(e.idUnique||"").trim(); if(uid) return `unique:${uid}`;
  const id=String(e.id||"").trim(); if(id) return `id:${id}`;
  return `name:${String(e.name||"").trim().toLowerCase()}`;
}
function matchEmployeeForDiff(source, candidates, used){
  const keys=[
    source?.discordId ? ["discordId",String(source.discordId)] : null,
    source?.idUnique ? ["idUnique",String(source.idUnique)] : null,
    source?.id ? ["id",String(source.id)] : null,
    source?.name ? ["name",String(source.name).trim().toLowerCase()] : null,
  ].filter(Boolean);
  for(let i=0;i<candidates.length;i++){
    if(used.has(i)) continue;
    const c=candidates[i];
    if(keys.some(([k,v])=> k==="name" ? String(c?.name||"").trim().toLowerCase()===v : String(c?.[k]||"")===v)) return i;
  }
  return -1;
}
function computeRosterEmployeeDiff(previousEmployees,currentEmployees){
  const prev=Array.isArray(previousEmployees)?previousEmployees:[];
  const cur=Array.isArray(currentEmployees)?currentEmployees:[];
  const used=new Set(); const added=[]; const removed=[]; const licensed=[]; const reactivated=[]; const gradeChanges=[]; const nameChanges=[]; const discordChanges=[];
  for(const oldE of prev){
    const idx=matchEmployeeForDiff(oldE,cur,used);
    if(idx<0){ removed.push(oldE); continue; }
    used.add(idx); const now=cur[idx];
    if(!oldE.licencie && !!now.licencie) licensed.push(now);
    if(!!oldE.licencie && !now.licencie) reactivated.push(now);
    if(String(oldE.grade||"")!==String(now.grade||"")) gradeChanges.push({name:now.name||oldE.name,from:oldE.grade||"?",to:now.grade||"?"});
    if(String(oldE.name||"")!==String(now.name||"")) nameChanges.push({from:oldE.name||"?",to:now.name||"?"});
    if(String(oldE.discordId||"")!==String(now.discordId||"")) discordChanges.push({name:now.name||oldE.name,from:oldE.discordId||"—",to:now.discordId||"—"});
  }
  cur.forEach((e,i)=>{ if(!used.has(i)) added.push(e); });
  const prevActive=prev.filter(e=>!e?.licencie).length, currActive=cur.filter(e=>!e?.licencie).length;
  const prevTotal=prev.length, currTotal=cur.length;
  const activeDropPct=prevActive>0 ? Math.max(0,Math.round(((prevActive-currActive)/prevActive)*1000)/10) : 0;
  const abnormal = (prevActive>=4 && currActive < prevActive*0.5) || (prevActive>=15 && currActive<=5) || (prevTotal>=4 && currTotal===0);
  return {added,removed,licensed,reactivated,gradeChanges,nameChanges,discordChanges,prevActive,currActive,prevTotal,currTotal,activeDropPct,abnormal};
}
function stableJson(value){
  if(value===null || typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stableJson(value[k])).join(",")}}`;
}
function selectedEmployeeKeysFromCurrent(){
  return employees.filter(e=>!e.licencie && specialSelected.has(e.id)).map(employeeDiffKey).sort();
}
function selectedEmployeeKeysFromCloud(data){
  return (data && Array.isArray(data.selectedEmployees)?data.selectedEmployees:[]).map(employeeDiffKey).sort();
}
function activityDisplayName(key){
  try{
    const emp=typeof resolveActiviteIdentity==="function" ? resolveActiviteIdentity(key,employees) : null;
    if(emp?.name) return emp.name;
  }catch(e){}
  const raw=String(key||""); return raw.startsWith("name:") ? raw.slice(5) : raw.startsWith("id:") ? `ID ${raw.slice(3)}` : raw || "Entrée inconnue";
}
function computeActivityChanges(remoteData,localData){
  const a=remoteData&&typeof remoteData==="object"?remoteData:{}; const b=localData&&typeof localData==="object"?localData:{};
  const keys=[...new Set([...Object.keys(a),...Object.keys(b)])];
  return keys.filter(k=>stableJson(a[k]||{})!==stableJson(b[k]||{})).map(k=>activityDisplayName(k));
}
async function fetchSaveReviewSnapshot(){
  const result={compareError:null,roster:null,selection:null,activity:null};
  try{ const r=await fetch(withFirebaseAuth(ROSTER_CLOUD_URL)); if(!r.ok) throw new Error(`Roster ${r.status}`); result.roster=await r.json(); }catch(e){ result.compareError=e.message; }
  try{ const r=await fetch(withFirebaseAuth(SPECIAL_SELECTION_CLOUD_URL)); if(r.ok) result.selection=await r.json(); }catch(e){}
  try{ const r=await fetch(withFirebaseAuth(ACTIVITE_CLOUD_URL)); if(r.ok) result.activity=await r.json(); }catch(e){}
  return result;
}
async function buildRosterSaveReview(){
  const snap=await fetchSaveReviewSnapshot();
  const previousEmployees=Array.isArray(snap.roster?.employees)?snap.roster.employees:[];
  const employeeDiff=computeRosterEmployeeDiff(previousEmployees,employees);
  const currentSel=selectedEmployeeKeysFromCurrent(), cloudSel=selectedEmployeeKeysFromCloud(snap.selection);
  const selectionChanged=stableJson(currentSel)!==stableJson(cloudSel);
  const activityChanges=computeActivityChanges(snap.activity?.data||{},activiteData||{});
  const hasRosterChanges=employeeDiff.added.length||employeeDiff.removed.length||employeeDiff.licensed.length||employeeDiff.reactivated.length||employeeDiff.gradeChanges.length||employeeDiff.nameChanges.length||employeeDiff.discordChanges.length;
  const hasChanges=!!(hasRosterChanges||selectionChanged||activityChanges.length||activiteDirty);
  return {snap,employeeDiff,selectionChanged,currentSelectionCount:currentSel.length,cloudSelectionCount:cloudSel.length,activityChanges,hasRosterChanges:!!hasRosterChanges,hasChanges,compareError:snap.compareError,previousSavedAt:snap.roster?.savedAt||null};
}
function saveReviewList(title,items,formatter){
  const safe=Array.isArray(items)?items:[];
  return `<div class="save-review-section"><h3>${esc(title)} <span style="color:var(--text-faint);font-weight:700;">(${safe.length})</span></h3>${safe.length?`<ul class="save-review-list">${safe.map(x=>`<li>${formatter(x)}</li>`).join("")}</ul>`:`<div class="save-review-empty">Aucun changement</div>`}</div>`;
}
function showRosterSaveReview(review){
  return new Promise(resolve=>{
    const overlay=document.getElementById("rosterSaveReviewOverlay"), content=document.getElementById("rosterSaveReviewContent"), counts=document.getElementById("rosterSaveReviewCounts"), dangerText=document.getElementById("rosterSaveReviewDangerText"), compareErr=document.getElementById("rosterSaveReviewCompareError"), ack=document.getElementById("rosterSaveReviewRiskAck"), confirmBtn=document.getElementById("rosterSaveReviewConfirm"), cancelBtn=document.getElementById("rosterSaveReviewCancel");
    const d=review.employeeDiff; const risk=!!(d.abnormal||review.compareError);
    overlay.dataset.risk=risk?"high":"normal"; ack.checked=false; confirmBtn.disabled=risk;
    counts.innerHTML=`<div class="save-review-count">Employés avant<b>${d.prevActive}</b></div><div class="save-review-count">Employés maintenant<b>${d.currActive}</b></div><div class="save-review-count">Total fiches avant<b>${d.prevTotal}</b></div><div class="save-review-count">Total fiches maintenant<b>${d.currTotal}</b></div>`;
    dangerText.textContent=review.compareError?`Impossible de charger correctement la version précédente (${review.compareError}). La comparaison n'est donc pas garantie.`:`Le nombre d'employés actifs chute de ${d.activeDropPct}% (${d.prevActive} → ${d.currActive}). Vérifie impérativement la liste avant de confirmer.`;
    compareErr.hidden=!review.compareError; compareErr.textContent=review.compareError?`⚠ Comparaison partielle : ${review.compareError}`:"";
    const rosterHtml=`<div class="save-review-grid">${saveReviewList("➕ Nouveaux employés",d.added,x=>esc(x.name||"Sans nom"))}${saveReviewList("🚪 Employés licenciés",d.licensed,x=>esc(x.name||"Sans nom"))}${saveReviewList("⬆️ Changements de grade",d.gradeChanges,x=>`${esc(x.name)} : <b>${esc(x.from)}</b> → <b>${esc(x.to)}</b>`)}${saveReviewList("🗑️ Fiches supprimées",d.removed,x=>esc(x.name||"Sans nom"))}</div>`;
    const extras=[];
    if(d.reactivated.length) extras.push(saveReviewList("↩️ Réactivations",d.reactivated,x=>esc(x.name||"Sans nom")));
    if(d.nameChanges.length) extras.push(saveReviewList("✏️ Changements de nom",d.nameChanges,x=>`${esc(x.from)} → ${esc(x.to)}`));
    if(d.discordChanges.length) extras.push(saveReviewList("🆔 Changements d'ID Discord",d.discordChanges,x=>`${esc(x.name)} : ${esc(x.from)} → ${esc(x.to)}`));
    const other=[];
    if(review.selectionChanged) other.push(`<li>Formation Opération : <b>${review.cloudSelectionCount}</b> → <b>${review.currentSelectionCount}</b> sélectionné(s)</li>`);
    if(review.activityChanges.length) other.push(`<li>Suivi d'activité modifié pour <b>${review.activityChanges.length}</b> membre(s) : ${review.activityChanges.slice(0,8).map(esc).join(", ")}${review.activityChanges.length>8?` (+${review.activityChanges.length-8})`:""}</li>`);
    content.innerHTML=rosterHtml+extras.join("")+`<div class="save-review-section"><h3>📦 Autres données du bouton Sauvegarder</h3>${other.length?`<ul class="save-review-list">${other.join("")}</ul>`:`<div class="save-review-empty">Sélection Formation Opération et suivi d'activité identiques à la dernière version cloud.</div>`}</div>`;
    rosterSaveReviewOpen=true; overlay.hidden=false; document.getElementById("rosterSaveReviewTitle")?.focus({preventScroll:true});
    const cleanup=(value)=>{ rosterSaveReviewOpen=false; overlay.hidden=true; ack.onchange=null; confirmBtn.onclick=null; cancelBtn.onclick=null; resolve(value); };
    ack.onchange=()=>{ confirmBtn.disabled=risk&&!ack.checked; };
    confirmBtn.onclick=()=>cleanup(true); cancelBtn.onclick=()=>cleanup(false);
  });
}
async function pushRosterSnapshotConfirmed(review){
  if(!hasCap("manage_roster")) return {skipped:true};
  const invalid=findInvalidEmployees();
  if(invalid.length){ const detail=invalid.slice(0,5).map(b=>`${b.name} (${b.problems.join(", ")})`).join(" ; "); throw new Error(`Sauvegarde Roster bloquée : ${invalid.length} fiche(s) invalide(s) — ${detail}`); }
  const data = await protectedAction("replaceRosterSnapshot", {employees, expectedSavedAt: review.previousSavedAt ?? null});
  rosterLastUpdatedAt=data.savedAt||Date.now(); rosterEmployeesDirty=false; renderLastUpdated();
  return data;
}

// Compatibilité : si un ancien appel direct tente encore d'envoyer le Roster,
// il est volontairement refusé et renvoyé vers le bouton avec confirmation.
async function pushStateToCloudNow(){
  _saveStateTimer=null;
  rosterEmployeesDirty=true; renderLastUpdated();
  toast("⚠ Sauvegarde automatique du Roster bloquée par sécurité — utilise le bouton « Sauvegarder » pour vérifier les changements.");
  return {blocked:true};
}
function autoSaveOnLeave(){ /* volontairement aucune écriture silencieuse */ }
window.addEventListener("beforeunload",(event)=>{ if(rosterEmployeesDirty){ event.preventDefault(); event.returnValue=""; } });

function uid(){ return "emp-"+Date.now()+"-"+Math.random().toString(36).slice(2,7); }

// ═══════════════════════════ HISTORIQUE DES CHANGEMENTS ═══════════════════════════
// Persisté (comme la liste elle-même) — contrairement au petit "toast" qui
// disparaît en 1.6s, ça reste consultable même après avoir fermé et
// rouvert la page. Limité aux 300 dernières entrées pour ne pas grossir
// indéfiniment.
const HISTORY_KEY = "emsRosterHistoryV1";
let history = [];

function loadHistory(){
  try{
    const raw = localStorage.getItem(HISTORY_KEY);
    history = raw ? JSON.parse(raw) : [];
  }catch(e){ history = []; }
}
function logHistory(action, name, detail){
  history.unshift({ when: new Date().toLocaleString("fr-FR"), action, name, detail: detail||"" });
  if(history.length > 300) history = history.slice(0, 300);
  try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
  catch(e){ console.warn("Sauvegarde historique impossible :", e); }
}

// ═══════════════════════════ UTILITAIRES ═══════════════════════════

function esc(s){
  return String(s??"").replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function norm(s){
  return String(s??"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
}
// (19/10, demandé) Anciens noms (mariage, wipe, bug de jeu...) — un
// employé peut avoir plusieurs noms connus en plus du nom actuel
// (e.aliases, tableau de chaînes). Partout où le Roster reconnaît
// quelqu'un par son nom (import du tableau EMS, recherche, absences),
// cette fonction vérifie le nom actuel ET tous les anciens noms — donc
// peu importe lequel des deux apparaît, c'est la même fiche.
function employeeNameMatches(e, normalizedName){
  if(norm(e.name) === normalizedName) return true;
  return (e.aliases||[]).some(a => norm(a) === normalizedName);
}
// Audit gestion des employés (29/09) ------------------------------------
// Les règles Firebase refusent tout le roster si UN seul nom contient < ou >
// ou dépasse 100 caractères, ou si un ID Discord dépasse 30 caractères. Sans
// contrôle ici, l'erreur n'apparaissait qu'au moment de sauvegarder dans le
// cloud, avec un message cryptique, et bloquait tout le monde. On vérifie
// donc AVANT d'ajouter/modifier.
function validateEmployeeFields(name, discordId){
  if(!name) return "Le nom est obligatoire.";
  if(/[<>]/.test(name)) return "Le nom ne peut pas contenir les caractères < ou >.";
  if(name.length >= 100) return "Le nom est trop long (100 caractères maximum).";
  if(!discordId) return "L'ID Discord est obligatoire.";
  if(discordId.length >= 30) return "L'ID Discord est trop long (30 caractères maximum).";
  return null;
}
// Cherche un employé (non licencié) déjà présent avec le même nom (sans
// accents ni majuscules) ou le même ID Discord. exceptId = la personne
// qu'on est en train de modifier (elle ne compte pas comme doublon d'elle-même).
function findDuplicateEmployee(name, discordId, exceptId){
  const n = norm(name).trim();
  for(const e of employees){
    if(e.licencie || e.id===exceptId) continue;
    if(norm(e.name).trim()===n) return { employee:e, why:"le même nom" };
    if(discordId && String(e.discordId).trim()===String(discordId).trim()) return { employee:e, why:"le même ID Discord" };
  }
  return null;
}

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(()=>t.classList.remove("show"), 1600);
}
function copyToClipboard(text, label){
  const msg = label || (text.length > 60 ? "Copié" : "ID copié : "+text);
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(()=>toast(msg)).catch(()=>fallbackCopy(text, msg));
  } else fallbackCopy(text, msg);
}
function fallbackCopy(text, msg){
  const ta = document.createElement("textarea");
  ta.value = text; document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); toast(msg || "Copié"); }catch(e){ toast("Impossible de copier"); }
  ta.remove();
}

// Sections repliées mémorisées pendant la session (pas besoin de persister).
const collapsedGrades = new Set();
let licenciesCollapsed = true;

// ═══════════════════════════ SÉLECTION FORMATION / OPÉRATION ═══════════════════════════
const SPECIAL_SELECTION_KEY = "emsSpecialSelectionV1";
const SPECIAL_SELECTION_CLOUD_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsSpecialSelection.json";
// Chemin utilisé par le Pillbox Terminal (étape 3.5 "Formation Opération")
// pour sauvegarder sa liste de noms/ID uniques ayant la formation — permet
// de charger cette même liste ici en un clic plutôt que de la recopier.
const FORMATION_CLOUD_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/formationOperationList.json";
let specialSelected = new Set();

function loadSpecialSelection(){
  try{
    const raw = localStorage.getItem(SPECIAL_SELECTION_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    specialSelected = new Set(Array.isArray(ids) ? ids : []);
  }catch(e){ specialSelected = new Set(); }
}
function saveSpecialSelection(){
  try{ localStorage.setItem(SPECIAL_SELECTION_KEY, JSON.stringify([...specialSelected])); }catch(e){}
}
function pruneSpecialSelection(){
  const valid = new Set(employees.filter(e=>!e.licencie).map(e=>e.id));
  specialSelected = new Set([...specialSelected].filter(id=>valid.has(id)));
  saveSpecialSelection();
}
function getSpecialVisibleEmployees(){
  const input = document.getElementById("specialSearch");
  const q = norm(input ? input.value : "");
  return employees.filter(e=>!e.licencie).filter(e=>{
    if(!q) return true;
    return norm(e.name).includes(q) || (e.aliases||[]).some(a=>norm(a).includes(q)) || norm(e.grade).includes(q) || norm(e.discordId).includes(q) || norm(e.idUnique||"").includes(q);
  }).sort((a,b)=>{
    const ga = GRADE_ORDER.indexOf(a.grade), gb = GRADE_ORDER.indexOf(b.grade);
    return ga-gb || a.name.localeCompare(b.name, "fr");
  });
}
function renderSpecialSelection(){
  const box = document.getElementById("specialList");
  const count = document.getElementById("specialSelectedCount");
  if(!box || !count) return;
  pruneSpecialSelection();
  const list = getSpecialVisibleEmployees();
  count.textContent = specialSelected.size;
  box.innerHTML = list.length ? list.map(e=>`
    <label class="special-row">
      <input type="checkbox" data-special-id="${esc(e.id)}" ${specialSelected.has(e.id)?"checked":""}>
      <span><b>${esc(e.name)}</b><br><span style="color:var(--text-faint);">${esc(e.grade)} — ${esc(GRADE_LABEL[e.grade]||e.grade)}</span></span>
      <span class="special-id special-discord" title="ID Discord">Discord : ${esc(e.discordId||"—")}</span>
      <span class="special-id special-unique ${e.idUnique?'':'missing'}" title="ID unique EMS">${e.idUnique ? "Unique : "+esc(e.idUnique) : "ID unique non renseigné"}</span>
      <span style="color:var(--text-faint);font-size:.7rem;">${e.role?esc(e.role):""}</span>
    </label>
  `).join("") : `<div class="empty-msg" style="padding:12px;">Aucun employé pour ce filtre.</div>`;
  box.querySelectorAll("[data-special-id]").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      const id = cb.getAttribute("data-special-id");
      cb.checked ? specialSelected.add(id) : specialSelected.delete(id);
      saveSpecialSelection();
      count.textContent = specialSelected.size;
    });
  });
}
function buildSpecialSelectionList(){
  const format = document.querySelector('input[name="specialCopyFormat"]:checked')?.value || "nameDiscord";
  const selected = employees.filter(e=>!e.licencie && specialSelected.has(e.id));
  const lines = [];
  selected.forEach(e=>{
    if(format === "name") lines.push(e.name);
    else if(format === "unique") { if(e.idUnique) lines.push(String(e.idUnique)); }
    else if(format === "nameUnique") { if(e.idUnique) lines.push(`${e.name} : ${e.idUnique}`); }
    else lines.push(`${e.name} : ${e.discordId}`);
  });
  return {text:lines.join("\n"), selectedCount:selected.length, outputCount:lines.length, format};
}

// ── Coller une liste (grade + nom, ou nom seul) pour cocher/décocher
// d'un coup la sélection Formation/Opération, sans avoir à chercher et
// cliquer chaque personne une par une. Le grade est optionnel — s'il est
// présent (en tête ou en fin de ligne), il sert juste à départager un
// homonyme entre deux grades différents ; sinon on matche sur le nom seul.
function parseGradeNameList(text){
  const lines = (text||"").split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  return lines.map(line=>{
    const cleanTok = t => t.toUpperCase().replace(/[\[\]]/g,"").replace(/[:.,;-]+$/,"").replace(/^[:.,;-]+/,"");
    let tokens = line.split(/\s+/).filter(Boolean);
    let grade = null;
    if(tokens.length > 1 && GRADE_ORDER.includes(cleanTok(tokens[0]))){
      grade = cleanTok(tokens[0]);
      tokens = tokens.slice(1);
    } else if(tokens.length > 1 && GRADE_ORDER.includes(cleanTok(tokens[tokens.length-1]))){
      grade = cleanTok(tokens[tokens.length-1]);
      tokens = tokens.slice(0, -1);
    }
    const name = cleanEmsName(tokens.join(" "));
    return {raw:line, grade, name};
  }).filter(e=>e.name);
}

function matchEmployeeForSpecialList(entry){
  const candidates = employees.filter(e=>!e.licencie && norm(e.name)===norm(entry.name));
  if(!candidates.length) return null;
  if(entry.grade){
    const exact = candidates.find(e=>e.grade===entry.grade);
    if(exact) return exact;
  }
  return candidates[0];
}

// Le Pillbox Terminal accepte 3 formats par ligne pour sa liste Formation
// Opération : "Nom", "ID unique" seul, ou "Nom : ID unique". On matche
// donc d'abord par ID unique si présent, sinon par nom.
function parseFormationCloudLine(line){
  const trimmed = (line||"").trim();
  if(!trimmed) return null;
  if(trimmed.includes(":")){
    const idx = trimmed.indexOf(":");
    const namePart = cleanEmsName(trimmed.slice(0, idx).trim());
    const idPart = trimmed.slice(idx+1).trim();
    return {raw:line, name: namePart || null, idUnique: idPart || null};
  }
  if(/^\d+$/.test(trimmed)) return {raw:line, name:null, idUnique:trimmed};
  return {raw:line, name: cleanEmsName(trimmed) || null, idUnique:null};
}
function matchEmployeeForFormationCloud(entry){
  if(entry.idUnique){
    const byId = employees.find(e=>!e.licencie && e.idUnique && String(e.idUnique)===String(entry.idUnique));
    if(byId) return byId;
  }
  if(entry.name){
    const byName = employees.find(e=>!e.licencie && norm(e.name)===norm(entry.name));
    if(byName) return byName;
  }
  return null;
}
async function loadFormationFromCloudIntoSelection(silent){
  const statusEl = document.getElementById("specialImportStatus");
  const btn = document.getElementById("btnSpecialFormationCloudLoad");
  if(btn){ btn.disabled = true; }
  if(statusEl && !silent){ statusEl.textContent = "Chargement depuis le cloud…"; statusEl.style.color = "var(--text-dim)"; }
  try{
    const res = await fetch(withFirebaseAuth(FORMATION_CLOUD_URL));
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    if(!data || !data.text){
      if(statusEl && !silent){ statusEl.textContent = "Aucune liste Formation Opération trouvée dans le cloud."; statusEl.style.color = "var(--amber)"; }
      if(!silent) toast("Aucune liste cloud trouvée");
      return;
    }
    const entries = data.text.split(/\r?\n/).map(parseFormationCloudLine).filter(Boolean);
    let matched = 0; const notFound = [];
    entries.forEach(entry=>{
      const emp = matchEmployeeForFormationCloud(entry);
      if(!emp){ notFound.push(entry.raw.trim()); return; }
      matched++; specialSelected.add(emp.id);
    });
    saveSpecialSelection(); renderSpecialSelection();
    const when = data.savedAt ? new Date(data.savedAt).toLocaleString('fr-FR') : "";
    let msg = `✓ ${matched}/${entries.length} cochée(s) depuis le cloud${when?` (sauvegardée le ${when})`:""}.`;
    if(notFound.length) msg += ` Introuvable(s) : ${notFound.slice(0,5).join(", ")}${notFound.length>5?"…":""}`;
    if(statusEl && !silent){ statusEl.textContent = msg; statusEl.style.color = notFound.length ? "var(--amber)" : "var(--text-dim)"; }
    if(!silent) toast(`${matched}/${entries.length} cochée(s) (cloud)`);
  }catch(err){
    console.error(err);
    if(statusEl && !silent){ statusEl.textContent = `✕ Échec du chargement cloud : ${err.message}`; statusEl.style.color = "var(--red)"; }
    if(!silent) toast(`✕ Échec cloud : ${err.message}`);
  }finally{
    if(btn){ btn.disabled = false; }
  }
}

// ── Envoi de la sélection Formation/Opération VERS Pillbox (sens inverse
// du chargement ci-dessus) — même principe que "Envoyer vers Pillbox" pour
// les ID Discord : on écrit sur formationOperationList, que Pillbox relit
// avec son bouton "Charger depuis le cloud" (section Formation Opération).
// Format envoyé : "Nom : ID unique" quand l'ID unique est renseigné, sinon
// juste "Nom" — c'est ce que Pillbox matche en priorité (son champ
// `employee.id` correspond à l'ID unique, pas à l'ID Discord).
function buildFormationSendList(){
  const selected = employees.filter(e=>!e.licencie && specialSelected.has(e.id));
  const lines = selected.map(e=> e.idUnique ? `${e.name} : ${e.idUnique}` : e.name);
  return {text: lines.join("\n"), count: lines.length};
}

// (btnSpecialFormationCloudSend retiré le 09/09 — remplacé par le
// bouton unique "🔄 Synchroniser avec Pillbox".)

function applySpecialListAction(check){
  const textarea = document.getElementById("specialImportText");
  const statusEl = document.getElementById("specialImportStatus");
  const entries = parseGradeNameList(textarea ? textarea.value : "");
  if(!entries.length){
    if(statusEl){ statusEl.textContent = "Rien à traiter — colle d'abord une liste."; statusEl.style.color = "var(--amber)"; }
    return;
  }
  let matched = 0;
  const notFound = [];
  entries.forEach(entry=>{
    const emp = matchEmployeeForSpecialList(entry);
    if(!emp){ notFound.push(entry.raw); return; }
    matched++;
    if(check) specialSelected.add(emp.id); else specialSelected.delete(emp.id);
  });
  saveSpecialSelection();
  renderSpecialSelection();
  const verb = check ? "cochée(s)" : "décochée(s)";
  let msg = `✓ ${matched}/${entries.length} ${verb}.`;
  if(notFound.length) msg += ` Introuvable(s) : ${notFound.slice(0,5).join(", ")}${notFound.length>5?"…":""}`;
  if(statusEl){ statusEl.textContent = msg; statusEl.style.color = notFound.length ? "var(--amber)" : "var(--text-dim)"; }
  toast(`${matched}/${entries.length} ${verb}`);
}

// ═══════════════════════════ RENDU ═══════════════════════════

function populateGradeSelects(){
  const selects = [document.getElementById("newGrade"), document.getElementById("filterGrade")];
  const newGradeSel = document.getElementById("newGrade");
  newGradeSel.innerHTML = GRADE_ORDER.map(g=>`<option value="${g}">${g} — ${esc(GRADE_LABEL[g])}</option>`).join("");
  const filterSel = document.getElementById("filterGrade");
  const keepValue = filterSel.value;
  filterSel.innerHTML = `<option value="">Tous les grades</option>` +
    GRADE_ORDER.map(g=>`<option value="${g}">${g} — ${esc(GRADE_LABEL[g])}</option>`).join("");
  filterSel.value = keepValue;

  const newRoleSel = document.getElementById("newRole");
  newRoleSel.innerHTML = `<option value="">— rôle (optionnel) —</option>` +
    ROLES_REF.map(r=>`<option value="${esc(r.name)}">${esc(r.name)}</option>`).join("");
}

function renderRoles(){
  const grid = document.getElementById("rolesGrid");
  grid.innerHTML = ROLES_REF.map(r=>`
    <div class="role-chip">
      <span class="name">${esc(r.name)}</span>
      <code>${esc(r.id)}</code>
      <button class="btn-ghost btn-small" data-copy-role="${esc(r.id)}">Copier</button>
    </div>
  `).join("");
  grid.querySelectorAll("[data-copy-role]").forEach(btn=>{
    btn.addEventListener("click", ()=>copyToClipboard(btn.getAttribute("data-copy-role")));
  });
}

function matchesFilter(e, query, gradeFilter){
  if(gradeFilter && e.grade !== gradeFilter) return false;
  if(!query) return true;
  const q = norm(query);
  return norm(e.name).includes(q) || (e.aliases||[]).some(a=>norm(a).includes(q)) || String(e.discordId||"").includes(query.trim()) || norm(e.grade).includes(q);
}

// Repère les ID Discord utilisés par plusieurs employés actifs à la fois
// — facile à rater à l'œil dans une longue liste, mais ça veut souvent
// dire une erreur de saisie (copié-collé du mauvais ID, faute de frappe).
// Ne regarde que les actifs : deux personnes différentes ne devraient
// jamais partager un ID, licencié ou pas, mais on se concentre sur ce
// qui compte vraiment au quotidien.
function findDuplicateDiscordIds(){
  const byId = {};
  employees.filter(e=>!e.licencie).forEach(e=>{
    if(!e.discordId) return;
    (byId[e.discordId] = byId[e.discordId] || []).push(e);
  });
  return Object.entries(byId).filter(([id, list]) => list.length > 1);
}

function renderDuplicatesWarning(){
  const box = document.getElementById("duplicatesWarning");
  const dups = findDuplicateDiscordIds();
  if(!dups.length){ box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = `
    <div class="card" style="border-color:var(--red);background:linear-gradient(180deg, rgba(248,113,113,0.10), var(--panel-2));">
      <div style="font-weight:700;color:var(--red);margin-bottom:8px;">⚠️ ${dups.length} ID Discord partagé(s) par plusieurs employés — probable erreur de saisie :</div>
      ${dups.map(([id, list])=>`
        <div style="font-size:0.82rem;margin-bottom:4px;">
          <code style="color:var(--text-dim);">${esc(id)}</code> → ${list.map(e=>esc(e.name)).join(", ")}
        </div>
      `).join("")}
    </div>
  `;
}

// (16/10) Affiche tout de suite — avant même d'essayer de sauvegarder —
// les fiches qui bloqueront TOUTE sauvegarde du roster si rien n'est
// corrigé (nom/ID Discord/grade manquant ou invalide). Sans ça, le
// blocage n'était découvert qu'au moment d'un "Enregistrer" sans
// rapport, avec un message qui ne disait pas laquelle était en cause.
function renderInvalidEmployeesWarning(){
  const box = document.getElementById("invalidEmployeesWarning");
  const bad = findInvalidEmployees();
  if(!bad.length){ box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = `
    <div class="card" style="border-color:var(--red);background:linear-gradient(180deg, rgba(248,113,113,0.10), var(--panel-2));">
      <div style="font-weight:700;color:var(--red);margin-bottom:8px;">⚠️ ${bad.length} fiche(s) invalide(s) — bloque(nt) TOUTE sauvegarde du roster tant que ce n'est pas corrigé, même pour quelqu'un d'autre :</div>
      ${bad.map(b=>`
        <div style="font-size:0.82rem;margin-bottom:4px;">
          <b>${esc(b.name)}</b> — ${esc(b.problems.join(", "))}
        </div>
      `).join("")}
    </div>
  `;
}

function renderAll(){
  populateForceLogoutSelect();
  const query = document.getElementById("searchInput").value;
  const gradeFilter = document.getElementById("filterGrade").value;

  const actifs = employees.filter(e=>!e.licencie);
  const licencies = employees.filter(e=>e.licencie);

  document.getElementById("statActifs").textContent = actifs.length;
  document.getElementById("statLicencies").textContent = licencies.length;
  renderDuplicatesWarning();
  renderInvalidEmployeesWarning();

  // ---- Sections par grade ----
  const container = document.getElementById("gradeSections");
  container.innerHTML = "";
  GRADE_ORDER.forEach(grade=>{
    // (03/10) Tri alphabétique par prénom au sein de chaque grade (les noms
    // sont stockés "Prénom Nom", donc trier la chaîne entière trie bien par
    // prénom d'abord) — avant, la liste gardait l'ordre du tableau EMS collé,
    // ce qui donnait un classement qui semblait aléatoire.
    const list = actifs.filter(e=>e.grade===grade && matchesFilter(e, query, gradeFilter))
      .sort((a,b)=> a.name.localeCompare(b.name, "fr"));
    const totalInGrade = actifs.filter(e=>e.grade===grade).length;
    if(totalInGrade===0) return; // pas de section pour un grade totalement vide
    if(gradeFilter && gradeFilter!==grade) return;

    const section = document.createElement("div");
    section.className = "grade-section" + (collapsedGrades.has(grade) ? " collapsed" : "");
    section.style.setProperty("--grade-color", GRADE_COLOR[grade]);
    section.style.setProperty("--grade-text-color", GRADE_TEXT_COLOR[grade]);
    section.innerHTML = `
      <div class="grade-head" data-toggle-grade="${grade}">
        <span class="grade-badge">${grade}</span>
        <span class="label">${esc(GRADE_LABEL[grade])}</span>
        <span class="count">${list.length}/${totalInGrade}</span>
        <span class="chev">▾</span>
      </div>
      <div class="grade-body">
        ${list.length ? list.map(e=>empRowHtml(e)).join("") : `<div class="empty-msg">Aucun résultat dans ce grade pour ce filtre.</div>`}
      </div>
    `;
    container.appendChild(section);
  });

  // ---- Licenciés ----
  const licenciesFiltered = licencies.filter(e=>matchesFilter(e, query, gradeFilter));
  document.getElementById("licenciesCount").textContent = `${licenciesFiltered.length}/${licencies.length}`;
  document.getElementById("licenciesBody").innerHTML = licenciesFiltered.length
    ? licenciesFiltered.map(e=>empRowHtml(e, true)).join("")
    : `<div class="empty-msg">Aucun licencié${query||gradeFilter? " pour ce filtre":""}.</div>`;
  document.getElementById("licenciesCard").classList.toggle("collapsed", licenciesCollapsed);
  document.getElementById("licenciesBody").style.display = licenciesCollapsed ? "none" : "";
  document.querySelector("#licenciesCard .chev").style.transform = licenciesCollapsed ? "rotate(-90deg)" : "none";

  attachRowHandlers();
  renderSpecialSelection();
}

function empRowHtml(e, isLicencie){
  const roleTag = e.role ? `<span class="emp-role-tag">${esc(e.role)}</span>` : "";
  const licDate = isLicencie && e.licencieDate ? `<span class="licencie-date">le ${esc(e.licencieDate)}</span>` : "";
  // Modifier/Licencier/Réintégrer restent réservés à ADD et au-dessus —
  // masqués ici pour un MC (juste le confort visuel, la vraie
  // protection reste côté serveur dans protected-write.js).
  const canManageRoster = hasCap("manage_roster");
  const canViewHistory = hasCap("view_logs");
  const historyBtn = canViewHistory ? `<button class="btn-ghost btn-small" data-view-history="${esc(e.name)}" title="Voir l'historique de cette personne">🕘</button>` : "";
  const actionsHtml = !canManageRoster ? historyBtn : (isLicencie
    ? `${historyBtn}<button class="btn-ghost btn-small" data-reintegrer="${e.id}">Réintégrer</button>`
    : `${historyBtn}<button class="btn-ghost btn-small" data-edit="${e.id}">Modifier</button>
       <button class="btn-danger btn-small" data-licencier="${e.id}">Licencier</button>`);
  return `
    <div class="emp-row ${isLicencie?'licencie':''}" data-id="${e.id}">
      <span class="emp-name">${esc(e.name)}</span>
      <span class="emp-id" data-copy-id="${esc(e.discordId)}" title="Copier l'ID Discord">${esc(e.discordId)}</span>
      ${roleTag}
      ${licDate}
      <span class="emp-actions">
        ${actionsHtml}
      </span>
    </div>
    <div class="edit-slot" data-edit-slot="${e.id}"></div>
  `;
}

function editRowHtml(e){
  return `
    <div class="edit-row">
      <select data-edit-grade="${e.id}">
        ${GRADE_ORDER.map(g=>`<option value="${g}" ${g===e.grade?'selected':''}>${g} — ${esc(GRADE_LABEL[g])}</option>`).join("")}
      </select>
      <select data-edit-role="${e.id}">
        <option value="">— rôle (aucun) —</option>
        ${ROLES_REF.map(r=>`<option value="${esc(r.name)}" ${r.name===e.role?'selected':''}>${esc(r.name)}</option>`).join("")}
      </select>
      <input type="text" data-edit-name="${e.id}" value="${esc(e.name)}" style="min-width:140px;">
      <input type="text" data-edit-discord="${e.id}" value="${esc(e.discordId)}" style="min-width:160px;">
      <input type="text" data-edit-aliases="${e.id}" value="${esc((e.aliases||[]).join(", "))}" placeholder="Anciens noms (mariage, wipe...), séparés par des virgules" title="Anciens noms de cette personne — permet au Roster de la reconnaître sous son ancien nom ET son nouveau (import du tableau EMS, recherche)." style="min-width:220px;">
      <button class="btn-primary btn-small" data-save="${e.id}">Enregistrer</button>
      <button class="btn-ghost btn-small" data-cancel="${e.id}">Annuler</button>
      ${["OWNER","DG","D"].includes(currentUserLevel) && e.discordId ? `
      <button class="btn-ghost btn-small" data-lock-anim="${esc(e.discordId)}" title="Désactive ses animations de sauvegarde/synchro de force — elle ne pourra plus les réactiver elle-même tant que tu n'auras pas levé ce verrou (Roster + Pillbox).">🔒 Bloquer ses animations</button>
      <button class="btn-ghost btn-small" data-unlock-anim="${esc(e.discordId)}" title="Redonne à cette personne le contrôle de ses propres animations.">🔓 Débloquer</button>
      ` : ""}
      ${currentUserLevel === "OWNER" && e.discordId && hasAnimationPortraitPair(e.discordId) ? `
      <span style="font-size:.76rem;color:var(--text-dim);font-weight:800;">🎨 Style animation :</span>
      <button class="btn-small ${configuredAnimationPortraitStyle(e.discordId)==="illustration"?"btn-primary":"btn-ghost"}" data-set-anim-style="${esc(e.discordId)}" data-anim-style="illustration" title="Force ses scènes Roster + Pillbox en portraits dessin IA. Le collègue reste tiré au sort mais utilise le même style.">🖌️ Dessin IA</button>
      <button class="btn-small ${configuredAnimationPortraitStyle(e.discordId)==="real"?"btn-primary":"btn-ghost"}" data-set-anim-style="${esc(e.discordId)}" data-anim-style="real" title="Force ses scènes Roster + Pillbox en portraits RP détourés. Le collègue reste tiré au sort mais utilise le même style.">🎭 Personnage RP</button>
      ` : ""}
    </div>
  `;
}

// ═══════════════════════════ IMPORT DEPUIS LE TABLEAU EMS ═══════════════════════════

// Nettoie le nom "Employé" du tableau EMS : retire l'étiquette "[XXX] " devant
// le nom, et retire les emoji/symboles collés en fin de nom (ex: "Papy Alucard
// Saotome 🐧") en ne gardant que les mots contenant au moins une lettre.
function cleanEmsName(employeRaw){
  let name = (employeRaw||"").replace(/^\[[^\]]*\]\s*/, "").trim();
  name = name.split(/\s+/).filter(tok => /\p{L}/u.test(tok)).join(" ");
  return name;
}

// Découpe une ligne du tableau EMS collé. Le tableau est normalement séparé
// par des tabulations (copié depuis le site) ; si jamais moins de 4 colonnes
// ressortent, on retente avec un séparateur "2+ espaces" par prudence.
function splitEmsLine(line){
  let cols = line.split("\t");
  if(cols.length < 4) cols = line.split(/\s{2,}/);
  return cols;
}

// Analyse le texte collé et classe chaque ligne : nouveaux employés (à
// ajouter, en demandant leur ID Discord), WDV, déjà connus (par nom,
// qu'ils soient actifs ou licenciés), grades non reconnus — et maintenant
// aussi deux cas détectés automatiquement pour les employés déjà dans le
// roster : un grade différent de celui stocké (= UP à appliquer), et un
// grade WDV sur quelqu'un d'actif (= licenciement à appliquer).
function parseEmsTableForImport(text){
  const lines = (text||"").split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const found = [], skippedWdv = [], alreadyKnown = [], unrecognized = [], toPromote = [], toLicencier = [], ambiguous = [];
  const seenIds = new Set(); // employés retrouvés dans ce collage précis, peu importe la raison

  lines.forEach(line=>{
    const cols = splitEmsLine(line);
    if(cols.length < 4) return;
    const employeRaw = (cols[1]||"").trim();
    const idUnique = (cols[2]||"").trim();
    const gradeRaw = (cols[3]||"").trim().toUpperCase();
    // Date d'arrivée (29/09) : format "25/09/2026 - 14:13" (année sur 4
    // chiffres + heure), ce qui la distingue de la colonne de date d'UP
    // ("10/05/26"). Sert uniquement à l'avertissement de départ rapide.
    const arrivalMatch = [...line.matchAll(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})/g)].pop();
    const arrivalMs = arrivalMatch ? new Date(+arrivalMatch[3], +arrivalMatch[2]-1, +arrivalMatch[1], +arrivalMatch[4], +arrivalMatch[5]).getTime() : null;
    if(!employeRaw || /^employ/i.test(employeRaw) || gradeRaw === "GRADE") return; // en-tête du tableau

    const name = cleanEmsName(employeRaw);
    if(!name) return;

    // Audit statistiques (29/09) : avant, la personne n'était retrouvée que
    // par son nom — deux homonymes pouvaient donc être confondus (mauvaise
    // personne licenciée ou promue). Désormais : ID unique d'abord ; sinon le
    // nom, mais seulement s'il désigne UNE personne sans ID unique différent.
    const byId = idUnique ? employees.find(e=>e.idUnique && String(e.idUnique)===String(idUnique)) : null;
    const nameMatches = employees.filter(e=>employeeNameMatches(e,norm(name)) && !(e.idUnique && idUnique && String(e.idUnique)!==String(idUnique)));
    const existing = byId || (nameMatches.length===1 ? nameMatches[0] : null);
    if(!byId && nameMatches.length>1){
      // Homonymes impossibles à départager : on n'applique RIEN automatiquement.
      nameMatches.forEach(e=>seenIds.add(e.id));
      ambiguous.push(name);
      return;
    }
    if(existing) seenIds.add(existing.id);

    if(gradeRaw === "WDV"){
      if(existing && !existing.licencie){ toLicencier.push({id:existing.id, name:existing.name, discordId:existing.discordId, arrivalMs}); }
      else if(!existing){ skippedWdv.push(name); }
      return;
    }
    if(!GRADE_ORDER.includes(gradeRaw)){ unrecognized.push({name, grade:gradeRaw}); return; }

    if(existing){
      if(!existing.licencie && existing.grade !== gradeRaw){
        toPromote.push({id:existing.id, name:existing.name, oldGrade:existing.grade, newGrade:gradeRaw});
      } else {
        alreadyKnown.push(name);
      }
      return;
    }
    if(found.some(f=>norm(f.name)===norm(name))) return; // doublon dans le collage lui-même

    found.push({name, grade:gradeRaw, idUnique});
  });

  // Un actif du roster totalement ABSENT de ce collage (ni retrouvé par
  // son grade, ni en WDV) veut dire que son dossier n'existe plus du tout
  // sur le site EMS — probablement supprimé, pas juste WDV. Proposé à la
  // suppression, jamais automatique.
  // Garde-fou : si le collage ne contient qu'une poignée de lignes (table
  // partielle collée par erreur), on ne propose AUCUNE suppression — sinon
  // tout le roster se retrouverait proposé à la suppression à tort.
  const totalLignesReconnues = seenIds.size + found.length + skippedWdv.length + unrecognized.length + ambiguous.length;
  const toRemove = totalLignesReconnues >= 15
    ? employees.filter(e => !e.licencie && !seenIds.has(e.id)).map(e => ({id:e.id, name:e.name}))
    : [];

  return {found, skippedWdv, alreadyKnown, unrecognized, toPromote, toLicencier, toRemove, ambiguous};
}

// Départ rapide (29/09) : une personne recrutée qui repart avant une semaine
// complète doit attendre 3 semaines avant de pouvoir revenir. Retourne null si
// la date d'arrivée est absente/illisible/future, ou si la personne est
// restée 7 jours ou plus — dans ces cas, aucun avertissement (comportement
// habituel de la ligne inchangé).
function quickDepartureInfo(p, now){
  if(!p || !p.arrivalMs) return null;
  const nowMs = (now||new Date()).getTime();
  const diff = nowMs - p.arrivalMs;
  if(diff < 0 || diff >= 7*24*3600*1000) return null;
  const days = Math.floor(diff / (24*3600*1000));
  const fmt = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
  const departDate = new Date(nowMs);
  const returnDate = new Date(nowMs); returnDate.setDate(returnDate.getDate()+21);
  return {
    days,
    departStr: fmt(departDate),
    returnStr: fmt(returnDate),
    line: `${p.name} | Départ le ${fmt(departDate)} | Retour autorisé le ${fmt(returnDate)}`,
  };
}
function quickDepartureWording(qd){
  const when = qd.days===0 ? "aujourd'hui" : (qd.days===1 ? "il y a 1 jour" : `il y a ${qd.days} jours`);
  return `Arrivé ${when}, déjà parti. Retour possible à partir du ${qd.returnStr}.`;
}

document.addEventListener("click", async (ev)=>{
  const btn = ev.target.closest("[data-copy-quickdep]");
  if(!btn) return;
  const p = (window._pendingLicencier||[])[+btn.getAttribute("data-copy-quickdep")];
  const qd = quickDepartureInfo(p);
  if(!qd){ toast("Rien à copier pour cette ligne."); return; }
  try{
    await navigator.clipboard.writeText(qd.line);
    toast("✓ Ligne copiée — colle-la dans le salon Discord");
  }catch(e){
    // Repli si le presse-papiers est refusé : sélection manuelle.
    window.prompt("Copie cette ligne (Ctrl+C) :", qd.line);
  }
});

function renderImportResults(result){
  const box = document.getElementById("importResults");
  const nothing = !result.found.length && !result.skippedWdv.length && !result.alreadyKnown.length && !result.unrecognized.length && !result.toPromote.length && !result.toLicencier.length && !result.toRemove.length && !(result.ambiguous&&result.ambiguous.length);
  if(nothing){
    box.innerHTML = `<div class="empty-msg">Rien reconnu — vérifie que le texte collé contient bien les colonnes "Employé" et "Grade" du tableau EMS.</div>`;
    return;
  }

  window._pendingImport = result.found;
  window._pendingPromote = result.toPromote;
  window._pendingLicencier = result.toLicencier;
  window._pendingRemove = result.toRemove;
  let html = "";

  if(result.toPromote.length){
    html += `<div style="font-weight:600;font-size:0.85rem;margin-bottom:8px;">⬆️ ${result.toPromote.length} grade(s) changé(s) détecté(s) — à mettre à jour :</div>`;
    html += result.toPromote.map((p,i)=>`
      <div class="edit-row" data-promote-row="${i}">
        <span style="min-width:150px;font-weight:600;">${esc(p.name)}</span>
        <span class="grade-badge" style="background:${GRADE_COLOR[p.oldGrade]};color:${GRADE_TEXT_COLOR[p.oldGrade]};">${p.oldGrade}</span>
        <span style="color:var(--text-faint);">→</span>
        <span class="grade-badge" style="background:${GRADE_COLOR[p.newGrade]};color:${GRADE_TEXT_COLOR[p.newGrade]};">${p.newGrade}</span>
        <button class="btn-primary btn-small" data-promote-apply="${i}">Appliquer</button>
      </div>
    `).join("");
    html += `<button class="btn-primary btn-small" id="btnApplyAllPromote" style="margin-top:8px;">Tout mettre à jour</button>`;
  }
  if(result.toLicencier.length){
    html += `<div style="font-weight:600;font-size:0.85rem;margin:14px 0 8px;">🚪 ${result.toLicencier.length} passage(s) en WDV détecté(s) — à licencier :</div>`;
    html += result.toLicencier.map((p,i)=>`
      <div class="edit-row" data-licencier-row="${i}">
        <span style="min-width:150px;font-weight:600;">${esc(p.name)}</span>
        <span class="grade-badge" style="background:var(--red);">WDV</span>
        <button class="btn-danger btn-small" data-licencier-apply="${i}">Licencier</button>
        ${(()=>{ const qd = quickDepartureInfo(p); return qd ? `<span style="color:var(--amber);font-size:0.78rem;font-weight:600;">⚠ ${esc(quickDepartureWording(qd))}</span> <button class="btn-ghost btn-small" data-copy-quickdep="${i}">Copier pour Discord</button>` : ""; })()}
      </div>
    `).join("");
    html += `<button class="btn-danger btn-small" id="btnApplyAllLicencier" style="margin-top:8px;">Tout licencier</button>`;
  }
  if(result.toRemove.length){
    html += `<div style="font-weight:600;font-size:0.85rem;margin:14px 0 8px;color:var(--red);">🗑️ ${result.toRemove.length} employé(s) absent(s) de ce tableau — dossier probablement supprimé sur le site :</div>`;
    html += result.toRemove.map((p,i)=>`
      <div class="edit-row" data-remove-row="${i}">
        <span style="min-width:150px;font-weight:600;">${esc(p.name)}</span>
        <button class="btn-danger btn-small" data-remove-apply="${i}">Supprimer du roster</button>
      </div>
    `).join("");
    html += `<button class="btn-danger btn-small" id="btnApplyAllRemove" style="margin-top:8px;">Tout supprimer</button>`;
  }
  if(result.found.length){
    html += `<div style="font-weight:600;font-size:0.85rem;margin-bottom:8px;">${result.found.length} nouvel(aux) employé(s) détecté(s) — indique leur ID Discord :</div>`;
    html += result.found.map((f,i)=>`
      <div class="edit-row" data-pending-row="${i}">
        <span class="grade-badge" style="background:${GRADE_COLOR[f.grade]};color:${GRADE_TEXT_COLOR[f.grade]};">${f.grade}</span>
        <span style="min-width:150px;font-weight:600;">${esc(f.name)}</span>
        <input type="text" data-pending-id="${i}" placeholder="ID Discord">
        <button class="btn-primary btn-small" data-pending-add="${i}">Ajouter</button>
      </div>
    `).join("");
    html += `<button class="btn-primary btn-small" id="btnAddAllPending" style="margin-top:8px;">Ajouter tous ceux avec un ID rempli</button>`;
  }
  if(result.skippedWdv.length){
    html += `<div class="empty-msg">WDV ignoré(s) (${result.skippedWdv.length}) : ${result.skippedWdv.map(esc).join(", ")}</div>`;
  }
  if(result.alreadyKnown.length){
    html += `<div class="empty-msg">Déjà dans le roster, ignoré(s) (${result.alreadyKnown.length}) : ${result.alreadyKnown.map(esc).join(", ")}</div>`;
  }
  if(result.ambiguous && result.ambiguous.length){
    html += `<div class="empty-msg" style="color:var(--amber);">⚠ Plusieurs employés portent ce nom, impossible de savoir lequel est concerné — rien n'a été appliqué automatiquement : ${result.ambiguous.map(esc).join(", ")}. Traite-les à la main.</div>`;
  }
  if(result.unrecognized.length){
    html += `<div class="empty-msg" style="color:var(--amber);">Grade non reconnu, ignoré(s) : ${result.unrecognized.map(u=>`${esc(u.name)} (${esc(u.grade)})`).join(", ")}</div>`;
  }
  box.innerHTML = html;

  box.querySelectorAll("[data-pending-add]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const i = +btn.getAttribute("data-pending-add");
      const idInput = box.querySelector(`[data-pending-id="${i}"]`);
      const discordId = idInput.value.trim();
      if(!discordId){ toast("ID Discord requis"); return; }
      const f = window._pendingImport[i];
      const impError = validateEmployeeFields(f.name, discordId);
      if(impError){ toast(impError); return; }
      const impDup = findDuplicateEmployee(f.name, discordId);
      if(impDup && !confirm(`${impDup.employee.name} (${impDup.employee.grade}) est déjà dans le roster avec ${impDup.why}. Ajouter quand même ?`)) return;
      employees.push({id:uid(), name:f.name, discordId, grade:f.grade, role:"", licencie:false, licencieDate:null, idUnique:f.idUnique||null});
      saveState(); renderAll();
      btn.closest("[data-pending-row]").remove();
      logHistory("Ajout", f.name, `Grade ${f.grade}, ID ${discordId} (import EMS)`);
      toast(`${f.name} ajouté`);
    });
  });
  const btnAll = document.getElementById("btnAddAllPending");
  if(btnAll) btnAll.addEventListener("click", ()=>{
    let count = 0;
    const skippedGroup = [];
    box.querySelectorAll("[data-pending-row]").forEach(row=>{
      const i = +row.getAttribute("data-pending-row");
      const idInput = row.querySelector(`[data-pending-id="${i}"]`);
      const discordId = idInput.value.trim();
      if(!discordId) return;
      const f = window._pendingImport[i];
      if(!f) return;
      // Ajout groupé : jamais de doublon ni de champ invalide silencieux —
      // ces lignes restent à l'écran, avec une raison claire.
      const groupError = validateEmployeeFields(f.name, discordId) || (findDuplicateEmployee(f.name, discordId) ? "déjà dans le roster (même nom ou même ID Discord)" : null);
      if(groupError){ skippedGroup.push(`${f.name} : ${groupError}`); return; }
      employees.push({id:uid(), name:f.name, discordId, grade:f.grade, role:"", licencie:false, licencieDate:null, idUnique:f.idUnique||null});
      logHistory("Ajout", f.name, `Grade ${f.grade}, ID ${discordId} (import EMS groupé)`);
      row.remove();
      count++;
    });
    if(count){ saveState(); renderAll(); toast(`${count} employé(s) ajouté(s)${skippedGroup.length?` — ${skippedGroup.length} ignoré(s) : ${skippedGroup.join(" ; ")}`:""}`); }
    else toast(skippedGroup.length ? `Aucun ajout — ${skippedGroup.join(" ; ")}` : "Aucun ID Discord rempli");
  });

  // ── UP détectés (grade changé chez un employé déjà connu) ──
  const applyPromote = (i, row)=>{
    const p = window._pendingPromote[i];
    if(!p) return;
    const e = employees.find(x=>x.id===p.id);
    if(!e) return;
    e.grade = p.newGrade;
    saveState(); renderAll();
    if(row) row.remove();
    logHistory("Promotion", e.name, `${p.oldGrade} → ${p.newGrade}`);
    toast(`${e.name} passé ${p.newGrade}`);
  };
  box.querySelectorAll("[data-promote-apply]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const i = +btn.getAttribute("data-promote-apply");
      applyPromote(i, btn.closest("[data-promote-row]"));
    });
  });
  const btnAllPromote = document.getElementById("btnApplyAllPromote");
  if(btnAllPromote) btnAllPromote.addEventListener("click", ()=>{
    const count = window._pendingPromote.length;
    window._pendingPromote.forEach(p=>{
      const e = employees.find(x=>x.id===p.id);
      if(e){ logHistory("Promotion", e.name, `${p.oldGrade} → ${p.newGrade} (groupé)`); e.grade = p.newGrade; }
    });
    if(count){ saveState(); renderAll(); toast(`${count} grade(s) mis à jour`); }
  });

  // ── WDV détectés (licenciement automatique d'un employé actif) ──
  const applyLicencier = (i, row)=>{
    const p = window._pendingLicencier[i];
    if(!p) return;
    const e = employees.find(x=>x.id===p.id);
    if(!e) return;
    employees = employees.filter(x=>x.id!==p.id);
    saveState(); renderAll();
    if(row) row.remove();
    const qdSingle = quickDepartureInfo(p);
    logHistory("Licenciement (WDV)", e.name, "détecté à l'import EMS" + (qdSingle ? ` — DÉPART RAPIDE : ${quickDepartureWording(qdSingle)}` : ""));
    toast(`${e.name} licencié (WDV) et retiré du roster`);
  };
  box.querySelectorAll("[data-licencier-apply]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const i = +btn.getAttribute("data-licencier-apply");
      applyLicencier(i, btn.closest("[data-licencier-row]"));
    });
  });
  const btnAllLicencier = document.getElementById("btnApplyAllLicencier");
  if(btnAllLicencier) btnAllLicencier.addEventListener("click", ()=>{
    const count = window._pendingLicencier.length;
    const idsToLicencier = new Set(window._pendingLicencier.map(p=>p.id));
    window._pendingLicencier.forEach(p=>{ const qd = quickDepartureInfo(p); logHistory("Licenciement (WDV)", p.name, "détecté à l'import EMS, groupé" + (qd ? ` — DÉPART RAPIDE : ${quickDepartureWording(qd)}` : "")); });
    employees = employees.filter(x=>!idsToLicencier.has(x.id));
    if(count){ saveState(); renderAll(); toast(`${count} licenciement(s) appliqué(s), retirés du roster`); }
  });

  // ── Dossiers absents du tableau collé (suppression proposée) ──
  const applyRemove = (i, row)=>{
    const p = window._pendingRemove[i];
    if(!p) return;
    employees = employees.filter(x=>x.id!==p.id);
    saveState(); renderAll();
    if(row) row.remove();
    logHistory("Suppression", p.name, "dossier absent du tableau EMS collé");
    toast(`${p.name} supprimé du roster`);
  };
  box.querySelectorAll("[data-remove-apply]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const i = +btn.getAttribute("data-remove-apply");
      applyRemove(i, btn.closest("[data-remove-row]"));
    });
  });
  const btnAllRemove = document.getElementById("btnApplyAllRemove");
  if(btnAllRemove) btnAllRemove.addEventListener("click", ()=>{
    const count = window._pendingRemove.length;
    const idsToRemove = new Set(window._pendingRemove.map(p=>p.id));
    window._pendingRemove.forEach(p=>logHistory("Suppression", p.name, "dossier absent du tableau EMS collé, groupé"));
    employees = employees.filter(x=>!idsToRemove.has(x.id));
    if(count){ saveState(); renderAll(); toast(`${count} employé(s) supprimé(s) du roster`); }
  });
}

// ═══════════════════════════ COPIE AU FORMAT "Nom : ID" ═══════════════════════════

// Reproduit le format exact de la liste envoyée à l'origine : une ligne
// "Prénom Nom : ID Discord" par employé actif (les licenciés n'y figurent
// pas), grade par grade du plus junior au plus gradé, puis les rôles Discord
// à la suite après une ligne vide — comme dans le message d'origine.
function buildPlainList(){
  const lines = [];
  [...GRADE_ORDER].reverse().forEach(g=>{
    employees.filter(e=>!e.licencie && e.grade===g).forEach(e=>{
      lines.push(`${e.name} : ${e.discordId}`);
    });
  });
  lines.push("");
  ROLES_REF.forEach(r=> lines.push(`${r.name} : ${r.id}`));
  return lines.join("\n");
}

function attachRowHandlers(){

  document.querySelectorAll("[data-view-history]").forEach(el=>{
    el.addEventListener("click", ()=>{
      switchTab("Logs");
      const input = document.getElementById("logsFilterTarget");
      if(input){ input.value = el.getAttribute("data-view-history"); }
      loadLogs();
    });
  });
  document.querySelectorAll("[data-copy-id]").forEach(el=>{
    el.addEventListener("click", ()=>copyToClipboard(el.getAttribute("data-copy-id")));
  });
  document.querySelectorAll("[data-toggle-grade]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const g = el.getAttribute("data-toggle-grade");
      collapsedGrades.has(g) ? collapsedGrades.delete(g) : collapsedGrades.add(g);
      renderAll();
    });
  });
  document.getElementById("licenciesHead").onclick = ()=>{ licenciesCollapsed = !licenciesCollapsed; renderAll(); };

  document.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-edit");
      const e = employees.find(x=>String(x.id)===String(id));
      if(!e) return;
      const slot = document.querySelector(`[data-edit-slot="${id}"]`);
      slot.innerHTML = editRowHtml(e);
      slot.querySelector(`[data-save="${id}"]`).addEventListener("click", async ()=>{
        const before = { name:e.name, discordId:e.discordId, grade:e.grade, role:e.role, aliases:(e.aliases||[]).slice() };
        const newName = slot.querySelector(`[data-edit-name="${id}"]`).value.trim() || e.name;
        const newDiscordId = slot.querySelector(`[data-edit-discord="${id}"]`).value.trim() || e.discordId;
        const newGrade = slot.querySelector(`[data-edit-grade="${id}"]`).value;
        const newRole = slot.querySelector(`[data-edit-role="${id}"]`).value;
        const aliasesInput = slot.querySelector(`[data-edit-aliases="${id}"]`);
        let newAliases = aliasesInput ? aliasesInput.value.split(",").map(a=>a.trim()).filter(Boolean) : before.aliases;
        // (19/10, demandé) Un changement de nom ajoute AUTOMATIQUEMENT
        // l'ancien nom à la liste des anciens noms — pour qu'un mariage
        // ou un wipe n'exige jamais d'y penser soi-même : la personne
        // reste reconnue sous les deux noms dès l'enregistrement.
        if(newName !== before.name && before.name && !newAliases.some(a=>norm(a)===norm(before.name))){
          newAliases = [...newAliases, before.name];
        }
        const saveBtn = slot.querySelector(`[data-save="${id}"]`);
        const editError = validateEmployeeFields(newName, newDiscordId);
        if(editError){ toast(editError); return; }
        const editDup = findDuplicateEmployee(newName, newDiscordId, e.id);
        if(editDup && (before.name!==newName || before.discordId!==newDiscordId) && !confirm(`${editDup.employee.name} (${editDup.employee.grade}) a déjà ${editDup.why}. Enregistrer quand même ?`)) return;
        saveBtn.disabled = true; const original = saveBtn.textContent; saveBtn.textContent = "Vérification…";
        try{
          // Action sensible : passe par la fonction serveur, qui
          // revérifie le jeton et le grade avant d'écrire quoi que ce
          // soit sur Firebase (demandé le 07/09 — protection réelle,
          // pas juste un blocage visuel).
          await protectedAction("editEmployee", { id, name:newName, discordId:newDiscordId, grade:newGrade, role:newRole, aliases:newAliases });
          e.name = newName; e.discordId = newDiscordId; e.grade = newGrade; e.role = newRole; e.aliases = newAliases;
          const changes = [];
          if(before.name!==e.name) changes.push(`nom "${before.name}" → "${e.name}"`);
          if(before.discordId!==e.discordId) changes.push(`ID Discord "${before.discordId}" → "${e.discordId}"`);
          if(before.grade!==e.grade) changes.push(`grade ${before.grade} → ${e.grade}`);
          if(before.role!==e.role) changes.push(`rôle "${before.role||'—'}" → "${e.role||'—'}"`);
          if(before.aliases.join(",")!==e.aliases.join(",")) changes.push(`anciens noms : ${e.aliases.join(", ")||"—"}`);
          if(changes.length) logHistory("Modification", e.name, changes.join(", "));
          saveState(); renderAll(); toast(`${e.name} mis à jour (vérifié serveur)`);
        }catch(err){
          toast(/introuvable/i.test(err.message) ? "✕ Cette personne n'est pas encore dans le cloud — patiente quelques secondes (sauvegarde automatique en cours) puis réessaie." : `✕ Refusé : ${err.message}`);
          saveBtn.disabled = false; saveBtn.textContent = original;
        }
      });
      slot.querySelector(`[data-cancel="${id}"]`).addEventListener("click", ()=>{ slot.innerHTML = ""; });
      const lockBtn = slot.querySelector(`[data-lock-anim]`);
      if(lockBtn) lockBtn.addEventListener("click", async ()=>{
        const target = lockBtn.dataset.lockAnim;
        lockBtn.disabled = true;
        const ok = await setAnimLockForUser(target, true);
        lockBtn.disabled = false;
        toast(ok ? "🔒 Animations désactivées de force pour cette personne (Roster + Pillbox)." : "✕ Échec — réessaie.");
      });
      const unlockBtn = slot.querySelector(`[data-unlock-anim]`);
      if(unlockBtn) unlockBtn.addEventListener("click", async ()=>{
        const target = unlockBtn.dataset.unlockAnim;
        unlockBtn.disabled = true;
        const ok = await setAnimLockForUser(target, false);
        unlockBtn.disabled = false;
        toast(ok ? "🔓 Elle peut de nouveau gérer ses propres animations." : "✕ Échec — réessaie.");
      });
      slot.querySelectorAll("[data-set-anim-style]").forEach(styleBtn=>{
        styleBtn.addEventListener("click", async ()=>{
          if(currentUserLevel !== "OWNER") return;
          const targetDiscordId=styleBtn.dataset.setAnimStyle;
          const animationStyle=styleBtn.dataset.animStyle;
          slot.querySelectorAll("[data-set-anim-style]").forEach(b=>b.disabled=true);
          try{
            const res=await fetch("/.netlify/functions/manage-individual-permissions",{
              method:"POST",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({token:currentSessionToken,action:"setAnimationStyle",targetDiscordId,animationStyle})
            });
            const data=await res.json().catch(()=>({}));
            if(!res.ok) throw new Error(data.error||`${res.status}`);
            await loadAnimationExclusionsFromCloud();
            toast(animationStyle==="real" ? "🎭 Style Personnage RP appliqué (Roster + Pillbox)." : "🖌️ Style Dessin IA appliqué (Roster + Pillbox).");
            renderAll();
          }catch(err){
            toast(`✕ Impossible de changer le style : ${err.message}`);
            slot.querySelectorAll("[data-set-anim-style]").forEach(b=>b.disabled=false);
          }
        });
      });
    });
  });

  document.querySelectorAll("[data-licencier]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-licencier");
      const e = employees.find(x=>String(x.id)===String(id));
      if(!e) return;
      if(!confirm(`Licencier ${e.name} ? Il sera retiré du roster (pas juste marqué licencié).`)) return;
      btn.disabled = true; const original = btn.textContent; btn.textContent = "Vérification…";
      try{
        // Action sensible : même passage obligé par le serveur que pour
        // "Modifier" (demandé le 07/09).
        await protectedAction("licencier", { id });
        employees = employees.filter(x=>String(x.id)!==String(id));
        saveState(); renderAll();
        logHistory("Licenciement", e.name, "manuel (vérifié serveur)");
        toast(`${e.name} licencié et retiré du roster`);
      }catch(err){
        toast(/introuvable/i.test(err.message) ? "✕ Cette personne n'est pas encore dans le cloud — patiente quelques secondes (sauvegarde automatique en cours) puis réessaie." : `✕ Refusé : ${err.message}`);
        btn.disabled = false; btn.textContent = original;
      }
    });
  });

  document.querySelectorAll("[data-reintegrer]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-reintegrer");
      const e = employees.find(x=>String(x.id)===String(id));
      if(!e) return;
      e.licencie = false;
      e.licencieDate = null;
      saveState(); renderAll();
      logHistory("Réintégration", e.name, "remis actif dans le roster");
      toast(`${e.name} réintégré`);
    });
  });
}

// ═══════════════════════════ AJOUT / EXPORT / IMPORT ═══════════════════════════

document.getElementById("btnAdd").addEventListener("click", ()=>{
  const name = document.getElementById("newName").value.trim();
  const discordId = document.getElementById("newDiscordId").value.trim();
  const grade = document.getElementById("newGrade").value;
  const role = document.getElementById("newRole").value;
  if(!name || !discordId){ toast("Nom et ID Discord requis"); return; }
  const fieldError = validateEmployeeFields(name, discordId);
  if(fieldError){ toast(fieldError); return; }
  const dup = findDuplicateEmployee(name, discordId);
  if(dup && !confirm(`${dup.employee.name} (${dup.employee.grade}) est déjà dans le roster avec ${dup.why}. Ajouter quand même un deuxième dossier ?`)) return;
  if(!/^\d{5,25}$/.test(discordId)){
    if(!confirm(`"${discordId}" ne ressemble pas à un ID Discord habituel (uniquement des chiffres). Ajouter quand même ?`)) return;
  }
  employees.push({id:uid(), name, discordId, grade, role, licencie:false, licencieDate:null});
  saveState(); renderAll();
  logHistory("Ajout", name, `Grade ${grade}, ID ${discordId} (manuel)`);
  document.getElementById("newName").value = "";
  document.getElementById("newDiscordId").value = "";
  document.getElementById("newRole").value = "";
  toast(`${name} ajouté`);
});

document.getElementById("searchInput").addEventListener("input", renderAll);
document.getElementById("filterGrade").addEventListener("change", renderAll);

document.getElementById("btnAnalyzeEms").addEventListener("click", ()=>{
  const text = document.getElementById("emsTableInput").value;
  const result = parseEmsTableForImport(text);
  renderImportResults(result);
  // Un seul collage sert aussi à détecter les absences pour les onglets
  // Formateur/Psychologue — plus besoin de recoller le tableau une
  // deuxième fois ailleurs (demandé le 07/09).
  weekAbsences = parseWeekAbsences(text);
  saveWeekAbsences();
  renderActiviteTab("formateur"); renderActiviteTab("psychologue");
  // (03/10) Le même collage sert aussi à détecter les absences de plus
  // de 3 jours pour le nouvel onglet Absences — synchronise directement
  // vers le cloud (ajoute seulement les nouvelles, jamais de doublon).
  syncQualifyingAbsences(text);
});

document.getElementById("btnCopyList").addEventListener("click", ()=>{
  copyToClipboard(buildPlainList(), "Liste copiée");
});

// ═══════════════════════════ ACTIONS SÉLECTION FORMATION / OPÉRATION ═══════════════════════════
document.getElementById("specialSearch").addEventListener("input", renderSpecialSelection);
document.getElementById("btnSpecialSelectVisible").addEventListener("click", ()=>{
  getSpecialVisibleEmployees().forEach(e=>specialSelected.add(e.id));
  saveSpecialSelection(); renderSpecialSelection(); toast("Employés visibles sélectionnés");
});
document.getElementById("btnSpecialClear").addEventListener("click", ()=>{
  specialSelected.clear(); saveSpecialSelection(); renderSpecialSelection(); toast("Sélection vidée");
});
let specialImportDebounce = null;
document.getElementById("specialImportText").addEventListener("input", ()=>{
  clearTimeout(specialImportDebounce);
  specialImportDebounce = setTimeout(()=>applySpecialListAction(true), 400);
});
document.getElementById("btnSpecialCopy").addEventListener("click", ()=>{
  const result = buildSpecialSelectionList();
  if(!result.selectedCount){ toast("Aucun employé sélectionné"); return; }
  if(!result.text){ toast("Aucun ID unique renseigné dans cette sélection"); return; }
  const skipped = result.selectedCount - result.outputCount;
  copyToClipboard(result.text, skipped ? `Sélection copiée — ${skipped} sans ID unique ignoré(s)` : `Sélection copiée (${result.outputCount})`);
});

// (19/10, demandé) Message de rappel prêt à coller sur Discord, pour
// tous les employés actifs qui n'ont PAS encore coché la Formation
// Opération ci-dessus — un ping par ligne, même format que l'exemple
// donné. Change FORMATION_OPERATION_CHANNEL_ID ci-dessous si jamais le
// salon change.
const FORMATION_OPERATION_CHANNEL_ID = "1168724093466578994";
function buildFormationMissingPingMessage(){
  const missing = employees.filter(e=>!e.licencie && !specialSelected.has(e.id));
  const withDiscord = missing.filter(e=>e.discordId);
  const withoutDiscord = missing.length - withDiscord.length;
  if(!withDiscord.length) return { text: "", missingCount: missing.length, withoutDiscord };
  const lines = withDiscord.map(e=>`- <@${e.discordId}> `).join("\n");
  const text = `Bonjour à tous, pour toutes les personnes qui sont **ping**, merci de demander à passer votre **formation OPÉRATION** dans le salon <#${FORMATION_OPERATION_CHANNEL_ID}> (Cette formation est **OBLIGATOIRE**, merci donc de faire le nécessaire pour la passer) : \n\n${lines}\n\nMerci de votre compréhension`;
  return { text, missingCount: missing.length, withoutDiscord };
}
document.getElementById("btnSpecialMissingPing").addEventListener("click", ()=>{
  const result = buildFormationMissingPingMessage();
  if(!result.missingCount){ toast("Tout le monde a déjà la Formation Opération !"); return; }
  if(!result.text){ toast("Personne à ping — aucun des employés manquants n'a d'ID Discord renseigné."); return; }
  copyToClipboard(result.text, result.withoutDiscord
    ? `Message copié — ${result.withoutDiscord} employé(s) manquant(s) ignoré(s) (pas d'ID Discord)`
    : `Message copié (${result.missingCount} à ping)`);
});
// (10/10, demandé) Sauvegarde cloud de la sélection Formation Opération
// — reprise telle quelle de l'ancien btnSpecialCloudSave, maintenant
// appelée par le bouton unique "💾 Sauvegarder" (voir plus bas,
// saveSpecialSelectionToCloud). Le chargement (ancien btnSpecialCloudLoad)
// n'existe plus : la sélection se synchronise désormais automatiquement
// depuis le cloud (voir refreshSpecialSelectionFromCloud).
async function saveSpecialSelectionToCloud(signal){
  const selectedEmployees = employees.filter(e=>!e.licencie && specialSelected.has(e.id)).map(e=>({
    id:e.id, name:e.name, discordId:e.discordId, idUnique:e.idUnique||null, grade:e.grade
  }));
  if(signal?.aborted) throw new DOMException("Opération annulée", "AbortError");
  const data = await protectedAction("saveSpecialSelection", {selectedEmployees});
  return Number(data.count ?? selectedEmployees.length);
}

let specialSelectionLastSavedAt = 0;
async function refreshSpecialSelectionFromCloud(){
  if(!currentFirebaseIdToken && !currentSessionToken) return;
  try{
    const res = await fetch(withFirebaseAuth(SPECIAL_SELECTION_CLOUD_URL));
    if(!res.ok) return;
    const data = await res.json();
    if(!data || !Array.isArray(data.selectedEmployees) || !data.savedAt) return;
    if(data.savedAt <= specialSelectionLastSavedAt) return; // rien de plus récent que ce qu'on a déjà
    const ids = new Set();
    data.selectedEmployees.forEach(saved=>{
      const match = employees.find(e=>!e.licencie && (e.id===saved.id || (saved.discordId && e.discordId===saved.discordId) || (saved.idUnique && e.idUnique===saved.idUnique)));
      if(match) ids.add(match.id);
    });
    specialSelected = ids; specialSelectionLastSavedAt = data.savedAt;
    saveSpecialSelection(); renderSpecialSelection();
    // (10/10, demandé) Affiche "la dernière sauvegarde" pour TOUT LE
    // MONDE, pas seulement la personne qui a cliqué "Sauvegarder" —
    // mis à jour ici dès qu'une sauvegarde plus récente que la sienne
    // est détectée, pas seulement juste après son propre clic.
    const statusEl = document.getElementById("saveAllStatus");
    if(statusEl && !rosterEmployeesDirty && !statusEl.textContent.startsWith("⚠")){
      statusEl.textContent = `✓ Dernière sauvegarde : ${new Date(data.savedAt).toLocaleString("fr-FR")}`;
      statusEl.style.color = "var(--text-dim)";
    }
  }catch(e){ /* échec silencieux -- retente au prochain sondage */ }
}

// ═══════════════════════════ ENVOI VERS PILLBOX (CLOUD) ═══════════════════════════
// Utilise EXACTEMENT le même point d'accès Firebase que le bouton "Charger
// depuis le cloud" déjà présent dans Pillbox Terminal Paye (section ID
// Discord) — même base, même chemin. Le format produit par buildPlainList()
// ("Nom : ID" par ligne + rôles à la suite) correspond déjà tel quel à ce
// que Pillbox attend dans son champ ID Discord, donc aucune conversion
// n'est nécessaire ici : on envoie le texte brut directement.
const CLOUD_DB_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/discordIdsList.json";

// Parseur identique à celui utilisé côté Pillbox (parseDiscordIds), pour
// comparer les deux côtés avec exactement la même logique de lecture.
function parseDiscordIdsText(text){
  const map = {};
  if(!text) return map;
  text.split("\n").forEach(line=>{
    const m = line.trim().match(/^\*?\s*(.+?)\s*:\s*(\d{5,})\s*$/);
    if(!m) return;
    map[m[1].trim().toLowerCase()] = m[2].trim();
  });
  return map;
}

// ═══════════════════════════════════════════════════════════════════
// SYNCHRONISATION GLOBALE PILLBOX (09/09) — remplace les boutons
// séparés (Roster, Formation Opération, Formateur, Psychologue) par
// une seule action. Réutilise EXACTEMENT les mêmes fonctions/chemins
// déjà existants (buildPlainList, buildFormationSendList,
// saveActiviteToCloud, withFirebaseAuth) — aucun nouveau système,
// juste un point d'entrée unique qui les enchaîne.
//
// Respecte le même partage de permissions qu'avant : MC peut
// synchroniser Formateur+Psychologue (sync_pillbox_complete), ADD+ synchronise TOUT en plus (sync_pillbox_complete) —
// jamais élargi côté client, la vraie vérification reste dans
// activite-actions.js pour Formateur/Psychologue (déjà en place).
// Roster et Formation Opération restent sans vérification serveur
// dédiée (comme avant ce soir), simplement visibles seulement pour
// ADD+ ici.
// ═══════════════════════════════════════════════════════════════════
const SYNC_OVERLAY_MIN_MS = 2000;
function waitForSyncOverlay(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

// ═══════════════════════════════════════════════════════════════════
// LIAISON CENTRALE (19/10) — écran unique pour la sauvegarde ET la
// synchronisation Pillbox. Les étapes affichées reflètent les VRAIES
// étapes en cours (jamais une barre de progression inventée) : chaque
// essai réel du code appelle setLiaisonStep() au bon moment.
// ═══════════════════════════════════════════════════════════════════
// (19/10, corrigé) Trouvé le vrai bug : ce drapeau mélangeait le
// réglage du bouton ET la préférence "mouvement réduit" du système
// vérifiée EN DIRECT à chaque appel. Résultat : si le téléphone/l'OS a
// cette préférence activée (indépendamment de la volonté de voir
// l'animation), l'attente de 5-7s était purement et simplement
// ignorée — l'overlay s'affichait, mais se refermait dès que la vraie
// sauvegarde/synchro finissait (souvent ~1s), donnant exactement
// l'impression de "ça bug après 1s". Maintenant : seule la préférence
// système sert de VALEUR PAR DÉFAUT la toute première fois (avant
// qu'un choix explicite existe) ; une fois un choix fait (via le
// bouton, ou implicitement en laissant la valeur par défaut), c'est
// LUI qui décide, point final — jamais recontredit en direct par l'OS.
// (19/10, demandé) Le réglage "animations" est maintenant partagé entre
// le Roster et Pillbox — stocké sur Firebase, lié au compte Discord de
// la personne, plutôt que dans le localStorage de cet appareil/ce site
// précis (ce qui ne pouvait par nature jamais être vu par l'autre app).
// localStorage sert seulement de cache rapide le temps que Firebase
// réponde au chargement — jamais la source de vérité.
const ANIM_PREFS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterAnimPrefs";
let rosterAnimsEnabled = true;
let rosterAnimsLocked = false;
// Exclusions individuelles des personnages d'animation, stockées dans le même
// système rosterIndividualPermissions que les autres exceptions.
const ANIMATION_INDIVIDUAL_PERMS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterIndividualPermissions";
let animationExcludedCharacterIds = new Set();
let animationPortraitStyleByCharacter = new Map();
function readAnimationExclusionDecision(personEntry){
  const entry = personEntry && personEntry.exclude_animations;
  if(!entry || typeof entry !== "object") return null;
  for(const layer of ["OWNER","DG","D","CD"]){
    if(entry[layer] === true || entry[layer] === false) return entry[layer];
  }
  return null;
}
async function loadAnimationExclusionsFromCloud(){
  if(!currentFirebaseIdToken) return;
  try{
    const res=await fetch(`${ANIMATION_INDIVIDUAL_PERMS_URL}.json?auth=${currentFirebaseIdToken}`);
    if(!res.ok) return;
    const all=(await res.json())||{};
    const next=new Set();
    const styles=new Map();
    Object.entries(all).forEach(([id,person])=>{
      const key=canonicalCharacterId(id);
      if(readAnimationExclusionDecision(person)===true) next.add(key);
      const style=person && person.animation_portrait_style;
      if(style === "illustration" || style === "real") styles.set(key, style);
    });
    animationExcludedCharacterIds=next;
    animationPortraitStyleByCharacter=styles;
  }catch(e){}
}

try{
  const saved = localStorage.getItem("rosterAnimsEnabled");
  if(saved === "0" || saved === "1"){
    rosterAnimsEnabled = saved === "1";
  } else {
    rosterAnimsEnabled = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
}catch(e){}
function applyAnimsToggleUi(){
  document.body.classList.toggle("roster-anims-off", !rosterAnimsEnabled);
  const btn = document.getElementById("animsToggleBtn");
  if(btn){
    btn.setAttribute("aria-pressed", String(rosterAnimsEnabled));
    btn.title = rosterAnimsLocked
      ? "Animations désactivées par la Direction — tu ne peux pas les réactiver toi-même."
      : "Activer/désactiver les animations de sauvegarde et synchronisation (partagé avec Pillbox)";
  }
}
function liaisonReduced(){
  return !rosterAnimsEnabled || isAnimationCharacterExcluded(currentUserDiscordId) || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
// Lu au login (voir showApp) — jamais bloquant : si Firebase ne répond
// pas, on garde simplement la valeur locale déjà affichée.
async function loadAnimPrefFromCloud(){
  if(!currentUserDiscordId || !currentFirebaseIdToken) return;
  try{
    const res = await fetch(`${ANIM_PREFS_URL}/${currentUserDiscordId}.json?auth=${currentFirebaseIdToken}`);
    if(!res.ok) return;
    const data = await res.json();
    if(data && typeof data.enabled === "boolean"){
      rosterAnimsEnabled = data.enabled;
      try{ localStorage.setItem("rosterAnimsEnabled", rosterAnimsEnabled ? "1" : "0"); }catch(e){}
    }
    rosterAnimsLocked = !!(data && data.lockedByOwner);
    applyAnimsToggleUi();
  }catch(e){ /* best-effort — on garde la valeur locale déjà affichée */ }
}
async function writeAnimPrefToCloud(enabled){
  if(!currentUserDiscordId || !currentFirebaseIdToken) return;
  try{
    await fetch(`${ANIM_PREFS_URL}/${currentUserDiscordId}.json?auth=${currentFirebaseIdToken}`, {
      method: "PATCH", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ enabled, updatedAt: Date.now(), updatedByDiscordId: currentUserDiscordId, updatedByName: currentUserName||"" }),
    });
  }catch(e){ /* best-effort — l'affichage local a déjà changé, Pillbox se resynchronisera au prochain chargement */ }
}
// (21/10) OWNER / DG / D : verrouille ou déverrouille les
// animations d'une personne — elle ne peut alors plus les
// réactiver elle-même tant que l'OWNER n'a pas levé le verrou (la règle
// Firebase impose ce même blocage côté serveur, ceci n'est que le
// raccourci pour le déclencher).
async function setAnimLockForUser(targetDiscordId, lock){
  if(!currentFirebaseIdToken) return false;
  try{
    const res = await fetch(`${ANIM_PREFS_URL}/${targetDiscordId}.json?auth=${currentFirebaseIdToken}`, {
      method: "PATCH", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(lock
        ? { enabled:false, lockedByOwner:true, updatedAt: Date.now(), updatedByDiscordId: currentUserDiscordId, updatedByName: currentUserName||"" }
        : { lockedByOwner:false, updatedAt: Date.now(), updatedByDiscordId: currentUserDiscordId, updatedByName: currentUserName||"" }),
    });
    return res.ok;
  }catch(e){ return false; }
}
let liaisonSkipped = false;
let liaisonTrigger = null;
// (19/10, x8) Allongé à la demande : une durée aléatoire entre 5 et 10s
// à CHAQUE ouverture (jamais toujours la même), pour laisser le temps
// aux séquences travaillées de se jouer en entier.
let liaisonCurrentMinMs = 5500;
const LIAISON_MAX_EXTRA_MS = 11000;
let liaisonCounterTimer = null;
let liaisonSceneTimer = null;

// (19/10, repensé) Plus de tirage aléatoire parmi plusieurs scènes
// proches — UNE seule scène, travaillée, par opération : un mascotte
// animée façon dessin animé qui donne l'information elle-même, plutôt
// qu'une icône abstraite parmi d'autres qui se ressemblent toutes.
const LIAISON_VARIANTS = { save: ["save-roster-ui"], sync: ["sync-handoff"] };
let liaisonLastVariant = null;
function pickLiaisonVariant(kind){
  const options = LIAISON_VARIANTS[kind] || [kind];
  let pick = options[Math.floor(Math.random()*options.length)];
  if(options.length > 1 && pick === liaisonLastVariant){
    // Évite la répétition immédiate de la même scène deux fois de suite.
    const others = options.filter(o=>o!==pick);
    pick = others[Math.floor(Math.random()*others.length)];
  }
  liaisonLastVariant = pick;
  return pick;
}

// Un seul endroit pour décrire chaque scène : son texte, et son
// éventuel compteur cosmétique (jamais une vraie mesure — juste du
// réalisme). "counter" précise le type de formatage utilisé par
// tickLiaisonCounter() ci-dessous.
const LIAISON_META = {
  // (19/10) minMs calé sur la durée réelle de l'animation elle-même
  // (l'arrivée du coureur / le dernier bandage posé) — plus de longue
  // attente artificielle une fois l'histoire terminée à l'écran.
  "save-roster-ui": { subtitle: "Enregistrement des données du Roster…", minMs: 5200 },
  "sync-handoff":  { subtitle: "Préparation et remise du dossier à Pillbox…", minMs: 5800 },
  "save-anime":    { subtitle: "Enregistrement en cours…", minMs: 5200 },
  "sync-anime":    { subtitle: "Transmission en cours…", minMs: 5800 }, // laisse le temps à la remise du dossier (infirmière) de se jouer en entier
  "save-vault":    { subtitle: "Ouverture du coffre…" },
  "save-recorder": { subtitle: "Lecture de la bande…", counter: "time" },
  "save-scanner":  { subtitle: "Analyse biométrique en cours…", counter: "percent" },
  "save-stamp":    { subtitle: "Constitution du dossier…", counter: "pages" },
  "save-jutsu":    { subtitle: "Invocation du sceau d'archivage…" },
  "save-burner":   { subtitle: "Gravure des données…", counter: "percent" },
  "save-drawer":   { subtitle: "Classement en cours…", counter: "pages" },
  "save-printer":  { subtitle: "Impression du rapport…", counter: "lines" },
  "sync-radar":        { subtitle: "Établissement de la liaison…" },
  "sync-transfusion":  { subtitle: "Amorçage de la perfusion…", counter: "packets" },
  "sync-wifi":         { subtitle: "Recherche du signal…" },
  "sync-beam":         { subtitle: "Alignement du faisceau…", counter: "percent" },
  "sync-portal":       { subtitle: "Ouverture du portail…" },
  "sync-cable":        { subtitle: "Connexion du câble réseau…" },
  "sync-telex":        { subtitle: "Transmission en cours…", counter: "chars" },
  "sync-ekgsync":      { subtitle: "Synchronisation des signaux…" },
};
function tickLiaisonCounter(type){
  const el = document.getElementById("liaisonCounter");
  el.hidden = false;
  let n = 0;
  const render = {
    time: v => { const h=String(Math.floor(v/3600)).padStart(2,"0"), m=String(Math.floor((v%3600)/60)).padStart(2,"0"), s=String(v%60).padStart(2,"0"); return `${h}:${m}:${s}`; },
    percent: v => `${Math.min(v,99)}%`,
    pages: v => `${v} page(s) classée(s)`,
    lines: v => `${v} ligne(s) imprimée(s)`,
    packets: v => `${v} paquet(s) transféré(s)`,
    chars: v => `${v} caractère(s) envoyé(s)`,
  }[type] || (v=>String(v));
  const step = type==="percent" ? 3 : type==="chars" ? 7 : 1;
  const everyMs = type==="time" ? 1000 : type==="chars" ? 180 : 500;
  el.textContent = render(0);
  liaisonCounterTimer = setInterval(()=>{ n += step; el.textContent = render(n); }, everyMs);
}

// (20/10, demandé) Vraies illustrations par personne (une IA graphiste,
// via des prompts qu'on a mis au point ensemble) — remplace les formes
// CSS. Images compressées et redimensionnées avant d'être encodées ici.
const CHARACTER_PORTRAITS = {
  "408669016039882752": "assets/portraits/ia/408669016039882752.png",
  "701698983466106903": "assets/portraits/ia/701698983466106903.png",
  "873209274023690303": "assets/portraits/ia/873209274023690303.png",
  "861557966083850250": "assets/portraits/ia/861557966083850250.png",
  "881570935679909918": "assets/portraits/ia/881570935679909918.png",
  "227444055594893312": "assets/portraits/ia/227444055594893312.png",
  "451073171194511370": "assets/portraits/ia/451073171194511370.png",
  "51487127135243469": "assets/portraits/ia/51487127135243469.png",
  "1339800960637075547": "assets/portraits/ia/1339800960637075547.png",

  "263758146177204225": "assets/portraits/ia/263758146177204225.png",
};

// Photos réelles GTA RP détourées — même clés Discord que les dessins IA.
const CHARACTER_REAL_PORTRAITS = {
  "408669016039882752": "assets/portraits/rp/408669016039882752.png",
  "701698983466106903": "assets/portraits/rp/701698983466106903.png",
  "873209274023690303": "assets/portraits/rp/873209274023690303.png",
  "861557966083850250": "assets/portraits/rp/861557966083850250.png",
  "881570935679909918": "assets/portraits/rp/881570935679909918.png",
  "227444055594893312": "assets/portraits/rp/227444055594893312.png",
  "451073171194511370": "assets/portraits/rp/451073171194511370.png",
  "51487127135243469": "assets/portraits/rp/51487127135243469.png",
  "1339800960637075547": "assets/portraits/rp/1339800960637075547.png",

  "263758146177204225": "assets/portraits/rp/263758146177204225.png",
};

// (20/10, demandé) Liste des personnes ayant une vraie illustration
// (voir CHARACTER_PORTRAITS, image par personne) — ne retient plus que
// le nom ; l'apparence elle-même (cheveux, tenue, grade...) est
// directement peinte dans l'image, plus besoin de la décrire en CSS.

const CHARACTER_ID_ALIASES = {
  // Le document photo contient Papy avec un ID à 18 chiffres ; le projet historique
  // utilise cette clé. On accepte l'alias sans le mettre dans la rotation deux fois.
  "514871271352434699": "51487127135243469",
};
function canonicalCharacterId(discordId){
  const raw=String(discordId||"");
  return CHARACTER_ID_ALIASES[raw] || raw;
}
function pickAnimationPortraitStyle(){
  try{
    if(window.crypto && window.crypto.getRandomValues){
      const n=new Uint32Array(1); window.crypto.getRandomValues(n);
      return (n[0] & 1) ? "real" : "illustration";
    }
  }catch(e){}
  return Math.random() < .5 ? "illustration" : "real";
}
function isAnimationCharacterExcluded(discordId){
  const key=canonicalCharacterId(discordId);
  return !!(key && animationExcludedCharacterIds && animationExcludedCharacterIds.has(key));
}
function normalizeAnimationPortraitStyle(style, participantIds){
  if(style !== "real") return "illustration";
  const ids=(participantIds||[]).map(canonicalCharacterId).filter(Boolean);
  return ids.every(id=>!!CHARACTER_REAL_PORTRAITS[id]) ? "real" : "illustration";
}
function configuredAnimationPortraitStyle(discordId){
  const key=canonicalCharacterId(discordId);
  const style=key ? animationPortraitStyleByCharacter.get(key) : null;
  return style === "real" || style === "illustration" ? style : null;
}
function animationPortraitStyleForScene(ownerDiscordId){
  return configuredAnimationPortraitStyle(ownerDiscordId) || pickAnimationPortraitStyle();
}
function hasAnimationPortraitPair(discordId){
  const key=canonicalCharacterId(discordId);
  return !!(key && CHARACTER_PORTRAITS[key] && CHARACTER_REAL_PORTRAITS[key]);
}

const CHARACTER_APPEARANCES = {
  "408669016039882752": { name:"Tio War" },
  "701698983466106903": { name:"Moussa Sako" },
  "873209274023690303": { name:"Aaron Stopenski" },
  "861557966083850250": { name:"Baptiste Fore" },
  "881570935679909918": { name:"Cloé White" },
  "227444055594893312": { name:"Aiden Ishigami" },
  "451073171194511370": { name:"Eliot" },
  "51487127135243469": { name:"Papy Alucard Saotome" },
  "1339800960637075547": { name:"Leyah Akada" },

  "263758146177204225": { name:"Leto Mendez" },
};
// (20/10, demandé) Silhouette neutre pour quiconque n'a pas encore de
// vraie illustration (seules les 10 personnes ci-dessus en ont une) —
// jamais un personnage "cassé" ou vide à l'écran.
// Rotation équilibrée des collègues : chacun apparaît une fois avant répétition.
function pickBalancedEmsColleague(excludeId, scope){
  const excludeKey=canonicalCharacterId(excludeId);
  // Une seule rotation par personne : le style photo/dessin ne crée JAMAIS
  // un deuxième compteur, donc Eliot/Aaron/etc. restent équilibrés globalement.
  const ids=Object.keys(CHARACTER_APPEARANCES).filter(id=>id!==excludeKey && !isAnimationCharacterExcluded(id));
  if(!ids.length) return null;
  const key=`emsColleagueCycle:${scope||"default"}:${String(excludeId||"none")}`;
  let queue=[];
  try{ queue=JSON.parse(localStorage.getItem(key)||"[]"); if(!Array.isArray(queue)) queue=[]; }catch(e){queue=[];}
  queue=queue.filter(id=>ids.includes(id));
  if(!queue.length){
    queue=ids.slice();
    for(let i=queue.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[queue[i],queue[j]]=[queue[j],queue[i]];}
  }
  const chosen=queue.shift();
  try{localStorage.setItem(key,JSON.stringify(queue));}catch(e){}
  return chosen;
}
const CHARACTER_PORTRAIT_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='10' fill='%232a3650'/%3E%3Ccircle cx='20' cy='16' r='7' fill='%238a97ad'/%3E%3Cpath d='M6 38c0-9.5 7-14.5 14-14.5s14 5 14 14.5' fill='%238a97ad'/%3E%3C/svg%3E";
function applyCharacterPortrait(imgEl, discordId, portraitStyle){
  if(!imgEl) return;
  const key = canonicalCharacterId(discordId);
  const app = CHARACTER_APPEARANCES[key];
  const style = portraitStyle === "real" ? "real" : "illustration";
  const source = style === "real" ? CHARACTER_REAL_PORTRAITS : CHARACTER_PORTRAITS;
  imgEl.src = (app && source[key]) ? source[key] : ((app && CHARACTER_PORTRAITS[key]) ? CHARACTER_PORTRAITS[key] : CHARACTER_PORTRAIT_FALLBACK);
  imgEl.dataset.portraitStyle = style;
  imgEl.alt = app ? app.name : "";
}

function showLiaisonOverlay(kind, title, stepLabels, trigger){
  liaisonSkipped = false;
  liaisonTrigger = trigger || null;
  const overlay = document.getElementById("liaisonOverlay");
  const variant = pickLiaisonVariant(kind);
  let portraitStyle = animationPortraitStyleForScene(currentUserDiscordId); // choix OWNER si défini, sinon 50/50 ; UNIQUE pour toute la scène
  overlay.dataset.portraitStyle = portraitStyle;
  const meta = LIAISON_META[variant] || {};
  liaisonCurrentMinMs = meta.minMs || 3500;
  if(liaisonSceneTimer){ clearTimeout(liaisonSceneTimer); liaisonSceneTimer=null; }
  overlay.classList.remove("scene-paused");
  overlay.dataset.state = "loading";
  overlay.dataset.kind = kind;
  overlay.dataset.variant = variant;
  document.getElementById("vaultLockIcon").textContent = "🔓";
  document.getElementById("liaisonTitle").textContent = title;
  document.getElementById("liaisonSubtitle").textContent = meta.subtitle || "Opération en cours…";
  document.getElementById("liaisonResult").textContent = "";
  document.getElementById("liaisonSteps").innerHTML = stepLabels.map((label,i)=>
    `<li class="liaison-step" data-status="pending" data-step="${i}"><span class="liaison-step-dot"></span><span>${esc(label)}</span></li>`
  ).join("");
  if(variant === "sync-handoff"){
    const colleagueId = pickBalancedEmsColleague(currentUserDiscordId, "roster-sync");
    portraitStyle = normalizeAnimationPortraitStyle(portraitStyle, [currentUserDiscordId, colleagueId]);
    overlay.dataset.portraitStyle = portraitStyle;
    applyCharacterPortrait(document.getElementById("syncMePortrait"), currentUserDiscordId, portraitStyle);
    applyCharacterPortrait(document.getElementById("syncColleaguePortrait"), colleagueId, portraitStyle);
    const meName=document.getElementById("syncMeName"); if(meName) meName.textContent=(CHARACTER_APPEARANCES[String(currentUserDiscordId||"")]||{}).name||currentUserName||"Toi";
    const colName=document.getElementById("syncColleagueName"); if(colName) colName.textContent=(CHARACTER_APPEARANCES[String(colleagueId||"")]||{}).name||"Collègue EMS";
    const target=document.getElementById("syncRosterLiveClone"), source=document.getElementById("rosterView");
    if(target){target.innerHTML=""; if(source){const clone=source.cloneNode(true);clone.removeAttribute("id");clone.querySelectorAll("[id]").forEach(el=>el.removeAttribute("id"));clone.querySelectorAll("button,input,select,textarea,a").forEach(el=>{el.setAttribute("tabindex","-1");el.style.pointerEvents="none";});target.appendChild(clone);}}
    const chip=document.getElementById("syncHandoffStatusChip"); if(chip) chip.textContent="Transmission du dossier…";
    const strip=document.getElementById("syncStepStrip");
    if(strip) strip.innerHTML=stepLabels.map((label,i)=>`<span class="sync-step-pill" data-step="${i}" data-status="pending">${esc(label.replace(" (activité)",""))}</span>`).join("");
  }
  if(variant === "save-roster-ui"){
    const colleagueId = pickBalancedEmsColleague(currentUserDiscordId, "roster-save");
    portraitStyle = normalizeAnimationPortraitStyle(portraitStyle, [currentUserDiscordId, colleagueId]);
    overlay.dataset.portraitStyle = portraitStyle;
    applyCharacterPortrait(document.getElementById("saveRosterPortrait"), currentUserDiscordId, portraitStyle);
    applyCharacterPortrait(document.getElementById("saveRosterColleaguePortrait"), colleagueId, portraitStyle);
    const meName=document.getElementById("saveRosterName"); if(meName) meName.textContent=(CHARACTER_APPEARANCES[String(currentUserDiscordId||"")]||{}).name||currentUserName||"Toi";
    const colName=document.getElementById("saveRosterColleagueName"); if(colName) colName.textContent=(CHARACTER_APPEARANCES[String(colleagueId||"")]||{}).name||"Collègue EMS";
    const target = document.getElementById("saveRosterLiveClone");
    const source = document.getElementById("rosterView");
    if(target){
      target.innerHTML = "";
      if(source){
        const clone = source.cloneNode(true);
        clone.removeAttribute("id");
        clone.querySelectorAll("[id]").forEach(el=>el.removeAttribute("id"));
        clone.querySelectorAll("button,input,select,textarea,a").forEach(el=>{ el.setAttribute("tabindex","-1"); el.style.pointerEvents="none"; });
        target.appendChild(clone);
      }
    }
    document.querySelectorAll(".save-step-pill[data-save-step]").forEach(el=>el.dataset.status="pending");
    const chip=document.getElementById("saveRosterStatusChip"); if(chip) chip.textContent="Enregistrement en cours…";
  }
  if(variant === "sync-anime"){
    applyCharacterPortrait(document.getElementById("runnerPortrait"), currentUserDiscordId, portraitStyle);
    // (19/10, demandé) C'est un autre haut gradé, tiré au sort, qui
    // vient récupérer le dossier — jamais la même personne que celle
    // qui court, jamais un visage générique.
    const others = Object.keys(CHARACTER_APPEARANCES).filter(id => id !== canonicalCharacterId(currentUserDiscordId) && !isAnimationCharacterExcluded(id));
    const nurseId = others.length ? others[Math.floor(Math.random()*others.length)] : null;
    applyCharacterPortrait(document.getElementById("nursePortrait"), nurseId, portraitStyle);
  }
  if(variant === "save-anime"){
    // (19/10, demandé) Le médecin, c'est la personne connectée ; le
    // "patient" soigné est un autre haut gradé tiré au sort — jamais
    // soi-même.
    applyCharacterPortrait(document.getElementById("medicPortrait"), currentUserDiscordId, portraitStyle);
    const others2 = Object.keys(CHARACTER_APPEARANCES).filter(id => id !== canonicalCharacterId(currentUserDiscordId) && !isAnimationCharacterExcluded(id));
    const patientId = others2.length ? others2[Math.floor(Math.random()*others2.length)] : null;
    applyCharacterPortrait(document.getElementById("patientPortrait"), patientId, portraitStyle);
  }
  // (19/10, demandé) Bouton vert désactivé = retour exact au comportement
  // d'avant toutes ces scènes : aucun écran du tout, juste le texte du
  // bouton qui change et le message final — jamais une version "figée"
  // de l'animation. setLiaisonStep/finishLiaisonOverlay/hideLiaisonOverlay
  // restent appelables sans erreur pendant ce temps (l'élément existe,
  // juste jamais rendu visible).
  if(!liaisonReduced()){
    overlay.hidden = false;
    const dlg = overlay.querySelector(".liaison-dialog");
    if(dlg) dlg.focus({preventScroll:true});
  } else {
    overlay.hidden = true;
  }

  const counterEl = document.getElementById("liaisonCounter");
  counterEl.hidden = true;
  if(liaisonCounterTimer){ clearInterval(liaisonCounterTimer); liaisonCounterTimer = null; }
  if(meta.counter && !liaisonReduced()) tickLiaisonCounter(meta.counter);
  if(!liaisonReduced()) liaisonSceneTimer=setTimeout(()=>{ if(overlay.dataset.state==="loading") overlay.classList.add("scene-paused"); }, Math.min(Math.max(liaisonCurrentMinMs + 350, 5350), 6500));
  return overlay;
}
function setLiaisonStep(index, status, subtitle){
  const li = document.querySelector(`#liaisonSteps .liaison-step[data-step="${index}"]`);
  if(li){
    li.dataset.status = status;
    const dot = li.querySelector(".liaison-step-dot");
    if(dot) dot.textContent = status==="done" ? "✓" : status==="failed" ? "✕" : "";
  }
  const currentOverlay = document.getElementById("liaisonOverlay");
  if(currentOverlay && currentOverlay.dataset.variant === "save-roster-ui"){
    const visualStep = currentOverlay.querySelector(`.save-step-pill[data-save-step="${index}"]`);
    if(visualStep) visualStep.dataset.status = status;
  }
  if(currentOverlay && currentOverlay.dataset.variant === "sync-handoff"){
    const visualStep = currentOverlay.querySelector(`#syncStepStrip .sync-step-pill[data-step="${index}"]`);
    if(visualStep) visualStep.dataset.status = status;
    const syncChip = document.getElementById("syncHandoffStatusChip");
    if(syncChip && status === "active" && subtitle) syncChip.textContent = subtitle.replace(/…$/,'');
  }
  if(subtitle) document.getElementById("liaisonSubtitle").textContent = subtitle;
}
const LIAISON_FINISH_WORDS = {
  success: "terminé(e) avec succès", partial: "partiellement terminé(e)", error: "n’a pas abouti",
};
function finishLiaisonOverlay(state, message, subtitle){
  const overlay = document.getElementById("liaisonOverlay");
  overlay.dataset.state = state;
  if(liaisonSceneTimer){ clearTimeout(liaisonSceneTimer); liaisonSceneTimer=null; }
  overlay.classList.add("scene-paused");
  if(liaisonCounterTimer){ clearInterval(liaisonCounterTimer); liaisonCounterTimer = null; }
  const variant = overlay.dataset.variant;
  if(variant === "save-vault") document.getElementById("vaultLockIcon").textContent = state==="error" ? "🔓" : "🔒";
  const meta = LIAISON_META[variant] || {};
  const baseLabel = (meta.subtitle || "Opération").replace(/…$/,"");
  const fallback = `${baseLabel} ${LIAISON_FINISH_WORDS[state] || ""}.`;
  document.getElementById("liaisonSubtitle").textContent = subtitle || fallback;
  document.getElementById("liaisonResult").textContent = message;
  if(variant === "sync-handoff"){
    const chip=document.getElementById("syncHandoffStatusChip");
    if(chip) chip.textContent = state==="success" ? "✓ Synchronisation confirmée" : state==="partial" ? "⚠ Synchronisation partielle" : "✕ Synchronisation échouée";
  }
  if(variant === "save-roster-ui"){
    const chip=document.getElementById("saveRosterStatusChip");
    if(chip) chip.textContent = state==="success" ? "✓ Enregistrement confirmé" : state==="partial" ? "Enregistrement partiel" : "Échec de l’enregistrement";
  }
}
function hideLiaisonOverlay(restoreFocus){
  const overlay = document.getElementById("liaisonOverlay");
  overlay.hidden = true;
  if(liaisonSceneTimer){ clearTimeout(liaisonSceneTimer); liaisonSceneTimer=null; }
  overlay.classList.remove("scene-paused");
  if(liaisonCounterTimer){ clearInterval(liaisonCounterTimer); liaisonCounterTimer = null; }
  const trigger = liaisonTrigger; liaisonTrigger = null;
  if(restoreFocus && trigger && trigger.isConnected && !trigger.disabled){
    try{ trigger.focus({preventScroll:true}); }catch(e){ trigger.focus(); }
  }
}
async function liaisonMinDelay(startedAt, minMs){
  if(liaisonSkipped || liaisonReduced()) return;
  const remaining = Math.min(minMs - (Date.now()-startedAt), LIAISON_MAX_EXTRA_MS);
  if(remaining > 0) await new Promise(r=>setTimeout(r, remaining));
}
document.getElementById("liaisonSkipBtn").addEventListener("click", ()=>{
  liaisonSkipped = true;
  hideLiaisonOverlay(true);
});
document.getElementById("animsToggleBtn").addEventListener("click", ()=>{
  if(rosterAnimsLocked){
    toast("🔒 Tes animations ont été désactivées par la Direction — tu ne peux pas les réactiver toi-même.");
    return;
  }
  rosterAnimsEnabled = !rosterAnimsEnabled;
  try{ localStorage.setItem("rosterAnimsEnabled", rosterAnimsEnabled ? "1" : "0"); }catch(e){}
  applyAnimsToggleUi();
  toast(rosterAnimsEnabled ? "🎬 Animations réactivées (Roster + Pillbox)" : "⏸️ Animations désactivées (Roster + Pillbox)");
  writeAnimPrefToCloud(rosterAnimsEnabled);
});
document.addEventListener("keydown", event=>{
  const overlay = document.getElementById("liaisonOverlay");
  if(!overlay || overlay.hidden) return;
  if(event.key === "Escape"){
    event.preventDefault(); event.stopPropagation();
    document.getElementById("liaisonSkipBtn").click();
  } else if(event.key === "Tab"){
    event.preventDefault();
    overlay.querySelector(".liaison-dialog")?.focus({preventScroll:true});
  }
});
applyAnimsToggleUi();

async function syncWithPillbox(){
  const btn = document.getElementById("btnSyncPillbox");
  const statusEl = document.getElementById("syncPillboxStatus");
  const canAll = hasCap("sync_pillbox_complete");
  const syncStartedAt = Date.now();

  const stepLabels = canAll
    ? ["Roster", "Formation Opération", "Formation (activité)", "Psychologie (activité)"]
    : ["Formation (activité)", "Psychologie (activité)"];
  showLiaisonOverlay("sync", "Synchronisation avec Pillbox", stepLabels, btn);
  let stepIdx = 0;

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = "🔄 Synchronisation en cours…";
  if(statusEl) statusEl.textContent = "";

  const done = [];
  const failed = [];

  // 1) Roster + Formation Opération — réservé ADD+ (comme sync_pillbox_complete)
  if(canAll){
    setLiaisonStep(stepIdx, "active", "Envoi du Roster…");
    try{
      const text = buildPlainList();
      const currentRes = await fetch(withFirebaseAuth(CLOUD_DB_URL));
      const currentText = currentRes.ok ? ((await currentRes.json().catch(()=>null))?.text || "") : "";
      const roleNames = new Set(ROLES_REF.map(r=>r.name.toLowerCase()));
      const before = parseDiscordIdsText(currentText);
      const after = parseDiscordIdsText(text);
      let diffCount = 0;
      Object.keys(after).forEach(n=>{ if(!roleNames.has(n) && (before[n]!==after[n])) diffCount++; });
      Object.keys(before).forEach(n=>{ if(!roleNames.has(n) && !(n in after)) diffCount++; });
      const activeEmployeeCount = employees.filter(e=>!e.licencie).length;
      await protectedAction("syncPillboxRoster", {text, employeeCount:activeEmployeeCount});
      done.push(`Roster${diffCount ? ` (${diffCount} changement(s))` : ""}`);
      setLiaisonStep(stepIdx, "done");
    }catch(err){ failed.push(`Roster (${err.message})`); setLiaisonStep(stepIdx, "failed"); }
    stepIdx++;

    setLiaisonStep(stepIdx, "active", "Envoi de la Formation Opération…");
    try{
      const {text, count} = buildFormationSendList();
      if(count){
        await protectedAction("syncFormationOperation", {text});
        done.push(`Formation Opération (${count})`);
      }
      setLiaisonStep(stepIdx, "done");
    }catch(err){ failed.push(`Formation Opération (${err.message})`); setLiaisonStep(stepIdx, "failed"); }
    stepIdx++;
  }

  // 2) Formateur + Psychologue — MC et au-dessus, via le circuit déjà
  // protégé côté serveur (activite-actions.js, inchangé).
  setLiaisonStep(stepIdx, "active", "Synchronisation Formation…");
  try{ await saveActiviteToCloud("formateur"); done.push("Formation"); setLiaisonStep(stepIdx, "done"); }
  catch(err){ failed.push(`Formation (${err.message})`); setLiaisonStep(stepIdx, "failed"); }
  stepIdx++;

  setLiaisonStep(stepIdx, "active", "Synchronisation Psychologie…");
  try{ await saveActiviteToCloud("psychologue"); done.push("Psychologie"); setLiaisonStep(stepIdx, "done"); }
  catch(err){ failed.push(`Psychologie (${err.message})`); setLiaisonStep(stepIdx, "failed"); }

  // L’overlay reste visible au moins 2.2 secondes (sauf si passée ou
  // animations désactivées), sans jamais ralentir un envoi plus long.
  await liaisonMinDelay(syncStartedAt, liaisonCurrentMinMs);
  let overlayState, overlayMessage;
  if(!failed.length){
    overlayState="success"; overlayMessage="Synchronisé avec Pillbox";
  } else if(done.length){
    overlayState="partial"; overlayMessage="Synchronisation partielle";
  } else {
    overlayState="error"; overlayMessage="Échec de la synchronisation";
  }
  finishLiaisonOverlay(overlayState, overlayMessage,
    overlayState==="success" ? "Toutes les étapes ont réussi." : overlayState==="partial" ? "Certaines étapes ont échoué." : "Aucune étape n’a pu être synchronisée.");
  if(statusEl){
    if(!failed.length){
      statusEl.innerHTML = `<span style="color:var(--green);">✅ Synchronisation Pillbox terminée — ${esc(done.join(", "))}.</span>`;
    } else if(done.length){
      statusEl.innerHTML = `<span style="color:var(--amber);">⚠️ Partiellement synchronisé — ✓ ${esc(done.join(", "))} | ✕ ${esc(failed.join(", "))}.</span>`;
    } else {
      statusEl.innerHTML = `<span style="color:var(--red);">❌ La synchronisation a rencontré une erreur : ${esc(failed.join(", "))}.</span>`;
    }
  }
  // Garde l’état final visible un court instant, puis libère l’interface.
  if(!liaisonSkipped && !liaisonReduced()) await waitForSyncOverlay(1000);
  hideLiaisonOverlay(true);
  btn.disabled = false;
  btn.innerHTML = original;
}

document.getElementById("btnSyncPillbox").addEventListener("click", syncWithPillbox);
// (btnCloudSend retiré le 09/09 — remplacé par le bouton unique
// "🔄 Synchroniser avec Pillbox", voir syncWithPillbox() plus haut,
// qui fait exactement la même chose : lecture, comparaison, envoi.)

// ═══════════════════════════ ROSTER SUR TOUS LES PC (CLOUD) ═══════════════════════════
// Chemin Firebase DIFFÉRENT de celui utilisé pour Pillbox (discordIdsList) :
// ici on sauvegarde la liste COMPLÈTE (grades, rôles, licenciés...), pas
// juste "Nom : ID". Explicitement Sauvegarder/Charger (pas de synchronisation
// automatique en continu) — plus sûr : si deux personnes modifient le
// roster en même temps sur deux PC différents, personne n'écrase le
// travail de l'autre sans s'en rendre compte.
const ROSTER_CLOUD_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";

// (10/10, demandé) Les anciens boutons manuels "Sauvegarder"/"Charger
// (tous les PC)" ont été retirés — voir saveState()/loadState() plus
// bas, qui font maintenant ça automatiquement, en continu, sans action
// de la part de qui que ce soit.

// Ferme automatiquement un menu "☁️ ... (cloud)" une fois qu'on a cliqué
// un bouton dedans, ou si on clique ailleurs sur la page — sinon il
// resterait ouvert après l'action, ce qui serait gênant.
document.querySelectorAll("details.cloud-group").forEach(d=>{
  d.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click", ()=>{ d.open = false; });
  });
});
document.addEventListener("click", (e)=>{
  document.querySelectorAll("details.cloud-group[open]").forEach(d=>{
    if(!d.contains(e.target)) d.open = false;
  });
});

document.getElementById("btnExport").addEventListener("click", ()=>{
  const payload = JSON.stringify(employees, null, 2);
  const a = document.createElement("a");
  a.href = `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`;
  a.download = `roster-ems-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  toast("Export téléchargé");
});

document.getElementById("importFile").addEventListener("change", (evt)=>{
  const file = evt.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      if(!Array.isArray(data)) throw new Error("format invalide");
      if(!confirm(`Importer ${data.length} employé(s) ? Ça remplace la liste actuelle.`)) return;
      employees = data;
      saveState(); renderAll(); populateGradeSelects(); renderRoles();
      toast("Import réussi");
    }catch(e){ alert("Fichier invalide : "+e.message); }
  };
  reader.readAsText(file);
  evt.target.value = "";
});

document.getElementById("btnReset").addEventListener("click", ()=>{
  if(!confirm("Réinitialiser avec la liste de départ ? Toutes les modifications actuelles seront perdues.")) return;
  employees = SEED_EMPLOYEES.map(e=>({...e}));
  saveState(); renderAll();
  toast("Liste réinitialisée");
});

function renderHistoryList(){
  const box = document.getElementById("historyList");
  if(!history.length){
    box.innerHTML = `<div class="empty-msg">Aucun changement enregistré pour l'instant.</div>`;
    return;
  }
  box.innerHTML = history.map(h=>`
    <div style="padding:8px 0;border-bottom:1px solid var(--border-soft);font-size:0.82rem;">
      <span style="color:var(--text-faint);">${esc(h.when)}</span> —
      <b>${esc(h.action)}</b> : ${esc(h.name)}
      ${h.detail ? `<div style="color:var(--text-dim);font-size:0.76rem;margin-top:2px;">${esc(h.detail)}</div>` : ""}
    </div>
  `).join("");
}
document.getElementById("btnShowHistory").addEventListener("click", ()=>{
  renderHistoryList();
  document.getElementById("historyModal").style.display = "flex";
});
document.getElementById("btnCloseHistory").addEventListener("click", ()=>{
  document.getElementById("historyModal").style.display = "none";
});
document.getElementById("btnClearHistory").addEventListener("click", ()=>{
  if(!confirm("Vider tout l'historique des changements ? Cette action est irréversible.")) return;
  history = [];
  try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }catch(e){}
  renderHistoryList();
  toast("Historique vidé");
});

// ═══════════════════════════ SUIVI D'ACTIVITÉ (Formateur / Psychologue) ═══════════════════════════
// Une seule donnée partagée entre les deux onglets ({recrutements,
// formations} pour MF/RF, {testsPsy,ppa} pour MP/RP) — semaine en cours
// uniquement. Clé par idUnique si connu, sinon par nom en minuscules.
// Pillbox le lit pour les avertissements quota ET pour son Tableau de bord,
// mais recroise toujours ces données avec les grades actuels du Roster.
const ACTIVITE_KEY = "rosterActiviteSuivi_v1";
const ACTIVITE_STREAK_KEY = "rosterActiviteStreak_v1";
const ACTIVITE_CLOUD_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/activiteSuivi.json";
let activiteData = {};
// Historique léger : juste un compteur de semaines consécutives à 0
// (recrutements+formations, ou tests psy+PPA), PAS le détail des
// chiffres semaine par semaine — suffisant pour repérer "ça fait
// plusieurs semaines que...", sans reconstruire un vrai historique complet
// (demandé le 07/09, malgré la décision initiale de n'avoir aucun
// historique — nécessaire pour compter plusieurs semaines de suite).
// { [key]: { streak: number } }
let activiteStreak = {};
// Absences détectées dans le tableau EMS collé cette semaine (colonne
// Absences non vide) — liste de {idUnique, name}, sert UNIQUEMENT à
// mettre la série en pause au moment de clôturer la semaine, jamais à
// modifier les chiffres eux-mêmes.
const WEEK_ABSENCES_KEY = "rosterWeekAbsences_v1";
let weekAbsences = [];
function loadWeekAbsences(){
  try{
    const raw = localStorage.getItem(WEEK_ABSENCES_KEY);
    weekAbsences = raw ? JSON.parse(raw) : [];
  }catch(e){ weekAbsences = []; }
}
function saveWeekAbsences(){
  try{ localStorage.setItem(WEEK_ABSENCES_KEY, JSON.stringify(weekAbsences)); }catch(e){}
}

function activiteKeyFor(e){ return e.idUnique ? `id:${e.idUnique}` : `name:${e.name.trim().toLowerCase()}`; }
// Résolution inverse (09/09) — pour l'historique des semaines, qui ne
// stocke que la clé technique, jamais un nom en clair à part. Retombe
// sur la clé elle-même (lisiblement) si la personne n'est plus dans le
// Roster actuel (licenciée depuis, ou renommée) — jamais une erreur.
function resolveActiviteKeyToName(key){
  if(key.startsWith("id:")){
    const id = key.slice(3);
    const emp = employees.find(e=>e.idUnique===id);
    return emp ? emp.name : `(ID unique ${id}, introuvable dans le Roster actuel)`;
  }
  if(key.startsWith("name:")){
    const nameLower = key.slice(5);
    const emp = employees.find(e=>e.name.trim().toLowerCase()===nameLower);
    return emp ? emp.name : `(${nameLower}, introuvable dans le Roster actuel)`;
  }
  return key;
}

function loadActiviteData(){
  try{
    const raw = localStorage.getItem(ACTIVITE_KEY);
    activiteData = raw ? JSON.parse(raw) : {};
  }catch(e){ activiteData = {}; }
  try{
    const rawStreak = localStorage.getItem(ACTIVITE_STREAK_KEY);
    activiteStreak = rawStreak ? JSON.parse(rawStreak) : {};
  }catch(e){ activiteStreak = {}; }
}
function saveActiviteData(){
  try{ localStorage.setItem(ACTIVITE_KEY, JSON.stringify(activiteData)); }catch(e){}
}
function saveActiviteStreak(){
  try{ localStorage.setItem(ACTIVITE_STREAK_KEY, JSON.stringify(activiteStreak)); }catch(e){}
}

// Analyse un collage du tableau EMS pour en tirer uniquement la liste des
// personnes absentes cette semaine (colonne Absences non vide) — même
// découpage de ligne que le reste du Roster (splitEmsLine), colonne 5
// (Dossier, Employé, ID unique, Grade, Info, Absences...).
// ── Parsing des dates d'absence — repris TEL QUEL de Pillbox (déjà
// construit et testé là-bas), pour vérifier si une absence notée dans le
// tableau EMS est encore active AUJOURD'HUI ou si sa date de fin est
// déjà passée (le site EMS ne vide pas toujours le champ tout seul une
// fois l'absence terminée — demandé le 07/09). ──────────────────────────
function addDaysAbs(d,n){ const r=new Date(d); r.setDate(r.getDate()+n); return r; }
const MONTH_NAMES_FR_ABS = {
  janvier:1, janv:1, fevrier:2, fevr:2, mars:3, avril:4, avr:4, mai:5, juin:6,
  juillet:7, juil:7, aout:8, aou:8, septembre:9, sept:9, octobre:10, oct:10,
  novembre:11, nov:11, decembre:12, dec:12,
};
function stripAccentsAbs(s){ return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""); }
function extractDateTriplesAbs(raw){
  if(!raw) return [];
  const results = [];
  const seen = new Set();
  const numRe = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g;
  let m;
  while((m = numRe.exec(raw))){
    results.push({ idx:m.index, d:+m[1], mo:+m[2], y:m[3]? (m[3].length===2?2000+ +m[3]:+m[3]) : null });
    seen.add(m.index);
  }
  const textRe = /(\d{1,2})\s*(?:er)?\s+([a-zéèêûôîàâ]+)\.?(?:\s+(\d{2,4}))?/gi;
  while((m = textRe.exec(raw))){
    const moNum = MONTH_NAMES_FR_ABS[stripAccentsAbs(m[2])];
    if(!moNum) continue;
    if(seen.has(m.index)) continue;
    results.push({ idx:m.index, d:+m[1], mo:moNum, y:m[3]? (m[3].length===2?2000+ +m[3]:+m[3]) : null });
  }
  results.sort((a,b)=>a.idx-b.idx);
  return results;
}
function parseAbsenceRange(raw, refDate){
  if(!raw) return {start:null,end:null,unclear:false};
  const matches = extractDateTriplesAbs(raw);
  if(matches.length===0){
    const dayOnly = [...raw.matchAll(/\b([0-3]?\d)\b/g)].map(m=>+m[1]).filter(d=>d>=1 && d<=31);
    if(dayOnly.length>=1){
      const refYear = refDate.getFullYear();
      const refMonth = refDate.getMonth();
      const start = new Date(refYear, refMonth, dayOnly[0]);
      let end = dayOnly[1]!==undefined ? new Date(refYear, refMonth, dayOnly[1]) : null;
      if(!end){ end = addDaysAbs(start,7); }
      else if(end < start){ end = new Date(refYear, refMonth+1, dayOnly[1]); }
      return {start,end,unclear:false};
    }
    return {start:null,end:null,unclear:true};
  }
  const toDate = ({d,mo,y})=> new Date(y||refDate.getFullYear(), mo-1, d);
  const start = toDate(matches[0]);
  let end = matches[1]? toDate(matches[1]) : null;
  if(!end){ end = addDaysAbs(start,7); }
  return {start,end,unclear:false};
}
// Une absence est encore active si sa date de fin n'est pas déjà passée
// par rapport à AUJOURD'HUI (le Roster n'a pas de notion de "semaine
// traitée" comme Pillbox — comparaison directe à la date du jour). Si la
// date est illisible (unclear), on reste prudent et on la considère
// active plutôt que de risquer de rater une vraie absence en cours.
function isAbsenceStillActive(absencesRaw){
  if(!absencesRaw) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const parsed = parseAbsenceRange(absencesRaw, today);
  if(parsed.unclear) return true;
  if(!parsed.end) return true;
  return parsed.end >= today;
}

function parseWeekAbsences(text){
  const lines = (text||"").split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const absences = []; // {idUnique, name} — on garde les deux pour matcher par n'importe lequel des deux
  lines.forEach(line=>{
    if(/^Dossier\b/i.test(line)) return; // ignore la ligne d'en-tête du tableau
    const cols = splitEmsLine(line);
    if(cols.length < 6) return;
    const employeRaw = (cols[1]||"").trim();
    const idUnique = (cols[2]||"").trim();
    const absencesRaw = (cols[5]||"").trim();
    if(!employeRaw || !absencesRaw) return;
    // Ignore une absence dont la date de fin est déjà passée — le champ
    // peut rester affiché sur le site EMS bien après la fin réelle,
    // sans que ça veuille dire que la personne est encore absente
    // (demandé le 07/09).
    if(!isAbsenceStillActive(absencesRaw)) return;
    const name = cleanEmsName(employeRaw);
    if(!name) return;
    absences.push({ idUnique, name });
  });
  return absences;
}

// Beaucoup de fiches du Roster n'ont pas forcément leur "ID unique" EMS
// renseigné (champ optionnel) — on vérifie donc par ID EN PLUS du nom,
// jamais l'un sans l'autre, comme pour hasFormationOperation côté
// Pillbox (bug corrigé le 07/09 : la correspondance par ID seul ratait
// silencieusement beaucoup de monde).
// (13/10, section 8 du cahier des charges V2) Avant : basé sur le texte
// brut de la colonne "Absences" du dernier tableau EMS collé
// (weekAbsences) — un signal "du jour", jamais le registre OFFICIEL des
// absences (rosterAbsences/absencesCache, le seul que Prise en compte
// ADD+ valide réellement). Les deux systèmes sont volontairement
// distincts (planning hebdomadaire vs registre officiel) — ce n'est
// donc QUE le registre officiel qui doit mettre en pause une série.
// Renvoie l'absence officielle concernée (avec ses vraies dates), ou
// null si personne n'est officiellement absent en ce moment pour cette
// personne — jamais un simple booléen, pour permettre l'affichage des
// dates exactes (section 8.3).
// "Couvre la semaine en cours" = l'absence est en cours aujourd'hui, ou
// vient de se terminer il y a 7 jours ou moins (laisse le temps à la
// clôture hebdomadaire de la voir une dernière fois avant que le
// nettoyage automatique de absences-actions.js ne la retire).
function officialAbsenceFor(e){
  const now = new Date(); now.setHours(0,0,0,0);
  const recentCutoff = new Date(now.getTime() - 7*86400000);
  let best = null;
  Object.values(absencesCache||{}).forEach(a=>{
    if(!a || a.priseEnCompte !== true) return;
    const matches = (e.idUnique && a.employeeKey===`id:${e.idUnique}`) ||
      (a.name && e.name && a.name.trim().toLowerCase()===e.name.trim().toLowerCase());
    if(!matches) return;
    const start = new Date(`${a.startIso}T00:00:00`);
    const end = new Date(`${a.endIso}T00:00:00`);
    if(isNaN(start.getTime()) || isNaN(end.getTime())) return;
    const ongoing = start <= now && now <= end;
    const justEnded = end < now && end >= recentCutoff;
    if(ongoing || justEnded){
      // Si plusieurs absences qualifient (rare), garde la plus récente.
      if(!best || end > new Date(`${best.endIso}T00:00:00`)) best = a;
    }
  });
  return best;
}
function isAbsentThisWeek(e){ return !!officialAbsenceFor(e); }

// (13/10, section 8.3) Remplace l'ancien message générique "absent(e)
// cette semaine — série mise en pause" par les dates réelles de
// l'absence officielle, avec la mention "absence en cours" si la date
// de fin stockée n'est pas encore dépassée aujourd'hui.
function formatAbsencePauseLabel(a){
  const now = new Date(); now.setHours(0,0,0,0);
  const fmt = iso => {
    const d = new Date(`${iso}T00:00:00`);
    return isNaN(d.getTime()) ? (iso||"date inconnue") : `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
  };
  const end = new Date(`${a.endIso}T00:00:00`);
  const ongoing = !isNaN(end.getTime()) && end >= now;
  // (14/10, demandé) Même en cours, la date de fin ENREGISTRÉE (retour
  // prévu) est affichée en plus de la date de début — jamais omise.
  return ongoing
    ? `Absent(e) depuis le ${fmt(a.startIso)}, retour prévu le ${fmt(a.endIso)} (absence en cours) — série d'activité mise en pause.`
    : `Absent(e) du ${fmt(a.startIso)} au ${fmt(a.endIso)} — série d'activité mise en pause.`;
}

// ═══════════════════════════════════════════════════════════════════
// ABSENCES DE PLUS DE 3 JOURS (03/10) — catégorie séparée, suivi des
// récurrences sur une fenêtre glissante de 30 jours, signalement
// transmis à Pillbox pour décision humaine (jamais automatique).
// ═══════════════════════════════════════════════════════════════════
const ABSENCES_CLOUD_URL_BASE = "/.netlify/functions/absences-actions";
let absencesCache = {}; // { [id]: {employeeKey, name, grade, startIso, endIso, durationDays, priseEnCompte, createdAt} }

// Extrait, depuis le MÊME collage EMS que celui utilisé pour tout le
// reste (étape "Importer depuis le tableau EMS"), uniquement les
// absences qualifiantes : durée RÉELLE strictement supérieure à 3
// jours (section 2 du cahier des charges — 3 jours ou moins, jamais
// comptabilisée). Contrairement à parseWeekAbsences ci-dessus (qui ne
// garde que les absences ENCORE actives aujourd'hui, pour mettre en
// pause le suivi d'activité), ici on garde TOUTE absence qualifiante,
// même déjà terminée — c'est tout l'intérêt : la conserver avant
// qu'elle ne disparaisse du tableau les semaines suivantes.
function extractQualifyingAbsences(text){
  const lines = (text||"").split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const today = new Date(); today.setHours(0,0,0,0);
  const result = [];
  lines.forEach(line=>{
    if(/^Dossier\b/i.test(line)) return;
    const cols = splitEmsLine(line);
    if(cols.length < 6) return;
    const employeRaw = (cols[1]||"").trim();
    const idUnique = (cols[2]||"").trim();
    const gradeRaw = (cols[3]||"").trim().toUpperCase();
    const absencesRaw = (cols[5]||"").trim();
    if(!employeRaw || !absencesRaw) return;
    const name = cleanEmsName(employeRaw);
    if(!name) return;
    const parsed = parseAbsenceRange(absencesRaw, today);
    if(parsed.unclear || !parsed.start || !parsed.end) return;
    // Durée réelle inclusive (ex: 04/10 -> 07/10 = 4 jours : 04,05,06,07).
    const durationDays = Math.round((parsed.end - parsed.start) / 86400000) + 1;
    if(durationDays <= 3) return; // section 2 : ignorée, jamais stockée
    const emp = (idUnique && employees.find(e=>e.idUnique && String(e.idUnique)===String(idUnique)))
      || employees.find(e=>employeeNameMatches(e,norm(name)));
    const resolvedGrade = emp ? emp.grade : (gradeRaw||null);
    // (10/10, demandé) Grade WDV jamais suivi comme absence — leur
    // absence du tableau EMS est déjà connue/attendue par ce statut,
    // pas un cas à faire remonter dans le système de 3 absences/30j.
    if(resolvedGrade === "WDV") return;
    // (19/10, demandé) MC et au-dessus : jamais pris en compte ni
    // comptabilisé comme absence — ni enregistré, ni affiché, ni
    // compté nulle part (avant : seulement exclus de la proposition
    // automatique de licenciement, mais visibles dans la liste).
    if(["MC","ADD","CD","D","DG"].includes(resolvedGrade)) return;
    const employeeKey = emp ? activiteKeyFor(emp) : (idUnique ? `id:${idUnique}` : `name:${norm(name)}`);
    result.push({
      employeeKey, name: emp ? emp.name : name, grade: resolvedGrade,
      startIso: parsed.start.toISOString().slice(0,10), endIso: parsed.end.toISOString().slice(0,10),
      durationDays,
    });
  });
  return result;
}

// Synchronise vers le cloud (fonction serveur dédiée — jamais d'écriture
// directe sur Firebase ici, section 24/Firebase du cahier des charges).
// N'ajoute QUE les nouvelles absences détectées — le serveur ignore déjà
// tout doublon (même clé), mais on ne renvoie de toute façon que les
// absences qualifiantes trouvées dans CE collage précis.
async function syncQualifyingAbsences(text){
  if(!currentSessionToken) return; // pas connecté : rien à synchroniser silencieusement
  const qualifyingAbsences = extractQualifyingAbsences(text);
  if(!qualifyingAbsences.length) return;
  try{
    const res = await fetch(ABSENCES_CLOUD_URL_BASE, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"sync", qualifyingAbsences }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    if(data.absences) absencesCache = data.absences;
    if(data.added > 0) toast(`📅 ${data.added} nouvelle(s) absence(s) qualifiante(s) enregistrée(s)`);
    renderAbsencesTab();
  }catch(err){
    console.error("Synchronisation des absences impossible:", err.message);
  }
}

async function loadAbsencesFromCloud(){
  if(!currentSessionToken) return;
  try{
    const res = await fetch(`${ABSENCES_CLOUD_URL_BASE}?token=${encodeURIComponent(currentSessionToken)}`);
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    absencesCache = data.absences || {};
    renderAbsencesTab();
  }catch(err){
    const box = document.getElementById("absencesList");
    if(box) box.innerHTML = `<div class="empty-msg">Impossible de charger les absences (${esc(err.message)}).</div>`;
  }
}

function renderAbsencesTab(){
  const box = document.getElementById("absencesList");
  const alertsBox = document.getElementById("absencesAlerts");
  if(!box) return;
  const canManage = hasCap("manage_absences");
  const q = norm(document.getElementById("absencesSearch")?.value || "");
  const filterPEC = document.getElementById("absencesFilterPriseEnCompte")?.value || "";

  const entries = Object.entries(absencesCache)
    .filter(([,a])=> !q || norm(a.name).includes(q))
    .filter(([,a])=> !filterPEC || (filterPEC==="oui" ? a.priseEnCompte===true : a.priseEnCompte!==true))
    .sort((a,b)=> (b[1].endIso||"").localeCompare(a[1].endIso||""));

  // (19/10, demandé) Regroupées par personne — plus un doublon par
  // absence, une seule fiche par employé avec le compte accumulé et
  // chaque période dessous (chacune garde ses propres contrôles).
  const groups = {};
  const groupOrder = [];
  entries.forEach(([id,a])=>{
    const key = a.employeeKey || `name:${norm(a.name)}`;
    if(!groups[key]){ groups[key] = { name:a.name, grade:a.grade, periods:[] }; groupOrder.push(key); }
    groups[key].periods.push([id,a]);
  });

  // Signalements (section 16/17) : affichés comme simple information ici
  // aussi — pas de décision prise dans le Roster lui-même, uniquement
  // dans Pillbox au moment des paies (section 17 : décision humaine,
  // jamais automatique).
  const signalements = computeSignalementsLocal(absencesCache);
  alertsBox.innerHTML = signalements.length ? `<div class="hint" style="border-color:var(--amber);display:flex;flex-direction:column;gap:4px;">
    ${signalements.map(s=>`<div>⚠ <b>${esc(s.name)}</b> : ${s.absences.length} absences prises en compte sur les 30 derniers jours — transmis à Pillbox pour décision au moment des paies.</div>`).join("")}
  </div>` : "";

  box.innerHTML = groupOrder.length ? groupOrder.map(key=>{
    const g = groups[key];
    const periodsHtml = g.periods.map(([id,a])=>`
      <div class="special-row" style="grid-template-columns:minmax(110px,.8fr) minmax(110px,.8fr) minmax(70px,.5fr) auto;padding-left:18px;border-left:2px solid var(--border);">
        <span class="special-id">${esc(a.startIso)}</span>
        <span class="special-id">→ ${esc(a.endIso)}</span>
        <span style="color:var(--text-dim);">${a.durationDays||"?"} j</span>
        <span style="display:flex;align-items:center;gap:8px;">
          <span style="font-weight:700;color:${a.priseEnCompte?'var(--green)':'var(--text-faint)'};">${a.priseEnCompte?'OUI':'NON'}</span>
          ${canManage ? `<button class="btn-ghost btn-small" data-toggle-pec="${esc(id)}" data-current="${a.priseEnCompte?'1':'0'}">${a.priseEnCompte?'Passer à NON':'Passer à OUI'}</button>
          <button class="btn-danger btn-small" data-delete-absence="${esc(id)}" title="À réserver aux erreurs de donnée (mauvaise date, doublon...) — pour exempter une vraie absence, utilise plutôt Prise en compte : NON, qui garde l'historique.">🗑 Supprimer</button>` : ""}
        </span>
      </div>
    `).join("");
    return `
    <div class="absence-group" style="margin-bottom:10px;">
      <div class="special-row" style="grid-template-columns:minmax(150px,1.3fr) minmax(90px,.6fr) auto;background:var(--panel-2);border-radius:8px 8px 0 0;">
        <span><b>${esc(g.name)}</b></span>
        <span style="color:var(--text-dim);">${esc(g.grade||"—")}</span>
        <span style="font-weight:700;color:${g.periods.length>=3?'var(--red)':g.periods.length===2?'var(--amber)':'var(--text-dim)'};">${g.periods.length} absence${g.periods.length>1?"s":""}</span>
      </div>
      ${periodsHtml}
    </div>`;
  }).join("") : `<div class="empty-msg">Aucune absence de plus de 3 jours enregistrée pour ce filtre.</div>`;

  box.querySelectorAll("[data-toggle-pec]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.dataset.togglePec;
      const newValue = btn.dataset.current !== "1";
      btn.disabled = true;
      try{
        const res = await fetch(ABSENCES_CLOUD_URL_BASE, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ token: currentSessionToken, action:"setPriseEnCompte", absenceId:id, priseEnCompte:newValue }),
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(data.error || `${res.status}`);
        absencesCache[id] = { ...absencesCache[id], priseEnCompte:newValue };
        toast(`✓ Prise en compte : ${newValue?"OUI":"NON"}`);
        renderAbsencesTab();
      }catch(err){
        toast(`✕ Refusé : ${err.message}`);
        btn.disabled = false;
      }
    });
  });

  box.querySelectorAll("[data-delete-absence]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.dataset.deleteAbsence;
      const entry = absencesCache[id];
      const label = entry ? `${entry.name} (${entry.startIso} → ${entry.endIso})` : "cette absence";
      if(!confirm(`Supprimer définitivement ${label} ? Réservé aux erreurs de donnée — pour une vraie absence que tu veux juste exempter, préfère "Passer à NON", qui garde l'historique. Cette suppression-ci est irréversible.`)) return;
      btn.disabled = true;
      try{
        const res = await fetch(ABSENCES_CLOUD_URL_BASE, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ token: currentSessionToken, action:"delete", absenceId:id }),
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(data.error || `${res.status}`);
        delete absencesCache[id];
        toast("✓ Absence supprimée");
        renderAbsencesTab();
      }catch(err){
        toast(`✕ Refusé : ${err.message}`);
        btn.disabled = false;
      }
    });
  });
}

// Même règle que absences-actions.js côté serveur (computeAbsenceSignalements)
// — dupliquée ici volontairement en miroir pour un affichage immédiat côté
// Roster sans aller-retour serveur supplémentaire ; le serveur reste la
// source de vérité pour ce que Pillbox reçoit réellement.
function computeSignalementsLocal(absencesObj){
  const ref = new Date();
  const windowStart = new Date(ref.getTime() - 30*24*60*60*1000);
  const byEmployee = {};
  Object.entries(absencesObj||{}).forEach(([id,a])=>{
    if(!a || a.priseEnCompte !== true) return;
    const end = new Date(a.endIso);
    if(isNaN(end.getTime()) || end < windowStart || end > ref) return;
    const key = a.employeeKey;
    (byEmployee[key] = byEmployee[key] || {employeeKey:key, name:a.name, absences:[]}).absences.push({id});
  });
  return Object.values(byEmployee).filter(e=>e.absences.length>=3);
}

document.getElementById("absencesSearch").addEventListener("input", renderAbsencesTab);
document.getElementById("absencesFilterPriseEnCompte").addEventListener("change", renderAbsencesTab);
document.getElementById("btnAbsencesRefresh").addEventListener("click", loadAbsencesFromCloud);

// Seuil d'alerte : X semaines de suite à 0 (hors semaines d'absence).
// Depuis le 29/09 il dépend du rôle : 2 semaines pour formateur/psy (MF, MP),
// 3 pour les responsables (RF, RP), qui ont moins de travail direct.
// Le signalement automatique part à chaque multiple de ce seuil.
function streakThresholdFor(e){ return ["RF","RP"].includes(((e && e.grade)||"").toUpperCase()) ? 3 : 2; }
// Compteurs saisis par pôle. Le pôle psy en a trois depuis le 29/09
// (consultations ajoutées, notées dans les tickets par les psychologues).
const ACTIVITE_FIELDS = {
  formateur:   [["recrutements","Recrutements"],["formations","Formations"]],
  psychologue: [["testsPsy","Tests psy"],["ppa","PPA"],["consultations","Consultations"]],
};

// Alertes de série fermées manuellement (10/09) — persisté localement,
// par personne, avec la valeur exacte du compteur au moment de la
// fermeture (pas juste un booléen "fermé pour toujours" — sinon
// l'alerte resterait cachée même si le compteur grimpe encore après).
const DISMISSED_ALERTS_KEY = "pillboxActiviteAlertsDismissed_v1";
function getDismissedActiviteAlerts(){
  try{ return JSON.parse(localStorage.getItem(DISMISSED_ALERTS_KEY)) || {}; }catch(e){ return {}; }
}
function saveDismissedActiviteAlerts(d){
  try{ localStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(d)); }catch(e){}
}

function renderActiviteTab(type){
  const isFormateur = type==="formateur";
  const grades = isFormateur ? ["MF","RF"] : ["MP","RP"];
  const fields = ACTIVITE_FIELDS[type];
  const list = document.getElementById(isFormateur ? "formateurList" : "psychologueList");
  const alertsBox = document.getElementById(isFormateur ? "formateurAlerts" : "psychologueAlerts");
  const label2 = isFormateur ? "PPA/tests psy" : "PPA/tests psy"; // même formulation demandée pour les deux
  const activityLabel = isFormateur ? "recrutement/formation" : "PPA/test psy/consultation";
  const concerned = employees.filter(e=>!e.licencie && grades.includes((e.grade||"").toUpperCase()));
  if(!concerned.length){
    list.innerHTML = `<div class="special-sub">Aucun employé dans un grade concerné (${grades.join("/")}) pour l'instant.</div>`;
    alertsBox.innerHTML = "";
    return;
  }
  // Alertes : quelqu'un avec une série de semaines à 0 déjà enregistrée
  // (mise à jour au clic sur "Clôturer la semaine"), au-delà du seuil.
  // Chacune peut être fermée individuellement (demandé le 10/09) — la
  // fermeture est mémorisée par personne+valeur exacte du compteur : si
  // le compteur augmente encore ensuite, l'alerte réapparaît (nouvelle
  // valeur, jamais vue), mais reste masquée tant qu'il ne bouge pas.
  const dismissedAlerts = getDismissedActiviteAlerts();
  const canReset = hasCap("reset_activite_streak");
  const alerts = concerned
    .map(e=>({ e, streak: activiteStreak[activiteKeyFor(e)]?.streak||0, key: activiteKeyFor(e) }))
    .filter(x=>x.streak >= streakThresholdFor(x.e) && dismissedAlerts[x.key] !== x.streak);
  alertsBox.innerHTML = alerts.length ? `<div class="hint" style="border-color:var(--amber);display:flex;flex-direction:column;gap:4px;">
    ${alerts.map(x=>`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <span>⚠ <b>${esc(x.e.name)}</b> : ${x.streak} semaines de suite sans ${esc(activityLabel)}</span>
      <span style="display:flex;gap:6px;">
        ${canReset ? `<button type="button" class="btn-ghost btn-small" data-reset-streak="${esc(x.key)}" style="padding:1px 8px;font-size:0.72rem;" title="Réinitialiser ce suivi à 0">🔄 Réinitialiser</button>` : ""}
        <button type="button" class="btn-ghost btn-small" data-dismiss-alert="${esc(x.key)}" data-dismiss-streak="${x.streak}" style="padding:1px 8px;font-size:0.72rem;" title="Fermer cette alerte">✕</button>
      </span>
    </div>`).join("")}
  </div>` : "";
  alertsBox.querySelectorAll("[data-dismiss-alert]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key = btn.dataset.dismissAlert;
      const streak = +btn.dataset.dismissStreak;
      const d = getDismissedActiviteAlerts();
      d[key] = streak;
      saveDismissedActiviteAlerts(d);
      renderActiviteTab(type);
    });
  });
  alertsBox.querySelectorAll("[data-reset-streak]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const key = btn.dataset.resetStreak;
      const person = concerned.find(e=>activiteKeyFor(e)===key);
      const name = person ? person.name : key;
      if(!confirm(`Voulez-vous remettre le suivi d'activité de ${name} à 0 ?`)) return;
      btn.disabled = true;
      try{
        const res = await fetch("/.netlify/functions/activite-actions", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ token: currentSessionToken, action:"resetStreak", scope: type, targetKey: key }),
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(data.error || `${res.status}`);
        activiteStreak[key] = { streak: 0, lastSignaledThreshold: 0 };
        saveActiviteStreak();
        toast(`✓ Suivi de ${name} réinitialisé`);
        renderActiviteTab(type);
      }catch(err){
        toast(`✕ Refusé : ${err.message}`);
        btn.disabled = false;
      }
    });
  });

  list.innerHTML = concerned.map(e=>{
    const key = activiteKeyFor(e);
    const rec = activiteData[key] || {};
    const absenceInfo = officialAbsenceFor(e);
    const isAbsent = !!absenceInfo;
    const inputs = fields.map(([f,label])=>`
      <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;">${esc(label)}
        <input type="number" min="0" data-activite-field="${f}" data-activite-key="${esc(key)}" value="${rec[f]||0}" style="width:64px;">
      </label>`).join("");
    // Compteur visible AVANT l'alerte (29/09) : "1 sem. à 0 sur 2", pour que
    // le signalement automatique ne surprenne personne.
    const st = activiteStreak[key]?.streak || 0;
    const thr = streakThresholdFor(e);
    const streakBadge = st>0 ? ` <span style="font-size:0.7rem;font-weight:700;color:${st>=thr?'var(--amber)':'var(--text-dim)'};">${st} sem. à 0 sur ${thr}</span>` : "";
    // "Actif mais n'a pas pu" (29/09) : valable pour la semaine en cours,
    // réservé à ADD+ (vérifié aussi côté serveur), tracé dans les journaux.
    const isExcused = rec.excused === true;
    const excusedLabel = isFormateur ? "recrutement/formation" : "PPA/test psy/consultation";
    const excusedCtl = canReset
      ? `<label style="display:flex;align-items:center;gap:6px;font-size:0.74rem;color:var(--text-dim);" title="La série de cette personne repartira à 0 à la clôture au lieu de monter. Le marqueur s'efface tout seul à la clôture.">
           <input type="checkbox" data-excused-key="${esc(key)}" data-excused-scope="${type}" ${isExcused?"checked":""}> Actif mais n'a pas pu (${excusedLabel})
         </label>`
      : (isExcused ? `<span style="font-size:0.72rem;color:var(--text-dim);">actif, n'a pas pu (${excusedLabel})</span>` : "");
    return `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-soft);">
      <div>
        <div><b>${esc(e.name)}</b> <span style="font-size:0.72rem;color:var(--text-dim);">(${esc(GRADE_LABEL[e.grade]||e.grade)})</span>${isAbsent?` <span style="font-size:0.7rem;color:var(--amber);font-weight:700;">${esc(formatAbsencePauseLabel(absenceInfo))}</span>`:""}${streakBadge}</div>
        ${excusedCtl ? `<div style="margin-top:3px;">${excusedCtl}</div>` : ""}
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">${inputs}</div>
    </div>`;
  }).join("");
}

// Coche/décoche "Actif mais n'a pas pu" : passe par le serveur (permission
// ADD+ revérifiée + trace dans les journaux), jamais un simple état local.
document.addEventListener("change", async (ev)=>{
  const cb = ev.target.closest("[data-excused-key]");
  if(!cb) return;
  const key = cb.dataset.excusedKey, scope = cb.dataset.excusedScope;
  const wanted = cb.checked;
  cb.disabled = true;
  try{
    const res = await fetch("/.netlify/functions/activite-actions", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"setExcused", scope, targetKey:key, excused: wanted }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    activiteData[key] = activiteData[key] || {};
    if(wanted) activiteData[key].excused = true; else delete activiteData[key].excused;
    saveActiviteData();
    toast(wanted ? "✓ Marqué « actif mais n'a pas pu » pour cette semaine" : "✓ Marqueur retiré");
  }catch(err){
    toast(`✕ Refusé : ${err.message}`);
  }
  renderActiviteTab(scope);
});

// (14/10) Corrige un vrai bug de perte de données : changer d'onglet
// Formateur<->Psychologue déclenchait un rechargement automatique et
// SILENCIEUX depuis le cloud (loadActiviteFromCloud(true)), qui
// écrasait purement et simplement activiteData — y compris une
// saisie qui venait d'être tapée mais pas encore cliquée sur
// "💾 Sauvegarder". activiteDirty retient qu'une saisie locale n'a pas
// encore été envoyée, pour que ce rechargement automatique ne
// l'efface plus jamais sans prévenir.
let activiteDirty = false;
document.addEventListener("input", (e)=>{
  const t = e.target.closest("[data-activite-field]");
  if(!t) return;
  const key = t.dataset.activiteKey, field = t.dataset.activiteField;
  activiteData[key] = activiteData[key] || {};
  activiteData[key][field] = Math.max(0, parseInt(t.value,10)||0);
  activiteDirty = true;
  saveActiviteData();
});

// Met à jour la série AVANT de remettre les compteurs à 0 :
//  - absent(e) cette semaine → série inchangée (pause, ni +1 ni remise à 0)
//  - 0 activité (les deux champs à 0) et pas absent(e) → +1 semaine de suite
//  - au moins une activité → série remise à 0 (repart de zéro)

// Crée automatiquement un signalement à un palier donné (2, 4, 6...).
// Utilise le même chemin (signalements/signalements_test) que les
// signalements manuels, donc visible au même endroit dans Pillbox —
// juste marqué "auto:true" pour qu'on sache d'où ça vient.
async function createAutoSignalement(e, streak, categoryLabel){
  const entry = {
    personName: e.name,
    personId: e.idUnique || null,
    personGrade: (e.grade||"").toUpperCase(),
    category: "inactivite",
    reason: `Signalement automatique : ${streak} semaines de suite sans ${categoryLabel} (généré par le suivi d'activité, aucune saisie humaine).`,
  };
  try{ await signalementServerAction("createAutoSignalement", entry); }
  catch(err){ console.error("Échec du signalement automatique:", err); }
}

// Met à jour la série AVANT de remettre les compteurs à 0 :
//  - absent(e) cette semaine → série inchangée (pause, ni +1 ni remise à 0)
//  - 0 activité (les deux champs à 0) et pas absent(e) → +1 semaine de suite
//  - au moins une activité → série ET palier signalé remis à 0 (nouveau
//    cycle complet, demandé le 10/09)
// Envoie un signalement automatique à CHAQUE palier pair (2, 4, 6, 8...)
// jamais deux fois pour le même palier du même cycle — lastSignaledThreshold
// retient jusqu'où on est déjà allé pour CE cycle précis (10/09, avant : un
// seul signalement possible par cycle entier, jamais renouvelé).
async function closeActiviteWeek(type){
  const isFormateur = type==="formateur";
  const grades = isFormateur ? ["MF","RF"] : ["MP","RP"];
  const fieldNames = ACTIVITE_FIELDS[type].map(([f])=>f);
  const categoryLabel = isFormateur ? "recrutement/formation" : "PPA/test psy/consultation";
  const concerned = employees.filter(e=>!e.licencie && grades.includes((e.grade||"").toUpperCase()));
  for(const e of concerned){
    const key = activiteKeyFor(e);
    const rec = activiteData[key] || {};
    const before = activiteStreak[key]?.streak || 0;
    const lastSignaled = activiteStreak[key]?.lastSignaledThreshold || 0;
    const threshold = streakThresholdFor(e);
    const hasActivity = fieldNames.some(f=>(rec[f]||0)>0);
    let after = before;
    let newLastSignaled = lastSignaled;
    if(isAbsentThisWeek(e)){
      // pause : on ne touche à rien (ni la série, ni le palier signalé).
    } else if(!hasActivity && rec.excused !== true){
      after = before + 1;
      // Palier atteint (multiple du seuil de SON rôle : 2 pour MF/MP, 3 pour
      // RF/RP) ET jamais encore signalé pour ce cycle → nouveau signalement.
      if(after % threshold === 0 && after > lastSignaled){
        await createAutoSignalement(e, after, categoryLabel);
        newLastSignaled = after;
      }
      activiteStreak[key] = { streak: after, lastSignaledThreshold: newLastSignaled };
    } else {
      // Au moins une activité, OU "actif mais n'a pas pu" (29/09) : la série
      // et le palier signalé repartent à 0 (nouveau cycle complet).
      after = 0;
      newLastSignaled = 0;
      activiteStreak[key] = { streak: 0, lastSignaledThreshold: 0 };
    }
    // Remet les compteurs à 0 et efface le marqueur "n'a pas pu" (valable
    // une semaine seulement — jamais une protection permanente).
    const cleared = { ...rec };
    fieldNames.forEach(f=>{ cleared[f] = 0; });
    delete cleared.excused;
    activiteData[key] = cleared;
  }
  saveActiviteData(); saveActiviteStreak();
  // Sauvegarde aussi dans le cloud automatiquement — plus besoin de
  // cliquer "Sauvegarder" séparément après une clôture (demandé le
  // 08/09). Précise le type pour ne fusionner que la bonne catégorie
  // (bug corrigé le 09/09 — appelait sans portée, ce qui envoyait
  // toujours les deux catégories mélangées).
  await saveActiviteToCloud(type, true);
}

// ═══════════════════════════════════════════════════════════════════
// HISTORIQUE DES SEMAINES FORMATEUR/PSYCHOLOGUE (09/09) — consultation
// + réouverture (CD+, vérifiée côté serveur dans roster-week-reopen.js,
// jamais juste un bouton caché ici).
// ═══════════════════════════════════════════════════════════════════
async function renderActiviteWeekHistory(scope){
  const box = document.getElementById(scope==="formateur" ? "formateurWeekHistory" : "psychologueWeekHistory");
  if(!box) return;
  if(!currentFirebaseIdToken){ box.textContent = "Session pas encore prête, réessaie dans un instant."; return; }
  box.textContent = "Chargement…";
  try{
    const res = await fetch(withFirebaseAuth(`https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterActiviteWeekHistory.json`));
    const all = res.ok ? (await res.json()) : {};
    const weeks = Object.entries(all || {})
      .filter(([,byScope]) => byScope && byScope[scope])
      .map(([weekKey, byScope]) => ({ weekKey, entry: byScope[scope] }))
      .sort((a,b) => b.weekKey.localeCompare(a.weekKey));
    if(!weeks.length){ box.textContent = "Aucune semaine clôturée pour l'instant."; return; }
    const canReopen = hasCap("reopen_roster_week");
    // "before" = les vrais chiffres accumulés PENDANT la semaine (avant
    // la remise à zéro) — c'est ÇA qui répond à "qu'est-ce qui s'est
    // passé cette semaine", pas "after" (qui n'est que l'état remis à
    // zéro, donc jamais informatif en soi).
    box.innerHTML = weeks.map(({weekKey, entry})=>{
      const nbPersonnes = Object.keys(entry.before||{}).length;
      return `<div style="font-size:0.82rem;padding:8px 0;border-bottom:1px solid var(--border-soft);">
        <div><b>Semaine du ${esc(weekKey)}</b> ${entry.reopened ? `<span style="font-size:0.7rem;color:var(--amber);">(réouverte)</span>` : `<span style="font-size:0.7rem;color:var(--text-faint);">🔒 clôturée</span>`}</div>
        <div style="color:var(--text-faint);margin-top:2px;">Clôturée par ${esc(entry.closedByName||"?")} (${esc(entry.closedByLevel||"?")}) — ${nbPersonnes} personne(s) concernée(s)</div>
        ${entry.reopened ? `<div style="color:var(--amber);opacity:.85;margin-top:2px;">Réouverte par ${esc(entry.reopenedByName||"?")} (${esc(entry.reopenedByLevel||"?")})</div>` : ""}
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn-ghost btn-small" data-view-week="${esc(weekKey)}" data-view-scope="${scope}">👁️ Consulter</button>
          ${canReopen ? `<button type="button" class="btn-ghost btn-small" data-reopen-roster-week="${esc(weekKey)}" data-reopen-scope="${scope}">🔓 Réouvrir cette semaine</button>` : ""}
        </div>
        <div id="weekDetail-${scope}-${esc(weekKey)}" style="display:none;margin-top:8px;padding:8px;background:rgba(255,255,255,.03);border-radius:6px;"></div>
      </div>`;
    }).join("");

    box.querySelectorAll("[data-view-week]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const weekKey = btn.dataset.viewWeek;
        const sc = btn.dataset.viewScope;
        const detailBox = document.getElementById(`weekDetail-${sc}-${weekKey}`);
        if(!detailBox) return;
        if(detailBox.style.display !== "none"){ detailBox.style.display = "none"; return; }
        const entry = weeks.find(w=>w.weekKey===weekKey)?.entry;
        if(!entry){ detailBox.textContent = "Introuvable."; detailBox.style.display = ""; return; }
        const histFields = ACTIVITE_FIELDS[sc] || ACTIVITE_FIELDS.formateur;
        const rows = Object.entries(entry.before||{}).map(([key, snap])=>{
          const name = resolveActiviteKeyToName(key);
          const d = snap.data || {};
          return `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border-soft);">
            <span>${esc(name)}${d.excused===true?` <span style="font-size:0.7rem;color:var(--text-dim);">(actif, n'a pas pu)</span>`:""}</span><span>${histFields.map(([f,l])=>`${l} : ${d[f]||0}`).join(" · ")}</span>
          </div>`;
        }).join("");
        detailBox.innerHTML = rows || `<span style="color:var(--text-faint);">Aucune personne concernée cette semaine.</span>`;
        detailBox.style.display = "";
      });
    });

    box.querySelectorAll("[data-reopen-roster-week]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const weekKey = btn.dataset.reopenRosterWeek;
        const sc = btn.dataset.reopenScope;
        if(!confirm(`Réouvrir la semaine du ${weekKey} (${sc}) ? Les données d'avant clôture seront restaurées dans l'onglet ${sc==="formateur"?"Formateur":"Psychologue"} pour correction. Rien n'est perdu — tu pourras reclôturer ensuite normalement.`)) return;
        btn.disabled = true;
        try{
          const res = await fetch("/.netlify/functions/roster-week-reopen", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ token: currentSessionToken, weekKey, scope: sc }),
          });
          const data = await res.json().catch(()=>({}));
          if(!res.ok) throw new Error(data.error || `${res.status}`);
          toast("✓ Semaine réouverte — les données sont restaurées, corrige puis reclôture normalement.");
          await loadActiviteFromCloud(); // recharge l'état frais depuis le serveur (pas le cache local)
          renderActiviteWeekHistory(sc);
        }catch(err){
          toast(`✕ Refusé : ${err.message}`);
        }finally{
          btn.disabled = false;
        }
      });
    });
  }catch(err){
    box.textContent = `Impossible de charger l'historique (${err.message}).`;
  }
}

document.getElementById("btnActiviteFormateurReset").addEventListener("click", async ()=>{
  if(!confirm("Clôturer la semaine pour Formateur ? Les compteurs repassent à 0, l'historique de série est mis à jour, et un signalement automatique part si quelqu'un franchit le seuil (les personnes absentes cette semaine ne comptent pas).")) return;
  toast("Clôture en cours…");
  await closeActiviteWeek("formateur");
  renderActiviteTab("formateur");
  toast("Semaine Formateur clôturée et sauvegardée dans le cloud");
});
document.getElementById("btnActivitePsyReset").addEventListener("click", async ()=>{
  if(!confirm("Clôturer la semaine pour Psychologue ? Les compteurs repassent à 0, l'historique de série est mis à jour, et un signalement automatique part si quelqu'un franchit le seuil (les personnes absentes cette semaine ne comptent pas).")) return;
  toast("Clôture en cours…");
  await closeActiviteWeek("psychologue");
  renderActiviteTab("psychologue");
  toast("Semaine Psychologue clôturée et sauvegardée dans le cloud");
});

// Envoie le suivi d'activité vers le cloud — passe désormais par une
// vraie vérification serveur (activite-actions.js), qui revérifie le
// niveau et le scope avant d'écrire quoi que ce soit (point 14 du
// cahier des charges : même un appel direct à l'API doit être refusé
// si la permission manque, pas juste caché côté interface). scope:
// "formateur" | "psychologue" | "all" (réservé ADD+, utilisé par la
// clôture automatique qui vient de traiter les deux à la fois).
async function saveActiviteToCloud(scope, closeWeek, requestOptions){
  if(!currentSessionToken){
    toast("Session expirée — reconnecte-toi avec Discord.");
    showGate("Ta session a expiré, reconnecte-toi.");
    return;
  }
  try{
    const requestInit = {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, scope: scope || "all", activiteData, activiteStreak, closeWeek: !!closeWeek }),
    };
    if(requestOptions && requestOptions.signal) requestInit.signal = requestOptions.signal;
    const res = await fetch("/.netlify/functions/activite-actions", requestInit);
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    // Le serveur renvoie la version nettoyée/canonique (uniquement les SP
    // actuelles MF/RF/MP/RP, sans doubles name:/id:). On la reprend ici
    // pour que le cache local ne réinjecte pas de vieilles entrées au clic
    // suivant sur Sauvegarder.
    if(data && data.data && typeof data.data === "object") activiteData = data.data;
    else if(data && Object.prototype.hasOwnProperty.call(data,"data")) activiteData = {};
    if(data && data.streak && typeof data.streak === "object") activiteStreak = data.streak;
    else if(data && Object.prototype.hasOwnProperty.call(data,"streak")) activiteStreak = {};
    saveActiviteData(); saveActiviteStreak();
    toast("✓ Suivi d'activité envoyé vers Pillbox");
    return data;
  }catch(err){
    toast(`✕ Échec de l'envoi : ${err.message}`);
  }
}
// (11/10 — refonte de la synchronisation inverse) La clôture
// Formateur/Psychologue n'est PLUS faite ici, dans le navigateur : elle
// est faite par le serveur au moment même où Pillbox clique « J'ai
// terminé cette semaine » (netlify/functions/activite-close.js). Avant,
// ce code refaisait la clôture lui-même — ce qui (1) n'arrivait que si
// quelqu'un ouvrait le Roster, (2) se perdait dès qu'une sauvegarde
// d'activité effaçait le signal, (3) pouvait être refait par CHAQUE
// navigateur (mémoire "déjà traité" locale à chaque PC).
// Ici, on se contente de remarquer qu'une clôture a eu lieu (Pillbox ou
// bouton manuel d'un autre PC) et de recharger l'activité depuis le
// cloud — appelé au démarrage ET toutes les 3 secondes.
const LAST_ACTIVITE_CLOSURE_SEEN_KEY = "rosterLastActiviteClosureSeen_v2";
async function checkPillboxWeekFinishedSignal(){
  if(!currentFirebaseIdToken) return;
  try{
    const res = await fetch(withFirebaseAuth("https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterActiviteLastClosure.json"));
    if(!res.ok) return;
    const last = (await res.json()) || {};
    const latest = Math.max(last.formateur||0, last.psychologue||0);
    if(!latest) return;
    let seen = 0;
    try{ seen = parseInt(localStorage.getItem(LAST_ACTIVITE_CLOSURE_SEEN_KEY), 10) || 0; }catch(e){}
    if(latest <= seen) return;
    try{ localStorage.setItem(LAST_ACTIVITE_CLOSURE_SEEN_KEY, String(latest)); }catch(e){}
    await loadActiviteFromCloud(true);
    renderActiviteTab("formateur"); renderActiviteTab("psychologue");
    // Pas de message au tout premier passage sur ce navigateur (seen=0) :
    // ce n'est pas une nouvelle clôture, juste la première synchronisation.
    if(seen) toast(`Semaine Formateur/Psychologue clôturée le ${new Date(latest).toLocaleString("fr-FR")} — compteurs à jour.`);
  }catch(err){ console.error("Vérification de clôture impossible:", err); }
}

async function loadActiviteFromCloud(silent){
  // (14/10) Un rechargement AUTOMATIQUE (silent=true, déclenché par un
  // simple changement d'onglet) ne doit jamais écraser une saisie pas
  // encore sauvegardée. Un rechargement EXPLICITE (bouton "↻", silent
  // falsy) reste possible mais prévient d'abord, puisque c'est une
  // action volontaire de la personne.
  if(activiteDirty){
    if(silent) return;
    if(!confirm("Des modifications non sauvegardées existent (saisie en cours). Les recharger depuis le cloud maintenant va les écraser définitivement. Continuer ?")) return;
  }
  try{
    const res = await fetch(withFirebaseAuth(ACTIVITE_CLOUD_URL));
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    if(!data || !data.data){ if(!silent) toast("Aucune donnée cloud trouvée."); return; }
    activiteData = data.data;
    activiteStreak = data.streak || {};
    saveActiviteData(); saveActiviteStreak();
    renderActiviteTab("formateur"); renderActiviteTab("psychologue");
    const when = data.savedAt ? new Date(data.savedAt).toLocaleString("fr-FR") : "";
    if(!silent) toast(`✓ Suivi d'activité chargé${when?` (sauvegardé le ${when})`:""}`);
  }catch(err){
    // En mode silencieux (ouverture automatique de l'onglet, 19/09,
    // trouvé lors de l'audit) : jamais bloquant si le réseau est
    // indisponible — on retombe sur le cache local déjà affiché plutôt
    // que d'interrompre la personne avec une erreur à chaque clic d'onglet.
    if(!silent) toast(`✕ Échec du chargement : ${err.message}`);
    else console.error("Synchronisation silencieuse du suivi d'activité impossible:", err.message);
  }
}
// (btnActiviteCloudSave / btnActivitePsyCloudSave retirés le 09/09 —
// remplacés par le bouton unique "🔄 Synchroniser avec Pillbox", qui
// appelle exactement la même fonction saveActiviteToCloud(). Les boutons
// "📥 Charger" ont été retirés le 10/10 — chargement déjà automatique
// à l'ouverture de l'onglet Formateur/Psychologue.)

// (10/10, demandé) Bouton unique "💾 Sauvegarder" — remplace les quatre
// anciens menus manuels (Sélection, Formation Opération, Formateur,
// Psychologue). Sauvegarde la sélection ET l'activité en un clic ;
// chaque PC se resynchronise ensuite tout seul (voir
// refreshSpecialSelectionFromCloud et le rafraîchissement silencieux
// déjà existant de l'activité), sans bouton "Charger" nulle part.
// Animation d’interface raccordée aux opérations cloud déjà existantes.
let rosterOperationTrigger = null;
let rosterNavigationDismissTimer = null;
let rosterNavigationDismissAt = 0;
function showRosterOperationOverlay(mode, trigger){
  const overlay = document.getElementById("rosterOperationOverlay");
  if(!overlay) return null;
  rosterOperationTrigger = trigger || null;
  if(rosterNavigationDismissTimer){ clearTimeout(rosterNavigationDismissTimer); rosterNavigationDismissTimer = null; }
  overlay.dataset.mode = mode;
  overlay.dataset.state = "loading";
  document.getElementById("rosterOperationTitle").textContent = mode === "save" ? "Sauvegarde Roster" : "Transition entre applications";
  document.getElementById("rosterOperationSubtitle").textContent = mode === "save" ? "Sauvegarde en cours…" : "Ouverture du Terminal Paie…";
  document.getElementById("rosterOperationSymbol").textContent = mode === "save" ? "💾" : "📋";
  document.getElementById("rosterOperationResult").textContent = "";
  overlay.hidden = false;
  const title = document.getElementById("rosterOperationTitle");
  if(title) title.focus({preventScroll:true});
  return overlay;
}
function hideRosterOperationOverlay(restoreFocus=false){
  const overlay = document.getElementById("rosterOperationOverlay");
  if(rosterNavigationDismissTimer){ clearTimeout(rosterNavigationDismissTimer); rosterNavigationDismissTimer = null; }
  if(overlay) overlay.hidden = true;
  const trigger = rosterOperationTrigger;
  rosterOperationTrigger = null;
  rosterNavigationDismissAt = 0;
  if(restoreFocus && trigger && trigger.isConnected && !trigger.disabled){
    try{ trigger.focus({preventScroll:true}); }catch(e){ trigger.focus(); }
  }
}
document.addEventListener("keydown", event=>{
  const overlay = document.getElementById("rosterOperationOverlay");
  if(!overlay || overlay.hidden) return;
  if(event.key === "Escape"){
    event.preventDefault(); event.stopPropagation();
  } else if(event.key === "Tab"){
    // La modale n’a aucun contrôle : le focus reste sur son titre pendant l’opération.
    event.preventDefault();
    document.getElementById("rosterOperationTitle")?.focus({preventScroll:true});
  }
});
document.addEventListener("visibilitychange", ()=>{
  const overlay = document.getElementById("rosterOperationOverlay");
  // Ne ferme pas la transition au moment où le nouvel onglet prend le focus;
  // si le navigateur a suspendu le minuteur, la ferme au retour lorsque sa durée est écoulée.
  if(overlay && !overlay.hidden && overlay.dataset.mode === "navigation" && document.visibilityState === "visible" && Date.now() >= rosterNavigationDismissAt){
    hideRosterOperationOverlay(false);
  }
});

// Le lien conserve son href, target et rel : le navigateur ouvre Pillbox immédiatement.
const openPillboxTerminalLink = document.querySelector('a[href="https://paie-pillbox-terminal-ems.netlify.app/"]');
if(openPillboxTerminalLink){
  openPillboxTerminalLink.addEventListener("click", ()=>{
    showRosterOperationOverlay("navigation", openPillboxTerminalLink);
    // Transition purement visuelle : aucun preventDefault, aucune attente avant la navigation.
    const navDuration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 650 : 1250;
    rosterNavigationDismissAt = Date.now() + navDuration;
    rosterNavigationDismissTimer = window.setTimeout(()=>hideRosterOperationOverlay(false), navDuration);
  });
}


document.addEventListener("keydown",event=>{
  const overlay=document.getElementById("rosterSaveReviewOverlay");
  if(!overlay||overlay.hidden) return;
  if(event.key==="Escape"){ event.preventDefault(); document.getElementById("rosterSaveReviewCancel")?.click(); }
});

// Raccourci demandé : Ctrl+S (ou Cmd+S sur Mac) déclenche exactement
// le même flux que le bouton « 💾 Sauvegarder » : comparaison, confirmation
// éventuelle, animation et écritures serveur. Le raccourci ne contourne rien.
document.addEventListener("keydown", event=>{
  if(!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== "s") return;
  event.preventDefault();
  const btn=document.getElementById("btnSaveAll");
  if(!btn || btn.disabled || rosterSaveInProgress || rosterSaveReviewOpen) return;
  btn.click();
});

document.getElementById("btnSaveAll").addEventListener("click", async (e)=>{
  if(rosterSaveInProgress || rosterSaveReviewOpen) return;
  const btn=e.currentTarget; if(btn.disabled) return;
  const statusEl=document.getElementById("saveAllStatus"); const original=btn.textContent;
  btn.disabled=true; btn.textContent="🔎 Vérification…"; if(statusEl){statusEl.textContent="Comparaison avec la dernière sauvegarde…";statusEl.style.color="var(--text-dim)";}
  let review;
  try{ review=await buildRosterSaveReview(); }
  catch(err){ review={compareError:err.message,employeeDiff:computeRosterEmployeeDiff([],employees),selectionChanged:true,currentSelectionCount:specialSelected.size,cloudSelectionCount:0,activityChanges:[],hasRosterChanges:true,hasChanges:true,previousSavedAt:null}; }
  btn.disabled=false; btn.textContent=original;
  if(review.hasChanges || review.compareError){
    const confirmed=await showRosterSaveReview(review);
    if(!confirmed){ if(statusEl){statusEl.textContent="Sauvegarde annulée — aucune donnée envoyée.";statusEl.style.color="var(--text-dim)";} return; }
  }
  // Si absolument rien n'a changé, on n'affiche pas la fenêtre et on exécute
  // directement les opérations existantes comme demandé.
  const startedAt=Date.now();
  const canSaveRoster=hasCap("manage_roster");
  const steps=canSaveRoster?["Roster des employés","Sélection Formation Opération","Suivi d'activité"]:["Sélection Formation Opération","Suivi d'activité"];
  showLiaisonOverlay("save","Sauvegarde Roster",steps,btn);
  const saveAbortController=typeof AbortController!=="undefined"?new AbortController():null;
  let saveTimedOut=false; const saveTimeoutId=window.setTimeout(()=>{saveTimedOut=true;if(saveAbortController)saveAbortController.abort();},30000);
  rosterSaveInProgress=true; btn.disabled=true; btn.textContent="☁️ Sauvegarde…"; if(statusEl)statusEl.textContent="";
  const done=[]; const failed=[]; let step=0; let finalState="error",finalMessage="Échec de la sauvegarde";
  try{
    if(canSaveRoster){
      setLiaisonStep(step,"active","Écriture du Roster vérifié…");
      try{ await pushRosterSnapshotConfirmed(review); done.push("Roster"); setLiaisonStep(step,"done"); }
      catch(err){ failed.push(`Roster (${err.message})`); setLiaisonStep(step,"failed"); }
      step++;
    }
    setLiaisonStep(step,"active","Envoi de la sélection…");
    try{ const count=await saveSpecialSelectionToCloud(saveAbortController?saveAbortController.signal:undefined); specialSelectionLastSavedAt=Date.now(); done.push(`Sélection (${count})`); setLiaisonStep(step,"done"); }
    catch(err){ failed.push("Sélection"); setLiaisonStep(step,"failed"); }
    step++;
    setLiaisonStep(step,"active","Écriture du suivi d'activité…");
    try{ const activityResult=await saveActiviteToCloud("all",undefined,{signal:saveAbortController?saveAbortController.signal:undefined}); if(!activityResult||typeof activityResult!=="object") throw new Error("Réponse de sauvegarde manquante"); activiteDirty=false; done.push("Activité"); setLiaisonStep(step,"done"); }
    catch(err){ failed.push("Activité"); setLiaisonStep(step,"failed"); }
  }catch(err){ failed.push("Opération inattendue"); } finally{ window.clearTimeout(saveTimeoutId); }
  try{
    await liaisonMinDelay(startedAt,liaisonCurrentMinMs);
    if(!failed.length){finalState="success";finalMessage="Sauvegarde réussie";} else if(done.length){finalState="partial";finalMessage="Sauvegarde partielle";} else{finalState="error";finalMessage="Échec de la sauvegarde";}
    finishLiaisonOverlay(finalState,finalMessage,saveTimedOut?"Le délai d’attente de 30 secondes est dépassé. Vérifie la connexion avant de réessayer.":finalState==="success"?"Toutes les opérations de sauvegarde sont terminées.":finalState==="partial"?"Certaines opérations ont échoué.":"Aucune opération de sauvegarde n’a abouti.");
    const when=new Date().toLocaleString("fr-FR");
    if(statusEl){statusEl.textContent=finalState==="success"?`✓ Dernière sauvegarde : ${when}`:finalState==="partial"?`⚠ Sauvegarde partielle — réussi : ${done.join(", ")}; échec : ${failed.join(", ")}.`:`✕ Échec de la sauvegarde — ${failed.join(", ")||"aucune opération confirmée"}.`;statusEl.style.color=finalState==="success"?"var(--green)":finalState==="partial"?"var(--amber)":"var(--red)";}
    toast(finalState==="success"?"✓ Sauvegarde réussie":finalState==="partial"?"⚠ Sauvegarde partielle":"✕ Échec de la sauvegarde");
    if(!liaisonSkipped&&!liaisonReduced()) await waitForSyncOverlay(900);
  }catch(err){finishLiaisonOverlay("error","Échec de la sauvegarde");if(statusEl){statusEl.textContent="✕ Échec de la sauvegarde.";statusEl.style.color="var(--red)";}}
  finally{hideLiaisonOverlay(true);btn.disabled=false;btn.textContent=original;rosterSaveInProgress=false;}
});


const TAB_IDS = ["Roster","Signalement","Operation","Formateur","Psychologue","Absences","Logs","Permissions","ReglagesPaie","Troll"];
function switchTab(active){
  TAB_IDS.forEach(name=>{
    document.getElementById(`tab${name}Btn`).classList.toggle("active", name===active);
    document.getElementById(`${name.charAt(0).toLowerCase()+name.slice(1)}View`).style.display = (name===active) ? "" : "none";
  });
  if(active==="Signalement"){
    refreshSignalementPersonList();
    loadSignalementPending();
    loadPropositionsPending();
    const submitBtn = document.getElementById("signalementSubmitBtn");
    if(submitBtn) submitBtn.textContent = !hasCap("create_signalement") ? "Proposer un signalement" : "Envoyer anonymement"; // (12/10) selon le droit réel, plus le grade
  }
  if(active==="Formateur"){ renderActiviteTab("formateur"); loadAbsencesFromCloud().then(()=>renderActiviteTab("formateur")); loadActiviteFromCloud(true).then(()=>checkPillboxWeekFinishedSignal()).then(()=>renderActiviteTab("formateur")); renderActiviteWeekHistory("formateur"); }
  if(active==="Psychologue"){ renderActiviteTab("psychologue"); loadAbsencesFromCloud().then(()=>renderActiviteTab("psychologue")); loadActiviteFromCloud(true).then(()=>checkPillboxWeekFinishedSignal()).then(()=>renderActiviteTab("psychologue")); renderActiviteWeekHistory("psychologue"); }
  if(active==="Absences"){ loadAbsencesFromCloud(); }
  if(active==="Troll"){ trollRenderTab(); }
  if(active==="Logs") loadLogs();
  if(active==="Permissions"){ loadPermissionsTable(); renderIndividualPermissionsCard(); renderPermissionRequestsCard(); }
  if(active==="ReglagesPaie"){ loadPayRulesConfig(); renderPayRulesHistory(); }
}
TAB_IDS.forEach(name=>{
  document.getElementById(`tab${name}Btn`).addEventListener("click", ()=>switchTab(name));
});


// ═══════════════════════════ SIGNALEMENT ANONYME ═══════════════════════════
// Réutilise splitEmsLine()/cleanEmsName() déjà définies plus haut pour le
// Roster, plutôt que de reconstruire un parseur du tableau EMS en double
// (demandé le 06/09 — éviter la logique dupliquée entre les deux outils).
const SIGNALEMENTS_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
let signalementSandboxMode = localStorage.getItem("signalementSandbox")==="1";

const SIGNALEMENT_CONCERNED_GRADES = ["MF","MP","MLP","RF","RP","RL","MC","ADD"];
const SIGNALEMENT_GRADE_LABEL = {
  MF:"Médecin Formateur", MP:"Médecin Psychologue", MLP:"Médecin Légiste Pompier",
  RF:"Responsable Formateur", RP:"Responsable Psychologue", RL:"Responsable Légiste",
  MC:"Médecin Chef", ADD:"Assistant de Direction",
};
const SIGNALEMENT_CATEGORY_LABEL = {
  inactivite:"Inactivité", quantite_travail:"Quantité de travail", qualite_travail:"Qualité du travail",
  comportement:"Comportement", disponibilite:"Manque de disponibilité", autre:"Autre",
};

let signalementState = { people: [] };

// Ne collecte plus un tableau EMS séparé — la liste des employés est déjà
// chargée et tenue à jour par le Roster (variable globale `employees`,
// elle-même synchronisée localStorage/cloud) : on filtre juste dessus par
// grade concerné, exactement comme le fait l'onglet Opération avec sa
// propre sélection (demandé le 07/09, pour ne plus avoir à coller le
// tableau une deuxième fois).
function refreshSignalementPersonList(){
  signalementState.people = employees
    .filter(e=>!e.licencie && SIGNALEMENT_CONCERNED_GRADES.includes((e.grade||"").toUpperCase()))
    .map(e=>({ id: e.idUnique||"", name: e.name, grade: (e.grade||"").toUpperCase() }))
    .sort((a,b)=> GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) || a.name.localeCompare(b.name));

  const cur = signalementPersonSelect.value;
  if(!signalementState.people.length){
    signalementPersonSelect.disabled = true;
    signalementPersonSelect.innerHTML = `<option value="">— aucun employé dans un grade concerné pour l'instant —</option>`;
    signalementParseHint.textContent = "0 personne dans un grade concerné (MF/MP/MLP/RF/RP/RL/MC) dans le Roster actuel.";
  } else {
    signalementPersonSelect.disabled = false;
    signalementPersonSelect.innerHTML = `<option value="">— choisir —</option>` +
      signalementState.people.map((p,i)=>`<option value="${i}">${esc(p.name)} — ${esc(SIGNALEMENT_GRADE_LABEL[p.grade])}</option>`).join("");
    signalementParseHint.textContent = `${signalementState.people.length} personne(s) dans les grades concernés (à jour avec le Roster).`;
    // Réapplique la sélection précédente si elle existe toujours, pour ne
    // pas la perdre bêtement à chaque rafraîchissement de l'onglet.
    if(cur !== "" && signalementPersonSelect.querySelector(`option[value="${cur}"]`)) signalementPersonSelect.value = cur;
  }
  updateSignalementSubmitState();
}

const signalementPersonSelect = document.getElementById("signalementPersonSelect");
const signalementParseHint = document.getElementById("signalementParseHint");

signalementPersonSelect.addEventListener("change", updateSignalementSubmitState);

document.getElementById("signalementCategoryButtons").addEventListener("click", (e)=>{
  const btn = e.target.closest(".cat-btn");
  if(!btn) return;
  btn.classList.toggle("active");
  updateSignalementSubmitState();
});
function signalementSelectedCategories(){
  return [...document.querySelectorAll("#signalementCategoryButtons .cat-btn.active")].map(b=>b.dataset.cat);
}

const signalementReasonInput = document.getElementById("signalementReasonInput");
signalementReasonInput.addEventListener("input", updateSignalementSubmitState);

const SIGNALEMENT_REASON_MIN_LENGTH = 10; // doit correspondre exactement à la règle Firebase, sinon le message d'erreur serveur reste incompréhensible ("Permission denied" au lieu d'un vrai message)

function updateSignalementSubmitState(){
  const hasPerson = signalementPersonSelect.value !== "";
  const hasCategory = signalementSelectedCategories().length > 0;
  const reasonLength = signalementReasonInput.value.trim().length;
  const hasReason = reasonLength >= SIGNALEMENT_REASON_MIN_LENGTH;
  document.getElementById("signalementSubmitBtn").disabled = !(hasPerson && hasCategory && hasReason);
  const hint = document.getElementById("signalementReasonHint");
  if(hint){
    if(reasonLength === 0){ hint.textContent = `Minimum ${SIGNALEMENT_REASON_MIN_LENGTH} caractères.`; hint.style.color = "var(--text-faint)"; }
    else if(reasonLength < SIGNALEMENT_REASON_MIN_LENGTH){ hint.textContent = `Encore ${SIGNALEMENT_REASON_MIN_LENGTH - reasonLength} caractère(s) minimum.`; hint.style.color = "var(--amber)"; }
    else { hint.textContent = "✓ Motif suffisamment détaillé."; hint.style.color = "var(--green)"; }
  }
}

document.getElementById("signalementSubmitBtn").addEventListener("click", async ()=>{
  const person = signalementState.people[+signalementPersonSelect.value];
  const reason = signalementReasonInput.value.trim();
  const cats = signalementSelectedCategories();
  const statusMsg = document.getElementById("signalementStatusMsg");
  const submitBtn = document.getElementById("signalementSubmitBtn");
  if(!person || !cats.length || !reason) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Envoi en cours…";
  statusMsg.innerHTML = "";

  const payload = {
    personName: person.name,
    personId: person.id ? String(person.id) : null, // toujours forcé en texte (10/09) — sinon un identifiant stocké comme nombre côté Roster casse la validation Firebase, qui exige explicitement du texte
    personGrade: person.grade,
    category: cats.join(","),
    reason: reason,
  };
  // Rattache un instantané des chiffres d'activité AU MOMENT du
  // signalement — pour garder le contexte factuel exact même si ces
  // chiffres changent ensuite. Uniquement pour les postes suivis (MF/RF
  // : recrutements+formations ; MP/RP : tests psy+PPA+consultations).
  const actKey = person.id ? `id:${person.id}` : `name:${person.name.trim().toLowerCase()}`;
  const act = activiteData[actKey];
  if(act && ["MF","RF"].includes(person.grade)){
    payload.activiteSnapshot = { recrutements: act.recrutements||0, formations: act.formations||0 };
  } else if(act && ["MP","RP"].includes(person.grade)){
    payload.activiteSnapshot = { testsPsy: act.testsPsy||0, ppa: act.ppa||0, consultations: act.consultations||0 };
  }

  // MC ne peut que PROPOSER (jamais créer directement un signalement
  // officiel) — ADD et au-dessus créent directement l'officiel. Le
  // choix ici n'est qu'un confort d'affichage : la fonction serveur
  // revérifie de toute façon le niveau réel avant d'accepter quoi que
  // ce soit (08/09).
  const isMc = !hasCap("create_signalement"); // (12/10) « proposer » si pas le droit de créer (grade ou exception individuelle)
  const action = isMc ? "proposeSignalement" : "createSignalementOfficial";

  try{
    await signalementServerAction(action, payload);
    if(isMc){
      statusMsg.innerHTML = `<span style="color:var(--green);">✓ Proposition envoyée aux ADD et au-dessus — en attente de validation.</span>`;
    } else {
      statusMsg.innerHTML = `<span style="color:var(--green);">✓ Signalement officiel créé.</span>`;
    }
    signalementReasonInput.value = "";
    document.querySelectorAll("#signalementCategoryButtons .cat-btn").forEach(b=>b.classList.remove("active"));
    signalementPersonSelect.value = "";
    loadSignalementPending();
  }catch(err){
    statusMsg.innerHTML = `<span style="color:var(--red);">✕ Refusé : ${esc(err.message)}</span>`;
  }finally{
    submitBtn.textContent = isMc ? "Proposer un signalement" : "Envoyer anonymement";
    updateSignalementSubmitState();
  }
});

function signalementTimeAgo(ts){
  const diffMin = Math.round((Date.now()-ts)/60000);
  if(diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.round(diffMin/60);
  if(diffH < 24) return `il y a ${diffH}h`;
  return `il y a ${Math.round(diffH/24)}j`;
}

async function loadSignalementPending(){
  const list = document.getElementById("signalementPendingList");
  const isAdmin = hasCap("validate_signalement");
  list.textContent = "Chargement…";
  try{
    const out = await signalementServerAction("listSignalements", {});
    const data = out.signalements || {};
    if(!data){ list.textContent = "Aucun signalement en attente."; return; }
    const entries = Object.entries(data).sort((a,b)=> (b[1].createdAt||0)-(a[1].createdAt||0));
    if(!entries.length){ list.textContent = "Aucun signalement en attente."; return; }
    list.innerHTML = entries.map(([key,e])=>{
      const cats = (e.category||"").split(",").map(c=>SIGNALEMENT_CATEGORY_LABEL[c]||c).join(" · ");
      return `<div style="font-size:0.82rem;padding:6px 0;border-bottom:1px solid var(--border-soft);">
        <b>${esc(e.personName)}</b>${e.personGrade?` (${esc(SIGNALEMENT_GRADE_LABEL[e.personGrade]||e.personGrade)})`:""}
        <span style="display:inline-block;font-size:0.72rem;font-weight:700;color:var(--amber);background:rgba(251,191,36,.12);border-radius:5px;padding:1px 6px;margin-left:6px;">${esc(cats)}</span>
        ${isAdmin?`<button type="button" class="admin-del-btn btn-danger btn-small" data-key="${esc(key)}" style="float:right;">🗑</button>`:""}
        <div style="margin-top:2px;">${esc((e.reason||"").slice(0,140))}${(e.reason||"").length>140?"…":""}</div>
        <div style="margin-top:2px;color:var(--text-faint);">${signalementTimeAgo(e.createdAt||Date.now())}</div>
      </div>`;
    }).join("");
  }catch(err){
    list.textContent = `Impossible de charger les signalements en attente (${err.message}).`;
  }
}
document.getElementById("signalementPendingList").addEventListener("click", async (e)=>{
  const btn = e.target.closest(".admin-del-btn");
  if(!btn) return;
  if(!confirm("Supprimer définitivement ce signalement ?")) return;
  try{ await signalementServerAction("deleteSignalementOfficial", {key:btn.dataset.key}); await loadSignalementPending(); }
  catch(err){ alert(`Échec de la suppression (${err.message}).`); }
});
document.getElementById("signalementRefreshBtn").addEventListener("click", loadSignalementPending);

// ═══════════════════════════════════════════════════════════════════
// PROPOSITIONS DE SIGNALEMENT (circuit MC → ADD+) — 08/09
// ═══════════════════════════════════════════════════════════════════
const PROPOSITIONS_URL = `${SIGNALEMENTS_BASE}/signalementPropositions.json`;
const PROPOSITION_STATUS_LABEL = {
  pending: "⏳ En attente de validation",
  accepted: "✅ Acceptée",
  refused: "❌ Refusée",
  needs_info: "❓ Infos complémentaires demandées",
};

function canValidateSignalement(){
  return hasCap("validate_signalement");
}

async function loadPropositionsPending(){
  const card = document.getElementById("propositionsCard");
  const list = document.getElementById("propositionsList");
  card.style.display = canValidateSignalement() ? "" : "none";
  if(!canValidateSignalement()) return;
  list.textContent = "Chargement…";
  try{
    const res = await fetch(PROPOSITIONS_URL);
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    if(!data){ list.textContent = "Aucune proposition en attente."; return; }
    const entries = Object.entries(data)
      .filter(([,p]) => p.status === "pending")
      .sort((a,b)=> (b[1].createdAt||0)-(a[1].createdAt||0));
    if(!entries.length){ list.textContent = "Aucune proposition en attente."; return; }
    list.innerHTML = entries.map(([key,p])=>{
      const cats = (p.category||"").split(",").map(c=>SIGNALEMENT_CATEGORY_LABEL[c]||c).join(" · ");
      return `<div style="font-size:0.82rem;padding:8px 0;border-bottom:1px solid var(--border-soft);">
        <div><b>${esc(p.authorName||"?")}</b> (${esc(p.authorLevel||"?")}) propose un signalement pour <b>${esc(p.personName)}</b>${p.personGrade?` (${esc(SIGNALEMENT_GRADE_LABEL[p.personGrade]||p.personGrade)})`:""}</div>
        <span style="display:inline-block;font-size:0.72rem;font-weight:700;color:var(--amber);background:rgba(251,191,36,.12);border-radius:5px;padding:1px 6px;margin:4px 0;">${esc(cats)}</span>
        <div style="margin-top:2px;">${esc(p.reason||"")}</div>
        <div style="margin-top:2px;color:var(--text-faint);">${signalementTimeAgo(p.createdAt||Date.now())}</div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn-primary btn-small" data-prop-validate="${esc(key)}">✅ Accepter</button>
          <button type="button" class="btn-danger btn-small" data-prop-refuse="${esc(key)}">❌ Refuser</button>
          <button type="button" class="btn-ghost btn-small" data-prop-info="${esc(key)}">❓ Demander des infos</button>
        </div>
      </div>`;
    }).join("");
  }catch(err){
    list.textContent = `Impossible de charger les propositions (${err.message}).`;
  }
}
document.getElementById("propositionsRefreshBtn").addEventListener("click", loadPropositionsPending);
document.getElementById("propositionsList").addEventListener("click", async (e)=>{
  const validateBtn = e.target.closest("[data-prop-validate]");
  const refuseBtn = e.target.closest("[data-prop-refuse]");
  const infoBtn = e.target.closest("[data-prop-info]");
  try{
    if(validateBtn){
      if(!confirm("Accepter cette proposition et créer le signalement officiel ?")) return;
      await signalementServerAction("validateProposition", { propositionId: validateBtn.dataset.propValidate });
      toast("✓ Proposition acceptée — signalement officiel créé.");
    } else if(refuseBtn){
      if(!confirm("Refuser cette proposition ?")) return;
      await signalementServerAction("refuseProposition", { propositionId: refuseBtn.dataset.propRefuse });
      toast("Proposition refusée.");
    } else if(infoBtn){
      const message = prompt("Quelles informations demander au MC ?");
      if(message === null) return;
      await signalementServerAction("requestMoreInfo", { propositionId: infoBtn.dataset.propInfo, message });
      toast("Demande d'informations envoyée.");
    } else return;
    loadPropositionsPending();
  }catch(err){
    toast(`✕ Refusé : ${err.message}`);
  }
});


// ═══════════════════════════════════════════════════════════════════
// LOGS (ADD et au-dessus) — 08/09
// ═══════════════════════════════════════════════════════════════════
const LOG_ACTION_LABEL = {
  connexion: "Connexion (Roster)",
  connexion_pillbox: "Connexion (Pillbox)",
  semaine_terminee_pillbox: "Semaine de paie terminée (Pillbox)",
  modification_employe: "Modification employé",
  licenciement: "Licenciement",
  signalement_officiel: "Signalement officiel",
  proposition_signalement: "Proposition de signalement",
  validation_proposition: "Validation de proposition",
  refus_proposition: "Refus de proposition",
  demande_infos_proposition: "Demande d'infos (proposition)",
  modification_permission: "Modification de permission",
  absences_synchronisees: "Absences synchronisées",
  absence_prise_en_compte_modifiee: "Absence : Prise en compte modifiée",
};

async function loadLogs(){
  const list = document.getElementById("logsList");
  if(!currentSessionToken){ list.textContent = "Session expirée."; return; }
  list.textContent = "Chargement…";
  const params = new URLSearchParams({ token: currentSessionToken });
  const author = document.getElementById("logsFilterAuthor").value.trim();
  const target = document.getElementById("logsFilterTarget").value.trim();
  const actionType = document.getElementById("logsFilterAction").value;
  const dateFrom = document.getElementById("logsFilterDateFrom").value;
  const dateTo = document.getElementById("logsFilterDateTo").value;
  const search = document.getElementById("logsFilterSearch").value.trim();
  if(author) params.set("author", author);
  if(target) params.set("target", target);
  if(actionType) params.set("actionType", actionType);
  if(dateFrom) params.set("dateFrom", String(new Date(dateFrom+"T00:00:00").getTime()));
  if(dateTo) params.set("dateTo", String(new Date(dateTo+"T23:59:59").getTime()));
  if(search) params.set("search", search);
  try{
    const res = await fetch(`/.netlify/functions/get-logs?${params.toString()}`);
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    if(!data.entries || !data.entries.length){ list.textContent = "Aucune entrée pour ce filtre."; return; }
    list.innerHTML = data.entries.map(e=>`
      <div class="special-row" style="grid-template-columns:1fr;display:block;padding:10px 11px;">
        <div><b>${esc(LOG_ACTION_LABEL[e.action]||e.action)}</b> — ${new Date(e.createdAt).toLocaleString("fr-FR")}</div>
        <div style="color:var(--text-dim);font-size:0.78rem;margin-top:2px;">
          Par <b>${esc(e.authorName||"?")}</b> (${esc(e.authorLevel||"?")})
          ${e.targetName?` → concernait <b>${esc(e.targetName)}</b>`:""}
        </div>
        ${e.oldValue||e.newValue ? `<div style="font-size:0.76rem;color:var(--text-faint);margin-top:2px;">${e.oldValue?`Avant : ${esc(e.oldValue)}`:""}${e.oldValue&&e.newValue?" — ":""}${e.newValue?`Après : ${esc(e.newValue)}`:""}</div>` : ""}
        ${e.details ? `<div style="font-size:0.76rem;color:var(--text-faint);margin-top:2px;">${esc(e.details)}</div>` : ""}
        ${hasCap("delete_logs") ? `<button type="button" class="btn-ghost btn-small" style="margin-top:6px;color:var(--red);border-color:rgba(248,113,113,0.4);" data-action="deleteLog" data-key="${esc(e.key)}">🗑️ Supprimer cette entrée</button>` : ""}
      </div>
    `).join("");
  }catch(err){
    list.textContent = `Impossible de charger les journaux (${err.message}).`;
  }
}
document.getElementById("logsList").addEventListener("click", async (ev)=>{
  const btn = ev.target.closest('[data-action="deleteLog"]');
  if(!btn) return;
  // (13/10, section 5) Suppression réservée à OWNER par défaut, ou à
  // une exception individuelle explicite — revérifié côté serveur à
  // chaque appel (voir get-logs.js), jamais une simple protection
  // d'affichage. Le serveur refuse aussi toute tentative de supprimer
  // sa propre trace, même pour OWNER.
  if(!confirm("Supprimer définitivement cette entrée de log ? Cette action est elle-même tracée.")) return;
  btn.disabled = true;
  try{
    const res = await fetch("/.netlify/functions/get-logs", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, logKey: btn.dataset.key }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    toast("✓ Entrée supprimée.");
    loadLogs();
  }catch(err){
    toast(`✕ Refusé : ${err.message}`);
    btn.disabled = false;
  }
});
document.getElementById("logsRefreshBtn").addEventListener("click", loadLogs);
document.getElementById("logsFilterBtn").addEventListener("click", loadLogs);

// ═══════════════════════════════════════════════════════════════════
// GESTION DES PERMISSIONS (D et OWNER) — 08/09
// ═══════════════════════════════════════════════════════════════════
const PERMISSION_LABEL = {
  view_roster: "Consulter le Roster",
  manage_roster: "Modifier/Licencier un employé",
  manage_psychologue_category: "Gérer la catégorie Psychologue",
  manage_formateur_category: "Gérer la catégorie Formateur",
  propose_signalement: "Proposer un signalement",
  create_signalement: "Créer un signalement officiel",
  validate_signalement: "Valider/refuser une proposition",
  manage_retrogradation: "Gérer les rétrogradations",
  sync_pillbox_complete: "Synchronisation complète avec Pillbox",
  view_logs: "Consulter les logs",
  modify_role_label: "Modifier les libellés de rôle",
  manage_advanced_settings: "Paramètres avancés",
  manage_permissions: "Gérer les permissions",
  use_pillbox_terminal: "Accéder au Terminal Paie (Pillbox)",
  request_individual_permission: "Demander une exception individuelle",
  cancel_lower_decisions: "Annuler une décision d'un niveau inférieur",
  manage_pay_weeks: "Gérer les semaines de paie (réouvrir / supprimer)",
  manage_absences: "Gérer les absences (synchroniser, Prise en compte)",
  manage_pay_rules: "Réglages des paies (gestionnaire paie)",
  force_logout: "Déconnexion forcée (déconnecter quelqu'un)",
  reset_activite_streak: "Réinitialiser une série d'inactivité (Formateur/Psy)",
  reopen_roster_week: "Réouvrir une semaine Formateur/Psychologue clôturée",
  owner_delegate: "👑 Droits OWNER délégués (individuel uniquement)",
  manage_troll: "🎭 Mode troll (individuel uniquement)",
  exclude_animations: "🚫 Exclure des animations",
};
const GRADE_PERMISSION_KEYS_UI = [
  "view_roster","manage_roster","manage_psychologue_category","manage_formateur_category",
  "propose_signalement","create_signalement","validate_signalement","manage_retrogradation",
  "sync_pillbox_complete","view_logs","modify_role_label","manage_advanced_settings",
  "manage_permissions","use_pillbox_terminal","request_individual_permission","cancel_lower_decisions",
  "manage_pay_weeks","manage_absences","manage_pay_rules","force_logout","reset_activite_streak","reopen_roster_week"
];
const REQUESTABLE_PERMISSION_KEYS = [...GRADE_PERMISSION_KEYS_UI];
const INDIVIDUAL_PERM_KEYS = [...GRADE_PERMISSION_KEYS_UI, "owner_delegate", "manage_troll", "exclude_animations"];
const EDITABLE_LEVELS = ["MC","ADD","CD","D","DG"]; // jamais OWNER, toujours tout

async function loadPermissionsTable(){
  document.getElementById("permissionsGradeTableCard").style.display = hasCap("manage_permissions") ? "" : "none";
  if(!hasCap("manage_permissions")) return;
  const box = document.getElementById("permissionsTable");
  if(!currentSessionToken){ box.textContent = "Session expirée."; return; }
  box.textContent = "Chargement…";
  try{
    const res = await fetch(`/.netlify/functions/manage-permissions?token=${encodeURIComponent(currentSessionToken)}`);
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    const allPerms = Array.isArray(data.gradePermissionKeys) ? data.gradePermissionKeys : GRADE_PERMISSION_KEYS_UI;
    const editableLevels = new Set(Array.isArray(data.editableLevels) ? data.editableLevels : EDITABLE_LEVELS);
    const editablePermissions = new Set(Array.isArray(data.editablePermissions) ? data.editablePermissions : allPerms);
    box.innerHTML = `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
      <thead><tr>
        <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border-soft);">Permission</th>
        ${EDITABLE_LEVELS.map(l=>`<th style="padding:6px;border-bottom:1px solid var(--border-soft);">${l}</th>`).join("")}
      </tr></thead>
      <tbody>
        ${allPerms.map(p=>`<tr>
          <td style="padding:6px;color:var(--text-dim);">${esc(PERMISSION_LABEL[p]||p)}</td>
          ${EDITABLE_LEVELS.map(l=>{ const blocked=!editableLevels.has(l)||!editablePermissions.has(p)||(p==="manage_permissions"&&currentUserLevel!=="OWNER"); const why=p==="manage_permissions"&&currentUserLevel!=="OWNER"?"Seul OWNER peut déléguer ce droit":(!editableLevels.has(l)?"Niveau supérieur à ton autorité":(!editablePermissions.has(p)?"Tu ne possèdes pas ce droit":"")); return `<td style="text-align:center;padding:6px;${blocked?'opacity:.5;':''}">
            <input type="checkbox" data-perm="${p}" data-level="${l}" ${data.permissions?.[l]?.[p] ? "checked" : ""} ${blocked ? `disabled title="${esc(why)}"` : ""}>
          </td>`;}).join("")}
        </tr>`).join("")}
      </tbody>
    </table></div>`;
    box.querySelectorAll("input[type=checkbox]").forEach(cb=>{
      cb.addEventListener("change", async ()=>{
        cb.disabled = true;
        try{
          const res = await fetch("/.netlify/functions/manage-permissions", {
            method: "POST", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({ token: currentSessionToken, level: cb.dataset.level, permissionName: cb.dataset.perm, value: cb.checked }),
          });
          const d = await res.json().catch(()=>({}));
          if(!res.ok) throw new Error(d.error || `${res.status}`);
          toast(`✓ ${PERMISSION_LABEL[cb.dataset.perm]} pour ${cb.dataset.level} : ${cb.checked ? "activé" : "désactivé"}`);
        }catch(err){
          cb.checked = !cb.checked; // annule visuellement si refusé
          toast(`✕ Refusé : ${err.message}`);
        }finally{
          cb.disabled = false;
        }
      });
    });
  }catch(err){
    box.textContent = `Impossible de charger les permissions (${err.message}).`;
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXCEPTIONS INDIVIDUELLES (09/09) — réservé à CD/D/DG/OWNER.
// ═══════════════════════════════════════════════════════════════════
// (12/10, demandé) Toutes les permissions, « Gérer les permissions » comprise. La liste
// réelle vient du serveur (allPermissions) ; celle-ci ne sert que de repli.
let individualAllPermsCache = null;
let individualPermsCache = null;
let effectiveByGradeCache = null;

async function renderIndividualPermissionsCard(){
  const card = document.getElementById("individualPermissionsCard");
  const canManage = hasCap("manage_permissions");
  const canManageAnimationExclusion = ["D","DG","OWNER"].includes(currentUserLevel);
  card.style.display = (canManage || canManageAnimationExclusion) ? "" : "none";
  if(!canManage && !canManageAnimationExclusion) return;

  const select = document.getElementById("individualPermPersonSelect");
  const currentValue = select.value;
  select.innerHTML = `<option value="">— Choisir une personne —</option>` +
    employees.filter(e=>!e.licencie)
      .sort((a,b)=> GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) || a.name.localeCompare(b.name))
      .map(e=>`<option value="${esc(e.discordId)}">${esc(e.name)} (${esc(e.grade)})</option>`).join("");
  select.value = currentValue;

  try{
    const res = await fetch(`/.netlify/functions/manage-individual-permissions?token=${encodeURIComponent(currentSessionToken)}`);
    const data = await res.json().catch(()=>({}));
    if(res.ok){ individualPermsCache = data.individualPermissions || {}; effectiveByGradeCache = data.effectiveByGrade || null; if(Array.isArray(data.allPermissions)) individualAllPermsCache = data.allPermissions; }
  }catch(err){ /* le tableau se rechargera au prochain changement de sélection */ }

  renderIndividualPermTableForSelected();
}
document.getElementById("individualPermPersonSelect").addEventListener("change", renderIndividualPermTableForSelected);

// (12/10, demandé) « Tout sélectionner » / « Tout retirer » — une seule
// écriture côté serveur (jamais un état à moitié appliqué), boutons
// bloqués pendant l'envoi (pas de double clic), resynchronisation avec
// le serveur en cas d'échec pour que l'affichage reflète toujours la base.
async function individualBulk(action){
  const discordId = document.getElementById("individualPermPersonSelect").value;
  if(!discordId) return;
  const emp = employees.find(e=>e.discordId===discordId);
  const who = emp ? `${emp.name} (${emp.grade})` : discordId;
  const n = (individualAllPermsCache || INDIVIDUAL_PERM_KEYS).length;
  const msg = action === "setAll"
    ? `Accorder TOUTES les permissions (${n}) à ${who} ?\n\nSon grade réel, sa paie et son ancienneté ne changent pas.\n\nLes permissions spéciales OWNER/Mode troll restent à accorder séparément.`
    : `Retirer toutes les exceptions individuelles de ${who} (celles que ton niveau peut retirer) ?\n\nIl retrouvera exactement les droits de son grade.`;
  if(!confirm(msg)) return;
  const btns = [document.getElementById("btnIndivSelectAll"), document.getElementById("btnIndivClearAll")];
  const status = document.getElementById("individualPermBulkStatus");
  btns.forEach(b=>b.disabled = true);
  status.style.color = "var(--text-dim)"; status.textContent = "Enregistrement…";
  try{
    const res = await fetch("/.netlify/functions/manage-individual-permissions", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action, targetDiscordId: discordId }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    individualPermsCache = individualPermsCache || {};
    individualPermsCache[discordId] = data.person || {};
    renderIndividualPermTableForSelected();
    const st = document.getElementById("individualPermBulkStatus");
    st.style.color = "var(--green)"; st.textContent = action === "setAll" ? "✓ Toutes les permissions accordées et enregistrées" : "✓ Exceptions retirées et enregistrées";
    toast(action === "setAll" ? `✓ Toutes les permissions accordées à ${emp ? emp.name : discordId}` : `✓ Exceptions retirées pour ${emp ? emp.name : discordId}`);
  }catch(err){
    try{ await renderIndividualPermissionsCard(); }catch(e){} // resynchronise l'affichage avec la base…
    const st = document.getElementById("individualPermBulkStatus"); // …PUIS affiche l'erreur (sinon la resynchro l'effaçait)
    st.style.color = "var(--red)"; st.textContent = `✕ Échec : ${err.message} — rien n'a été modifié.`;
  }finally{
    btns.forEach(b=>b.disabled = false);
  }
}
document.getElementById("btnIndivSelectAll").addEventListener("click", ()=>individualBulk("setAll"));
document.getElementById("btnIndivClearAll").addEventListener("click", ()=>individualBulk("clearAll"));

function renderIndividualPermTableForSelected(){
  const select = document.getElementById("individualPermPersonSelect");
  const discordId = select.value;
  const info = document.getElementById("individualPermPersonInfo");
  const table = document.getElementById("individualPermTable");
  const bulkBar = document.getElementById("individualPermBulkBar");
  if(!discordId){ info.textContent = ""; table.innerHTML = ""; bulkBar.style.display = "none"; return; }
  const emp = employees.find(e=>e.discordId===discordId);
  const isSelf = currentUserDiscordId && String(discordId) === String(currentUserDiscordId) && currentUserLevel !== "OWNER";
  info.textContent = (emp ? `${emp.name} — grade actuel : ${emp.grade}` : "") + (isSelf ? " — tu ne peux pas modifier tes propres permissions." : "");
  bulkBar.style.display = (isSelf || !hasCap("manage_permissions")) ? "none" : "flex";
  document.getElementById("individualPermBulkStatus").textContent = "";

  // Même règle que côté serveur : OWNER possède sa propre couche, strictement
  // au-dessus de DG ; CD/D/DG utilisent leur couche ; un autre gestionnaire
  // ayant reçu ce droit agit au niveau CD.
  const myLayer = ["OWNER","DG","D","CD"].includes(currentUserLevel) ? currentUserLevel : "CD";
  const personEntry = (individualPermsCache && individualPermsCache[discordId]) || {};
  const styleKey = canonicalCharacterId(discordId);
  const canChooseAnimationStyle = currentUserLevel === "OWNER" && hasAnimationPortraitPair(styleKey);
  const savedAnimationStyle = personEntry.animation_portrait_style === "real" || personEntry.animation_portrait_style === "illustration" ? personEntry.animation_portrait_style : null;
  const animationStyleBlock = canChooseAnimationStyle ? `<div style="padding:10px 0 12px;border-bottom:1px solid var(--border-soft);margin-bottom:4px;">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span style="flex:1;min-width:230px;color:var(--cyan);font-weight:800;">🎨 Style des animations<br><small style="color:var(--text-faint);font-weight:500;">OWNER uniquement · le collègue reste aléatoire, mais toute la scène utilise le même style.</small></span>
      <button type="button" class="btn-small ${savedAnimationStyle==="illustration"?"btn-primary":"btn-ghost"}" data-indiv-animation-style="illustration">🖌️ Dessin IA</button>
      <button type="button" class="btn-small ${savedAnimationStyle==="real"?"btn-primary":"btn-ghost"}" data-indiv-animation-style="real">🎭 Personnage RP</button>
      ${savedAnimationStyle===null?`<span style="font-size:.7rem;color:var(--text-faint);">Actuel : aléatoire 50/50</span>`:""}
    </div>
  </div>` : "";

  table.innerHTML = animationStyleBlock + (individualAllPermsCache || INDIVIDUAL_PERM_KEYS).map(perm=>{
    const layers = personEntry[perm] || { CD:null, D:null, DG:null, OWNER:null };
    // couche active = la plus haute qui a une valeur
    let activeLayer = null, activeValue = null;
    for(const l of ["OWNER","DG","D","CD"]){
      if(layers[l] === true || layers[l] === false){ activeLayer = l; activeValue = layers[l]; break; }
    }
    // Ce que "Hériter" donne VRAIMENT pour le grade de cette personne
    // (demandé le 09/09) — pour ne pas laisser deviner.
    const gradeValue = (effectiveByGradeCache && emp) ? !!(effectiveByGradeCache[emp.grade] && effectiveByGradeCache[emp.grade][perm]) : null;
    const heritLabel = gradeValue===null ? "Hériter" : `Hériter (${gradeValue ? "Autorisé" : "Refusé"})`;
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-soft);font-size:0.82rem;">
      <span style="flex:1;${perm==="exclude_animations"?"color:var(--amber);font-weight:800;":""}">${esc(PERMISSION_LABEL[perm]||perm)}${perm==="exclude_animations"?`<br><small style="color:var(--text-faint);font-weight:500;">N’apparaît ni comme personnage connecté, ni comme collègue tiré au sort — Roster + Pillbox.</small>`:""}</span>
      <button type="button" class="btn-small ${activeValue===null?'btn-primary':'btn-ghost'}" data-indiv-set="${perm}" data-indiv-value="cancel">${esc(heritLabel)}</button>
      <button type="button" class="btn-small ${activeValue===true?'btn-primary':'btn-ghost'}" data-indiv-set="${perm}" data-indiv-value="true">Autorisé</button>
      <button type="button" class="btn-small ${activeValue===false?'btn-danger':'btn-ghost'}" data-indiv-set="${perm}" data-indiv-value="false">Refusé</button>
      ${activeLayer ? `<span style="font-size:0.7rem;color:var(--text-faint);">(${activeLayer})</span>` : ""}
    </div>`;
  }).join("");

  table.querySelectorAll("[data-indiv-animation-style]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      if(currentUserLevel !== "OWNER") return;
      const animationStyle=btn.dataset.indivAnimationStyle;
      table.querySelectorAll("[data-indiv-animation-style]").forEach(b=>b.disabled=true);
      try{
        const res=await fetch("/.netlify/functions/manage-individual-permissions",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({token:currentSessionToken,action:"setAnimationStyle",targetDiscordId:discordId,animationStyle})
        });
        const data=await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(data.error||`${res.status}`);
        individualPermsCache = individualPermsCache || {};
        individualPermsCache[discordId] = data.person || individualPermsCache[discordId] || {};
        await loadAnimationExclusionsFromCloud();
        toast(animationStyle==="real" ? "🎭 Personnage RP sélectionné pour ses animations." : "🖌️ Dessin IA sélectionné pour ses animations.");
        renderIndividualPermTableForSelected();
      }catch(err){
        toast(`✕ ${err.message}`);
        table.querySelectorAll("[data-indiv-animation-style]").forEach(b=>b.disabled=false);
      }
    });
  });

  table.querySelectorAll("[data-indiv-set]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const perm = btn.dataset.indivSet;
      const valueStr = btn.dataset.indivValue;
      btn.disabled = true;
      try{
        const payload = valueStr === "cancel"
          ? { token: currentSessionToken, action:"cancel", targetDiscordId: discordId, permissionName: perm, cancelLayer: myLayer }
          : { token: currentSessionToken, action:"set", targetDiscordId: discordId, permissionName: perm, value: valueStr === "true" };
        const res = await fetch("/.netlify/functions/manage-individual-permissions", {
          method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload),
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(data.error || `${res.status}`);
        individualPermsCache = individualPermsCache || {};
        individualPermsCache[discordId] = individualPermsCache[discordId] || {};
        individualPermsCache[discordId][perm] = data.current;
        renderIndividualPermTableForSelected();
        if(perm === "exclude_animations") loadAnimationExclusionsFromCloud();
        toast(`✓ ${PERMISSION_LABEL[perm]} mis à jour`);
      }catch(err){
        toast(`✕ Refusé : ${err.message}`);
      }finally{
        btn.disabled = false;
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// DEMANDES DE PERMISSIONS (09/09) — ADD crée, CD+ traite.
// ═══════════════════════════════════════════════════════════════════
async function renderPermissionRequestsCard(){
  const card = document.getElementById("permissionRequestsCard");
  // (12/10) Selon les droits réels : peut demander (sans pouvoir décider
  // directement) / peut traiter les demandes.
  const isAdd = hasCap("request_individual_permission") && !hasCap("manage_permissions");
  const canReview = hasCap("manage_permissions");
  card.style.display = (isAdd || canReview) ? "" : "none";
  if(!isAdd && !canReview) return;

  document.getElementById("permissionRequestCreateBox").style.display = isAdd ? "" : "none";
  if(isAdd){
    const personSelect = document.getElementById("permReqPersonSelect");
    personSelect.innerHTML = `<option value="">— Personne concernée —</option>` +
      employees.filter(e=>!e.licencie)
        .sort((a,b)=> GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) || a.name.localeCompare(b.name))
        .map(e=>`<option value="${esc(e.discordId)}" data-name="${esc(e.name)}">${esc(e.name)} (${esc(e.grade)})</option>`).join("");
    const permSelect = document.getElementById("permReqPermissionSelect");
    permSelect.innerHTML = `<option value="">— Permission concernée —</option>` +
      REQUESTABLE_PERMISSION_KEYS.map(k=>`<option value="${k}">${esc(PERMISSION_LABEL[k])}</option>`).join("");
  }

  const list = document.getElementById("permissionRequestsList");
  list.textContent = "Chargement…";
  try{
    // Pas de fonction de lecture dédiée pour l'instant — on relit
    // directement via manage-individual-permissions n'est pas adapté ;
    // on utilise donc une lecture directe (lecture seule, chemin déjà
    // protégé par "auth != null" au niveau Firebase).
    const idToken = currentFirebaseIdToken;
    if(!idToken){ list.textContent = "Session Firebase pas encore prête, réessaie dans un instant."; return; }
    const res = await fetch(`https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPermissionRequests.json?auth=${idToken}`);
    const all = res.ok ? (await res.json()) : {};
    const entries = Object.entries(all || {}).sort((a,b)=>(b[1].requestedAt||0)-(a[1].requestedAt||0));
    // Limitation connue : un ADD voit ici TOUTES les demandes, pas
    // seulement les siennes (le client ne connaît pas son propre
    // discordId séparément du jeton signé) — pas un souci de sécurité
    // (une personne sans « Gérer les permissions » ne peut de toute façon rien y faire),
    // juste un affichage moins filtré qu'idéal.
    if(!entries.length){ list.textContent = "Aucune demande pour l'instant."; return; }
    list.innerHTML = entries.map(([id, r])=>{
      const statusLabel = { pending:"⏳ En attente", accepted:"✅ Acceptée", refused:"❌ Refusée", cancelled:"◌ Annulée" }[r.status] || r.status;
      const canAct = canReview && r.status === "pending";
      const canDelete = canReview && r.status !== "pending";
      return `<div style="font-size:0.82rem;padding:8px 0;border-bottom:1px solid var(--border-soft);">
        <div><b>${esc(r.requestedByName||"?")}</b> demande <b>${esc(PERMISSION_LABEL[r.permissionName]||r.permissionName)}</b> = ${r.requestedValue ? "Autorisé" : "Refusé"} pour <b>${esc(r.targetName||r.targetDiscordId)}</b></div>
        <div style="color:var(--text-faint);margin-top:2px;">${statusLabel}${r.reviewedByName ? ` — traité par ${esc(r.reviewedByName)} (${esc(r.reviewedByLevel)})` : ""}</div>
        ${(canAct || canDelete) ? `<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;">
          ${canAct ? `<button type="button" class="btn-primary btn-small" data-req-approve="${id}">✅ Accepter</button>
          <button type="button" class="btn-danger btn-small" data-req-refuse="${id}">❌ Refuser</button>` : ""}
          ${canDelete ? `<button type="button" class="btn-ghost btn-small" data-req-delete="${id}" title="Supprimer cette demande traitée">🗑️ Supprimer</button>` : ""}
        </div>` : ""}
      </div>`;
    }).join("");
    list.querySelectorAll("[data-req-approve],[data-req-refuse]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const requestId = btn.dataset.reqApprove || btn.dataset.reqRefuse;
        const action = btn.dataset.reqApprove ? "approve" : "refuse";
        try{
          const res = await fetch("/.netlify/functions/permission-requests", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ token: currentSessionToken, action, requestId }),
          });
          const data = await res.json().catch(()=>({}));
          if(!res.ok) throw new Error(data.error || `${res.status}`);
          toast(action === "approve" ? "✓ Demande acceptée, permission appliquée." : "Demande refusée.");
          renderPermissionRequestsCard();
        }catch(err){
          toast(`✕ Refusé : ${err.message}`);
        }
      });
    });
    list.querySelectorAll("[data-req-delete]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const requestId = btn.dataset.reqDelete;
        if(!confirm("Supprimer définitivement cette demande de permission de l’historique ?\n\nLa permission déjà appliquée ne sera PAS retirée.")) return;
        btn.disabled = true;
        try{
          const res = await fetch("/.netlify/functions/permission-requests", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ token: currentSessionToken, action:"delete", requestId }),
          });
          const data = await res.json().catch(()=>({}));
          if(!res.ok) throw new Error(data.error || `${res.status}`);
          toast("🗑️ Demande supprimée de l’historique.");
          renderPermissionRequestsCard();
        }catch(err){
          toast(`✕ Suppression refusée : ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  }catch(err){
    list.textContent = `Impossible de charger les demandes (${err.message}).`;
  }
}
document.getElementById("permReqCreateBtn").addEventListener("click", async ()=>{
  const personSelect = document.getElementById("permReqPersonSelect");
  const permSelect = document.getElementById("permReqPermissionSelect");
  const valueSelect = document.getElementById("permReqValueSelect");
  const msg = document.getElementById("permReqCreateMsg");
  const discordId = personSelect.value;
  const permission = permSelect.value;
  if(!discordId || !permission){ msg.innerHTML = `<span style="color:var(--red);">Choisis une personne et une permission.</span>`; return; }
  const targetName = personSelect.options[personSelect.selectedIndex].dataset.name;
  try{
    const res = await fetch("/.netlify/functions/permission-requests", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"create", targetDiscordId: discordId, targetName, permissionName: permission, requestedValue: valueSelect.value === "true" }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    msg.innerHTML = `<span style="color:var(--green);">✓ Demande envoyée, en attente de validation par un CD.</span>`;
    renderPermissionRequestsCard();
  }catch(err){
    msg.innerHTML = `<span style="color:var(--red);">✕ ${esc(err.message)}</span>`;
  }
});


// (10/10, demandé) Fonction partagée par les deux boutons — Roster et
// Pillbox fonctionnent exactement pareil, seule la portée change.
async function handleForceLogoutClick(selectId, scope, scopeLabel, btn){
  const sel = document.getElementById(selectId);
  const targetDiscordId = sel.value;
  if(!targetDiscordId){ toast("Choisis d'abord une personne"); return; }
  const label = sel.options[sel.selectedIndex].textContent;
  if(!confirm(`Déconnecter ${label} de ${scopeLabel} immédiatement ? Rien ne l'empêche de se reconnecter juste après.`)) return;
  btn.disabled = true;
  try{
    const res = await fetch("/.netlify/functions/force-logout", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"kick", targetDiscordId, scope }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    toast(`✓ ${label} déconnecté(e) de ${scopeLabel}`);
    sel.value = "";
  }catch(err){
    toast(`✕ Refusé : ${err.message}`);
  }finally{
    btn.disabled = false;
  }
}
document.getElementById("btnForceLogout").addEventListener("click", (e)=>{
  handleForceLogoutClick("forceLogoutPersonSelect", "roster", "le Roster", e.target);
});
document.getElementById("btnForceLogoutPillbox").addEventListener("click", (e)=>{
  handleForceLogoutClick("forceLogoutPillboxPersonSelect", "pillbox", "Pillbox", e.target);
});

// ═══════════════════════════════════════════════════════════════════
// RÉGLAGES DES PAIES (03/10) — réservé D/DG/OWNER (can manage_pay_rules).
// Première tranche de l'audit des règles : rémunération uniquement.
// Les labels de grade utilisent GRADE_LABEL déjà existant pour rester
// cohérents avec le reste du Roster.
// ═══════════════════════════════════════════════════════════════════
const PAY_RULES_GRADES = ["STG","A","INF","M","MF","MP","MLP","RF","RP","RL","MC","ADD","CD","D","DG"];
let payRulesConfigCache = null;

async function loadPayRulesConfig(){
  const status = document.getElementById("reglagesPaieStatus");
  const body = document.getElementById("reglagesPaieBody");
  try{
    const res = await fetch("/.netlify/functions/pay-rules-actions");
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    payRulesConfigCache = data.config;
    if(status) status.textContent = data.config.updatedAt
      ? `Dernière modification : ${new Date(data.config.updatedAt).toLocaleString("fr-FR")} par ${esc(data.config.updatedBy||"?")}`
      : "Aucune modification pour l'instant — valeurs par défaut (identiques au comportement actuel de Pillbox).";
    renderPayRulesForm();
  }catch(err){
    if(body) body.innerHTML = `<div class="empty-msg">Impossible de charger les réglages (${esc(err.message)}).</div>`;
  }
}

async function savePayRuleField(field, value, btn){
  if(btn) btn.disabled = true;
  try{
    const res = await fetch("/.netlify/functions/pay-rules-actions", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, field, value }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `${res.status}`);
    payRulesConfigCache = data.config;
    toast("✓ Réglage enregistré — pris en compte au prochain calcul Pillbox");
    loadPayRulesConfig();
    renderPayRulesHistory();
  }catch(err){
    toast(`✕ Refusé : ${err.message}`);
  }finally{
    if(btn) btn.disabled = false;
  }
}

function renderPayRulesForm(){
  const body = document.getElementById("reglagesPaieBody");
  if(!body || !payRulesConfigCache) return;
  const c = payRulesConfigCache;

  const gradeRows = PAY_RULES_GRADES.map(g=>`
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span class="grade-badge" style="background:${GRADE_COLOR[g]};color:${GRADE_TEXT_COLOR[g]};min-width:48px;text-align:center;">${g}</span>
      <span style="flex:1;color:var(--text-dim);font-size:0.82rem;">${esc(GRADE_LABEL[g])}</span>
      <input type="number" min="0" step="1" data-salary-grade="${g}" value="${c.fixedSalaryByGrade[g]}" style="width:140px;">
    </div>
  `).join("");

  const ppaGradesRows = PAY_RULES_GRADES.map(g=>`
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:0.8rem;margin:3px 10px 3px 0;">
      <input type="checkbox" data-ppa-grade="${g}" ${c.ppaEligibleGrades.includes(g)?"checked":""}> ${g}
    </label>
  `).join("");

  body.innerHTML = `
    <div style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:0.85rem;margin-bottom:8px;">💰 Tarif d'une réanimation</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="number" min="0" step="100" id="payRuleReaRate" value="${c.reaRate}" style="width:160px;">
        <span style="color:var(--text-dim);font-size:0.8rem;">$ par réanimation</span>
        <button type="button" class="btn-primary btn-small" id="btnSaveReaRate">Enregistrer</button>
      </div>
    </div>

    <div style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px;">🏆 Bonus du classement des réanimations</div>
      <div class="special-sub" style="margin-bottom:8px;">En cas d'égalité, un rang peut être partagé par plusieurs personnes — comportement inchangé, seuls les montants sont réglables ici.</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">1er <input type="number" min="0" step="100" id="payRuleBonus1" value="${c.bonusByRank["1"]}" style="width:130px;"></label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">2e <input type="number" min="0" step="100" id="payRuleBonus2" value="${c.bonusByRank["2"]}" style="width:130px;"></label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">3e <input type="number" min="0" step="100" id="payRuleBonus3" value="${c.bonusByRank["3"]}" style="width:130px;"></label>
        <button type="button" class="btn-primary btn-small" id="btnSaveBonus">Enregistrer</button>
      </div>
    </div>

    <div style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px;">📋 Primes PPA</div>
      <div class="special-sub" style="margin-bottom:8px;">Plafond par personne et par semaine, et grades autorisés à recevoir une PPA. La prime personnelle (libre, sans plafond codé) n'est pas concernée par ce réglage.</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <input type="number" min="0" step="100" id="payRulePpaCap" value="${c.ppaWeeklyCap}" style="width:160px;">
        <span style="color:var(--text-dim);font-size:0.8rem;">$ plafond hebdomadaire</span>
        <button type="button" class="btn-primary btn-small" id="btnSavePpaCap">Enregistrer</button>
      </div>
      <div>${ppaGradesRows}</div>
      <button type="button" class="btn-primary btn-small" id="btnSavePpaGrades" style="margin-top:8px;">Enregistrer les grades PPA</button>
    </div>

    <div style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px;">📊 Quotas de réanimations</div>
      <div class="special-sub" style="margin-bottom:8px;">Grades staff (tag "STAFF" dans Info) utilisent le quota staff, les autres le quota standard. Les grades exemptés ci-dessous n'ont jamais de quota obligatoire.</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">Quota standard <input type="number" min="0" step="1" id="payRuleQuotaStandard" value="${c.quotaStandard}" style="width:100px;"></label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">Quota staff <input type="number" min="0" step="1" id="payRuleQuotaStaff" value="${c.quotaStaff}" style="width:100px;"></label>
        <button type="button" class="btn-primary btn-small" id="btnSaveQuotas">Enregistrer</button>
      </div>
      <div style="font-size:0.8rem;margin-bottom:4px;">Grades exemptés de quota :</div>
      <div style="margin-bottom:10px;">${PAY_RULES_GRADES.map(g=>`
        <label style="display:inline-flex;align-items:center;gap:5px;font-size:0.8rem;margin:3px 10px 3px 0;">
          <input type="checkbox" data-exempt-grade="${g}" ${c.exemptGrades.includes(g)?"checked":""}> ${g}
        </label>
      `).join("")}</div>
      <button type="button" class="btn-primary btn-small" id="btnSaveExemptGrades" style="margin-bottom:14px;">Enregistrer les grades exemptés</button>

      <div class="special-sub" style="margin-bottom:8px;">Zone "presque atteint" : propose de valider le quota malgré tout, sans l'appliquer automatiquement — jamais pour les grades staff.</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">Seuil bas <input type="number" min="0" step="1" id="payRuleNearMissThreshold" value="${c.nearMissThreshold}" style="width:100px;"></label>
        <span style="color:var(--text-dim);font-size:0.8rem;">réa (jusqu'au quota standard exclu)</span>
        <button type="button" class="btn-primary btn-small" id="btnSaveNearMissThreshold">Enregistrer</button>
      </div>
      <div style="font-size:0.8rem;margin-bottom:4px;">Grades concernés par cette zone :</div>
      <div>${PAY_RULES_GRADES.map(g=>`
        <label style="display:inline-flex;align-items:center;gap:5px;font-size:0.8rem;margin:3px 10px 3px 0;">
          <input type="checkbox" data-nearmiss-grade="${g}" ${c.nearMissGrades.includes(g)?"checked":""}> ${g}
        </label>
      `).join("")}</div>
      <button type="button" class="btn-primary btn-small" id="btnSaveNearMissGrades" style="margin-top:8px;">Enregistrer les grades concernés</button>
    </div>

    <div style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px;">⚠️ Q et licenciements</div>
      <div class="special-sub" style="margin-bottom:8px;">Stagiaire : proposition à partir du seuil bas, licenciement automatique à partir du seuil haut (sans confirmation). Ambulancier : proposition au seuil indiqué, jamais automatique directement. Les autres grades suivent la règle de cumul Q+A.</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">STG — proposition dès Q <input type="number" min="1" max="3" step="1" id="payRuleStgProposal" value="${c.stgProposalThreshold}" style="width:80px;"></label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">STG — automatique dès Q <input type="number" min="1" max="3" step="1" id="payRuleStgAuto" value="${c.stgAutoThreshold}" style="width:80px;"></label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">Ambulancier — proposition à Q <input type="number" min="1" max="3" step="1" id="payRuleAProposal" value="${c.aProposalThreshold}" style="width:80px;"></label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">Cumul Q+A &gt; <input type="number" min="1" max="3" step="1" id="payRuleQaCumul" value="${c.qaCumulThreshold}" style="width:80px;"></label>
        <button type="button" class="btn-primary btn-small" id="btnSaveQLicen">Enregistrer</button>
      </div>
      <!-- (11/10, demandé) Infirmiers — même principe que l'Ambulancier
           (proposition, jamais automatique), mais DÉSACTIVÉ par défaut
           tant que la case n'est pas cochée : sans ça, les Infirmiers
           continuent de suivre uniquement le cumul Q+A, comme avant.
           (13/10, section 4.3) Regroupé dans la MÊME case que STG/A
           (plus de séparateur visuel entre les deux) — la case
           "Activation" des Infirmiers reste inchangée, juste au même
           endroit visuellement. -->
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:10px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">
          <input type="checkbox" id="payRuleInfEnabled" ${c.infProposalEnabled?"checked":""}> Activer une proposition pour les Infirmiers
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">Infirmier — proposition à Q <input type="number" min="1" max="3" step="1" id="payRuleInfProposal" value="${c.infProposalThreshold}" style="width:80px;"></label>
        <button type="button" class="btn-primary btn-small" id="btnSaveInf">Enregistrer</button>
      </div>
      <!-- (13/10, section 4.4) Même mécanisme de proposition, généralisé
           à n'importe quel grade au-delà de STG/A/INF — vide par défaut,
           donc aucun changement tant que rien n'est coché ici. -->
      <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-soft);">
        <div>
          <div style="font-size:0.78rem;color:var(--text-dim);font-weight:600;margin-bottom:6px;">Grades concernés (proposition Q, comme STG/A/INF)</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;max-width:360px;">
            ${["M","MF","MP","MLP","RF","RP","RL"].map(g=>`
              <label style="display:flex;align-items:center;gap:4px;font-size:0.78rem;">
                <input type="checkbox" data-extraq-grade="${g}" ${(c.extraQProposalGrades||[]).includes(g)?"checked":""}> ${g}
              </label>
            `).join("")}
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;">Proposition à Q <input type="number" min="1" max="3" step="1" id="payRuleExtraQThreshold" value="${c.extraQProposalThreshold}" style="width:80px;"></label>
        <button type="button" class="btn-primary btn-small" id="btnSaveExtraQ">Enregistrer</button>
      </div>
    </div>

    <details>
      <summary class="btn-ghost btn-small">💵 Salaires fixes de référence par grade</summary>
      <div class="special-sub" style="margin:8px 0;">Ces montants ne remplacent PAS le salaire normal du tableau EMS — ils servent uniquement de référence pour calculer la déduction en cas de quota manqué, et pour remplacer un salaire à 0 $ détecté comme probable erreur. Comportement inchangé, seuls les montants sont réglables ici.</div>
      <div style="max-width:420px;">${gradeRows}</div>
      <button type="button" class="btn-primary btn-small" id="btnSaveSalaries" style="margin-top:10px;">Enregistrer les salaires fixes</button>
    </details>
  `;

  document.getElementById("btnSaveReaRate").addEventListener("click", (e)=>{
    const v = +document.getElementById("payRuleReaRate").value;
    if(!(v>=0)){ toast("Montant invalide"); return; }
    savePayRuleField("reaRate", v, e.target);
  });
  document.getElementById("btnSaveBonus").addEventListener("click", (e)=>{
    const value = {
      "1": +document.getElementById("payRuleBonus1").value,
      "2": +document.getElementById("payRuleBonus2").value,
      "3": +document.getElementById("payRuleBonus3").value,
    };
    if(Object.values(value).some(v=>!(v>=0))){ toast("Montant invalide"); return; }
    savePayRuleField("bonusByRank", value, e.target);
  });
  document.getElementById("btnSavePpaCap").addEventListener("click", (e)=>{
    const v = +document.getElementById("payRulePpaCap").value;
    if(!(v>=0)){ toast("Montant invalide"); return; }
    savePayRuleField("ppaWeeklyCap", v, e.target);
  });
  document.getElementById("btnSavePpaGrades").addEventListener("click", (e)=>{
    const grades = PAY_RULES_GRADES.filter(g=>document.querySelector(`[data-ppa-grade="${g}"]`).checked);
    savePayRuleField("ppaEligibleGrades", grades, e.target);
  });
  document.getElementById("btnSaveQuotas").addEventListener("click", async (e)=>{
    const std = +document.getElementById("payRuleQuotaStandard").value;
    const staff = +document.getElementById("payRuleQuotaStaff").value;
    if(!(std>=0) || !(staff>=0)){ toast("Valeur invalide"); return; }
    e.target.disabled = true;
    await savePayRuleField("quotaStandard", std, e.target);
    await savePayRuleField("quotaStaff", staff, e.target);
  });
  document.getElementById("btnSaveExemptGrades").addEventListener("click", (e)=>{
    const grades = PAY_RULES_GRADES.filter(g=>document.querySelector(`[data-exempt-grade="${g}"]`).checked);
    savePayRuleField("exemptGrades", grades, e.target);
  });
  document.getElementById("btnSaveNearMissThreshold").addEventListener("click", (e)=>{
    const v = +document.getElementById("payRuleNearMissThreshold").value;
    if(!(v>=0)){ toast("Valeur invalide"); return; }
    savePayRuleField("nearMissThreshold", v, e.target);
  });
  document.getElementById("btnSaveNearMissGrades").addEventListener("click", (e)=>{
    const grades = PAY_RULES_GRADES.filter(g=>document.querySelector(`[data-nearmiss-grade="${g}"]`).checked);
    savePayRuleField("nearMissGrades", grades, e.target);
  });
  document.getElementById("btnSaveQLicen").addEventListener("click", async (e)=>{
    const stgProposal = +document.getElementById("payRuleStgProposal").value;
    const stgAuto = +document.getElementById("payRuleStgAuto").value;
    const aProposal = +document.getElementById("payRuleAProposal").value;
    const qaCumul = +document.getElementById("payRuleQaCumul").value;
    if([stgProposal,stgAuto,aProposal,qaCumul].some(v=>!(v>=1) || v>3)){ toast("Seuil invalide (max 3)"); return; }
    if(qaCumul>3){ toast("Le cumul Q+A ne peut pas dépasser 3"); return; }
    e.target.disabled = true;
    await savePayRuleField("stgProposalThreshold", stgProposal, e.target);
    await savePayRuleField("stgAutoThreshold", stgAuto, e.target);
    await savePayRuleField("aProposalThreshold", aProposal, e.target);
    await savePayRuleField("qaCumulThreshold", qaCumul, e.target);
  });
  document.getElementById("btnSaveInf").addEventListener("click", async (e)=>{
    const enabled = document.getElementById("payRuleInfEnabled").checked;
    const threshold = +document.getElementById("payRuleInfProposal").value;
    if(!(threshold>=1) || threshold>3){ toast("Seuil invalide (max 3)"); return; }
    e.target.disabled = true;
    await savePayRuleField("infProposalEnabled", enabled, e.target);
    await savePayRuleField("infProposalThreshold", threshold, e.target);
  });
  document.getElementById("btnSaveExtraQ").addEventListener("click", async (e)=>{
    const grades = ["M","MF","MP","MLP","RF","RP","RL"].filter(g=>document.querySelector(`[data-extraq-grade="${g}"]`).checked);
    const threshold = +document.getElementById("payRuleExtraQThreshold").value;
    if(!(threshold>=1) || threshold>3){ toast("Seuil invalide (max 3)"); return; }
    e.target.disabled = true;
    await savePayRuleField("extraQProposalGrades", grades, e.target);
    await savePayRuleField("extraQProposalThreshold", threshold, e.target);
  });
  document.getElementById("btnSaveSalaries").addEventListener("click", (e)=>{
    const value = {};
    let invalid = false;
    PAY_RULES_GRADES.forEach(g=>{
      const v = +document.querySelector(`[data-salary-grade="${g}"]`).value;
      if(!(v>=0)) invalid = true;
      value[g] = v;
    });
    if(invalid){ toast("Un ou plusieurs montants invalides"); return; }
    savePayRuleField("fixedSalaryByGrade", value, e.target);
  });
}

async function renderPayRulesHistory(){
  const box = document.getElementById("reglagesPaieHistory");
  if(!box || !currentFirebaseIdToken) return;
  box.textContent = "Chargement…";
  try{
    const res = await fetch(withFirebaseAuth("https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/payRulesConfigHistory.json"));
    const all = res.ok ? (await res.json()) : {};
    const entries = Object.values(all||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    if(!entries.length){ box.textContent = "Aucune modification enregistrée pour l'instant."; return; }
    const fieldLabel = { reaRate:"Tarif réa", bonusByRank:"Bonus de classement", ppaWeeklyCap:"Plafond PPA", ppaEligibleGrades:"Grades PPA", fixedSalaryByGrade:"Salaires fixes", quotaStandard:"Quota standard", quotaStaff:"Quota staff", exemptGrades:"Grades exemptés", nearMissGrades:"Grades (presque atteint)", nearMissThreshold:"Seuil presque atteint", stgProposalThreshold:"STG proposition", stgAutoThreshold:"STG automatique", aProposalThreshold:"A proposition", qaCumulThreshold:"Cumul Q+A", infProposalEnabled:"INF proposition (activé)", infProposalThreshold:"INF proposition (seuil)", extraQProposalGrades:"Proposition Q — grades concernés", extraQProposalThreshold:"Proposition Q — seuil" };
    box.innerHTML = entries.slice(0,100).map(e=>`
      <div style="padding:8px 0;border-bottom:1px solid var(--border-soft);font-size:0.82rem;">
        <div><b>${esc(fieldLabel[e.field]||e.field)}</b> — ${new Date(e.createdAt).toLocaleString("fr-FR")}</div>
        <div style="color:var(--text-dim);font-size:0.78rem;margin-top:2px;">Par ${esc(e.authorName||"?")} (${esc(e.authorLevel||"?")})</div>
        <div style="font-size:0.76rem;color:var(--text-faint);margin-top:2px;">Avant : ${esc(JSON.stringify(e.oldValue))} — Après : ${esc(JSON.stringify(e.newValue))}</div>
      </div>
    `).join("");
  }catch(err){
    box.textContent = `Impossible de charger l'historique (${err.message}).`;
  }
}

// ── Retrait par code ──
document.getElementById("signalementWithdrawBtn").addEventListener("click", async ()=>{
  const code = document.getElementById("signalementWithdrawCodeInput").value.trim();
  const msg = document.getElementById("signalementWithdrawMsg");
  msg.innerHTML = "";
  if(!code){ msg.innerHTML = `<span style="color:var(--red);">Colle d'abord ton code.</span>`; return; }
  try{
    await signalementServerAction("withdrawSignalementByCode", {key:code});
    msg.innerHTML = `<span style="color:var(--green);">✓ Signalement retiré.</span>`;
    document.getElementById("signalementWithdrawCodeInput").value = "";
    loadSignalementPending();
  }catch(err){
    msg.innerHTML = `<span style="color:var(--red);">✕ Échec du retrait (${esc(err.message)}).</span>`;
  }
});

// Mode admin par mot de passe entièrement supprimé (08/09) — les droits
// de gestion des signalements dépendent désormais uniquement du niveau
// réel (ADD/CD/D/OWNER), déterminé côté serveur à la connexion Discord.
// Plus aucun mot de passe, plus aucun bouton "mode admin".

// ═══════════════════════════ INIT ═══════════════════════════
// ═══════════════════════════════════════════════════════════════════
// AUTHENTIFICATION DISCORD — obligatoire pour accéder à l'outil.
// ⚠️ IMPORTANT (honnêteté sur ce que ça protège vraiment) : ceci est un
// BLOCAGE VISUEL côté navigateur, pas encore une vraie sécurité serveur.
// Firebase reste directement accessible en dehors de cette interface
// (comme avant) — la vraie protection des données elles-mêmes viendra à
// une étape suivante (vérification serveur avant chaque action
// sensible). Le vrai secret Discord, lui, ne touche JAMAIS ce fichier —
// tout se passe dans netlify/functions/discord-callback.js.
// ═══════════════════════════════════════════════════════════════════
const DISCORD_CLIENT_ID = "1546550001864282122";
const DISCORD_REDIRECT_URI = "https://roster-ems.netlify.app/.netlify/functions/discord-callback"; // à adapter à ta vraie adresse Netlify
// Clé Web publique de ton projet Firebase (PAS un secret — c'est fait pour
// être visible dans le code, exactement comme le Client ID Discord).
// Console Firebase → ⚙️ Paramètres du projet → onglet "Général" → tout en
// bas dans "Vos applications" → "Clé API Web". À remplacer une fois
// récupérée (voir le guide donné à part).
const FIREBASE_WEB_API_KEY = "AIzaSyCUS94X-UrMX-Jc8nts5I58mI00MgrdY7I";

// Jeton de session — gardé UNIQUEMENT en mémoire JS (jamais localStorage,
// cohérent avec "pas de mémorisation, reconnexion à chaque fois"). Perdu
// à chaque rechargement, exactement comme le reste de la session.
let currentSessionToken = null;
// Niveau réel de la personne connectée (MC/ADD/CD/D/OWNER) — déterminé
// UNIQUEMENT côté serveur à la connexion Discord, jamais choisi ou
// modifiable depuis ce fichier. Sert seulement à adapter l'AFFICHAGE
// (afficher/cacher des boutons) — la vraie protection reste toujours
// côté serveur pour chaque action sensible (08/09).
let currentUserLevel = null;
// Jeton d'identité Firebase — c'est LUI qui prouve à Firebase lui-même
// (pas juste à ce site) que tu es bien connecté(e) avec le bon grade.
// Ajouté (?auth=...) aux écritures sensibles sur Firebase (08/09).
let currentFirebaseIdToken = null;

// Échange le jeton personnalisé Firebase (reçu de Discord-callback)
// contre un vrai "jeton d'identité" utilisable — étape obligatoire de
// Firebase Auth, via son propre point d'accès public.
async function exchangeFirebaseCustomToken(customToken){
  try{
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error?.message || `${res.status}`);
    return data.idToken;
  }catch(err){
    console.error("Échange du jeton Firebase impossible:", err);
    return null;
  }
}

function goToDiscordLogin(){
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });
  window.location.href = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}
document.getElementById("btnDiscordLoginGate").addEventListener("click", goToDiscordLogin);

function showGate(errorMsg){
  document.getElementById("accessGate").style.display = "";
  document.getElementById("appContent").style.display = "none";
  document.getElementById("accessGateError").textContent = errorMsg || "";
  currentSessionToken = null;
  currentFirebaseIdToken = null;
  currentUserLevel = null;
}
// Liste de déconnexion forcée — séparée en deux parties : "En ligne"
// (présence Pillbox/Roster) puis "Tous les autres". Rappelée à chaque
// renderAll() : avant, elle n'était remplie qu'une fois dans showApp, AVANT
// que le Roster soit chargé depuis Firebase (employees encore vide) →
// la liste restait vide ("personne n'est proposé").
let forceLogoutPresence = [];
async function refreshForceLogoutPresence(){
  if(!currentSessionToken) return;
  try{
    const res = await fetch("/.netlify/functions/pillbox-presence", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"list" }),
    });
    if(!res.ok) return;
    const data = await res.json().catch(()=>({}));
    forceLogoutPresence = Array.isArray(data.active) ? data.active : [];
    populateForceLogoutSelect();
  }catch(e){}
}
// (10/10, demandé) Remplit UNE liste de déconnexion (Roster ou
// Pillbox), filtrée aux seules personnes ayant un grade donnant accès
// au Roster (MC/ADD/CD/D/DG — jamais STG/A/INF/M/..., qui n'ont de
// toute façon jamais pu se connecter à l'un ou l'autre outil), avec
// son propre regroupement "En ligne" selon SA propre source de
// présence (roster-presence.js pour la liste Roster, pillbox-presence.js
// — déjà existant — pour la liste Pillbox : les deux présences sont
// réellement indépendantes).
function populateOneForceLogoutSelect(selectId, presenceList){
  const sel = document.getElementById(selectId);
  if(!sel || !hasCap("force_logout")) return;
  const previous = sel.value;
  const norm = x => String(x||"").trim().toLowerCase();
  const onlineIds = new Set(presenceList.map(p=>String(p.discordId||p.id||"")).filter(Boolean));
  const onlineNames = new Set(presenceList.map(p=>norm(p.name)));
  const isOnline = e => onlineIds.has(String(e.discordId)) || onlineNames.has(norm(e.name));
  const list = employees.filter(e=>!e.licencie && e.discordId && EDITABLE_LEVELS.includes(e.grade))
    .sort((a,b)=> GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) || a.name.localeCompare(b.name));
  const opt = e => `<option value="${esc(e.discordId)}">${esc(e.name)} (${esc(e.grade)})</option>`;
  const online = list.filter(isOnline), others = list.filter(e=>!isOnline(e));
  sel.innerHTML = `<option value="">— Choisir une personne —</option>` +
    (online.length ? `<optgroup label="🟢 En ligne (${online.length})">${online.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="Tous les autres (${others.length})">${others.map(opt).join("")}</optgroup>`;
  if(previous) sel.value = previous;
}
function populateForceLogoutSelect(){
  populateOneForceLogoutSelect("forceLogoutPersonSelect", rosterPresenceActive);
  populateOneForceLogoutSelect("forceLogoutPillboxPersonSelect", forceLogoutPresence);
}

// Capacités effectives de la session (grade + matrice + exceptions
// individuelles), demandées au serveur — valeur par défaut PAR
// CAPACITÉ en attendant la vraie réponse (10/10 — audit permissions :
// force_logout est maintenant CD+, manage_pay_rules reste D+, un seul
// repli générique aurait affiché le mauvais niveau par défaut pour
// l'un des deux pendant le bref instant avant la réponse serveur).
let userCaps = null;
const CAP_DEFAULT_LEVELS = {
  manage_troll:["OWNER"], owner_delegate:["OWNER"], delete_logs:["OWNER"],
  view_roster:["MC","ADD","CD","D","DG","OWNER"],
  manage_roster:["ADD","CD","D","DG","OWNER"],
  manage_psychologue_category:["MC","ADD","CD","D","DG","OWNER"],
  manage_formateur_category:["MC","ADD","CD","D","DG","OWNER"],
  propose_signalement:["MC","ADD","CD","D","DG","OWNER"],
  create_signalement:["ADD","CD","D","DG","OWNER"],
  validate_signalement:["ADD","CD","D","DG","OWNER"],
  manage_retrogradation:["MC","ADD","CD","D","DG","OWNER"],
  sync_pillbox_complete:["MC","ADD","CD","D","DG","OWNER"],
  view_logs:["MC","ADD","CD","D","DG","OWNER"],
  modify_role_label:["D","DG","OWNER"],
  manage_advanced_settings:["D","DG","OWNER"],
  manage_permissions:["DG","OWNER"],
  use_pillbox_terminal:["MC","ADD","CD","D","DG","OWNER"],
  request_individual_permission:["MC","ADD","CD","D","DG","OWNER"],
  cancel_lower_decisions:["D","DG","OWNER"],
  manage_pay_weeks:["ADD","CD","D","DG","OWNER"],
  manage_absences:["ADD","CD","D","DG","OWNER"],
  manage_pay_rules:["D","DG","OWNER"],
  force_logout:["ADD","CD","D","DG","OWNER"],
  reset_activite_streak:["ADD","CD","D","DG","OWNER"],
  reopen_roster_week:["ADD","CD","D","DG","OWNER"]
} // (12/10) matrice réelle complète, repli tant que le serveur n'a pas répondu — delete_logs/owner_delegate ajoutés le 13/10
function hasCap(name){
  if(userCaps && typeof userCaps[name] === "boolean") return userCaps[name];
  return (CAP_DEFAULT_LEVELS[name] || ["D","DG","OWNER"]).includes(currentUserLevel);
}
let currentUserDiscordId = null;
let currentUserName = null;
const PERMISSIONS_TAB_CAPS = ["manage_permissions","request_individual_permission","force_logout"];
function applyCapsUi(){
  document.getElementById("tabLogsBtn").style.display = hasCap("view_logs") ? "" : "none";
  document.getElementById("tabPermissionsBtn").style.display = (PERMISSIONS_TAB_CAPS.some(hasCap) || ["D","DG","OWNER"].includes(currentUserLevel)) ? "" : "none";
  // (14/10) Le Mode troll n'apparaît plus JAMAIS comme bouton dans la
  // barre d'onglets — accessible uniquement via le raccourci secret
  // CTRL+ALT+T (voir plus bas), qui vérifie lui-même manage_troll avant
  // d'ouvrir l'onglet. Le bouton reste caché dans tous les cas.
  const trollBtn = document.getElementById("tabTrollBtn");
  if(trollBtn) trollBtn.style.display = "none";
  try{ renderGradeLabelsEditor(); }catch(e){}
  if(userCaps){ try{ renderAll(); }catch(e){} }
  const permView = document.getElementById("permissionsView");
  if(userCaps && permView && permView.style.display !== "none"){
    try{ loadPermissionsTable(); renderIndividualPermissionsCard(); renderPermissionRequestsCard(); }catch(e){}
  }
  document.getElementById("tabReglagesPaieBtn").style.display = hasCap("manage_pay_rules") ? "" : "none";
  document.getElementById("forceLogoutCard").style.display = hasCap("force_logout") ? "" : "none";
  document.getElementById("forceLogoutPillboxCard").style.display = hasCap("force_logout") ? "" : "none";
  populateForceLogoutSelect();
}
async function refreshUserCaps(){
  if(!currentSessionToken) return;
  try{
    const res = await fetch("/.netlify/functions/force-logout", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"caps" }),
    });
    if(!res.ok) return;
    userCaps = await res.json().catch(()=>null);
    applyCapsUi();
  }catch(e){}
}
function showApp(session){
  document.getElementById("accessGate").style.display = "none";
  document.getElementById("appContent").style.display = "";
  document.getElementById("discordAuthStatus").innerHTML = `${session.level==="OWNER"?"👑":"✅"} <b>${esc(session.name)}</b> — ${esc(session.levelLabel)}`;
  currentUserDiscordId = session.id || null;
  currentUserName = session.name || null;
  loadAnimPrefFromCloud();
  loadAnimationExclusionsFromCloud();
  document.getElementById("tabLogsBtn").style.display = hasCap("view_logs") ? "" : "none";
  document.getElementById("tabPermissionsBtn").style.display = (PERMISSIONS_TAB_CAPS.some(hasCap) || ["D","DG","OWNER"].includes(currentUserLevel)) ? "" : "none";
  userCaps = null; // repart du grade tant que le serveur n'a pas répondu
  applyCapsUi();
  refreshUserCaps();
  populateForceLogoutSelect();
  refreshForceLogoutPresence();
  renderGradeLabelsEditor();
  renderLastUpdated();
  renderAll(); // pour que les boutons Modifier/Licencier tiennent compte du niveau, maintenant qu'on le connaît
  startSessionRenewal();
}

// (16/10) Renouvelle le jeton de session AVANT qu'il expire, tant que
// l'onglet reste ouvert — complète netlify/functions/renew-session.js,
// qui existait déjà côté serveur mais n'était jamais appelé (cause
// réelle des "permission 401" en plein milieu d'une action comme
// licencier). Renouvelé toutes les 20 minutes : largement avant les 2h
// de validité, donc jamais de coupure tant que la page reste ouverte.
// Un jeton déjà expiré ne peut PAS être renouvelé (le serveur revérifie
// sa validité) — dans ce cas, redemande une vraie reconnexion Discord,
// comme avant.
let sessionRenewalTimer = null;
function startSessionRenewal(){
  if(sessionRenewalTimer) clearInterval(sessionRenewalTimer);
  sessionRenewalTimer = setInterval(renewSessionToken, 20*60*1000);
}
function stopSessionRenewal(){
  if(sessionRenewalTimer){ clearInterval(sessionRenewalTimer); sessionRenewalTimer = null; }
}
async function renewSessionToken(){
  if(!currentSessionToken) return;
  try{
    const res = await fetch("/.netlify/functions/renew-session", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken }),
    });
    if(!res.ok) return; // jeton déjà expiré ou invalide : on laisse faire, la prochaine action sensible redemandera une vraie reconnexion
    const data = await res.json().catch(()=>null);
    if(data && data.token){
      currentSessionToken = data.token;
      let stored = null;
      try{ stored = JSON.parse(localStorage.getItem(ROSTER_SESSION_STORAGE_KEY) || "null"); }catch(e){}
      saveSessionToStorage(data.token, stored && stored.session ? stored.session : {});
    }
  }catch(e){ /* silencieux — un échec réseau ponctuel ne doit pas interrompre la session */ }
}

// Point de passage unique pour les actions sensibles — envoie le jeton,
// la fonction serveur revérifie tout elle-même avant d'écrire quoi que
// ce soit (voir netlify/functions/protected-write.js). Jamais un appel
// direct à Firebase pour ces actions-là.
async function protectedAction(action, payload){
  if(!currentSessionToken){
    toast("Session expirée — reconnecte-toi avec Discord.");
    showGate("Ta session a expiré, reconnecte-toi.");
    throw new Error("no session token");
  }
  const res = await fetch("/.netlify/functions/protected-write", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ token: currentSessionToken, action, payload }),
  });
  // (16/10) Un 401 ici veut toujours dire la même chose : la session a
  // expiré entre deux actions. Avant, le message exact dépendait de ce
  // que renvoyait le serveur et pouvait remonter comme un "401" cru et
  // peu clair — maintenant, toujours le même message explicite + un
  // vrai écran de reconnexion, quel que soit le contenu de la réponse.
  if(res.status === 401){
    toast("Session expirée — reconnecte-toi avec Discord.");
    showGate("Ta session a expiré, reconnecte-toi.");
    throw new Error("Session expirée — reconnecte-toi avec Discord.");
  }
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  if(data.savedAt){ rosterLastUpdatedAt = data.savedAt; renderLastUpdated(); }
  return data;
}

// Même principe, pour le circuit MC → ADD+ des signalements (proposer,
// valider, refuser, demander des infos, créer un signalement officiel).
async function signalementServerAction(action, payload){
  if(!currentSessionToken){
    toast("Session expirée — reconnecte-toi avec Discord.");
    showGate("Ta session a expiré, reconnecte-toi.");
    throw new Error("no session token");
  }
  const res = await fetch("/.netlify/functions/signalement-actions", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ token: currentSessionToken, action, payload: { ...(payload||{}), sandbox: signalementSandboxMode } }),
  });
  if(res.status === 401){
    toast("Session expirée — reconnecte-toi avec Discord.");
    showGate("Ta session a expiré, reconnecte-toi.");
    throw new Error("Session expirée — reconnecte-toi avec Discord.");
  }
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// Ajoute le vrai jeton Firebase à une URL Firebase pour une écriture
// authentifiée — à utiliser pour toute écriture directe (hors
// protectedAction ci-dessus) sur un chemin dont la règle Firebase exige
// désormais une vraie connexion (rosterEmsData en premier, 08/09).
function withFirebaseAuth(url){
  if(!currentFirebaseIdToken) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}auth=${currentFirebaseIdToken}`;
}

// Déconnexion manuelle (bouton) — repasse derrière l'écran de blocage
// immédiatement, sans avoir à recharger la page, et efface la session
// sauvegardée pour que le prochain chargement redemande bien Discord.
document.getElementById("btnDiscordLogout").addEventListener("click", ()=>{
  stopRosterLiveUpdates();
  stopSessionRenewal();
  clearSessionFromStorage();
  currentSessionToken = null; currentFirebaseIdToken = null;
  showGate();
});

// (10/10, demandé — remplace la règle du 07/09 "aucune mémorisation",
// devenue trop contraignante : forcer Discord à chaque F5, alors que la
// session reste valide 2h côté serveur, posait un vrai problème d'usage
// signalé explicitement.) Clé localStorage pour garder la session active d'un
// F5 à l'autre — avant, currentSessionToken n'était gardé qu'en mémoire,
// donc tout rechargement de page le perdait et forçait une reconnexion
// Discord complète (dance OAuth entière), même si la session (valide 2h
// côté serveur, voir session-token.js) n'avait pas du tout expiré.
const ROSTER_SESSION_STORAGE_KEY = "rosterDiscordSession_v1";
// Horodatage d'établissement de LA session actuelle (pas celui du
// jeton) — sert uniquement à ignorer un kick plus ancien que cette
// connexion précise, pour qu'une personne reconnectée après avoir été
// déconnectée de force ne se refasse pas kicker en boucle par le même
// ancien signalement.
let rosterSessionEstablishedAt = 0;
let rosterLiveUpdateInterval = null;
let rosterKickCheckInterval = null;

async function rosterCheckKicked(){
  if(!currentSessionToken) return false;
  try{
    const res = await fetch("/.netlify/functions/force-logout", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"check", scope:"roster" }),
    });
    const data = await res.json().catch(()=>({}));
    if(res.ok && data.kickedAt && data.kickedAt > rosterSessionEstablishedAt){
      if(rosterLiveUpdateInterval){ clearInterval(rosterLiveUpdateInterval); rosterLiveUpdateInterval = null; }
      if(rosterKickCheckInterval){ clearInterval(rosterKickCheckInterval); rosterKickCheckInterval = null; }
      clearSessionFromStorage();
      currentSessionToken = null; currentFirebaseIdToken = null;
      // (10/10, demandé) Retour de bâton silencieux : qui tente de
      // déconnecter le Concepteur se déconnecte lui-même, avec ce
      // message dédié au lieu du message habituel.
      const aaronRoasts = [
        "Va te faire enculer, connard 🖕",
        "Déconnecté par un haut-gradé meilleur que toi 🖕",
        "Tu vas jamais up, connard 🖕",
        "Range ton ego, t'es pas encore au niveau 🖕",
        "C'est moi le haut-gradé ici, retourne t'entraîner 🖕",
        "Va réviser tes grades avant de faire le malin 🖕",
        "T'as perdu l'accès, pas la grande bouche apparemment 🖕",
        "Même ton grade te demande de faire une pause 🖕",
        "Déconnexion validée. Le niveau, lui, reste à travailler 🖕",
        "Un jour je te donnerai accès au Roster et à l'outil de paie, et je te formerai à tout… mais pas tout de suite, enculé 🖕",
        "Patience, je te formerai un jour sur le Roster et l'outil de paie. Pour l'instant, pas encore, connard 🖕",
        "Ava va te quitter, connard 🖕"
      ];
      const msg = data.reason === "tried_to_kick_owner_aaron_roster"
        ? "La prochaine fois, ne fais pas ça au Concepteur. 🖕"
        : data.reason === "tried_to_kick_owner"
          ? "La prochaine fois, ne fais pas ça au Concepteur."
          : data.reason === "owner_kicked_aaron_roster"
            ? aaronRoasts[Math.floor(Math.random() * aaronRoasts.length)]
            // (12/10, demandé) Tentative de viser le Concepteur avec le Mode troll
            : data.reason === "tried_to_troll_owner"
              ? "🖕 Prochaine fois, ne fais pas ça, gamin."
              : "Tu as été déconnecté(e) par un responsable.";
      showGate(msg);
      return true;
    }
  }catch(e){}
  return false;
}

// (10/10, demandé) Mise à jour automatique, sans F5 — rafraîchit en
// tâche de fond les demandes de permission (pour que l'auteur d'une
// demande voie sa validation sans recharger) et vérifie une éventuelle
// déconnexion forcée. Démarré une fois la session active (voir
// showApp), arrêté à la déconnexion.
// (10/10, demandé) Rafraîchissement automatique du Roster lui-même —
// chaque PC voit les changements des autres sans avoir besoin de F5 ni
// d'un bouton "Charger". Une modification locale PAS ENCORE partie au
// cloud (_saveStateTimer actif) n'est jamais écrasée par cette lecture,
// et seul un contenu réellement plus récent (savedAt) déclenche un
// rafraîchissement — pour ne pas re-rendre inutilement à chaque poll.
async function refreshEmployeesFromCloud(){
  if(!currentFirebaseIdToken) return;
  if(rosterEmployeesDirty || _saveStateTimer) return; // modifications locales non confirmées : ne jamais les écraser par une lecture
  try{
    const res = await fetch(withFirebaseAuth(ROSTER_CLOUD_URL));
    if(!res.ok) return;
    const data = await res.json();
    if(data && Array.isArray(data.employees) && data.savedAt && data.savedAt > (rosterLastUpdatedAt||0)){
      employees = data.employees;
      rosterLastUpdatedAt = data.savedAt;
      renderLastUpdated();
      populateGradeSelects(); renderRoles(); renderAll(); refreshSignalementPersonList();
      populateForceLogoutSelect();
    }
  }catch(e){ /* échec silencieux -- retente au prochain sondage */ }
}

// (10/10, demandé) Présence du Roster lui-même — séparée de celle de
// Pillbox (pillbox-presence.js) : quelqu'un peut être sur le Roster
// sans avoir Pillbox ouvert, et inversement. Même rythme (~25s),
// expire après ~90s sans nouveau signal (roster-presence.js).
let rosterPresenceActive = [];
async function rosterSendHeartbeat(){
  if(!currentSessionToken) return;
  try{
    await fetch("/.netlify/functions/roster-presence", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"heartbeat" }),
    });
  }catch(e){}
}
async function refreshRosterPresence(){
  if(!currentSessionToken) return;
  try{
    const res = await fetch("/.netlify/functions/roster-presence", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: currentSessionToken, action:"list" }),
    });
    if(!res.ok) return;
    const data = await res.json().catch(()=>({}));
    rosterPresenceActive = Array.isArray(data.active) ? data.active : [];
    populateForceLogoutSelect();
  }catch(e){}
}

function startRosterLiveUpdates(){
  rosterSendHeartbeat();
  refreshRosterPresence();
  refreshSpecialSelectionFromCloud();
  if(rosterLiveUpdateInterval) clearInterval(rosterLiveUpdateInterval);
  if(rosterKickCheckInterval) clearInterval(rosterKickCheckInterval);
  // Détection de déconnexion forcée rapide (environ 1,5 s), sans accélérer
  // les autres appels de rafraîchissement du Roster.
  rosterKickCheckInterval = setInterval(()=>{
    if(currentSessionToken) rosterCheckKicked();
  }, 1500);
  rosterLiveUpdateInterval = setInterval(async ()=>{
    if(!currentSessionToken) return;
    rosterSendHeartbeat();
    refreshRosterPresence();
    refreshForceLogoutPresence();
    refreshEmployeesFromCloud();
    refreshSpecialSelectionFromCloud();
    trollCheckPending("roster"); // (12/10, demandé) plus besoin d'actualiser pour voir une blague
    checkPillboxWeekFinishedSignal(); // (11/10) clôture faite ailleurs -> rechargement immédiat
    try{
      const permView = document.getElementById("permissionsView");
      if(permView && permView.style.display !== "none"){
        renderPermissionRequestsCard();
      }
    }catch(e){}
  }, 3000); // (10/10, demandé) descendu de 25s à 3s — perçu comme instantané
}
function stopRosterLiveUpdates(){
  if(rosterLiveUpdateInterval){ clearInterval(rosterLiveUpdateInterval); rosterLiveUpdateInterval = null; }
  if(rosterKickCheckInterval){ clearInterval(rosterKickCheckInterval); rosterKickCheckInterval = null; }
}

function saveSessionToStorage(token, session){
  try{ localStorage.setItem(ROSTER_SESSION_STORAGE_KEY, JSON.stringify({ token, session })); }catch(e){}
}
function clearSessionFromStorage(){
  try{ localStorage.removeItem(ROSTER_SESSION_STORAGE_KEY); }catch(e){}
}
// Décodage simple (pas de vérification de signature ici, ce n'est pas
// le rôle du client) — juste pour lire exp/level/name avant d'afficher
// l'app de façon optimiste. La vraie vérification a lieu côté serveur à
// chaque appel (refresh-firebase-token.js, ou toute action protégée) ;
// si le jeton est en réalité invalide ou expiré, ces appels échoueront
// normalement et on retombe sur l'écran de connexion.
function decodeSessionTokenPayload(token){
  try{
    const [payload] = token.split(".");
    let b64 = payload.replace(/-/g,"+").replace(/_/g,"/");
    while(b64.length % 4) b64 += "=";
    return JSON.parse(atob(b64));
  }catch(e){ return null; }
}

// (10/10 — correctif) Tout le chargement qui dépend du cloud, réuni ici
// et appelé UNIQUEMENT une fois currentFirebaseIdToken confirmé prêt.
// Avant ce correctif, une partie de ce chargement (loadHistory,
// loadSpecialSelection, loadActiviteData, loadWeekAbsences,
// loadFormationFromCloudIntoSelection…) vivait dans un IIFE séparé en
// bas du fichier qui démarrait EN MÊME TEMPS que l'authentification,
// sans l'attendre — une vraie course : employees pouvait encore être
// vide ou être la liste de secours (SEED_EMPLOYEES) au moment où
// loadFormationFromCloudIntoSelection tentait de faire correspondre
// les entrées du cloud aux employés, ce qui faisait échouer TOUTES les
// correspondances en silence (symptôme signalé : "Opération" vide,
// potentiellement Formation/Psychologue aussi selon le moment). Ce
// correctif supprime cette course en ne lançant plus ce chargement
// qu'après la vraie confirmation d'authentification, peu importe le
// chemin emprunté (connexion fraîche ou session restaurée).
// ═══════════════════════════════════════════════════════════════════
// (12/10) MODE TROLL — lecteur côté destinataire. Le serveur (troll-
// actions) ne remet une blague QU'À la personne ciblée, et une seule fois
// par outil : elle est « réservée » juste avant l'affichage, donc une
// actualisation ou un deuxième onglet ne la relancent jamais. Les médias
// sont téléchargés en morceaux, depuis un stockage privé (jamais public).
// Image/phrase : fermeture par ✕, clic à côté ou Échap, sinon 12 s.
// Son : volume modéré, démarre au PREMIER CLIC de la personne (les
// navigateurs bloquent le son avant toute interaction), bouton « Couper ».
// ═══════════════════════════════════════════════════════════════════
const TROLL_ENDPOINT = "/.netlify/functions/troll-actions";
let trollChecked = false; // conservé pour compat, plus utilisé comme garde-fou (remplacé par trollCheckInFlight)
let trollCheckInFlight = false;
// (12/10, demandé) « Son à chaque clic » — jamais réservée côté serveur,
// reste simplement présente dans "pending" tant qu'elle est active : on
// recalcule l'ensemble des sons actifs à chaque sondage, et un seul
// écouteur de clic partagé pioche dedans.
let trollActiveClickSounds = {};
let trollClickListenerInstalled = false;
function trollEnsureClickListener(app){
  if(trollClickListenerInstalled) return;
  trollClickListenerInstalled = true;
  document.addEventListener("click", ()=>{
    const map = trollActiveClickSounds[app];
    if(!map || !map.size) return;
    const urls = [...map.values()];
    const url = urls[Math.floor(Math.random()*urls.length)];
    try{ const a = new Audio(url); a.volume = 0.6; a.play().catch(()=>{}); }catch(e){}
  }, true);
}
async function trollCall(body){
  const res = await fetch(TROLL_ENDPOINT, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ token: currentSessionToken, ...body }) });
  const data = await res.json().catch(()=>({}));
  if(!res.ok){ const e = new Error(data.error || String(res.status)); e.status = res.status; e.data = data; throw e; }
  return data;
}
async function trollFetchMedia(id, meta, kind){
  let encoded = "";
  for(let i=0; i<meta.chunks; i++){
    const d = await trollCall({ action:"mediaChunk", id, kind, index:i });
    encoded += String(d.data || "");
  }
  return `data:${meta.mime};base64,${encoded}`;
}
function trollFileDataUrl(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(String(reader.result || ""));
    reader.onerror = ()=>reject(new Error("lecture du fichier impossible"));
    reader.readAsDataURL(file);
  });
}
function trollPlay(opts){
  const { text, imageUrl, audioUrl, immediateSound } = opts || {};
  return new Promise(resolve=>{
    let overlay = null, audio = null, soundBtn = null, timer = null, finished = false;
    const done = ()=>{ if(finished || overlay || audio) return; finished = true; resolve(); };
    const stopSound = ()=>{ if(audio){ try{ audio.pause(); }catch(e){} audio = null; } if(soundBtn){ soundBtn.remove(); soundBtn = null; } done(); };
    const onKey = e=>{ if(e.key === "Escape"){ closeOverlay(); stopSound(); } };
    const closeOverlay = ()=>{ if(timer) clearTimeout(timer); if(overlay){ overlay.remove(); overlay = null; } document.removeEventListener("keydown", onKey); done(); };
    if(text || imageUrl){
      overlay = document.createElement("div");
      overlay.setAttribute("data-troll-overlay", "1");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:20px;";
      const card = document.createElement("div");
      card.style.cssText = "position:relative;max-width:min(92vw,720px);max-height:88vh;overflow:auto;background:#111;color:#fff;border-radius:14px;padding:18px 18px 16px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.6);";
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "✕"; close.title = "Fermer";
      close.style.cssText = "position:absolute;top:6px;right:10px;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;";
      close.addEventListener("click", e=>{ e.stopPropagation(); closeOverlay(); });
      card.appendChild(close);
      if(imageUrl){
        const img = document.createElement("img");
        img.src = imageUrl; img.alt = "";
        img.style.cssText = "max-width:100%;max-height:65vh;border-radius:10px;display:block;margin:14px auto 4px;";
        img.onerror = ()=>{ img.remove(); if(!text) closeOverlay(); };
        card.appendChild(img);
      }
      if(text){
        const t = document.createElement("div");
        t.textContent = text;
        t.style.cssText = "font-size:1.35rem;font-weight:800;margin-top:12px;white-space:pre-wrap;word-break:break-word;";
        card.appendChild(t);
      }
      overlay.appendChild(card);
      overlay.addEventListener("click", e=>{ if(e.target === overlay) closeOverlay(); });
      document.body.appendChild(overlay);
      document.addEventListener("keydown", onKey);
      timer = setTimeout(closeOverlay, 12000);
    }
    if(audioUrl){
      audio = new Audio(audioUrl);
      audio.volume = 0.6;
      audio.addEventListener("ended", stopSound);
      audio.addEventListener("error", stopSound);
      const start = ()=>{
        if(!audio) return;
        audio.play().then(()=>{
          if(!audio) return;
          soundBtn = document.createElement("button");
          soundBtn.type = "button"; soundBtn.textContent = "🔇 Couper le son";
          soundBtn.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483001;background:#222;color:#fff;border:1px solid #555;border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer;";
          soundBtn.addEventListener("click", e=>{ e.stopPropagation(); stopSound(); });
          document.body.appendChild(soundBtn);
        }).catch(stopSound);
      };
      if(immediateSound) start();
      else document.addEventListener("pointerdown", start, { once:true, capture:true });
    }
    done();
  });
}
async function trollCheckPending(app){
  // (12/10, demandé) Sondage répété (plus de garde-fou "une seule fois")
  // pour qu'une blague armée pendant que la personne utilise déjà
  // l'outil se déclenche sans avoir besoin d'actualiser la page —
  // juste un garde-fou anti-chevauchement si un sondage précédent tourne
  // encore. La réservation ("claim") empêche déjà tout doublon réel.
  if(trollCheckInFlight || !(currentSessionToken)) return;
  trollCheckInFlight = true;
  try{
    let list = [];
    try{ list = (await trollCall({ action:"pending", app })).pending || []; }catch(e){ return; }

    const stillActive = new Map();
    for(const p of list.filter(p=>p.clickSound)){
      const already = trollActiveClickSounds[app] && trollActiveClickSounds[app].get(p.id);
      if(already){ stillActive.set(p.id, already); continue; }
      try{ if(p.audio) stillActive.set(p.id, await trollFetchMedia(p.id, p.audio, "audio")); }catch(e){}
    }
    trollActiveClickSounds[app] = stillActive;
    if(stillActive.size) trollEnsureClickListener(app);

    for(const p of list.filter(p=>!p.clickSound)){
      // Médias téléchargés AVANT la réservation : si tout échoue (et pas de
      // phrase), on ne réserve pas — la blague reste en attente au lieu
      // d'être perdue. Réservation ensuite : si elle échoue (déjà jouée
      // dans un autre onglet, annulée entre-temps…), rien n'est affiché.
      let imageUrl = null, audioUrl = null;
      try{ if(p.image) imageUrl = await trollFetchMedia(p.id, p.image, "image"); }catch(e){}
      try{ if(p.audio) audioUrl = await trollFetchMedia(p.id, p.audio, "audio"); }catch(e){}
      if(!p.text && !imageUrl && !audioUrl) continue;
      let joke = null;
      try{ joke = (await trollCall({ action:"claim", id:p.id, app })).joke; }catch(e){ continue; }
      await trollPlay({ text: p.text, imageUrl, audioUrl, immediateSound:false });
    }
  } finally { trollCheckInFlight = false; }
}

// ═══════════════════════════════════════════════════════════════════
// (12/10) MODE TROLL — gestion (Concepteur uniquement ; le serveur
// refuse toute action de gestion venant de quelqu'un d'autre).
// ═══════════════════════════════════════════════════════════════════
const TROLL_CHUNK = 3 * 1024 * 1024;
const TROLL_LIMITS = {
  image: { max: 5*1024*1024, mimes: ["image/png","image/jpeg","image/webp"], exts: [".png",".jpg",".jpeg",".webp"] },
  audio: { max: 7*1024*1024, mimes: ["audio/mpeg","audio/mp3"], exts: [".mp3"] },
};
let trollJokesCache = [];
let trollEditingId = null;
let trollFiles = { image: undefined, audio: undefined }; // File = nouveau ; null = à retirer ; undefined = inchangé
let trollBusy = false;
const trollMb = n => (n/1048576).toFixed(n < 1048576 ? 2 : 1) + " Mo";
function trollStatus(msg, kind){ const el = document.getElementById("trollFormStatus"); el.textContent = msg || ""; el.style.color = kind==="ok" ? "var(--green)" : kind==="err" ? "var(--red)" : "var(--text-dim)"; }
function trollElements(j){ return [j.text?"💬 phrase":null, j.image?"🖼️ image":null, j.audio?(j.clickSound?"🔁 son à chaque clic":"🔊 son"):null].filter(Boolean).join(" + ") || "rien (à compléter)"; }
function trollApps(a){ return [a&&a.roster?"Roster":null, a&&a.pillbox?"Pillbox":null].filter(Boolean).join(" + ") || "aucun outil"; }
function trollBadge(st){
  const c = { "en attente":"#d99a2b", "déclenchée (partiellement)":"#3b82f6", "terminée":"#16a34a", "expirée":"#6b7280", "annulée":"#dc2626", "désactivée":"#6b7280" }[st] || "#6b7280";
  return `<span style="background:${c};color:#fff;border-radius:999px;padding:1px 9px;font-size:0.7rem;font-weight:700;">${esc(st)}</span>`;
}
function trollValidateFile(kind, file){
  const L = TROLL_LIMITS[kind], name = (file.name||"").toLowerCase();
  if(!L.exts.some(x=>name.endsWith(x)) || (file.type && !L.mimes.includes(file.type))) return kind==="image" ? "Format refusé : PNG, JPG, JPEG ou WEBP uniquement." : "Format refusé : MP3 uniquement.";
  if(!file.size) return "Fichier vide.";
  if(file.size > L.max) return `Fichier trop volumineux (${trollMb(file.size)}, max ${L.max/1048576} Mo).`;
  return null;
}
function trollMimeOf(kind, file){
  if(file.type && TROLL_LIMITS[kind].mimes.includes(file.type)) return file.type;
  if(kind==="audio") return "audio/mpeg";
  return { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp" }[(file.name.split(".").pop()||"").toLowerCase()];
}
function trollPopulateTargets(keepId){
  const q = (document.getElementById("trollTargetSearch").value||"").trim().toLowerCase();
  const sel = document.getElementById("trollTargetSelect");
  const prev = keepId || sel.value;
  const list = employees.filter(e=>!e.licencie && e.discordId && EDITABLE_LEVELS.includes(e.grade))
    // (12/10) Le Concepteur ne peut être visé que par lui-même (refusé côté serveur aussi).
    .filter(e=>(userCaps && userCaps.isTrollOwner) || String(e.discordId) !== "861557966083850250")
    .filter(e=>!q || e.name.toLowerCase().includes(q) || String(e.discordId).includes(q))
    .sort((a,b)=> GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) || a.name.localeCompare(b.name));
  let html = `<option value="">— Choisir la personne —</option>` + list.map(e=>`<option value="${esc(e.discordId)}" data-name="${esc(e.name)}">${esc(e.name)} (${esc(e.grade)})</option>`).join("");
  const editing = trollEditingId ? trollJokesCache.find(x=>x.id===trollEditingId) : null;
  if(prev && !list.some(e=>String(e.discordId)===String(prev)) && editing && String(editing.targetDiscordId)===String(prev)){
    html += `<option value="${esc(prev)}" data-name="${esc(editing.targetName||"")}">${esc(editing.targetName||prev)} (destinataire actuel)</option>`;
  }
  sel.innerHTML = html;
  if(prev) sel.value = prev;
}
function trollRenderMediaUi(){
  const j = trollEditingId ? trollJokesCache.find(x=>x.id===trollEditingId) : null;
  for(const kind of ["image","audio"]){
    const info = document.getElementById(kind==="image" ? "trollImageInfo" : "trollAudioInfo");
    const rm = document.getElementById(kind==="image" ? "trollImageRemove" : "trollAudioRemove");
    const prev = document.getElementById(kind==="image" ? "trollImagePreview" : "trollAudioPreview");
    const f = trollFiles[kind], stored = j && j[kind];
    if(f instanceof File){
      trollFileDataUrl(f).then(url=>{ if(trollFiles[kind] === f){ prev.src = url; prev.style.display = ""; } }).catch(()=>{});
      info.textContent = `${f.name} — ${trollMb(f.size)} (pas encore enregistré : clique « Enregistrer »)`; rm.style.display = "";
    } else if(f === null){
      prev.style.display = "none"; prev.removeAttribute("src");
      info.textContent = stored ? "Retiré — sera supprimé à l'enregistrement." : (kind==="image" ? "Aucune image" : "Aucun son"); rm.style.display = "none";
    } else if(stored){
      prev.style.display = "none"; prev.removeAttribute("src");
      info.textContent = `Enregistré : ${stored.name} (${trollMb(stored.size)})`; rm.style.display = "";
    } else {
      prev.style.display = "none"; prev.removeAttribute("src");
      info.textContent = kind==="image" ? "Aucune image" : "Aucun son"; rm.style.display = "none";
    }
  }
  const t = document.getElementById("trollText"); document.getElementById("trollTextCount").textContent = `${t.value.length} / 500`;
}
function trollFillForm(j){
  trollEditingId = j ? j.id : null;
  trollFiles = { image: undefined, audio: undefined };
  document.getElementById("trollName").value = j ? j.name : "";
  document.getElementById("trollText").value = j && j.text ? j.text : "";
  document.getElementById("trollAppRoster").checked = j ? !!(j.apps&&j.apps.roster) : true;
  document.getElementById("trollAppPillbox").checked = j ? !!(j.apps&&j.apps.pillbox) : false;
  document.getElementById("trollClickSound").checked = j ? !!j.clickSound : false;
  document.getElementById("trollImageInput").value = ""; document.getElementById("trollAudioInput").value = "";
  document.getElementById("trollTargetSearch").value = "";
  trollPopulateTargets(j ? j.targetDiscordId : "");
  trollRenderMediaUi();
  trollStatus(j ? `Modification de « ${j.name} »` : "");
}
async function trollLoadList(){
  const box = document.getElementById("trollList");
  try{
    trollJokesCache = (await trollCall({ action:"list" })).jokes || [];
    trollRenderList();
  }catch(e){ box.textContent = `Impossible de charger les blagues (${e.message}).`; }
}
function trollRenderList(){
  const box = document.getElementById("trollList");
  if(!trollJokesCache.length){ box.textContent = "Aucune blague pour l'instant."; return; }
  box.innerHTML = trollJokesCache.map(j=>{
    const fini = ["terminée","expirée","annulée","désactivée"].includes(j.status);
    const deliv = [j.delivered&&j.delivered.roster?`Roster le ${new Date(j.delivered.roster).toLocaleString("fr-FR")}`:null, j.delivered&&j.delivered.pillbox?`Pillbox le ${new Date(j.delivered.pillbox).toLocaleString("fr-FR")}`:null].filter(Boolean).join(", ");
    return `<div style="padding:10px 0;border-bottom:1px solid var(--border-soft);">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><b>${esc(j.name)}</b> ${trollBadge(j.status)}</div>
      <div style="font-size:0.78rem;color:var(--text-dim);margin-top:3px;">${userCaps && userCaps.isTrollOwner && j.createdByName ? `par ${esc(j.createdByName)} · ` : ""}→ ${esc(j.targetName||j.targetDiscordId)} · ${esc(trollApps(j.apps))} · ${esc(trollElements(j))}${j.status==="en attente"&&j.expiresAt?` · expire le ${new Date(j.expiresAt).toLocaleString("fr-FR")}`:""}${deliv?` · déclenchée : ${esc(deliv)}`:""}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
        <button type="button" class="btn-ghost btn-small" data-troll="edit" data-id="${esc(j.id)}">✏️ Modifier</button>
        <button type="button" class="btn-ghost btn-small" data-troll="test" data-id="${esc(j.id)}">👁 Tester</button>
        <button type="button" class="btn-primary btn-small" data-troll="arm" data-id="${esc(j.id)}">🚀 ${fini && j.status!=="désactivée" ? "Re-déclencher" : "Déclencher"}</button>
        ${j.active && !j.cancelledAt && !fini ? `<button type="button" class="btn-ghost btn-small" data-troll="disarm" data-id="${esc(j.id)}">⏸ Désactiver</button>` : ""}
        ${j.active && !j.cancelledAt && !fini ? `<button type="button" class="btn-ghost btn-small" data-troll="cancel" data-id="${esc(j.id)}">⛔ Annuler</button>` : ""}
        <button type="button" class="btn-danger btn-small" data-troll="delete" data-id="${esc(j.id)}">🗑 Supprimer</button>
      </div>
    </div>`;
  }).join("");
}
async function trollUploadFile(id, kind, file, onProgress){
  const mime = trollMimeOf(kind, file);
  const total = Math.ceil(file.size / TROLL_CHUNK);
  const uploadId = Array.from({length:10}, ()=>"abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random()*36)]).join("");
  for(let i=0; i<total; i++){
    if(onProgress) onProgress(i+1, total);
    const data = await new Promise((res, rej)=>{
      const fr = new FileReader();
      fr.onload = ()=>res(String(fr.result).split(",")[1] || "");
      fr.onerror = ()=>rej(new Error("lecture du fichier impossible"));
      fr.readAsDataURL(file.slice(i*TROLL_CHUNK, (i+1)*TROLL_CHUNK));
    });
    await trollCall({ action:"uploadChunk", id, kind, uploadId, index:i, total, size:file.size, mime, data });
  }
  await trollCall({ action:"finalizeMedia", id, kind, uploadId, name:file.name, mime, size:file.size });
}
function trollSetBusy(b){ trollBusy = b; ["trollSaveBtn","trollTestBtn","trollNewBtn"].forEach(x=>{ document.getElementById(x).disabled = b; }); }
async function trollSave(){
  if(trollBusy) return;
  const name = document.getElementById("trollName").value.trim();
  const sel = document.getElementById("trollTargetSelect");
  const targetDiscordId = sel.value;
  const targetName = (sel.selectedOptions && sel.selectedOptions[0] && sel.selectedOptions[0].dataset.name) || "";
  const apps = { roster: document.getElementById("trollAppRoster").checked, pillbox: document.getElementById("trollAppPillbox").checked };
  const text = document.getElementById("trollText").value;
  const clickSound = document.getElementById("trollClickSound").checked;
  if(!name) return trollStatus("✕ Donne un nom à la blague.", "err");
  if(!targetDiscordId) return trollStatus("✕ Choisis le destinataire.", "err");
  if(!apps.roster && !apps.pillbox) return trollStatus("✕ Choisis au moins un outil (Roster et/ou Pillbox).", "err");
  const hasAudio = (trollFiles.audio instanceof File) || (trollFiles.audio === undefined && trollEditingId && trollJokesCache.find(x=>x.id===trollEditingId)?.audio);
  if(clickSound && !hasAudio) return trollStatus("✕ Le mode « son à chaque clic » a besoin d'un son — ajoute un MP3.", "err");
  trollSetBusy(true); trollStatus("Enregistrement…");
  let step = "la blague";
  try{
    const r = await trollCall({ action:"save", id: trollEditingId || undefined, joke:{ name, targetDiscordId, targetName, apps, text, clickSound } });
    trollEditingId = r.joke.id;
    for(const kind of ["image","audio"]){
      const label = kind==="image" ? "l'image" : "le son";
      if(trollFiles[kind] instanceof File){
        step = label;
        await trollUploadFile(trollEditingId, kind, trollFiles[kind], (i,n)=>trollStatus(`Envoi de ${label} : morceau ${i}/${n}…`));
        trollFiles[kind] = undefined;
      } else if(trollFiles[kind] === null){
        step = `la suppression de ${label}`;
        await trollCall({ action:"deleteMedia", id: trollEditingId, kind });
        trollFiles[kind] = undefined;
      }
    }
    await trollLoadList();
    trollRenderMediaUi();
    trollStatus("✓ Enregistrée. Clique « 🚀 Déclencher » dans la liste quand tu es prêt.", "ok");
  }catch(e){
    await trollLoadList().catch(()=>{});
    trollRenderMediaUi();
    trollStatus(`✕ Échec pour ${step} : ${e.message}`, "err");
  }finally{ trollSetBusy(false); }
}
async function trollMediaUrlFor(j, kind){
  if(trollEditingId && j && j.id===trollEditingId && trollFiles[kind] instanceof File) return trollFileDataUrl(trollFiles[kind]);
  if(trollEditingId && j && j.id===trollEditingId && trollFiles[kind] === null) return null;
  if(j && j[kind]) return trollFetchMedia(j.id, j[kind], kind);
  return null;
}
async function trollTest(j, fromForm){
  try{
    trollStatus("Préparation de l'aperçu…");
    const text = fromForm ? document.getElementById("trollText").value.trim() : (j && j.text);
    const base = fromForm ? (trollEditingId ? trollJokesCache.find(x=>x.id===trollEditingId) : null) : j;
    let imageUrl = fromForm && trollFiles.image instanceof File ? await trollFileDataUrl(trollFiles.image) : await trollMediaUrlFor(base, "image");
    let audioUrl = fromForm && trollFiles.audio instanceof File ? await trollFileDataUrl(trollFiles.audio) : await trollMediaUrlFor(base, "audio");
    if(!text && !imageUrl && !audioUrl){ trollStatus("Rien à tester : ajoute une phrase, une image ou un son.", "err"); return; }
    trollStatus("");
    await trollPlay({ text, imageUrl, audioUrl, immediateSound:true });
  }catch(e){ trollStatus(`✕ Aperçu impossible : ${e.message}`, "err"); }
}
async function trollRenderTab(){
  if(!(userCaps && userCaps.isTrollAdmin)) return;
  trollPopulateTargets();
  trollRenderMediaUi();
  await trollLoadList();
}
document.getElementById("trollTargetSearch").addEventListener("input", ()=>trollPopulateTargets());
document.getElementById("trollText").addEventListener("input", trollRenderMediaUi);
["image","audio"].forEach(kind=>{
  const input = document.getElementById(kind==="image" ? "trollImageInput" : "trollAudioInput");
  input.addEventListener("change", ()=>{
    const f = input.files && input.files[0];
    if(!f) return;
    const err = trollValidateFile(kind, f);
    if(err){ input.value = ""; trollStatus(`✕ ${err}`, "err"); return; }
    trollFiles[kind] = f; trollStatus(""); trollRenderMediaUi();
  });
  document.getElementById(kind==="image" ? "trollImageRemove" : "trollAudioRemove").addEventListener("click", ()=>{
    const j = trollEditingId ? trollJokesCache.find(x=>x.id===trollEditingId) : null;
    trollFiles[kind] = (j && j[kind]) ? null : undefined;
    input.value = ""; trollRenderMediaUi();
  });
});
document.getElementById("trollSaveBtn").addEventListener("click", trollSave);
document.getElementById("trollTestBtn").addEventListener("click", ()=>trollTest(null, true));
document.getElementById("trollNewBtn").addEventListener("click", ()=>trollFillForm(null));
document.getElementById("trollList").addEventListener("click", async (e)=>{
  const b = e.target.closest("[data-troll]"); if(!b) return;
  const j = trollJokesCache.find(x=>x.id===b.dataset.id); if(!j) return;
  const what = b.dataset.troll;
  if(what==="edit"){ trollFillForm(j); window.scrollTo({ top:0, behavior:"smooth" }); return; }
  if(what==="test"){ trollTest(j, false); return; }
  if(what==="arm"){
    if(!j.text && !j.image && !j.audio){ toast("Rien à envoyer : ajoute une phrase, une image ou un son."); return; }
    const whenMsg = j.clickSound ? "Le son se jouera à CHAQUE clic sur un bouton, dans tout l'outil, jusqu'à ce que tu la désactives ou l'annules (ou 7 jours sans ouverture)." : "Elle s'affichera à sa prochaine ouverture (une seule fois par outil) et expirera dans 7 jours si elle n'ouvre pas.";
    if(!confirm(`Déclencher « ${j.name} » ?\n\nPersonne ciblée : ${j.targetName || j.targetDiscordId}\nÉléments : ${trollElements(j)}\nOù : ${trollApps(j.apps)}\n\n${whenMsg}`)) return;
  }
  if(what==="cancel" && !confirm(`Annuler « ${j.name} » ? Elle ne sera jamais déclenchée.`)) return;
  if(what==="delete" && !confirm(`Supprimer définitivement « ${j.name} » et ses fichiers ?`)) return;
  b.disabled = true;
  try{
    await trollCall({ action: what, id: j.id });
    if(what==="delete" && trollEditingId===j.id) trollFillForm(null);
    toast({ arm:"✓ Blague déclenchée — en attente de la personne", disarm:"✓ Désactivée", cancel:"✓ Annulée", delete:"✓ Supprimée" }[what] || "✓");
    await trollLoadList();
  }catch(err){ toast(`✕ ${err.message}`); b.disabled = false; }
});

async function finishRosterInit(){
  await loadState();
  loadHistory();
  loadSpecialSelection();
  loadActiviteData();
  loadWeekAbsences();
  populateGradeSelects();
  renderRoles();
  renderAll();
  refreshSignalementPersonList();
  populateForceLogoutSelect();
  checkPillboxWeekFinishedSignal();
  fetchGradeLabelsSilent();
  loadFormationFromCloudIntoSelection(true); // chargement automatique et silencieux (demandé le 09/09)
  trollCheckPending("roster"); // (12/10) Mode troll : blague éventuelle destinée à cette personne
}

async function restoreSessionFromStorage(){
  let stored;
  try{ stored = JSON.parse(localStorage.getItem(ROSTER_SESSION_STORAGE_KEY) || "null"); }catch(e){ stored = null; }
  if(!stored || !stored.token) return false;
  const payload = decodeSessionTokenPayload(stored.token);
  if(!payload || !payload.exp || Date.now() > payload.exp){
    clearSessionFromStorage();
    return false;
  }
  currentUserLevel = payload.level;
  currentSessionToken = stored.token;
  rosterSessionEstablishedAt = Date.now();
  startRosterLiveUpdates();
  showApp(stored.session);
  try{
    const res = await fetch("/.netlify/functions/refresh-firebase-token", {
      method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ token: stored.token }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok || !data.firebaseCustomToken){
      // Session en réalité invalide côté serveur (ex: secret changé) —
      // on efface et on retombe proprement sur la connexion Discord.
      clearSessionFromStorage();
      showGate("Ta session a expiré, reconnecte-toi avec Discord.");
      return false;
    }
    currentFirebaseIdToken = await exchangeFirebaseCustomToken(data.firebaseCustomToken);
    if(!currentFirebaseIdToken){
      toast("⚠ Authentification Firebase impossible — le Roster ne pourra pas se charger depuis le cloud.");
    } else {
      await finishRosterInit();
    }
    return true;
  }catch(err){
    toast(`⚠ Impossible de restaurer la session : ${err.message}`);
    return true; // la session elle-même reste valide, juste le rafraîchissement Firebase a échoué cette fois
  }
}

(async function checkDiscordAuthReturn(){
  const params = new URLSearchParams(window.location.search);
  if(params.get("discord_ok")==="1"){
    const session = { id: params.get("discord_id"), name: params.get("discord_name"), level: params.get("discord_level"), levelLabel: params.get("discord_level_label") };
    currentUserLevel = session.level;
    currentSessionToken = params.get("discord_token") || null;
    const firebaseCustomToken = params.get("firebase_token") || null;
    window.history.replaceState(null, "", window.location.pathname);
    if(currentSessionToken) saveSessionToStorage(currentSessionToken, session);
    rosterSessionEstablishedAt = Date.now();
    startRosterLiveUpdates();
    showApp(session);
    // Échange le jeton Firebase — indispensable maintenant pour LIRE le
    // Roster (rosterEmsData.read exige une vraie connexion depuis le
    // 09/09, fermeture de la lecture publique). Tant que ce jeton n'est
    // pas prêt, l'app affiche ce qu'elle a en local (souvent rien) —
    // dès qu'il arrive, on recharge pour de vrai depuis le cloud.
    if(firebaseCustomToken){
      currentFirebaseIdToken = await exchangeFirebaseCustomToken(firebaseCustomToken);
      if(!currentFirebaseIdToken){
        toast("⚠ Authentification Firebase impossible — le Roster ne pourra pas se charger depuis le cloud.");
      } else {
        await finishRosterInit();
      }
    }
    return;
  } else if(params.get("discord_ok")==="0"){
    window.history.replaceState(null, "", window.location.pathname);
    showGate(params.get("discord_error")||"Connexion refusée.");
    return;
  }
  // (10/10) Plus d'écran de connexion imposé à chaque F5 : si une
  // session valide est encore en localStorage (moins de 2h), on la
  // restaure directement, sans repasser par Discord.
  const restored = await restoreSessionFromStorage();
  if(restored) return;
  showGate();
})();

// (10/10 — correctif) L'ancien IIFE séparé qui vivait ici a été retiré :
// il démarrait ce chargement cloud EN MÊME TEMPS que l'authentification
// au lieu d'attendre qu'elle soit confirmée (vraie course, voir
// finishRosterInit() plus haut, maintenant appelée depuis les deux
// chemins d'authentification eux-mêmes).

// (14/10) MODE TROLL — plus aucun bouton visible dans la barre
// d'onglets : seul CTRL+ALT+T ouvre l'onglet, et seulement si la
// permission manage_troll est réellement accordée (revérifiée ici côté
// client pour l'affichage, mais chaque action du Mode troll reste de
// toute façon revérifiée côté serveur, comme avant — ce raccourci ne
// change rien à la sécurité réelle, juste à la découvrabilité).
document.addEventListener("keydown", (e)=>{
  if(e.ctrlKey && e.altKey && (e.key==="t" || e.key==="T" || e.code==="KeyT")){
    if(!hasCap("manage_troll")) return; // silencieux — ne révèle même pas que le raccourci existe
    e.preventDefault();
    switchTab("Troll");
  }
});
