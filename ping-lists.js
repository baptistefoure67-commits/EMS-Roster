// Listes de ping Discord — intégré au Roster (JavaScript vanilla).
const EMPLOYES_ROLE_ID = "1168614318846267492";
const EXCLUDED_FROM_PING_LISTS = ["451073171194511370"];
const PING_LIST_GRADE_ORDER = ["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF","A"];
const PING_LIST_CONFIG = {
  pilote: { label:"Pilotes", title:"LISTE des Pilotes", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF"] },
  coPilote: { label:"Co-Pilotes", title:"LISTE des Co-Pilotes", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF","A"] },
  formateurPilote: { label:"Formateurs Pilote", title:"LISTE des Formateurs Pilote", grades:["DG","D","CD","ADD","MC","RF","MF"] },
  mup: { label:"M.U.P", title:"LISTE des M.U.P", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M"] },
  formateurMup: { label:"Formateurs M.U.P", title:"LISTE des Formateurs M.U.P", grades:["DG","D","CD","ADD","MC","RF","MF"] }
};
// Présentation + condition d'accès affichées sur chaque carte.
const PING_LIST_META = {
  pilote: { icon:"✈️", accent:"#38bdf8", rule:"À partir d'Infirmier" },
  coPilote: { icon:"🧑‍✈️", accent:"#818cf8", rule:"À partir d'Ambulancier" },
  formateurPilote: { icon:"🎓", accent:"#f59e0b", rule:"Médecins formateurs" },
  mup: { icon:"🚑", accent:"#34d399", rule:"À partir de Médecin" },
  formateurMup: { icon:"🎓", accent:"#fb7185", rule:"Médecins formateurs" }
};
const PING_COPY_ORDER = ["mup","formateurMup","formateurPilote","pilote","coPilote"];
// Messages "formation" : plusieurs listes dans un seul message Discord, une seule date finale.
const PING_COPY_GROUPS = {
  formationPilote: { label:"Formation Pilote - Co-Pilote", keys:["formateurPilote","pilote","coPilote"] },
  formationMup: { label:"Formation MUP", keys:["mup","formateurMup"] }
};
// Référentiel validé des compositions réellement utilisées sur Discord.
// L'appartenance est liée au Discord ID (stable), pas au nom RP ni à une
// supposition basée sur le grade. Un membre peut être dans les deux listes.
const PING_PILOTE_DISCORD_IDS = new Set([
  "514871271352434699", "408669016039882752", "873209274023690303",
  "861557966083850250", "701698983466106903", "881570935679909918",
  "871023722520264714", "263758146177204225", "888085010949738536",
  "336843152679763968", "911686634351759370", "753895886559510588",
  "1155340672077926463", "1277978622094872598", "1449159028944011416",
  "269573630063542284", "1568011061443961056"
]);
const PING_COPILOTE_DISCORD_IDS = new Set([
  "514871271352434699", "408669016039882752", "873209274023690303",
  "861557966083850250", "701698983466106903", "227444055594893312",
  "881570935679909918", "871023722520264714", "263758146177204225",
  "747513913221972081", "888085010949738536", "336843152679763968",
  "911686634351759370", "1414581879193210962", "753895886559510588",
  "1155340672077926463", "1277978622094872598", "1018286479002325072",
  "1449159028944011416", "269573630063542284", "1568011061443961056",
  "1311123243775557652", "1124004082143735888", "1535715965914841158",
  "971134294963683358"
]);
// Formateurs : liste de référence (IDs Discord), plus basée sur le seul grade —
// avoir un grade MC/ADD/CD... ne veut pas dire être encore médecin formateur.
const PING_FORMATEUR_DISCORD_IDS = new Set([
  "514871271352434699", "408669016039882752", "873209274023690303",
  "861557966083850250", "701698983466106903", "881570935679909918",
  "871023722520264714", "263758146177204225", "753895886559510588",
  "1155340672077926463"
]);
function pingValidDiscordId(value) { return /^\d{17,20}$/.test(String(value||"").trim()); }
function pingFirstName(name) { return String(name||"").trim().split(/\s+/)[0] || ""; }
function pingCompareEmployees(a,b) {
  const ga=PING_LIST_GRADE_ORDER.indexOf(a.grade), gb=PING_LIST_GRADE_ORDER.indexOf(b.grade);
  return (ga<0?999:ga)-(gb<0?999:gb) ||
    pingFirstName(a.name).localeCompare(pingFirstName(b.name),"fr",{sensitivity:"base"}) ||
    String(a.name||"").localeCompare(String(b.name||""),"fr",{sensitivity:"base"});
}
function pingIsExcluded(e) {
  return e.licencie === true || e.excludeFromPingLists === true ||
    EXCLUDED_FROM_PING_LISTS.includes(String(e.discordId||"").trim());
}
// Ajouts / retraits manuels (tri-état, stockés sur la fiche employé) :
//   true  = ajouté à la main dans la liste (même hors référence / hors grade)
//   false = retiré à la main de la liste
//   absent = composition de référence (IDs Discord) ou filtre par grade
const PING_MANUAL_FIELD = { pilote:"pingPilote", coPilote:"pingCoPilote", mup:"pingMup", formateurPilote:"pingFormateurPilote", formateurMup:"pingFormateurMup" };
function pingManualFlag(e,key) {
  const f=PING_MANUAL_FIELD[key]; if(!f||!e) return undefined;
  return typeof e[f]==="boolean" ? e[f] : undefined;
}
// Un grade doit être éligible à la formation : jamais de stagiaire (STG) ni WDV,
// même en ajout manuel. Co-Pilote dès Ambulancier, Pilote dès Infirmier, MUP dès Médecin.
function pingEligible(e,key) {
  const cfg=PING_LIST_CONFIG[key]; return !!(cfg && e && cfg.grades.includes(e.grade));
}
function getPingListEmployees(key, source=employees) {
  const cfg=PING_LIST_CONFIG[key];
  if(!cfg) return {employees:[],missingIds:[]};
  const list=(Array.isArray(source)?source:[]).filter(e=>{
    if(!e || pingIsExcluded(e) || !pingEligible(e,key)) return false;
    const manual=pingManualFlag(e,key);
    if(manual===true) return true;
    if(manual===false) return false;
    const id=String(e.discordId||"").trim();
    if(key==="pilote") return PING_PILOTE_DISCORD_IDS.has(id);
    if(key==="coPilote") return PING_COPILOTE_DISCORD_IDS.has(id);
    // Formateurs : un médecin formateur (MF) l'est d'office pour Pilote ET MUP ;
    // une fois promu, il reste formateur (mémorisé par la liste de référence / l'ajout automatique).
    if(key==="formateurPilote"||key==="formateurMup") return e.grade==="MF" || PING_FORMATEUR_DISCORD_IDS.has(id);
    return true;
  });
  const valid=list.filter(e=>pingValidDiscordId(e.discordId)).sort(pingCompareEmployees);
  const missing=list.filter(e=>!pingValidDiscordId(e.discordId)).sort(pingCompareEmployees);
  return {employees:valid,missingIds:missing};
}
function buildPingListText(key, source=employees, date=new Date(), includeUpdate=true) {
  const cfg=PING_LIST_CONFIG[key]; if(!cfg) throw new Error("Liste de ping inconnue.");
  const {employees:list}=getPingListEmployees(key,source);
  const blocks=list.map(e=>`<@${String(e.discordId).trim()}>`);
  const body=blocks.length ? `**${cfg.title} :**\n\n${blocks.join("\n")}` : `**${cfg.title} :**`;
  return includeUpdate ? `${body}\n\nMis à jour le ${date.toLocaleDateString("fr-FR")}\n<@&${EMPLOYES_ROLE_ID}>` : body;
}
function buildAllPingListsText(source=employees,date=new Date()) {
  const blocks=PING_COPY_ORDER.map(k=>buildPingListText(k,source,date,false));
  return `${blocks.join("\n\n")}\n\nMis à jour le ${date.toLocaleDateString("fr-FR")}\n<@&${EMPLOYES_ROLE_ID}>`;
}
function buildPingGroupText(groupKey, source=employees, date=new Date()) {
  const g=PING_COPY_GROUPS[groupKey]; if(!g) throw new Error("Groupe de ping inconnu.");
  const blocks=g.keys.map(k=>buildPingListText(k,source,date,false));
  return `${blocks.join("\n\n")}\n\nMis à jour le ${date.toLocaleDateString("fr-FR")}\n<@&${EMPLOYES_ROLE_ID}>`;
}
async function pingSetMembership(employeeId, flags) {
  // flags : {pilote,coPilote,mup} -> true | false | null (null = revenir à la composition de référence)
  if(typeof protectedAction!=="function") throw new Error("Session indisponible.");
  const e=(typeof employees!=="undefined"?employees:[]).find(x=>String(x.id)===String(employeeId));
  if(!e) throw new Error("Employé introuvable.");
  await protectedAction("setPingFormations",{id:employeeId,...flags});
  Object.keys(PING_MANUAL_FIELD).forEach(k=>{
    if(!(k in flags)) return;
    const f=PING_MANUAL_FIELD[k];
    if(flags[k]===null) delete e[f]; else e[f]=flags[k];
  });
  if(typeof saveState==="function") saveState();
  renderPingLists();
  pingLoadHistory(true);
  return e;
}
function pingEscape(v){ return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
// Aperçu Discord : remplace les <@id> par @Nom, le rôle par @Employés, et met le gras en forme.
function buildPingPreviewHtml(text, source=employees) {
  const byId=new Map((Array.isArray(source)?source:[]).map(e=>[String(e.discordId||"").trim(),e]));
  return pingEscape(text)
    .replace(/&lt;@&amp;(\d+)&gt;/g,(m,id)=>`<span class="ping-mention ping-mention-role">@${id===EMPLOYES_ROLE_ID?"Employés":"rôle"}</span>`)
    .replace(/&lt;@(\d+)&gt;/g,(m,id)=>{const e=byId.get(id);return e?`<span class="ping-mention">@${pingEscape(e.name)}</span>`:`<span class="ping-mention ping-mention-unknown" title="ID absent du Roster">@inconnu (${id.slice(-4)})</span>`;})
    .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
    .replace(/\n/g,"<br>");
}
function pingPreviewText(state, source=employees, date=new Date()) {
  if(!state) return "";
  if(state.kind==="all") return buildAllPingListsText(source,date);
  if(state.kind==="group") return buildPingGroupText(state.key,source,date);
  return buildPingListText(state.key,source,date,true);
}
function pingPreviewTitle(state) {
  if(!state) return "";
  if(state.kind==="all") return "Copier tout";
  if(state.kind==="group") return PING_COPY_GROUPS[state.key].label;
  return PING_LIST_CONFIG[state.key].title;
}
let pingPreviewState=null, pingPreviewLastHtml="";
function renderPingPreview() {
  const box=document.getElementById("pingPreview"); if(!box) return;
  if(!pingPreviewState){ box.hidden=true; pingPreviewLastHtml=""; return; }
  const html=`<div class="ping-preview-head"><div><h3>👁 Aperçu — ${pingEscape(pingPreviewTitle(pingPreviewState))}</h3><p>Voici le message tel qu'il apparaîtra dans Discord (noms à la place des numéros d'ID).</p></div><div class="ping-preview-actions"><button type="button" class="ping-preview-copy" data-ping-preview-copy="1">⧉ Copier ce message</button><button type="button" class="ping-preview-close" data-ping-preview-close="1" aria-label="Fermer l'aperçu">✕</button></div></div><div class="ping-preview-msg">${buildPingPreviewHtml(pingPreviewText(pingPreviewState))}</div>`;
  box.hidden=false;
  if(html!==pingPreviewLastHtml){ box.innerHTML=html; pingPreviewLastHtml=html; }
}
function pingOpenPreview(kind,key) {
  pingPreviewState={kind,key}; pingPreviewLastHtml=""; renderPingPreview();
  const box=document.getElementById("pingPreview"); if(box&&box.scrollIntoView) box.scrollIntoView({behavior:"smooth",block:"nearest"});
}
// Historique des ajouts / retraits (lu côté serveur dans les logs « liste_ping »).
const pingHistoryState={loaded:false,loading:false,error:"",entries:[],lastHtml:""};
function pingTimeAgo(ms) {
  const d=Math.max(0,Date.now()-Number(ms||0)), min=Math.floor(d/60000);
  if(min<1) return "à l'instant"; if(min<60) return `il y a ${min} min`;
  const h=Math.floor(min/60); if(h<24) return `il y a ${h} h`;
  const j=Math.floor(h/24); if(j<8) return `il y a ${j} j`;
  return new Date(Number(ms)).toLocaleDateString("fr-FR");
}
function pingHistoryIcon(details) { return /retiré/.test(details)?"➖":/remis par défaut/.test(details)?"↩️":"➕"; }
function buildPingHistoryHtml(entries) {
  if(!entries.length) return '<div class="ping-empty">Aucun changement enregistré pour le moment.</div>';
  return entries.map(e=>{
    const parts=String(e.details||"").split(" — source : ");
    const what=parts[0]||"", source=parts[1]||"";
    return `<div class="ping-hist-row"><span class="ping-hist-ico">${pingHistoryIcon(what)}</span><div class="ping-hist-main"><div class="ping-hist-line"><b>${pingEscape(e.targetName||"?")}</b> <span>${pingEscape(what)}</span></div><div class="ping-hist-meta">${source?`<span class="ping-tag">${pingEscape(source)}</span>`:""}<span>par ${pingEscape(e.authorName||"?")}</span><span title="${pingEscape(new Date(Number(e.createdAt)).toLocaleString("fr-FR"))}">${pingTimeAgo(e.createdAt)}</span></div></div></div>`;
  }).join("");
}
async function pingLoadHistory(force) {
  if(pingHistoryState.loading) return; if(pingHistoryState.loaded && !force) return;
  if(typeof currentSessionToken==="undefined" || !currentSessionToken) return;
  pingHistoryState.loading=true; renderPingHistory();
  try {
    const res=await fetch("/.netlify/functions/ping-history",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:currentSessionToken})});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||`${res.status}`);
    pingHistoryState.entries=data.entries||[]; pingHistoryState.error="";
  } catch(err) { pingHistoryState.error=err.message; }
  pingHistoryState.loaded=true; pingHistoryState.loading=false; renderPingHistory();
}
function renderPingHistory() {
  const body=document.getElementById("pingHistoryBody"); if(!body) return;
  const html=pingHistoryState.loading&&!pingHistoryState.entries.length?'<div class="ping-empty">Chargement…</div>':pingHistoryState.error?`<div class="ping-empty ping-empty-warn">⚠ ${pingEscape(pingHistoryState.error)}</div>`:buildPingHistoryHtml(pingHistoryState.entries);
  if(html!==pingHistoryState.lastHtml){ body.innerHTML=html; pingHistoryState.lastHtml=html; }
}
const PING_AUTO_TRIED = new Set();
// Un MF devient automatiquement formateur Pilote ET MUP, et le reste après promotion :
// on mémorise l'état sur sa fiche (une seule fois, jamais si retiré à la main).
async function pingAutoFormateurSync() {
  if(window.__pingSyncBusy || typeof employees==="undefined" || typeof protectedAction!=="function" || typeof hasCap!=="function") return;
  if(!hasCap("manage_roster")) return;
  if(typeof rosterCloudConfirmed!=="undefined" && !rosterCloudConfirmed) return;
  if(typeof currentSessionToken!=="undefined" && !currentSessionToken) return;
  const todo=employees.filter(e=>e && !e.licencie && e.grade==="MF" && !pingIsExcluded(e) && !PING_AUTO_TRIED.has(e.id) &&
    (typeof e.pingFormateurPilote!=="boolean" || typeof e.pingFormateurMup!=="boolean"));
  if(!todo.length) return;
  window.__pingSyncBusy=true;
  try {
    for(const e of todo){
      PING_AUTO_TRIED.add(e.id);
      const flags={};
      if(typeof e.pingFormateurPilote!=="boolean") flags.formateurPilote=true;
      if(typeof e.pingFormateurMup!=="boolean") flags.formateurMup=true;
      try {
        await protectedAction("setPingFormations",{id:e.id,...flags,source:"mf-auto"});
        if(flags.formateurPilote) e.pingFormateurPilote=true;
        if(flags.formateurMup) e.pingFormateurMup=true;
      } catch(err) { console.warn("Formateur automatique non enregistré :",e.name,err.message); }
    }
  } finally { window.__pingSyncBusy=false; }
}
const PING_ADD_CHECKS = { pilote:"pingAddPilote", coPilote:"pingAddCoPilote", mup:"pingAddMup", formateurPilote:"pingAddFormateurPilote", formateurMup:"pingAddFormateurMup" };
function pingUpdateAddChecks() {
  const sel=document.getElementById("pingAddSelect"); if(!sel || typeof employees==="undefined") return;
  const e=employees.find(x=>String(x.id)===String(sel.value));
  const hint=document.getElementById("pingAddHint");
  Object.keys(PING_ADD_CHECKS).forEach(k=>{
    const input=document.getElementById(PING_ADD_CHECKS[k]); if(!input) return;
    const ok=!e || pingEligible(e,k);
    input.disabled=!ok; if(!ok) input.checked=false;
    const chip=input.closest(".ping-chip"); if(chip) chip.classList.toggle("is-disabled",!ok);
  });
  if(hint) hint.textContent=e ? `Grade ${e.grade} : les listes grisées demandent un grade plus élevé.` : "Choisis un employé : seules les listes auxquelles son grade donne accès restent cochables.";
}
function renderPingAddCard() {
  const host=document.getElementById("pingAddCard"); if(!host || typeof employees==="undefined") return;
  if(typeof hasCap==="function" && !hasCap("manage_roster")) { host.hidden=true; return; }
  host.hidden=false;
  const sel=document.getElementById("pingAddSelect"); if(!sel) return;
  if(document.activeElement===sel) return; // ne pas perturber la saisie
  const keep=sel.value;
  // Jamais de stagiaires (STG) ni WDV : aucun accès aux formations.
  const people=employees.filter(e=>e && !e.licencie && !pingIsExcluded(e) && Object.keys(PING_ADD_CHECKS).some(k=>pingEligible(e,k))).sort(pingCompareEmployees);
  const sig=people.map(e=>e.id+e.name+e.grade).join("|");
  if(sel.dataset.sig!==sig){
    sel.innerHTML='<option value="">Choisir un employé…</option>'+people.map(e=>`<option value="${esc(e.id)}">[${esc(e.grade)}] ${esc(e.name)}${pingValidDiscordId(e.discordId)?"":" — ID manquant"}</option>`).join("");
    sel.dataset.sig=sig; if(keep) sel.value=keep;
  }
  pingUpdateAddChecks();
}
function pingInitials(name) {
  const parts=String(name||"").replace(/[^\p{L}\p{N}\s'-]/gu,"").trim().split(/\s+/).filter(Boolean);
  const first=Array.from(parts[0]||"?")[0]||"?", second=parts[1]?Array.from(parts[1])[0]:"";
  return (first+second).toUpperCase();
}
let pingLastHtml="";
function renderPingLists() {
  const host=document.getElementById("pingListsGrid"); if(!host || typeof employees==="undefined") return;
  renderPingAddCard();
  pingAutoFormateurSync();
  renderPingPreview();
  const view=document.getElementById("pingListsView");
  if(view && view.style.display!=="none") pingLoadHistory(false);
  const html=Object.keys(PING_LIST_CONFIG).map(key=>{
    const cfg=PING_LIST_CONFIG[key], meta=PING_LIST_META[key]||{icon:"📣",accent:"#60a5fa",rule:""}, data=getPingListEmployees(key);
    const missing=data.missingIds, preview=[...data.employees,...missing].sort(pingCompareEmployees);
    const grouped=PING_LIST_GRADE_ORDER.map(grade=>({grade,people:preview.filter(e=>e.grade===grade)})).filter(group=>group.people.length);
    const others=preview.filter(e=>!PING_LIST_GRADE_ORDER.includes(e.grade)); if(others.length) grouped.push({grade:"Autres",people:others});
    const gColor=g=>(typeof GRADE_COLOR!=="undefined"&&GRADE_COLOR[g])||"#334155", gText=g=>(typeof GRADE_TEXT_COLOR!=="undefined"&&GRADE_TEXT_COLOR[g])||"#fff";
    const groupedHtml=grouped.map(group=>`<div class="ping-grade-group"><div class="ping-grade-heading"><span class="ping-grade-pill" style="background:${gColor(group.grade)};color:${gText(group.grade)}">${esc(group.grade)}</span><span>${esc((typeof GRADE_LABEL!=="undefined"&&GRADE_LABEL[group.grade])||group.grade)}</span><span class="ping-grade-count">${group.people.length}</span></div>${group.people.map(e=>`<div class="ping-row"><span class="ping-avatar">${esc(pingInitials(e.name))}</span><span class="ping-name">${esc(e.name)}</span><span class="ping-tags">${pingValidDiscordId(e.discordId)?"":'<span class="ping-tag ping-tag-warn">ID manquant</span>'}${pingManualFlag(e,key)===true?`<span class="ping-tag">ajout manuel</span><button type="button" class="ping-remove" data-ping-remove="${esc(e.id)}" data-ping-remove-key="${key}" title="Retirer cet ajout manuel" aria-label="Retirer cet ajout manuel">✕</button>`:""}</span></div>`).join("")}</div>`).join("");
    return `<section class="ping-card" style="--ping-accent:${meta.accent}"><header class="ping-card-head"><span class="ping-card-icon" aria-hidden="true">${meta.icon}</span><div class="ping-card-titles"><h3>${esc(cfg.title)}</h3><p>${esc(meta.rule)}</p></div><span class="ping-count" title="Membres à ping">${data.employees.length}</span></header><div class="ping-card-btns"><button class="ping-copy-btn" type="button" data-ping-copy="${key}">⧉ Copier la liste</button><button class="ping-eye-btn" type="button" data-ping-preview="list:${key}" title="Aperçu du message" aria-label="Aperçu du message">👁</button></div><div class="ping-list-preview">${preview.length?groupedHtml:'<div class="ping-empty">Personne dans cette liste pour le moment.</div>'}</div><details class="ping-missing"><summary>ID manquants : ${missing.length}</summary>${missing.length?missing.map(e=>`<div>${esc(e.name)} (${esc(e.grade)})</div>`).join(""):'<span class="sub">Aucun ID manquant.</span>'}</details></section>`;
  }).join("");
  if(html===pingLastHtml && host.childElementCount) return; // évite de réinitialiser le défilement toutes les 3 s
  pingLastHtml=html; host.innerHTML=html;
}
async function copyPingText(text) {
  if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
  else { const ta=document.createElement("textarea"); ta.value=text; ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select(); const ok=document.execCommand("copy"); ta.remove(); if(!ok) throw new Error("Copie refusée par le navigateur."); }
}
if (typeof document !== "undefined") document.addEventListener("click",async ev=>{
  const pv=ev.target.closest("[data-ping-preview]");
  if(pv){ const v=pv.dataset.pingPreview; const [kind,key]=v.split(":"); pingOpenPreview(kind,key); return; }
  if(ev.target.closest("[data-ping-preview-close]")){ pingPreviewState=null; renderPingPreview(); return; }
  if(ev.target.closest("[data-ping-preview-copy]")){
    try { await copyPingText(pingPreviewText(pingPreviewState,employees,new Date())); if(typeof toast==="function") toast("✓ Message copié."); }
    catch(err) { if(typeof toast==="function") toast("✕ Copie impossible : "+err.message); }
    return;
  }
  if(ev.target.closest("#btnPingHistoryRefresh")){ pingLoadHistory(true); return; }
  const rm=ev.target.closest("[data-ping-remove]");
  if(rm){
    try { await pingSetMembership(rm.dataset.pingRemove,{[rm.dataset.pingRemoveKey]:null}); if(typeof toast==="function") toast("✓ Ajout manuel retiré."); }
    catch(err) { if(typeof toast==="function") toast("✕ Retrait impossible : "+err.message); }
    return;
  }
  if(ev.target.closest("#btnPingAdd")){
    const sel=document.getElementById("pingAddSelect"), id=sel&&sel.value;
    const flags={pilote:document.getElementById("pingAddPilote").checked,coPilote:document.getElementById("pingAddCoPilote").checked,mup:document.getElementById("pingAddMup").checked,formateurPilote:document.getElementById("pingAddFormateurPilote").checked,formateurMup:document.getElementById("pingAddFormateurMup").checked};
    if(!id){ if(typeof toast==="function") toast("Choisis d'abord un employé."); return; }
    if(!Object.values(flags).some(Boolean)){ if(typeof toast==="function") toast("Coche au moins une liste."); return; }
    const btnAdd=ev.target.closest("#btnPingAdd"); btnAdd.disabled=true;
    try {
      const payload={}; Object.keys(flags).forEach(k=>{ if(flags[k]) payload[k]=true; });
      const e=await pingSetMembership(id,payload);
      const noIdWarn=pingValidDiscordId(e.discordId)?"":" (⚠ ID Discord manquant : il ne sera pas ping)";
      if(typeof toast==="function") toast(`✓ ${e.name} ajouté${noIdWarn}`);
      ["pingAddPilote","pingAddCoPilote","pingAddMup","pingAddFormateurPilote","pingAddFormateurMup"].forEach(i=>{document.getElementById(i).checked=false;}); sel.value="";
    } catch(err) { if(typeof toast==="function") toast("✕ Ajout impossible : "+err.message); }
    finally { btnAdd.disabled=false; }
    return;
  }
  const btn=ev.target.closest("[data-ping-copy],[data-ping-group],#btnPingCopyAll"); if(!btn) return;
  try {
    const date=new Date();
    const text=btn.id==="btnPingCopyAll"?buildAllPingListsText(employees,date):btn.dataset.pingGroup?buildPingGroupText(btn.dataset.pingGroup,employees,date):buildPingListText(btn.dataset.pingCopy,employees,date,true);
    await copyPingText(text); if(typeof toast==="function") toast("✓ Liste Discord copiée.");
  } catch(err) { if(typeof toast==="function") toast("✕ Copie impossible : "+err.message); }
});
if (typeof document !== "undefined") {
  document.addEventListener("change",ev=>{
    if(!ev.target) return;
    if(ev.target.id==="pingAddSelect") pingUpdateAddChecks();
    if(ev.target.id==="pingAddPilote" && ev.target.checked){ const c=document.getElementById("pingAddCoPilote"); if(c&&!c.disabled) c.checked=true; }
    if(ev.target.id==="pingAddFormateurPilote" || ev.target.id==="pingAddFormateurMup"){ /* un formateur l'est pour Pilote ET MUP */
      if(ev.target.checked){ ["pingAddFormateurPilote","pingAddFormateurMup"].forEach(i=>{const c=document.getElementById(i); if(c&&!c.disabled) c.checked=true;}); }
    }
  });
  document.addEventListener("DOMContentLoaded",()=>{
    renderPingLists();
  });
  if (typeof hasCap === "function" && !hasCap("view_roster")) {
    document.addEventListener("DOMContentLoaded",()=>{const c=document.getElementById("pingListsCard");if(c)c.hidden=true;});
  }
  setInterval(renderPingLists,3000);
}
if(typeof module!=="undefined") module.exports={buildPingPreviewHtml,pingPreviewText,buildPingHistoryHtml,PING_FORMATEUR_DISCORD_IDS,PING_COPY_GROUPS,PING_MANUAL_FIELD,buildPingGroupText,pingManualFlag,PING_LIST_META,pingEligible,PING_LIST_CONFIG,EXCLUDED_FROM_PING_LISTS,PING_LIST_GRADE_ORDER,PING_PILOTE_DISCORD_IDS,PING_COPILOTE_DISCORD_IDS,getPingListEmployees,pingCompareEmployees,buildPingListText,buildAllPingListsText,pingValidDiscordId,pingIsExcluded};
