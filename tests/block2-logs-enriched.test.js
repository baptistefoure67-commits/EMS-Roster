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
    rosterLogs: {},
    rosterLogsHiddenTrace: {},
    rosterPermissionsOverride: { DG:{delete_logs:true}, D:{} },
    rosterIndividualPermissions: {},
    payRulesConfig: { reaRate:14000, fixedSalaryByGrade:{}, bonusByRank:{"1":3000000,"2":2000000,"3":1000000}, ppaWeeklyCap:10000000, ppaEligibleGrades:[], updatedAt:0 },
    payRulesConfigHistory: {},
    rosterAbsences: {},
  };
}
fresh();

global.fetch = async (url, opts) => {
  const u = String(url);
  if(u.includes('identitytoolkit')) return { ok:true, status:200, json: async()=>({idToken:'fake-id-token'}) };
  const method = (opts && opts.method) || 'GET';
  const pathMatch = (branch) => u.match(new RegExp(branch+'(?:/([^/.?]+))?\\.json'));

  for(const branch of ['rosterLogsHiddenTrace','rosterLogs','rosterIndividualPermissions','payRulesConfig','payRulesConfigHistory','rosterAbsences','rosterPermissionsOverride']){
    const m = pathMatch(branch);
    if(!m) continue;
    const key = m[1] ? decodeURIComponent(m[1]) : null;
    if(method === 'GET'){
      if(branch==='rosterLogs' && !key && u.includes('orderBy')){
        return { ok:true, status:200, json: async()=>DB.rosterLogs };
      }
      return { ok:true, status:200, json: async()=> (key ? (DB[branch][key] ?? null) : DB[branch]) };
    }
    if(method === 'PUT'){
      const body = JSON.parse(opts.body);
      if(key) DB[branch][key] = body; else DB[branch] = body;
      return { ok:true, status:200, json: async()=>({}), text: async()=>'' };
    }
    if(method === 'DELETE'){
      if(key) delete DB[branch][key];
      return { ok:true, status:200, json: async()=>({}), text: async()=>'' };
    }
    if(method === 'PATCH'){
      const bodyPatch = JSON.parse(opts.body);
      DB[branch] = { ...(DB[branch]||{}), ...bodyPatch };
      return { ok:true, status:200, json: async()=>({}), text: async()=>'' };
    }
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
  const dgNoPermTok = sessionFor('DG','333333333333333333','AutreDG');
  const addTok = sessionFor('ADD','444444444444444444','UnADD');

  // ───── Suppression de logs : DG avec permission individuelle + trace cachée OWNER ─────
  fresh();
  DB.rosterIndividualPermissions['222222222222222222'] = { delete_logs: { CD:null, D:null, DG:true, OWNER:null } };
  DB.rosterLogs['log1'] = { action:'modification_employe', authorDiscordId:'999', authorName:'Quelqu’un', createdAt: Date.now(), details:'test' };

  let r = await callPost('get-logs.js', { token: dgTok, logKey: 'log1' });
  t('DG avec la permission individuelle peut supprimer un log', r.status===200 && !DB.rosterLogs.log1, JSON.stringify(r));
  const hiddenKeys = Object.keys(DB.rosterLogsHiddenTrace);
  t('Une trace cachée a été créée pour la suppression par le DG', hiddenKeys.length===1, JSON.stringify(DB.rosterLogsHiddenTrace));
  if(hiddenKeys.length){
    const trace = DB.rosterLogsHiddenTrace[hiddenKeys[0]];
    t('La trace cachée identifie bien le DG et le log supprimé', trace.deletedByLevel==='DG' && trace.deletedEntry.action==='modification_employe', JSON.stringify(trace));
  }
  r = await callGet('get-logs.js', { token: dgTok, hiddenTrace: '1' });
  t('Un DG ne peut PAS lire la trace cachée (même celui qui a supprimé)', r.status===403, JSON.stringify(r));
  r = await callGet('get-logs.js', { token: ownerTok, hiddenTrace: '1' });
  t('OWNER peut lire la trace cachée', r.status===200 && r.body.entries.length===1, JSON.stringify(r));

  // DG SANS la permission individuelle -> refusé
  fresh();
  DB.rosterLogs['log2'] = { action:'x', authorDiscordId:'999', createdAt: Date.now() };
  r = await callPost('get-logs.js', { token: dgNoPermTok, logKey: 'log2' });
  t('DG SANS la permission individuelle ne peut pas supprimer', r.status===403 && !!DB.rosterLogs.log2, JSON.stringify(r));

  // ADD (même avec vue logs) ne peut jamais supprimer, même avec la permission accordée par erreur
  fresh();
  DB.rosterIndividualPermissions['444444444444444444'] = { delete_logs: { CD:null, D:null, DG:null, OWNER:true } };
  DB.rosterLogs['log3'] = { action:'x', authorDiscordId:'999', createdAt: Date.now() };
  r = await callPost('get-logs.js', { token: addTok, logKey: 'log3' });
  t('Un ADD ne peut JAMAIS supprimer (réservé au grade OWNER/DG, même avec la permission)', r.status===403 && !!DB.rosterLogs.log3, JSON.stringify(r));

  // OWNER peut toujours
  fresh();
  DB.rosterLogs['log4'] = { action:'x', authorDiscordId:'999', createdAt: Date.now() };
  r = await callPost('get-logs.js', { token: ownerTok, logKey: 'log4' });
  t('OWNER peut toujours supprimer', r.status===200 && !DB.rosterLogs.log4, JSON.stringify(r));
  t('OWNER qui supprime lui-même -> AUCUNE trace cachée créée', Object.keys(DB.rosterLogsHiddenTrace).length===0, JSON.stringify(DB.rosterLogsHiddenTrace));

  // ───── Expiration 13 jours ─────
  fresh();
  const now = Date.now();
  const DAY = 24*60*60*1000;
  DB.rosterLogs['old'] = { action:'x', authorDiscordId:'1', createdAt: now - 14*DAY, details:'vieux' };
  DB.rosterLogs['recent'] = { action:'y', authorDiscordId:'1', createdAt: now - 2*DAY, details:'récent' };
  r = await callGet('get-logs.js', { token: addTok });
  t('Entrée de 14 jours absente du résultat', r.status===200 && !r.body.entries.some(e=>e.key==='old'), JSON.stringify(r.body.entries.map(e=>e.key)));
  t('Entrée de 2 jours bien présente', r.body.entries.some(e=>e.key==='recent'));
  await new Promise(res=>setTimeout(res, 50)); // laisse le nettoyage best-effort s'exécuter
  t('Entrée expirée réellement supprimée de la base ensuite', !DB.rosterLogs.old, JSON.stringify(Object.keys(DB.rosterLogs)));

  // ───── Absence longue détectée ─────
  fresh();
  const absToken = sessionFor('ADD','555555555555555555','Gestionnaire');
  r = await callPost('absences-actions.js', {
    token: absToken, action:'sync',
    qualifyingAbsences: [
      { employeeKey:'e1', name:'Courte', grade:'A', startIso:'2026-10-10', endIso:'2026-10-11', durationDays:1 },
      { employeeKey:'e2', name:'Longue', grade:'A', startIso:'2026-10-10', endIso:'2026-10-20', durationDays:10 },
    ],
  });
  t('Synchronisation absences OK', r.status===200, JSON.stringify(r));
  const logActions = Object.values(DB.rosterLogs).map(l=>l.action);
  t('Log "absences_synchronisees" créé', logActions.includes('absences_synchronisees'), JSON.stringify(logActions));
  t('Log dédié "absence_longue_detectee" créé (seulement pour la longue)', logActions.includes('absence_longue_detectee'), JSON.stringify(logActions));
  const longLog = Object.values(DB.rosterLogs).find(l=>l.action==='absence_longue_detectee');
  t('Le détail mentionne la bonne personne, pas la courte', longLog && /Longue/.test(longLog.details) && !/Courte/.test(longLog.details), JSON.stringify(longLog));

  // Aucune absence longue -> pas de log dédié
  fresh();
  r = await callPost('absences-actions.js', {
    token: absToken, action:'sync',
    qualifyingAbsences: [{ employeeKey:'e3', name:'Courte2', grade:'A', startIso:'2026-10-10', endIso:'2026-10-11', durationDays:1 }],
  });
  const logActions2 = Object.values(DB.rosterLogs).map(l=>l.action);
  t('Pas de log "absence_longue_detectee" si rien ne dépasse 3 jours', !logActions2.includes('absence_longue_detectee'), JSON.stringify(logActions2));

  // ───── Règles de paie groupées ─────
  fresh();
  const dTok = sessionFor('D','666666666666666666','Aaron');
  DB.rosterPermissionsOverride = { D:{manage_pay_rules:true} };
  r = await callPost('pay-rules-actions.js', { token: dTok, action:'setBatch', fields: { reaRate: 16000, ppaWeeklyCap: 12000000 } });
  t('setBatch règles de paie : 200', r.status===200, JSON.stringify(r));
  t('Les deux champs sont bien appliqués', DB.payRulesConfig.reaRate===16000 && DB.payRulesConfig.ppaWeeklyCap===12000000, JSON.stringify(DB.payRulesConfig));
  const payLogActions = Object.values(DB.rosterLogs).map(l=>l.action);
  t('UN SEUL log groupé (pas un par champ)', payLogActions.filter(a=>a.startsWith('regle')).length===1 && payLogActions.includes('regles_paie_modifiees_groupe'), JSON.stringify(payLogActions));
  t('Historique : une entrée PAR champ quand même (trace complète)', Object.keys(DB.payRulesConfigHistory).length===2, JSON.stringify(Object.keys(DB.payRulesConfigHistory)));

  // Un seul champ -> ancien comportement (log simple), pas "groupe"
  fresh();
  DB.rosterPermissionsOverride = { D:{manage_pay_rules:true} };
  r = await callPost('pay-rules-actions.js', { token: dTok, field:'reaRate', value:17000 });
  const singleLogActions = Object.values(DB.rosterLogs).map(l=>l.action);
  t('Un seul champ modifié -> log simple "regle_paie_modifiee" (pas groupe)', singleLogActions.includes('regle_paie_modifiee') && !singleLogActions.includes('regles_paie_modifiees_groupe'), JSON.stringify(singleLogActions));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis`);
  process.exit(failed?1:0);
})();
