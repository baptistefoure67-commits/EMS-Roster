// Suite dédiée au cahier des charges "Importer les activités Discord" :
// recrutements, anti-doublon réel (pas juste le compteur), concurrence
// serveur, formats de date, noms imparfaits/ambigus. Complète (ne
// remplace pas) formation-discord-import.test.js, qui couvre déjà le
// parseur Markdown/accents/types de formation existants.
const path = require('path'), crypto = require('crypto');
const assert = require('assert');
const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const { privateKey } = crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
process.env.SESSION_SECRET='s3cret-recrutement-test'; process.env.FIREBASE_CLIENT_EMAIL='x@y.z'; process.env.FIREBASE_PRIVATE_KEY=privateKey; process.env.FIREBASE_WEB_API_KEY='k';
const { sign } = require(path.join(DIR,'session-token'));

const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };
function sessionFor(level='OWNER'){ return sign({discordId:'owner-1', name:'Test Owner', level, exp: Date.now()+7200000}, process.env.SESSION_SECRET); }

const EMPLOYEES = [
  {id:'1', name:'Baptiste Fore', discordId:'861557966083850250', grade:'ADD', licencie:false},
  {id:'2', name:'Fatima Babidi', discordId:'10', idUnique:'100', grade:'A', licencie:false},
  {id:'3', name:'Kelly Guzman', discordId:'11', idUnique:'101', grade:'A', licencie:false},
  {id:'4', name:'John Smith', discordId:'12', idUnique:'102', grade:'A', licencie:false},
  {id:'5', name:'Djam Mas', discordId:'20', grade:'RF', licencie:false}, // formateur reconnu MF/RF -> credite le suivi hebdo
];

// --- Mock Firebase minimal, avec ETag/if-match (même esprit que les
// autres suites de ce projet) et support du PATCH multi-emplacements à
// la racine (clés en "branche/sousClé") utilisé par formation-import.js
// pour écrire l'historique sans jamais remplacer tout le nœud. ---
let DB, versions;
function freshDB(){
  DB = {
    rosterEmsData: { employees: EMPLOYEES, savedAt: 1 },
    rosterFormationExperience: {},
    activiteSuivi: { data: {}, savedAt: 1 },
    rosterEmsSpecialSelection: { selectedEmployees: [], savedAt: 1 },
    formationOperationList: { text: '', savedAt: 1 },
    rosterLogs: {},
  };
  versions = { rosterFormationExperience: 1, activiteSuivi: 1, rosterEmsSpecialSelection: 1, formationOperationList: 1 };
}
freshDB();
function etagFor(branch){ return `W/"v${versions[branch]||1}"`; }
function setDeep(key, value){
  // key du style "rosterFormationExperience/<fingerprint>" ou juste "activiteSuivi"
  const parts = key.split('/');
  const branch = parts[0];
  if(parts.length===1){ DB[branch]=value; versions[branch]=(versions[branch]||1)+1; return; }
  DB[branch] = DB[branch] || {};
  let o = DB[branch];
  for(let i=1;i<parts.length-1;i++){ o[parts[i]]=o[parts[i]]||{}; o=o[parts[i]]; }
  o[parts[parts.length-1]] = value;
  versions[branch]=(versions[branch]||1)+1;
}
global.fetch = async (url, opts) => {
  const u = String(url);
  if(u.includes('identitytoolkit')) return { ok:true, status:200, json: async()=>({idToken:'fake-id-token'}) };
  const method = (opts && opts.method) || 'GET';
  // Racine ".json" : PATCH multi-emplacements (historique, opération)
  if(/\/\.json(\?|$)/.test(u)){
    if(method==='PATCH'){
      const b = JSON.parse(opts.body);
      for(const [k,v] of Object.entries(b)) setDeep(k,v);
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({}), text: async()=>'' };
    }
  }
  for(const branch of Object.keys(DB).concat(['rosterLogs'])){
    const re = new RegExp(branch+'\\.json');
    if(!re.test(u)) continue;
    if(method==='GET'){
      return { ok:true, status:200, headers:{get:(h)=> h.toLowerCase()==='etag' ? etagFor(branch) : null}, json: async()=> DB[branch] };
    }
    if(method==='PUT'){
      const etagHeader = opts.headers && opts.headers['if-match'];
      if(etagHeader && etagHeader !== etagFor(branch)){
        return { ok:false, status:412, headers:{get:()=>null}, json: async()=>({error:'precondition failed'}), text: async()=>'precondition failed' };
      }
      const b = JSON.parse(opts.body);
      DB[branch] = b; versions[branch]=(versions[branch]||1)+1;
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=> b, text: async()=>'' };
    }
    if(method==='POST'){
      return { ok:true, status:200, headers:{get:()=>null}, json: async()=>({name:'x'+Math.random()}), text: async()=>'' };
    }
  }
  return { ok:true, status:200, headers:{get:()=>null}, json: async()=>null, text: async()=>'' };
};

