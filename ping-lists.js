// Listes de ping Discord — intégré au Roster (JavaScript vanilla).
const EMPLOYES_ROLE_ID = "1168614318846267492";
const EXCLUDED_FROM_PING_LISTS = ["451073171194511370"];
const PING_LIST_GRADE_ORDER = ["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF","A"];
const PING_LIST_CONFIG = {
  pilote: { label:"Pilotes", title:"LISTE des Pilotes", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF","A"] },
  coPilote: { label:"Co-Pilotes", title:"LISTE des Co-Pilotes", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF","A"] },
  formateurPilote: { label:"Formateurs Pilote", title:"LISTE des Formateurs Pilote", grades:["DG","D","CD","ADD","MC","RF","MF"] },
  mup: { label:"M.U.P", title:"LISTE des M.U.P", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M"] },
  formateurMup: { label:"Formateurs M.U.P", title:"LISTE des Formateurs M.U.P", grades:["DG","D","CD","ADD","MC","RF","MF"] }
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
const PING_MANUAL_FIELD = { pilote:"pingPilote", coPilote:"pingCoPilote", mup:"pingMup" };
function pingManualFlag(e,key) {
  const f=PING_MANUAL_FIELD[key]; if(!f||!e) return undefined;
  return typeof e[f]==="boolean" ? e[f] : undefined;
}
function getPingListEmployees(key, source=employees) {
  const cfg=PING_LIST_CONFIG[key];
  if(!cfg) return {employees:[],missingIds:[]};
  const allowed=new Set(cfg.grades);
  const list=(Array.isArray(source)?source:[]).filter(e=>{
    if(!e || pingIsExcluded(e)) return false;
    const manual=pingManualFlag(e,key);
    if(manual===true) return true;
    if(manual===false) return false;
    if(!allowed.has(e.grade)) return false;
    if(key==="pilote") return PING_PILOTE_DISCORD_IDS.has(String(e.discordId||"").trim());
    if(key==="coPilote") return PING_COPILOTE_DISCORD_IDS.has(String(e.discordId||"").trim());
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
  return e;
}
function renderPingAddCard() {
  const host=document.getElementById("pingAddCard"); if(!host || typeof employees==="undefined") return;
  if(typeof hasCap==="function" && !hasCap("manage_roster")) { host.hidden=true; return; }
  host.hidden=false;
  const sel=document.getElementById("pingAddSelect"); if(!sel) return;
  if(host.contains(document.activeElement) && sel.options.length>1) return; // ne pas perturber la saisie
  const keep=sel.value;
  const people=employees.filter(e=>e && !e.licencie && !pingIsExcluded(e)).sort(pingCompareEmployees);
  sel.innerHTML='<option value="">Choisir un employé…</option>'+people.map(e=>`<option value="${esc(e.id)}">${esc(e.name)} (${esc(e.grade)})${pingValidDiscordId(e.discordId)?"":" — ID manquant"}</option>`).join("");
  if(keep) sel.value=keep;
}
function renderPingLists() {
  const host=document.getElementById("pingListsGrid"); if(!host || typeof employees==="undefined") return;
  renderPingAddCard();
  host.innerHTML=Object.keys(PING_LIST_CONFIG).map(key=>{
    const cfg=PING_LIST_CONFIG[key], data=getPingListEmployees(key);
    const missing=data.missingIds, preview=[...data.employees,...missing].sort(pingCompareEmployees);
    const total=preview.length;
    const grouped=PING_LIST_GRADE_ORDER.map(grade=>({grade,people:preview.filter(e=>e.grade===grade)})).filter(group=>group.people.length);
    const others=preview.filter(e=>!PING_LIST_GRADE_ORDER.includes(e.grade)); if(others.length) grouped.push({grade:"Autres",people:others});
    const groupedHtml=grouped.map(group=>`<div class="ping-grade-group"><div class="ping-grade-heading">${esc(group.grade)} — ${esc(GRADE_LABEL[group.grade]||group.grade)}</div>${group.people.map(e=>`<div class="special-row"><span><b>${esc(e.name)}</b></span><span class="sub">${pingValidDiscordId(e.discordId)?"":"ID manquant "}${pingManualFlag(e,key)===true?`ajout manuel <button type="button" class="btn-ghost btn-small" data-ping-remove="${esc(e.id)}" data-ping-remove-key="${key}" title="Retirer cet ajout manuel">✕</button>`:""}</span></div>`).join("")}</div>`).join("");
    return `<section class="card ping-list-card"><div class="ping-card-top"><div class="ping-card-title-wrap"><div class="special-title">LISTE des ${esc(cfg.label)}</div><div class="special-sub">${data.employees.length} membre(s) à ping</div></div><span class="ping-count">${data.employees.length}</span></div><div class="ping-card-actions"><button class="btn-primary btn-small" type="button" data-ping-copy="${key}">⧉ Copier la liste</button><span class="ping-preview-label">Aperçu des membres</span></div><div class="special-list ping-list-preview">${total?groupedHtml:'<div class="empty-msg">Aucun employé trouvé.</div>'}</div><details class="ping-missing"><summary>ID manquants : ${missing.length}</summary>${missing.length?missing.map(e=>`<div>${esc(e.name)} (${esc(e.grade)})</div>`).join(""):'<span class="sub">Aucun ID manquant.</span>'}</details></section>`;
  }).join("");
}
async function copyPingText(text) {
  if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
  else { const ta=document.createElement("textarea"); ta.value=text; ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select(); const ok=document.execCommand("copy"); ta.remove(); if(!ok) throw new Error("Copie refusée par le navigateur."); }
}
if (typeof document !== "undefined") document.addEventListener("click",async ev=>{
  const rm=ev.target.closest("[data-ping-remove]");
  if(rm){
    try { await pingSetMembership(rm.dataset.pingRemove,{[rm.dataset.pingRemoveKey]:null}); if(typeof toast==="function") toast("✓ Ajout manuel retiré."); }
    catch(err) { if(typeof toast==="function") toast("✕ Retrait impossible : "+err.message); }
    return;
  }
  if(ev.target.closest("#btnPingAdd")){
    const sel=document.getElementById("pingAddSelect"), id=sel&&sel.value;
    const flags={pilote:document.getElementById("pingAddPilote").checked,coPilote:document.getElementById("pingAddCoPilote").checked,mup:document.getElementById("pingAddMup").checked};
    if(!id){ if(typeof toast==="function") toast("Choisis d'abord un employé."); return; }
    if(!flags.pilote&&!flags.coPilote&&!flags.mup){ if(typeof toast==="function") toast("Coche au moins une liste : Pilote, Co-Pilote ou MUP."); return; }
    const btnAdd=ev.target.closest("#btnPingAdd"); btnAdd.disabled=true;
    try {
      const payload={}; Object.keys(flags).forEach(k=>{ if(flags[k]) payload[k]=true; });
      const e=await pingSetMembership(id,payload);
      const noIdWarn=pingValidDiscordId(e.discordId)?"":" (⚠ ID Discord manquant : il ne sera pas ping)";
      if(typeof toast==="function") toast(`✓ ${e.name} ajouté${noIdWarn}`);
      ["pingAddPilote","pingAddCoPilote","pingAddMup"].forEach(i=>{document.getElementById(i).checked=false;}); sel.value="";
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
    if(ev.target && ev.target.id==="pingAddPilote" && ev.target.checked){ const c=document.getElementById("pingAddCoPilote"); if(c) c.checked=true; }
  });
  document.addEventListener("DOMContentLoaded",()=>{
    renderPingLists();
  });
  if (typeof hasCap === "function" && !hasCap("view_roster")) {
    document.addEventListener("DOMContentLoaded",()=>{const c=document.getElementById("pingListsCard");if(c)c.hidden=true;});
  }
  setInterval(renderPingLists,3000);
}
if(typeof module!=="undefined") module.exports={PING_COPY_GROUPS,PING_MANUAL_FIELD,buildPingGroupText,pingManualFlag,PING_LIST_CONFIG,EXCLUDED_FROM_PING_LISTS,PING_LIST_GRADE_ORDER,PING_PILOTE_DISCORD_IDS,PING_COPILOTE_DISCORD_IDS,getPingListEmployees,pingCompareEmployees,buildPingListText,buildAllPingListsText,pingValidDiscordId,pingIsExcluded};
