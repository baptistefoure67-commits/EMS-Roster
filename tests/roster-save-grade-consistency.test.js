// Vérifie que la restriction "changement de grade réservé à D et
// au-dessus" s'applique de façon cohérente aux DEUX chemins qui
// peuvent modifier un employé : la fiche individuelle (editEmployee)
// ET la sauvegarde groupée (replaceRosterSnapshot, utilisée après un
// collage du tableau EMS). Avant le 01/11, seule la fiche individuelle
// vérifiait ça — un ADD/CD pouvait donc changer n'importe quel grade
// simplement en passant par "Sauvegarder" à la place de "Modifier".
const path = require('path'), crypto = require('crypto');
const assert = require('assert');
const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const { privateKey } = crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
process.env.SESSION_SECRET='s3cret-grade-consistency'; process.env.FIREBASE_CLIENT_EMAIL='x@y.z'; process.env.FIREBASE_PRIVATE_KEY=privateKey; process.env.FIREBASE_WEB_API_KEY='k';
const { sign } = require(path.join(DIR,'session-token'));
function sessionFor(level){ return sign({discordId:'1', name:'Test', level, exp: Date.now()+7200000}, process.env.SESSION_SECRET); }

const results=[]; let failed=0;
const t=(name,cond,extra='')=>{ if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

const EMPLOYEES=[{id:'e1', name:'Peter Nox', discordId:'20', idUnique:'265476', grade:'STG', licencie:false}];
let DB;
function freshDB(){ DB = { rosterEmsData: { employees: JSON.parse(JSON.stringify(EMPLOYEES)), savedAt: 1 } }; }
freshDB();
global.fetch = async (url, opts) => {
  const u=String(url);
  if(u.includes('identitytoolkit')) return { ok:true, status:200, json: async()=>({idToken:'fake'}) };
  const method=(opts&&opts.method)||'GET';
  if(u.includes('rosterEmsData')){
    if(method==='GET') return { ok:true, status:200, headers:{get:()=>'W/"etag1"'}, json: async()=>DB.rosterEmsData };
    if(method==='PUT'){ DB.rosterEmsData=JSON.parse(opts.body); return { ok:true, status:200, json: async()=>DB.rosterEmsData }; }
  }
  if(u.includes('rosterLogs')) return { ok:true, status:200, json: async()=>({name:'x'}) };
  return { ok:true, status:200, json: async()=>null };
};
delete require.cache[require.resolve(path.join(DIR,'protected-write.js'))];
const handler = require(path.join(DIR,'protected-write.js')).handler;
async function call(level, action, payload){
  const res = await handler({ httpMethod:'POST', body: JSON.stringify({ token: sessionFor(level), action, payload }) });
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

async function run(){
  freshDB();
  let r1=await call('ADD','editEmployee',{ id:'e1', grade:'A' });
  t('editEmployee : ADD refusé pour un changement de grade', r1.status===403, JSON.stringify(r1));

  freshDB();
  let r2=await call('ADD','replaceRosterSnapshot',{ employees:[{...EMPLOYEES[0], grade:'A'}], expectedSavedAt:1 });
  t('replaceRosterSnapshot : ADD refusé pour le même changement de grade (cohérence)', r2.status===403, JSON.stringify(r2));

  freshDB();
  let r3=await call('D','replaceRosterSnapshot',{ employees:[{...EMPLOYEES[0], grade:'A'}], expectedSavedAt:1 });
  t('replaceRosterSnapshot : D autorisé à changer un grade', r3.status===200, JSON.stringify(r3));

  freshDB();
  let r4=await call('ADD','replaceRosterSnapshot',{ employees:[{...EMPLOYEES[0], name:'Peter Nox Jr'}], expectedSavedAt:1 });
  t('replaceRosterSnapshot : ADD toujours autorisé sans toucher au grade', r4.status===200 && r4.data.employees[0].name==='Peter Nox Jr', JSON.stringify(r4));

  freshDB();
  let r5=await call('ADD','replaceRosterSnapshot',{ employees:[{...EMPLOYEES[0], grade:'STG'}], expectedSavedAt:1 });
  t('replaceRosterSnapshot : grade identique (pas un vrai changement) toujours autorisé pour ADD', r5.status===200, JSON.stringify(r5));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis.`);
  if(failed) process.exit(1);
}
run().catch(e=>{ console.error('ERREUR INATTENDUE', e); process.exit(1); });
