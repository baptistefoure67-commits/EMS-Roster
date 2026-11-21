'use strict';
// Authentification serveur Google OAuth2 pour les seules operations de journal.
// Ne jamais transmettre le jeton OAuth2, la cle ou les donnees du journal au navigateur.
const crypto=require('crypto');
const SCOPE='https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database';
const TOKEN_URL='https://oauth2.googleapis.com/token';
let cached=null,pending=null;
function b64(value){return Buffer.from(value).toString('base64url');}
function serviceAccount(env=process.env){
  let account=null;
  const rawB64=String(env.FIREBASE_SERVICE_ACCOUNT_B64||'').trim().replace(/\s+/g,'');
  const raw=rawB64?Buffer.from(rawB64.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'):String(env.FIREBASE_SERVICE_ACCOUNT_JSON||'').trim();
  if(raw){try{account=JSON.parse(raw);if(typeof account==='string')account=JSON.parse(account);}catch(_){throw new Error('Compte de service Firebase invalide dans Netlify');}}
  const clientEmail=String(account?.client_email||env.FIREBASE_CLIENT_EMAIL||'').trim();
  let privateKey=String(account?.private_key||env.FIREBASE_PRIVATE_KEY||'').trim();
  if(privateKey.startsWith('\"')&&privateKey.endsWith('\"')){try{privateKey=JSON.parse(privateKey);}catch(_){}}
  if(privateKey.startsWith("'")&&privateKey.endsWith("'"))privateKey=privateKey.slice(1,-1);
  privateKey=privateKey.replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n').replace(/\r/g,'\n');
  if(!clientEmail || !privateKey.includes('-----BEGIN PRIVATE KEY-----'))throw new Error('Compte de service Firebase manquant ou invalide dans Netlify');
  return {clientEmail,privateKey};
}
function assertion({clientEmail,privateKey},now=Math.floor(Date.now()/1000)){
  const input=b64(JSON.stringify({alg:'RS256',typ:'JWT'}))+'.'+b64(JSON.stringify({iss:clientEmail,scope:SCOPE,aud:TOKEN_URL,iat:now,exp:now+3600}));
  return input+'.'+crypto.sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');
}
async function accessToken(force=false){
  if(!force&&cached&&Date.now()<cached.validUntil)return cached.value;
  if(pending&&!force)return pending;
  const job=(async()=>{
    const jwt=assertion(serviceAccount());
    const response=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt}).toString()});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.access_token)throw new Error(`Authentification Google du journal refusée (${response.status})`);
    const validSeconds=Math.max(60,Math.min(3300,Number(data.expires_in)||3600)-120);
    cached={value:data.access_token,validUntil:Date.now()+validSeconds*1000};
    return cached.value;
  })();
  pending=job;
  try{return await job;}finally{if(pending===job)pending=null;}
}
async function firebaseAdminFetch(url,options={}){
  for(let attempt=0;attempt<2;attempt++){
    const token=await accessToken(attempt===1);
    const headers={...(options.headers||{}),Authorization:`Bearer ${token}`};
    const response=await fetch(url,{...options,headers});
    if(response.status!==401 || attempt===1)return response;
    cached=null;
  }
}
module.exports={firebaseAdminFetch,accessToken,serviceAccount,assertion};
