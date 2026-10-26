const path = require('path'), crypto = require('crypto');
const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const { privateKey } = crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
process.env.SESSION_SECRET='s3cret'; process.env.FIREBASE_CLIENT_EMAIL='x@y.z'; process.env.FIREBASE_PRIVATE_KEY=privateKey; process.env.FIREBASE_WEB_API_KEY='k';
const { sign } = require(path.join(DIR,'session-token'));

const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };
function sessionFor(level, discordId, name){ return sign({discordId, name, level, exp: Date.now()+7200000}, process.env.SESSION_SECRET); }

let DB = {};
function fresh(){
  DB = {
    rosterIndividualPermissions: {},
    rosterPermissionsOverride: { D:{manage_permissions:true}, DG:{manage_permissions:true}, OWNER:{manage_permissions:true} },
    rosterPermissionRequests: {},
    rosterLogs: {},
    payRulesConfig: { reaRate:14000, fixedSalaryByGrade:{}, bonusByRank:{"1":3000000,"2":2000000,"3":1000000}, ppaWeeklyCap:10000000, ppaEligibleGrades:[], recruitmentPrice:500000, formationPrice:70000, updatedAt:0 },
    pillboxWeekHistory: {},
  };
}
fresh();

global.fetch = async (url, opts) => {
  const u = String(url);
  if(u.includes('identitytoolkit')) return { ok:true, status:200, json: async()=>({idToken:'fake-id-token'}) };
  const method = (opts && opts.method) || 'GET';
  for(const branch of ['rosterIndividualPermissions','rosterPermissionsOverride','rosterPermissionRequests','rosterLogs','payRulesConfig','pillboxWeekHistory']){
    const m = u.match(new RegExp(branch+'(?:/([^/.?]+))?\\.json'));
    if(!m) continue;
    const key = m[1] ? decodeURIComponent(m[1]) : null;
    if(method === 'GET'){
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=> (key ? (DB[branch][key] ?? null) : DB[branch]) };
    }
    if(method === 'PUT'){
      const body = JSON.parse(opts.body);
      if(key) DB[branch][key] = body; else DB[branch] = body;
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({}) , text: async()=>'' };
    }
    if(method === 'PATCH'){
      const bodyPatch = JSON.parse(opts.body);
      if(key){ DB[branch][key] = { ...(DB[branch][key]||{}), ...bodyPatch }; } else { DB[branch] = { ...(DB[branch]||{}), ...bodyPatch }; }
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({}) , text: async()=>'' };
    }
  }
  return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({}) };
};

function freshHandler(file){ delete require.cache[require.resolve(path.join(DIR,file))]; return require(path.join(DIR,file)).handler; }
async function callPost(file, bodyExtra){
  const handler = freshHandler(file);
  // pillbox-proxy.js attend le jeton de session dans l'en-tête
  // X-Pillbox-Session (pas dans le corps JSON comme les autres fonctions).
  const { token, ...rest } = bodyExtra;
  const event = file === 'pillbox-proxy.js'
    ? { httpMethod:'POST', headers: token ? { 'x-pillbox-session': token } : {}, body: JSON.stringify(rest) }
    : { httpMethod:'POST', body: JSON.stringify(bodyExtra) };
  const res = await handler(event);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

(async()=>{
  const ownerTok = sessionFor('OWNER','111111111111111111','Baptiste');
  const dgTok = sessionFor('DG','222222222222222222','Papy');
  const dTok = sessionFor('D','333333333333333333','Aaron');
  const TARGET = '999000111';

  // ───── Priorité 5 : OWNER ne crée QUE OWNER/OWNER++ ─────
  let r = await callPost('manage-individual-permissions.js', { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:'D' });
  // (session non authentifiée volontairement absente du body -> test suivant avec vrai token)
  r = await callPost('manage-individual-permissions.js', { token:ownerTok, action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:'D' });
  t('OWNER NE PEUT PLUS créer 🔒D (corrigé)', r.status===403, JSON.stringify(r));
  r = await callPost('manage-individual-permissions.js', { token:ownerTok, action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:'DG' });
  t('OWNER NE PEUT PLUS créer 🔒DG (corrigé)', r.status===403, JSON.stringify(r));
  r = await callPost('manage-individual-permissions.js', { token:ownerTok, action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:'OWNER' });
  t('OWNER peut toujours créer 🔒OWNER', r.status===200, JSON.stringify(r));
  r = await callPost('manage-individual-permissions.js', { token:ownerTok, action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:null });
  t('OWNER peut toujours RETIRER une protection (même pas la sienne)', r.status===200 && r.body.protection===null, JSON.stringify(r));

  // ───── Priorité 4 : permission-requests bloque sur une permission protégée ─────
  fresh();
  await callPost('manage-individual-permissions.js', { token:dTok, action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:'D' });
  DB.rosterPermissionRequests['req1'] = { targetDiscordId:TARGET, permissionName:'manage_absences', requestedValue:true, status:'pending', authorDiscordId:'x', authorLevel:'MC' };
  r = await callPost('permission-requests.js', { token:dgTok, action:'approve', requestId:'req1' });
  t('Demande approuvée REFUSÉE si la permission est protégée (corrigé, 423 attendu)', r.status===423, JSON.stringify(r));
  t('La valeur protégée n a PAS été modifiée par l approbation (DG toujours vide)', DB.rosterIndividualPermissions[TARGET].manage_absences.DG === null, JSON.stringify(DB.rosterIndividualPermissions[TARGET]));

  // Cas normal : pas de protection -> l'approbation fonctionne toujours
  fresh();
  DB.rosterPermissionRequests['req2'] = { targetDiscordId:TARGET, permissionName:'manage_pay_weeks', requestedValue:true, status:'pending', authorDiscordId:'x', authorLevel:'MC' };
  r = await callPost('permission-requests.js', { token:dgTok, action:'approve', requestId:'req2' });
  t('Demande approuvée fonctionne toujours normalement (pas de protection)', r.status===200, JSON.stringify(r));

  // ───── Priorité 3 : log de clôture créé APRÈS succès, avec weekKey structuré ─────
  fresh();
  r = await callPost('pillbox-verify-session.js', { token: ownerTok, weekRange:'17/10 - 23/10' });
  t('pillbox-verify-session NE loggue PLUS rien (corrigé)', Object.keys(DB.rosterLogs).length===0, JSON.stringify(DB.rosterLogs));

  r = await callPost('pillbox-proxy.js', { token: ownerTok, action:'saveWeekHistory', weekKey:'2026-10-17', entry:{ processedAt: Date.now(), summary:{ totalPaye: 1000, paieEffectueePar:'Baptiste' } } });
  t('saveWeekHistory réussit', r.status===200, JSON.stringify(r));
  const logs = Object.values(DB.rosterLogs);
  t('Log "semaine_terminee_pillbox" créé APRÈS la sauvegarde réussie', logs.some(l=>l.action==='semaine_terminee_pillbox'), JSON.stringify(logs));
  const closureLog = logs.find(l=>l.action==='semaine_terminee_pillbox');
  t('Le log contient bien un weekKey structuré (point 21/12)', closureLog && closureLog.weekKey==='2026-10-17', JSON.stringify(closureLog));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis`);
  process.exit(failed?1:0);
})();
