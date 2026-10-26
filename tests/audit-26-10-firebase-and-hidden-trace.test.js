const path = require('path'), crypto = require('crypto');
const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const { privateKey } = crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
process.env.SESSION_SECRET='s3cret'; process.env.FIREBASE_CLIENT_EMAIL='x@y.z'; process.env.FIREBASE_PRIVATE_KEY=privateKey; process.env.FIREBASE_WEB_API_KEY='k';
const { sign } = require(path.join(DIR,'session-token'));
const fs = require('fs');

const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };
function sessionFor(level, discordId, name){ return sign({discordId, name, level, exp: Date.now()+7200000}, process.env.SESSION_SECRET); }

// ───── Partie 1 : règles Firebase statiques ─────
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase-rules.permissions-regroupees.json'), 'utf8')).rules;

t('rosterLogs : la CRÉATION exige aussi server:true (plus de trou "!data.exists()")',
  rules.rosterLogs.$logId['.write'] === "auth != null && auth.token.server == true",
  rules.rosterLogs.$logId['.write']);

t('payRulesConfigHistory : écriture réservée au serveur (plus de check de niveau déclaré par le client)',
  rules.payRulesConfigHistory['.write'] === "auth != null && auth.token.server == true",
  rules.payRulesConfigHistory['.write']);

t('signalementPropositions : lecture ne demande plus "true" mais au moins authentifié',
  rules.signalementPropositions['.read'] === "auth != null",
  rules.signalementPropositions['.read']);

t('rosterPresence/$discordId : écriture liée au serveur ET au bon uid (empêche d écrire la présence de quelqu un d autre)',
  rules.rosterPresence.$discordId['.write'] === "auth.token.server == true && auth.uid == 'roster-presence:' + $discordId",
  rules.rosterPresence.$discordId['.write']);

t('pillboxPresence/$discordId : idem, préfixe pillbox-presence',
  rules.pillboxPresence.$discordId['.write'] === "auth.token.server == true && auth.uid == 'pillbox-presence:' + $discordId",
  rules.pillboxPresence.$discordId['.write']);

t('rosterLogsHiddenTrace toujours présente et réservée au serveur',
  rules.rosterLogsHiddenTrace && rules.rosterLogsHiddenTrace['.read']==='auth != null && auth.token.server == true' && rules.rosterLogsHiddenTrace['.write']==='auth != null && auth.token.server == true');

// ───── Partie 2 : comportement réel, DG supprime = pas de trace publique ─────
let DB = {};
function fresh(){
  // delete_logs est individuel UNIQUEMENT (INDIVIDUAL_ONLY_KEYS) : un
  // override de GRADE ne suffit jamais, il faut l'accorder à CETTE personne précisément.
  DB = { rosterLogs: {}, rosterLogsHiddenTrace: {}, rosterIndividualPermissions: { '222222222222222222': { delete_logs: { CD:null, D:null, DG:true, OWNER:null } } }, rosterPermissionsOverride: {} };
}
fresh();
global.fetch = async (url, opts) => {
  const u = String(url);
  if(u.includes('identitytoolkit')) return { ok:true, status:200, json: async()=>({idToken:'fake-id-token'}) };
  const method = (opts && opts.method) || 'GET';
  for(const branch of ['rosterLogsHiddenTrace','rosterLogs','rosterIndividualPermissions','rosterPermissionsOverride']){
    const m = u.match(new RegExp(branch+'(?:/([^/.?]+))?\\.json'));
    if(!m) continue;
    const key = m[1] ? decodeURIComponent(m[1]) : null;
    if(method === 'GET') return { ok:true, status:200, json: async()=> (key ? (DB[branch][key] ?? null) : DB[branch]) };
    if(method === 'PUT'){ const body = JSON.parse(opts.body); if(key) DB[branch][key] = body; else DB[branch] = body; return { ok:true, status:200, json: async()=>({}), text: async()=>'' }; }
    if(method === 'DELETE'){ if(key) delete DB[branch][key]; return { ok:true, status:200, json: async()=>({}), text: async()=>'' }; }
  }
  return { ok:true, status:200, json: async()=>({}) };
};
function freshHandler(file){ delete require.cache[require.resolve(path.join(DIR,file))]; return require(path.join(DIR,file)).handler; }
async function callPost(file, bodyExtra){
  const handler = freshHandler(file);
  const res = await handler({ httpMethod:'POST', body: JSON.stringify(bodyExtra) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function callGet(file, qs){
  const handler = freshHandler(file);
  const res = await handler({ httpMethod:'GET', queryStringParameters: qs });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

(async()=>{
  const ownerTok = sessionFor('OWNER','111111111111111111','Baptiste');
  const dgTok = sessionFor('DG','222222222222222222','Papy');

  fresh();
  DB.rosterLogs['logDG'] = { action:'modification_employe', authorDiscordId:'999', authorName:'Quelqu’un', createdAt: Date.now(), details:'test' };
  let r = await callPost('get-logs.js', { token: dgTok, logKey: 'logDG' });
  t('DG supprime avec succès', r.status===200);
  let publicLogs = Object.values(DB.rosterLogs).map(l=>l.action);
  t('AUCUNE entrée publique "log_supprime" créée par un DG (corrigé)', !publicLogs.includes('log_supprime'), JSON.stringify(publicLogs));
  t('La trace cachée existe bien quand même', Object.keys(DB.rosterLogsHiddenTrace).length===1);

  fresh();
  DB.rosterLogs['logOwner'] = { action:'modification_employe', authorDiscordId:'999', authorName:'X', createdAt: Date.now(), details:'test' };
  r = await callPost('get-logs.js', { token: ownerTok, logKey: 'logOwner' });
  let publicLogsOwner = Object.values(DB.rosterLogs).map(l=>l.action);
  t('OWNER qui supprime laisse toujours la trace publique normale', publicLogsOwner.includes('log_supprime'), JSON.stringify(publicLogsOwner));
  t('OWNER qui supprime : aucune trace cachée en plus (inutile)', Object.keys(DB.rosterLogsHiddenTrace).length===0);

  // ───── Nettoyage 13 jours de la trace cachée ─────
  fresh();
  const now = Date.now(); const DAY = 24*60*60*1000;
  DB.rosterLogsHiddenTrace['old'] = { deletedByName:'Papy', deletedByLevel:'DG', createdAt: now-14*DAY, deletedEntry:{} };
  DB.rosterLogsHiddenTrace['recent'] = { deletedByName:'Papy', deletedByLevel:'DG', createdAt: now-2*DAY, deletedEntry:{} };
  r = await callGet('get-logs.js', { token: ownerTok, hiddenTrace:'1' });
  t('Trace cachée de 14 jours absente du résultat', !r.body.entries.some(e=>e.key==='old'), JSON.stringify(r.body.entries.map(e=>e.key)));
  t('Trace cachée de 2 jours bien présente', r.body.entries.some(e=>e.key==='recent'));
  await new Promise(res=>setTimeout(res, 50));
  t('Trace cachée expirée réellement supprimée de la base ensuite (corrigé)', !DB.rosterLogsHiddenTrace.old, JSON.stringify(Object.keys(DB.rosterLogsHiddenTrace)));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis`);
  process.exit(failed?1:0);
})();
