// Vérifie que le Mode Troll du Roster accepte désormais les GIF dans
// le créneau "image" (01/11, demandé après l'ajout du GIF côté Gain de
// Temps) — upload réel en morceaux, lecture par le vrai destinataire,
// octets identiques à l'original une fois reconstruits.
const path = require('path'), crypto = require('crypto'), fs = require('fs');
const assert = require('assert');
const DIR = path.join(__dirname, '..', 'netlify', 'functions');

const { privateKey } = crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
process.env.SESSION_SECRET='s3cret-troll-gif-test'; process.env.FIREBASE_CLIENT_EMAIL='x@y.z'; process.env.FIREBASE_PRIVATE_KEY=privateKey; process.env.FIREBASE_WEB_API_KEY='k';
const { sign } = require(path.join(DIR,'session-token'));

const results=[]; let failed=0;
const t=(name,cond,extra='')=>{ if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

const OWNER_ID='861557966083850250'; // isTrollAdmin reconnait cet ID exact (voir permissions.js)
const TARGET_ID='701698983466106903';
function sessionFor(discordId,level='OWNER'){ return sign({discordId, name:'Test', level, exp: Date.now()+7200000}, process.env.SESSION_SECRET); }

let DB;
function freshDB(){ DB={ trollJokes:{}, trollMedia:{} }; }
freshDB();
function setDeep(fullPath, value){
  const parts=fullPath.split('/'); const branch=parts[0];
  if(parts.length===1){ DB[branch]=value; return; }
  DB[branch]=DB[branch]||{}; let o=DB[branch];
  for(let i=1;i<parts.length-1;i++){ o[parts[i]]=o[parts[i]]||{}; o=o[parts[i]]; }
  o[parts[parts.length-1]]=value;
}
global.fetch=async(url,opts)=>{
  const u=String(url);
  if(u.includes('identitytoolkit')) return { ok:true, status:200, json: async()=>({idToken:'fake-id-token'}) };
  const method=(opts&&opts.method)||'GET';
  const m=u.match(/\/([a-zA-Z]+(?:\/[^.?]*)?)\.json/);
  const fullPath=m?m[1]:''; const branch=fullPath.split('/')[0];
  if(!(branch in DB)) DB[branch]={};
  if(method==='GET'){
    const parts=fullPath.split('/'); let o=DB[branch];
    for(let i=1;i<parts.length && o!=null;i++) o=o[parts[i]];
    return { ok:true, status:200, headers:{get:(h)=>null}, json: async()=> (parts.length===1?DB[branch]:(o===undefined?null:o)) };
  }
  if(method==='PUT'){
    const b=JSON.parse(opts.body);
    const etagHeader=opts.headers && opts.headers['if-match'];
    if(etagHeader){ return { ok:true, status:200, json: async()=>b }; } // pas de test de conflit ici, juste le flux normal
    setDeep(fullPath,b); return { ok:true, status:200, json: async()=>b };
  }
  return { ok:true, status:200, json: async()=>null };
};

delete require.cache[require.resolve(path.join(DIR,'troll-actions.js'))];
const handler=require(path.join(DIR,'troll-actions.js')).handler;
async function call(discordId, action, extra={}, level='OWNER'){
  const res=await handler({ httpMethod:'POST', body: JSON.stringify({ token: sessionFor(discordId,level), action, ...extra }) });
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

async function run(){
  freshDB();
  const gifBytes=fs.readFileSync('/tmp/test_animated.gif');
  t('fichier de test disponible', gifBytes.length>0, 'GIF de test introuvable');

  let save=await call(OWNER_ID,'save',{joke:{name:'Test GIF',targetDiscordId:TARGET_ID,targetName:'Cible',apps:{roster:true,pillbox:false},text:'un GIF',clickSound:false}});
  t('creation de la blague', save.data.ok===true, JSON.stringify(save.data));
  const jokeId=save.data.joke.id;

  const CHUNK=3*1024*1024;
  const total=Math.ceil(gifBytes.length/CHUNK);
  const uploadId='gifupl0ad1';
  for(let i=0;i<total;i++){
    const slice=gifBytes.slice(i*CHUNK,(i+1)*CHUNK);
    const up=await call(OWNER_ID,'uploadChunk',{id:jokeId, kind:'image', uploadId, index:i, total, size:gifBytes.length, mime:'image/gif', data:slice.toString('base64')});
    t(`uploadChunk ${i+1}/${total} accepte`, up.status===200, JSON.stringify(up));
  }
  const fin=await call(OWNER_ID,'finalizeMedia',{id:jokeId, kind:'image', uploadId, name:'anim.gif', mime:'image/gif', size:gifBytes.length});
  t('finalizeMedia accepte le GIF', fin.status===200 && fin.data.ok===true, JSON.stringify(fin));

  // Le destinataire recupere le morceau comme le ferait trollFetchMedia
  const chunk=await call(TARGET_ID,'mediaChunk',{id:jokeId, kind:'image', index:0});
  t('le vrai destinataire peut lire le morceau du GIF', chunk.status===200 && typeof chunk.data.data==='string', JSON.stringify(chunk));
  if(chunk.status===200){
    const rebuilt=Buffer.from(chunk.data.data,'base64');
    t('octets reconstruits identiques au GIF original', rebuilt.equals(gifBytes));
    t('le mime renvoye est bien image/gif', chunk.data.mime==='image/gif', chunk.data.mime);
  }

  // Un faux PNG dont le contenu est en realite du texte -> refuse (securite deja en place, non-regression)
  const fakeId=save.data.joke ? (await call(OWNER_ID,'save',{joke:{name:'Test2',targetDiscordId:TARGET_ID,targetName:'Cible',apps:{roster:true,pillbox:false},text:'x',clickSound:false}})).data.joke.id : null;
  const badUpload=await call(OWNER_ID,'uploadChunk',{id:fakeId, kind:'image', uploadId:'badup123', index:0, total:1, size:20, mime:'image/gif', data:Buffer.from('ceci nest pas un gif').toString('base64')});
  t('un faux GIF (mauvaise signature) est toujours refuse', badUpload.status===400, JSON.stringify(badUpload));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} reussis.`);
  if(failed) process.exit(1);
}
run().catch(e=>{ console.error('ERREUR INATTENDUE', e); process.exit(1); });