delete require.cache[require.resolve(path.join(DIR,'formation-import.js'))];
const handler = require(path.join(DIR,'formation-import.js')).handler;

async function call(action, text){
  const res = await handler({ httpMethod:'POST', body: JSON.stringify({ token: sessionFor(), action, text }) });
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

async function run(){
  // ===== Test 1 : l'exemple réel du cahier des charges =====
  freshDB();
  const sample1 = `[ADD] Baptiste Fore\n17:43\n\n@[A] Fatima Babidi Formation Opération Validée :T_CK:\n@[A] Kelly Guzman Formation Opération Validée :T_CK:\n@[A] John Smith Formation Opération Validée :T_CK:`;
  let r = await call('commit', sample1);
  t('Test 1 — premier import : 3 détectées, 3 nouvelles', r.data.summary.detected===3 && r.data.imported===3, JSON.stringify(r.data.summary));
  r = await call('commit', sample1);
  t('Test 1 — recollé : 3 détectées, 0 nouvelle, 3 doublons, rien importé', r.data.summary.detected===3 && r.data.summary.duplicates===3 && r.data.imported===0, JSON.stringify(r.data.summary));

  // ===== Test 2 : nouveau recrutement =====
  freshDB();
  const recrut1 = `[ADD] Baptiste Fore — 17:43\n@[A] Fatima Babidi Recrutement Validé`;
  r = await call('commit', recrut1);
  t('Test 2 — nouveau recrutement : +1 exactement', r.data.imported===1 && r.data.summary.recruitments===1, JSON.stringify(r.data));
  let activity = DB.activiteSuivi.data['name:djam mas'] || DB.activiteSuivi.data['id:'+EMPLOYEES[4].idUnique];
  // Baptiste Fore est ADD (pas MF/RF) dans ce test -> pas de crédit hebdo pour LUI ;
  // on refait le test avec un formateur RF pour vérifier le crédit réel ci-dessous.

  // ===== Test 2bis : recrutement crédite bien le compteur d'un RF =====
  freshDB();
  const recrutRF = `[RF] Djam Mas — 17:43\n@[A] Fatima Babidi Recrutement Validé`;
  r = await call('commit', recrutRF);
  const key5 = 'name:djam mas';
  t('Test 2bis — RF recruteur : recrutements 0 → 1', (DB.activiteSuivi.data[key5]||{}).recrutements===1, JSON.stringify(DB.activiteSuivi.data));

  // ===== Test 3 : le même recrutement recollé ne change rien =====
  r = await call('commit', recrutRF);
  t('Test 3 — recrutement déjà importé recollé : 0 nouvelle, compteur inchangé', r.data.imported===0 && (DB.activiteSuivi.data[key5]||{}).recrutements===1, JSON.stringify(r.data));

  // ===== Test 4 : deux recrutements différents comptent deux fois =====
  const recrutRF2 = `[RF] Djam Mas — 17:44\n@[A] Kelly Guzman Recrutement Validé`;
  r = await call('commit', recrutRF2);
  t('Test 4 — deuxième recrutement différent : recrutements 1 → 2', (DB.activiteSuivi.data[key5]||{}).recrutements===2, JSON.stringify(DB.activiteSuivi.data));

  // ===== Test 5 : plusieurs lignes dans un même message =====
  freshDB();
  r = await call('preview', sample1);
  t('Test 5 — 3 lignes détectées dans un seul message', r.data.summary.detected===3, JSON.stringify(r.data.summary));
  t('Test 5 — les 3 personnes sont identifiées', r.data.records.every(x=>x.trainee&&['Fatima Babidi','Kelly Guzman','John Smith'].includes(x.trainee.name)), JSON.stringify(r.data.records.map(x=>x.trainee)));

  // ===== Test 6 : heure seule =====
  freshDB();
  const heureSeule = `[ADD] Baptiste Fore\n17:43\n\n@[A] Fatima Babidi Formation Opération Validée`;
  r = await call('preview', heureSeule);
  t('Test 6 — heure seule reconnue (1 détectée, formateur = Baptiste Fore)', r.data.summary.detected===1 && r.data.records[0].trainerName==='Baptiste Fore', JSON.stringify(r.data.records));

  // ===== Test 7 : "Aujourd'hui à HH:MM" =====
  const aujourdhui = `[ADD] Baptiste Fore — Aujourd'hui à 17:43\n@[A] Fatima Babidi Formation Opération Validée`;
  r = await call('preview', aujourdhui);
  t("Test 7 — Aujourd'hui à HH:MM reconnu", r.data.summary.detected===1, JSON.stringify(r.data.summary));

  // ===== Test 8 : "Hier à HH:MM" calcule la bonne date =====
  const hierMsg = `[ADD] Baptiste Fore — Hier à 22:40\n@[A] Fatima Babidi Formation Opération Validée`;
  r = await call('preview', hierMsg);
  const occurredAt = r.data.records[0].occurredAt;
  const expectedYesterday = new Date(); expectedYesterday.setDate(expectedYesterday.getDate()-1);
  const got = new Date(occurredAt);
  t('Test 8 — "Hier à HH:MM" retombe bien la veille', got.getDate()===expectedYesterday.getDate() && got.getHours()===22 && got.getMinutes()===40, JSON.stringify({got:got.toISOString(), expectedDate:expectedYesterday.getDate()}));

  // ===== Test 9 : nom légèrement imparfait, non ambigu =====
  freshDB();
  const typoMsg = `[ADD] Baptiste Fore — 17:43\n@[A] Jhon Smit Formation Opération Validée`;
  r = await call('preview', typoMsg);
  t('Test 9 — petite variante de nom reconnue (pas ambiguë)', r.data.records[0].trainee && r.data.records[0].trainee.name==='John Smith', JSON.stringify(r.data.records[0]));

  // ===== Test 10 : ambiguïté jamais résolue au hasard =====
  const employeesAmbigus = [...EMPLOYEES, {id:'6', name:'Jhon Smith', discordId:'13', grade:'A', licencie:false}];
  DB.rosterEmsData = { employees: employeesAmbigus, savedAt: 1 };
  r = await call('preview', typoMsg);
  t('Test 10 — avec un homonyme proche en plus, jamais deviné', !r.data.records[0].trainee, JSON.stringify(r.data.records[0]));
  t('Test 10 — l ambiguite est explicitement signalée', r.data.records[0].traineeAmbiguous===true, JSON.stringify(r.data.records[0]));

  // ===== Test 11 : concurrence serveur — deux imports simultanés du MÊME événement ne comptent qu'une fois =====
  freshDB();
  const soloRecrut = `[RF] Djam Mas — 17:43\n@[A] Fatima Babidi Recrutement Validé`;
  const [ra, rb] = await Promise.all([call('commit', soloRecrut), call('commit', soloRecrut)]);
  const totalImported = (ra.data.imported||0) + (rb.data.imported||0);
  t('Test 11 — deux imports simultanés du même événement : une seule écriture compte', totalImported===1, JSON.stringify({a:ra.data.imported,b:rb.data.imported}));
  t('Test 11 — le compteur final vaut bien 1, pas 2 ni 0', (DB.activiteSuivi.data['name:djam mas']||{}).recrutements===1, JSON.stringify(DB.activiteSuivi.data));

  // ===== Test 11bis : deux événements DIFFÉRENTS simultanés comptent tous les deux (pas de perte) =====
  freshDB();
  const evtA = `[RF] Djam Mas — 17:43\n@[A] Fatima Babidi Recrutement Validé`;
  const evtB = `[RF] Djam Mas — 17:44\n@[A] Kelly Guzman Recrutement Validé`;
  const [rc, rd] = await Promise.all([call('commit', evtA), call('commit', evtB)]);
  t('Test 11bis — deux événements différents en parallèle : les deux sont importés', rc.data.imported===1 && rd.data.imported===1, JSON.stringify({c:rc.data,d:rd.data}));
  t('Test 11bis — le compteur final vaut 2 (aucun incrément perdu)', (DB.activiteSuivi.data['name:djam mas']||{}).recrutements===2, JSON.stringify(DB.activiteSuivi.data));

  // ===== Test 12 : non-régression — les anciens types de formation marchent toujours =====
  freshDB();
  const mup = `[CD] Aaron Stopenski — 11/10/2026 17:08\n@[M] Pablo Akada Formation MUP Validée`;
  const employeesWithPablo = [...EMPLOYEES, {id:'7', name:'Aaron Stopenski', discordId:'99', grade:'CD', licencie:false}, {id:'8', name:'Pablo Akada', discordId:'98', grade:'M', licencie:false}];
  DB.rosterEmsData = { employees: employeesWithPablo, savedAt: 1 };
  r = await call('preview', mup);
  t('Test 12 — Formation MUP toujours reconnue (non-régression)', r.data.records[0] && r.data.records[0].type==='mup', JSON.stringify(r.data.records[0]));
  const copilote = `[CD] Aaron Stopenski — 11/10/2026 17:08\n@[M] Pablo Akada Formation Co-Pilote Validée`;
  r = await call('preview', copilote);
  t('Test 12 — Formation Co-Pilote toujours reconnue (non-régression)', r.data.records[0] && r.data.records[0].type==='copilote', JSON.stringify(r.data.records[0]));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis.`);
  if(failed) process.exit(1);
}
run().catch(e=>{ console.error('ERREUR INATTENDUE', e); process.exit(1); });
