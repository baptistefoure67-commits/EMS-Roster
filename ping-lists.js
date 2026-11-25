// Listes de ping Discord — intégré au Roster (JavaScript vanilla).
const EMPLOYES_ROLE_ID = "1168614318846267492";
const EXCLUDED_FROM_PING_LISTS = ["451073171194511370"];
const PING_LIST_GRADE_ORDER = ["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF","A"];
const PING_LIST_CONFIG = {
  pilote: { label:"Pilotes", title:"LISTE PILOTES", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF","A"] },
  coPilote: { label:"Co-Pilotes", title:"LISTE CO-PILOTES", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M","BNVL","INF","A"] },
  formateurPilote: { label:"Formateurs Pilote", title:"LISTE FORMATEURS PILOTE", grades:["DG","D","CD","ADD","MC","RF","MF"] },
  mup: { label:"M.U.P", title:"LISTE M.U.P", grades:["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M"] },
  formateurMup: { label:"Formateurs M.U.P", title:"LISTE FORMATEURS M.U.P", grades:["DG","D","CD","ADD","MC","RF","MF"] }
};
const PING_COPY_ORDER = ["mup","formateurMup","formateurPilote","pilote","coPilote"];
const PING_FORMATION_MEMBERSHIP = {
  piloteDiscordIds:new Set(), copiloteDiscordIds:new Set(),
  piloteEmployeeIds:new Set(), copiloteEmployeeIds:new Set(), loaded:false
};
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
function getPingListEmployees(key, source=employees) {
  const cfg=PING_LIST_CONFIG[key];
  if(!cfg) return {employees:[],missingIds:[]};
  const allowed=new Set(cfg.grades);
  // Les formations pilote/co-pilote ne sont pas stockées dans les fiches
  // employé de cette version du Roster : ne pas inventer l'appartenance.
  const list=(Array.isArray(source)?source:[]).filter(e=>{
    if(!e || pingIsExcluded(e) || !allowed.has(e.grade)) return false;
    if(key==="pilote" || key==="coPilote") {
      const prefix=key==="pilote"?"pilote":"copilote";
      if(!PING_FORMATION_MEMBERSHIP.loaded) return false;
      return PING_FORMATION_MEMBERSHIP[prefix+"DiscordIds"].has(String(e.discordId||"").trim()) ||
        PING_FORMATION_MEMBERSHIP[prefix+"EmployeeIds"].has(String(e.id));
    }
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
  const body=blocks.length ? `**${cfg.title} :**\n\n${blocks.join("\n\n")}` : `**${cfg.title} :**`;
  return includeUpdate ? `${body}\n\nMis à jour le ${date.toLocaleDateString("fr-FR")} <@&${EMPLOYES_ROLE_ID}>` : body;
}
function buildAllPingListsText(source=employees,date=new Date()) {
  const blocks=PING_COPY_ORDER.map(k=>buildPingListText(k,source,date,false));
  return `${blocks.join("\n\n")}\n\nMis à jour le ${date.toLocaleDateString("fr-FR")} <@&${EMPLOYES_ROLE_ID}>`;
}
function renderPingLists() {
  const host=document.getElementById("pingListsGrid"); if(!host || typeof employees==="undefined") return;
  host.innerHTML=Object.keys(PING_LIST_CONFIG).map(key=>{
    const cfg=PING_LIST_CONFIG[key], data=getPingListEmployees(key);
    const missing=data.missingIds, preview=[...data.employees,...missing].sort(pingCompareEmployees);
    const total=preview.length;
    const grouped=PING_LIST_GRADE_ORDER.map(grade=>({grade,people:preview.filter(e=>e.grade===grade)})).filter(group=>group.people.length);
    const groupedHtml=grouped.map(group=>`<div class="ping-grade-group"><div class="ping-grade-heading">${esc(group.grade)} — ${esc(GRADE_LABEL[group.grade]||group.grade)}</div>${group.people.map(e=>`<div class="special-row"><span><b>${esc(e.name)}</b></span><span class="sub">${pingValidDiscordId(e.discordId)?"":"ID manquant"}</span></div>`).join("")}</div>`).join("");
    return `<section class="card ping-list-card"><div class="special-head"><div><div class="special-title">${cfg.label}</div><div class="special-sub">${total} employé(s)${(key==="pilote"||key==="coPilote")&&!PING_FORMATION_MEMBERSHIP.loaded?" · formations en cours de chargement":""}</div></div><button class="btn-primary btn-small" type="button" data-ping-copy="${key}">Copier</button></div><div class="special-list ping-list-preview">${total?groupedHtml:'<div class="empty-msg">Aucun employé trouvé.</div>'}</div><details class="ping-missing"><summary>ID manquants : ${missing.length}</summary>${missing.length?missing.map(e=>`<div>${esc(e.name)} (${esc(e.grade)})</div>`).join(""):'<span class="sub">Aucun ID manquant.</span>'}</details></section>`;
  }).join("");
}
async function copyPingText(text) {
  if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
  else { const ta=document.createElement("textarea"); ta.value=text; ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select(); const ok=document.execCommand("copy"); ta.remove(); if(!ok) throw new Error("Copie refusée par le navigateur."); }
}
if (typeof document !== "undefined") document.addEventListener("click",async ev=>{
  const btn=ev.target.closest("[data-ping-copy],#btnPingCopyAll"); if(!btn) return;
  try {
    const date=new Date();
    const text=btn.id==="btnPingCopyAll"?buildAllPingListsText(employees,date):buildPingListText(btn.dataset.pingCopy,employees,date,true);
    await copyPingText(text); if(typeof toast==="function") toast("✓ Liste Discord copiée.");
  } catch(err) { if(typeof toast==="function") toast("✕ Copie impossible : "+err.message); }
});
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded",()=>{
    renderPingLists();
    if(typeof formationDiscordRequest==="function") formationDiscordRequest("ping-membership","").then(data=>{
      PING_FORMATION_MEMBERSHIP.piloteDiscordIds=new Set(data.piloteDiscordIds||[]);
      PING_FORMATION_MEMBERSHIP.copiloteDiscordIds=new Set(data.copiloteDiscordIds||[]);
      PING_FORMATION_MEMBERSHIP.piloteEmployeeIds=new Set(data.piloteEmployeeIds||[]);
      PING_FORMATION_MEMBERSHIP.copiloteEmployeeIds=new Set(data.copiloteEmployeeIds||[]);
      PING_FORMATION_MEMBERSHIP.loaded=true; renderPingLists();
    }).catch(err=>{console.warn("Appartenance Pilote/Co-Pilote indisponible :",err);});
  });
  if (typeof hasCap === "function" && !hasCap("view_roster")) {
    document.addEventListener("DOMContentLoaded",()=>{const c=document.getElementById("pingListsCard");if(c)c.hidden=true;});
  }
  setInterval(renderPingLists,3000);
}
if(typeof module!=="undefined") module.exports={PING_LIST_CONFIG,EXCLUDED_FROM_PING_LISTS,PING_LIST_GRADE_ORDER,PING_FORMATION_MEMBERSHIP,getPingListEmployees,pingCompareEmployees,buildPingListText,buildAllPingListsText,pingValidDiscordId,pingIsExcluded};
