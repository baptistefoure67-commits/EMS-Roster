const fs=require('fs');
const vm=require('vm');
const path=require('path');
const assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function extractAsync(name){
  const marker=`async function ${name}`;
  const start=html.indexOf(marker); assert(start>=0,`${name} introuvable`);
  const open=html.indexOf('{',start); let d=0,q=null,esc=false,line=false,block=false;
  for(let i=open;i<html.length;i++){
    const c=html[i],n=html[i+1];
    if(line){if(c==='\n')line=false;continue}
    if(block){if(c==='*'&&n==='/'){block=false;i++}continue}
    if(q){if(esc){esc=false;continue}if(c==='\\'){esc=true;continue}if(c===q)q=null;continue}
    if(c==='/'&&n==='/'){line=true;i++;continue}
    if(c==='/'&&n==='*'){block=true;i++;continue}
    if(c==='"'||c==="'"||c==='`'){q=c;continue}
    if(c==='{')d++; else if(c==='}'&&--d===0)return html.slice(start,i+1);
  }
  throw new Error('fin fonction introuvable');
}
const fnSrc=extractAsync('saveActiviteToCloud');
async function make(overrides={}){
  const events=[];
  const ctx={
    currentSessionToken:'session-ok', activiteData:{}, activiteStreak:{},
    toast:m=>events.push(['toast',m]), showGate:m=>events.push(['gate',m]),
    saveActiviteData:()=>events.push(['saveData']), saveActiviteStreak:()=>events.push(['saveStreak']),
    fetch:async()=>({ok:true,status:200,statusText:'OK',json:async()=>({data:{},streak:{}})}),
    console, AbortController, ...overrides
  };
  vm.createContext(ctx); vm.runInContext(fnSrc,ctx);
  return {ctx,events};
}
(async()=>{
  let ok=0,fail=0; const t=async(n,f)=>{try{await f();console.log('✅',n);ok++;}catch(e){console.error('❌',n,'—',e.message);fail++;}};
  await t('Succès activité résout normalement', async()=>{const {ctx}=await make();const r=await ctx.saveActiviteToCloud('formateur');assert(r&&typeof r==='object')});
  await t('Erreur HTTP activité est propagée au caller', async()=>{const {ctx,events}=await make({fetch:async()=>({ok:false,status:500,statusText:'Server Error',json:async()=>({error:'Firebase indisponible'})})});let err;try{await ctx.saveActiviteToCloud('formateur')}catch(e){err=e}assert(err);assert.match(err.message,/Firebase indisponible/);assert(events.some(x=>x[0]==='toast'&&String(x[1]).includes('Échec')))});
  await t('Session expirée rejette au lieu de réussir silencieusement', async()=>{const {ctx,events}=await make({currentSessionToken:''});let err;try{await ctx.saveActiviteToCloud('psychologue')}catch(e){err=e}assert(err);assert.match(err.message,/Session Discord expirée/);assert(events.some(x=>x[0]==='gate'))});
  await t('Synchronisation Formation/Psychologie entoure les appels par try/catch', async()=>{assert(html.includes('try{ await saveActiviteToCloud("formateur"); done.push("Formation")'));assert(html.includes('catch(err){ failed.push(`Formation (${err.message})`)'));assert(html.includes('try{ await saveActiviteToCloud("psychologue"); done.push("Psychologie")'));assert(html.includes('catch(err){ failed.push(`Psychologie (${err.message})`)'))});
  console.log(`\nRésultat propagation activité : ${ok} réussi(s), ${fail} échec(s).`); if(fail)process.exit(1);
})();
