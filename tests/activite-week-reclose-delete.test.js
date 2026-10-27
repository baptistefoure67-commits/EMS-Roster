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
    rosterActiviteWeekHistory: { '2026-10-22': { formateur: { closedAt: 1, before:{}, after:{}, reopened: true } } },
    rosterActiviteWeekHistoryArchive: {},
    rosterIndividualPermissions: {},
    rosterPermissionsOverride: { CD:{} },
    rosterLogs: {},
  };
}
fresh();

global.fetch = async (url, opts) => {
  const u = String(url);
  if(u.includes('identitytoolkit')) return { ok:true, status:200, json: async()=>({idToken:'fake-id-token'}) };
  const method = (opts && opts.method) || 'GET';
  for(const branch of ['rosterActiviteWeekHistoryArchive','rosterActiviteWeekHistory','rosterIndividualPermissions','rosterPermissionsOverride','rosterLogs']){
    const re = new RegExp(branch+'(?:/([^?]+))?\\.json');
    const m = u.match(re);
    if(!m) continue;
    const key = m[1] ? decodeURIComponent(m[1]) : null;
    if(method === 'GET'){
      let val = key ? key.split('/').reduce((o,k)=>o&&o[k], DB[branch]) : DB[branch];
      return { ok:true, status:200, headers:{get:(h)=> h.toLowerCase()==='etag' ? 'W/"abc123"' : null}, json: async()=> (val===undefined?null:val) };
    }
    if(method === 'PUT'){
      const b = JSON.parse(opts.body);
      if(key){ const parts = key.split('/'); let o = DB[branch]; for(let i=0;i<parts.length-1;i++){ o[parts[i]]=o[parts[i]]||{}; o=o[parts[i]]; } o[parts[parts.length-1]] = b; } else DB[branch]=b;
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({}), text: async()=>'' };
    }
    if(method === 'PATCH'){
      const b = JSON.parse(opts.body);
      const parts = key.split('/'); let o = DB[branch]; for(let i=0;i<parts.length-1;i++){ o[parts[i]]=o[parts[i]]||{}; o=o[parts[i]]; }
      o[parts[parts.length-1]] = { ...(o[parts[parts.length-1]]||{}), ...b };
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({}), text: async()=>'' };
    }
    if(method === 'DELETE'){
      const parts = key.split('/'); let o = DB[branch]; for(let i=0;i<parts.length-1;i++){ o=o&&o[parts[i]]; }
      if(o) delete o[parts[parts.length-1]];
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({}), text: async()=>'' };
    }
  }
  return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({}) };
};

function freshHandler(file){ delete require.cache[require.resolve(path.join(DIR,file))]; return require(path.join(DIR,file)).handler; }
async function callPost(file, bodyExtra){
  const handler = freshHandler(file);
  const res = await handler({ httpMethod:'POST', body: JSON.stringify(bodyExtra) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

(async()=>{
  const cdTok = sessionFor('CD','111111111111111111','Aaron');

  // ───── Refermer ─────
  fresh();
  let r = await callPost('roster-week-reopen.js', { token: cdTok, weekKey:'2026-10-22', scope:'formateur', action:'reclose' });
  t('Refermer une semaine réouverte réussit', r.status===200, JSON.stringify(r));
  t('reopened repasse bien à false', DB.rosterActiviteWeekHistory['2026-10-22'].formateur.reopened===false, JSON.stringify(DB.rosterActiviteWeekHistory));

  // Refermer une semaine qui n'est PAS réouverte -> refusé proprement
  fresh();
  DB.rosterActiviteWeekHistory['2026-10-22'].formateur.reopened = false;
  r = await callPost('roster-week-reopen.js', { token: cdTok, weekKey:'2026-10-22', scope:'formateur', action:'reclose' });
  t('Refermer une semaine déjà fermée est refusé (409)', r.status===409, JSON.stringify(r));

  // reopen normal (sans action, ou action='reopen') continue de fonctionner comme avant
  fresh();
  DB.rosterActiviteWeekHistory['2026-10-22'].formateur.reopened = false;
  r = await callPost('roster-week-reopen.js', { token: cdTok, weekKey:'2026-10-22', scope:'formateur' });
  t('Réouverture normale (sans action) fonctionne toujours', r.status===200, JSON.stringify(r));

  // ───── Supprimer ─────
  fresh();
  r = await callPost('activite-week-delete.js', { token: cdTok, weekKey:'2026-10-22', scope:'formateur' });
  t('Suppression réussit', r.status===200, JSON.stringify(r));
  // (le mock ne reproduit pas l'auto-élagage Firebase des nœuds vides — en
  // vrai, 2026-10-22 disparaîtrait entièrement ; ici on vérifie juste que
  // la clé "formateur" elle-même a bien disparu, ce qui est garanti dans
  // les deux cas.)
  t('Entrée "formateur" retirée de rosterActiviteWeekHistory', !(DB.rosterActiviteWeekHistory['2026-10-22']||{}).formateur, JSON.stringify(DB.rosterActiviteWeekHistory));
  const archiveKeys = Object.keys(DB.rosterActiviteWeekHistoryArchive['2026-10-22-formateur']||{});
  t('Mais archivée avant suppression (rien perdu)', archiveKeys.length===1, JSON.stringify(DB.rosterActiviteWeekHistoryArchive));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis`);
  process.exit(failed?1:0);
})();
