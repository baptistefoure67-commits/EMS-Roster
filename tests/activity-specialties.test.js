const fs=require('fs');
const vm=require('vm');
const path=require('path');
let ok=0, fail=0;
function test(name,fn){try{fn();console.log('✅',name);ok++;}catch(e){console.error('❌',name,'—',e.message);fail++;}}

const actions=require('../netlify/functions/activite-actions.js')._test;
const close=require('../netlify/functions/activite-close.js');
const employees=[
 {name:'Leyah Akada',grade:'MC',idUnique:'1'},
 {name:'William Bradford',grade:'MF',idUnique:'2'},
 {name:'Ava Stopenski',grade:'MP',idUnique:'3'},
 {name:'Eve Gunther',grade:'MP',idUnique:'4'},
 {name:'Evan Miller',grade:'M',idUnique:'5'},
 {name:'Yanisse Doumbia',grade:'M',idUnique:'6'},
 {name:'Djam Mas',grade:'RF',idUnique:'7'},
 {name:'Leto Mendez',grade:'RF',idUnique:'8'},
 {name:'Ancien Licencie',grade:'MF',idUnique:'9',licencie:true},
];
const dirty={
 'id:1':{formations:9,recrutements:9},
 'id:2':{formations:0,recrutements:0,ppa:99},
 'name:ava stopenski':{consultations:1,ppa:1,testsPsy:1},
 'id:3':{consultations:2,ppa:2,testsPsy:1,formations:50},
 'id:4':{consultations:0,ppa:0,testsPsy:0},
 'id:5':{consultations:4,ppa:4,testsPsy:4},
 'id:6':{formations:3,recrutements:2},
 'name:djam mas':{formations:5,recrutements:2},
 'id:7':{formations:6,recrutements:4},
 'name:leto mendez':{formations:1,recrutements:2},
 'id:8':{formations:1,recrutements:3},
 'id:9':{formations:7,recrutements:7},
 'id:999':{formations:100}
};

const cleaned=actions.sanitizeActivityCloud(dirty,{'name:ava stopenski':{streak:4},'id:7':{streak:1},'id:1':{streak:9}},employees);
test('Seuls MF/RF/MP/RP actifs restent',()=>{
 const keys=Object.keys(cleaned.data).sort();
 const exp=['id:2','id:3','id:4','id:7','id:8'];
 if(JSON.stringify(keys)!==JSON.stringify(exp)) throw new Error(keys.join(','));
});
test('Les anciens MC/M et licenciés sont supprimés',()=>{
 for(const k of ['id:1','id:5','id:6','id:9','id:999']) if(cleaned.data[k]) throw new Error(k+' présent');
});
test('La clé id: canonique gagne sur le doublon name:',()=>{
 if(cleaned.data['id:3'].consultations!==2) throw new Error('Ava mauvaise source');
 if(cleaned.data['id:7'].formations!==6) throw new Error('Djam mauvaise source');
 if(cleaned.data['id:8'].recrutements!==3) throw new Error('Leto mauvaise source');
});
test('Les anciens champs de l’autre SP sont retirés',()=>{
 if('ppa' in cleaned.data['id:2']) throw new Error('PPA resté chez MF');
 if('formations' in cleaned.data['id:3']) throw new Error('formations restées chez MP');
});
test('Un ancien name: est migré vers id: avec son streak',()=>{
 if(!cleaned.streak['id:3'] || cleaned.streak['id:3'].streak!==4) throw new Error('streak non migré');
 if(cleaned.streak['name:ava stopenski']) throw new Error('ancienne clé streak conservée');
});

test('Une clôture Pillbox ne réinjecte pas les vieilles entrées',()=>{
 const result=close.computeClosure({activite:{data:dirty,streak:{}},employees,scopesToClose:['formateur','psychologue'],isAbsent:()=>false,now:Date.now()});
 for(const k of ['id:1','id:5','id:6','id:9','id:999','name:ava stopenski','name:djam mas','name:leto mendez']){
   if(result.data[k]) throw new Error(k+' réinjectée');
 }
});

// Teste le vrai renderer Pillbox modifié via VM.
const pillboxPath=require('./_helpers').pillboxHtmlPath();
const html=fs.readFileSync(pillboxPath,'utf8');
const s=html.indexOf('const ACTIVITE_FIELD_LABEL = {');
const e=html.indexOf("document.getElementById('showDashboardBtn').addEventListener",s);
if(s<0||e<0) throw new Error('Bloc renderer Pillbox introuvable');
const ctx={state:{activiteSuivi:dirty},esc:x=>String(x).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])),console};
vm.createContext(ctx); vm.runInContext(html.slice(s,e)+'\nthis.renderActiviteDiagnostic=renderActiviteDiagnostic;',ctx);
const rendered=ctx.renderActiviteDiagnostic({error:false,employees});

test('Pillbox affiche chaque spécialiste actif une seule fois',()=>{
 for(const name of ['William Bradford','Ava Stopenski','Eve Gunther','Djam Mas','Leto Mendez']){
  const count=(rendered.match(new RegExp(name,'g'))||[]).length;
  if(count!==1) throw new Error(name+' x'+count);
 }
});
test('Pillbox ne montre pas les anciens MC/M dans la liste active',()=>{
 for(const name of ['Leyah Akada','Evan Miller','Yanisse Doumbia']) if(rendered.includes('>'+name+'<')) throw new Error(name+' visible');
});
test('Pillbox utilise les données canoniques des doublons',()=>{
 if(!rendered.includes('2 consultations, 2 PPA et 1 test psychologique')) throw new Error('Ava incorrecte');
 if(!rendered.includes('6 formations et 4 recrutements')) throw new Error('Djam incorrect');
 if(!rendered.includes('1 formation et 3 recrutements')) throw new Error('Leto incorrect');
});
test('Pillbox sépare clairement Formateur et Psychologue',()=>{
 if(!rendered.includes('Pôle Formateur')||!rendered.includes('Pôle Psychologue')) throw new Error('pôles absents');
});

console.log(`\nRésultat spécialités : ${ok} test(s) réussi(s), ${fail} échec(s).`);
if(fail) process.exit(1);
