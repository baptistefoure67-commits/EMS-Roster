const path = require('path'), crypto = require('crypto');
const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const { privateKey } = crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
process.env.SESSION_SECRET='s3cret'; process.env.FIREBASE_CLIENT_EMAIL='x@y.z'; process.env.FIREBASE_PRIVATE_KEY=privateKey; process.env.FIREBASE_WEB_API_KEY='k';
const { sign } = require(path.join(DIR,'session-token'));

let DB = {}; // store simulé, par URL path "rosterIndividualPermissions/<id>" etc.
const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

global.fetch = async (url, opts) => {
  const u = String(url);
  if(u.includes('identitytoolkit')) return { ok:true, status:200, json: async()=>({idToken:'fake-id-token'}) };
  if(u.includes('rosterPermissionsOverride')) return { ok:true, status:200, json: async()=>({ D:{manage_permissions:true}, DG:{manage_permissions:true}, CD:{manage_permissions:true} }) };
  if(u.includes('rosterIndividualPermissions')){
    const m = u.match(/rosterIndividualPermissions\/([^/.?]+)\.json/);
    const key = m ? decodeURIComponent(m[1]) : null;
    if(!opts || !opts.method || opts.method==='GET'){
      return { ok:true, status:200, json: async()=> (key ? (DB[key]||null) : DB) };
    }
    if(opts.method==='PUT'){
      DB[key] = JSON.parse(opts.body);
      return { ok:true, status:200, json: async()=>({}) , text: async()=>'' };
    }
  }
  if(u.includes('rosterLogs')) return { ok:true, status:200, json: async()=>({}), text: async()=>'' };
  return { ok:true, status:200, json: async()=>({}) };
};

function sessionFor(level, discordId, name){
  return sign({discordId, name, level, exp: Date.now()+7200000}, process.env.SESSION_SECRET);
}

async function call(token, bodyExtra){
  delete require.cache[require.resolve(path.join(DIR,'manage-individual-permissions.js'))];
  const { handler } = require(path.join(DIR,'manage-individual-permissions.js'));
  const res = await handler({ httpMethod:'POST', body: JSON.stringify({ token, ...bodyExtra }) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

(async()=>{
  const TARGET = '999000111';
  const ownerTok = sessionFor('OWNER','111111111111111111','Baptiste');
  const dgTok = sessionFor('DG','222222222222222222','Papy');
  const d1Tok = sessionFor('D','333333333333333333','Aaron');
  const d2Tok = sessionFor('D','444444444444444444','Tio');
  const cdTok = sessionFor('CD','555555555555555555','Moussa');

  // 1) D pose une protection D sur manage_absences
  let r = await call(d1Tok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:'D' });
  t('D pose 🔒D sur lui-même', r.status===200 && r.body.protection && r.body.protection.type==='D', JSON.stringify(r));

  // 2) D essaie de poser DG -> refusé
  r = await call(d1Tok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:'DG' });
  t('D ne peut pas créer 🔒DG', r.status===403, JSON.stringify(r));

  // 3) set direct refusé tant que protégé (même pour celui qui a posé la protection)
  r = await call(d1Tok, { action:'set', targetDiscordId:TARGET, permissionName:'manage_absences', value:true });
  t('set refusé tant que protégé (423)', r.status===423, JSON.stringify(r));

  // 4) CD ne peut PAS toucher une protection D (pas dans D/DG/OWNER)
  r = await call(cdTok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:null });
  t('CD ne peut pas toucher une protection D', r.status===403, JSON.stringify(r));

  // 5) un AUTRE D (pas l'auteur) peut retirer la protection D
  r = await call(d2Tok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_absences', protectionType:null });
  t('Un autre D peut retirer la protection D posée par le premier', r.status===200 && r.body.protection===null, JSON.stringify(r));

  // 6) maintenant set fonctionne (2e action, séparée)
  r = await call(d2Tok, { action:'set', targetDiscordId:TARGET, permissionName:'manage_absences', value:true });
  t('set fonctionne après retrait de la protection (2e action)', r.status===200, JSON.stringify(r));

  // 7) DG pose une protection DG, puis un D essaie de la remplacer par DG -> refusé, mais par D -> OK
  await call(dgTok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_pay_rules', protectionType:'DG' });
  r = await call(d1Tok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_pay_rules', protectionType:'DG' });
  t('D ne peut pas remplacer une protection DG par DG', r.status===403, JSON.stringify(r));
  r = await call(d1Tok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_pay_rules', protectionType:'D' });
  t('D peut intervenir sur une protection DG et la remplacer par D', r.status===200 && r.body.protection.type==='D', JSON.stringify(r));

  // 8) OWNER pose OWNER++ ; DG ne peut RIEN faire dessus
  await call(ownerTok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'view_logs', protectionType:'OWNER_PLUS' });
  r = await call(dgTok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'view_logs', protectionType:null });
  t('DG ne peut RIEN faire sur OWNER++', r.status===403, JSON.stringify(r));
  r = await call(ownerTok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'view_logs', protectionType:null });
  t('Seul OWNER peut retirer OWNER++', r.status===200 && r.body.protection===null, JSON.stringify(r));

  // 9) setBatch : plusieurs permissions en une fois, une protégée est ignorée (pas bloquante pour les autres)
  await call(ownerTok, { action:'setProtection', targetDiscordId:TARGET, permissionName:'manage_pay_weeks', protectionType:'OWNER' });
  r = await call(ownerTok, { action:'setBatch', targetDiscordId:TARGET, operations:[
    { permissionName:'reset_activite_streak', action:'set', value:true },
    { permissionName:'manage_roster_backup', action:'set', value:true },
    { permissionName:'manage_pay_weeks', action:'set', value:true }, // protégée -> doit être refusée
  ]});
  t('setBatch : 2 appliquées, 1 refusée (protégée)', r.status===200 && r.body.applied===2 && r.body.refused.length===1, JSON.stringify(r));

  // 10) l'ancien format sans protection continue de fonctionner (compat)
  DB['777000111'] = { manage_absences: { CD:null, D:true, DG:null, OWNER:null } }; // pas de champ "protection" du tout
  r = await call(ownerTok, { action:'set', targetDiscordId:'777000111', permissionName:'manage_absences', value:false });
  t('Permission sans "protection" (ancien format) reste modifiable normalement', r.status===200, JSON.stringify(r));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis`);
  process.exit(failed?1:0);
})();
