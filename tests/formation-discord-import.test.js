const assert=require('assert');
const fs=require('fs');
const path=require('path');
const imp=require('../netlify/functions/formation-import.js')._test;
let ok=0;
function test(name,fn){try{fn();ok++;console.log(`✅ ${name}`);}catch(e){console.error(`❌ ${name}`);throw e;}}

const sample=`[CD] Aaron Stopenski [LS],  — 11/10/2026 17:08
@[M] Pablo Akada Formation MUP Validée  :T_CK:
@[M] Carlos Navarro  Formation MUP Validée  :T_CK:
[ADD] Baptiste Fore [LS],  — 13/10/2026 20:43
@[M] Ray Cooper Formation MUP Validée :T_CK:
[ADD] Moussa Sako [GAZA],  — 18/10/2026 15:19
@[A] Julio Gusman Formation Co-Pilote Validé :T_CK:
[RF] Djam Mas [LS],  — 18/10/2026 20:33
@[A] Léa Salvatore Formation Opération Validée ✅
[RF] Djam Mas [LS],  — Hier à 22:40
@[M] Clément Eldran Formation Pilote Validée ✅`;


const markdownExportSample=`1.

### [RF] Djam Mas18/10/2026 22:05

**@[A] Jean Troudeau** Formation Opération Validée [✅](https://discord.com/assets/43b7ead1fb91b731.svg)

1.`;
const markdownParsed=imp.parseDiscordFormationText(markdownExportSample,new Date(2026,9,22,20,0).getTime());
test('Accepte un export Markdown Discord avec ### et date collée au nom',()=>{
 assert.strictEqual(markdownParsed.records.length,1);
 assert.strictEqual(markdownParsed.records[0].trainerName,'Djam Mas');
 assert.strictEqual(markdownParsed.records[0].dateLabel,'18/10/2026 22:05');
});
test('Nettoie le gras Markdown autour de la personne formée',()=>{
 assert.strictEqual(markdownParsed.records[0].traineeName,'Jean Troudeau');
 assert.strictEqual(markdownParsed.records[0].type,'operation');
});

const employees=[
 {id:'1',name:'Aaron Stopenski',discordId:'11',idUnique:'101',grade:'CD',aliases:[]},
 {id:'2',name:'Pablo Akada',discordId:'12',idUnique:'102',grade:'M'},
 {id:'3',name:'Carlos Navarro',discordId:'13',idUnique:'103',grade:'M'},
 {id:'4',name:'Baptiste Fore',discordId:'14',idUnique:'104',grade:'ADD'},
 {id:'5',name:'Ray Cooper',discordId:'15',idUnique:'105',grade:'M'},
 {id:'6',name:'Moussa Sako',discordId:'16',idUnique:'106',grade:'ADD'},
 {id:'7',name:'Julio Gusman',discordId:'17',idUnique:'107',grade:'A'},
 {id:'8',name:'Djam Mas',discordId:'18',idUnique:'108',grade:'RF'},
 {id:'9',name:'Léa Salvatore',discordId:'19',idUnique:'109',grade:'A',aliases:['Lea Salvatore']},
 {id:'10',name:'Clément Eldran',discordId:'20',idUnique:'110',grade:'M'},
 {id:'11',name:'Jean Troudeau',discordId:'21',idUnique:'111',grade:'A'},
];

const parsed=imp.parseDiscordFormationText(sample,new Date(2026,9,22,20,0).getTime());
test('Détecte toutes les lignes de formation validées',()=>assert.strictEqual(parsed.records.length,6));
test('Le contexte auteur reste actif sur plusieurs formations',()=>{
 assert.strictEqual(parsed.records[0].trainerName,'Aaron Stopenski');
 assert.strictEqual(parsed.records[1].trainerName,'Aaron Stopenski');
});
test('Nettoie les grades/tags Discord autour du formateur',()=>assert.strictEqual(parsed.records[2].trainerName,'Baptiste Fore'));
test('Nettoie le @ et le grade autour de la personne formée',()=>assert.strictEqual(parsed.records[0].traineeName,'Pablo Akada'));
test('Reconnaît MUP',()=>assert.strictEqual(parsed.records[0].type,'mup'));
test('Reconnaît Co-Pilote avec tiret et Validé au masculin',()=>assert.strictEqual(parsed.records[3].type,'copilote'));
test('Reconnaît Opération avec accent',()=>assert.strictEqual(parsed.records[4].type,'operation'));
[
 'Formation Opération Validée ✅',
 'Formation operation validée ✅',
 'Formation Opérations Validée ✅',
 'Formation OP Validée ✅',
 'Formation OPE Validée ✅',
 'Formation Opé Validée ✅',
 'Formation OPS Validée ✅',
 "Formation d'opération Validée ✅",
].forEach(label=>test(`Reconnaît la variante Opération : ${label}`,()=>assert.strictEqual(imp.formationTypeFromLine(`@[A] Jean Troudeau ${label}`),'operation')));
test('Une formation validée au libellé inconnu est signalée au lieu d’être ignorée',()=>{
 const p=imp.parseDiscordFormationText('[RF] Djam Mas — 18/10/2026 22:05\n@[A] Jean Troudeau Formation Operatoin Validée ✅');
 assert.strictEqual(p.records.length,1); assert.strictEqual(p.records[0].type,'unknown'); assert.strictEqual(p.records[0].typeLabel,'Formation non reconnue');
});
test('Reconnaît Pilote sans confondre avec Co-Pilote',()=>assert.strictEqual(parsed.records[5].type,'pilote'));
test('Convertit “Hier à 22:40” en date de la veille',()=>{
 const d=new Date(parsed.records[5].occurredAt); assert.strictEqual(d.getDate(),21); assert.strictEqual(d.getHours(),22); assert.strictEqual(d.getMinutes(),40);
});
test('Ignore une formation non validée/refusée',()=>{
 const p=imp.parseDiscordFormationText('[RF] Djam Mas — 18/10/2026 20:33\n@[A] Test Formation Opération Refusée ❌');
 assert.strictEqual(p.records.length,0);
});
test('Ignore une formation sans auteur Discord au-dessus',()=>{
 const p=imp.parseDiscordFormationText('@[A] Test Formation Opération Validée ✅'); assert.strictEqual(p.records.length,0); assert.ok(p.ignored.some(x=>x.reason==='missing_author'));
});
test('Le matching tolère accents et alias sans fuzzy dangereux',()=>{
 assert.strictEqual(imp.matchEmployee('Lea Salvatore',employees).employee.id,'9');
 assert.strictEqual(imp.matchEmployee('Clément Eldran',employees).employee.id,'10');
 assert.strictEqual(imp.matchEmployee('Clement Eldr',employees).employee,null);
});
test('Un homonyme exact devient ambigu au lieu de choisir au hasard',()=>{
 const list=[...employees,{id:'99',name:'Ray Cooper',discordId:'99',grade:'A'}]; const m=imp.matchEmployee('Ray Cooper',list); assert.strictEqual(m.employee,null); assert.strictEqual(m.ambiguous,true);
});
const enriched=imp.enrichParsed(parsed,employees,{});
test('Toutes les personnes du sample sont résolues',()=>assert.ok(enriched.every(r=>r.trainer&&r.trainee)));

const markdownEnriched=imp.enrichParsed(markdownParsed,employees,{});
test('Le format Markdown exact résout Djam Mas et Jean Troudeau dans le Roster',()=>{
 assert.strictEqual(markdownEnriched[0].trainer.name,'Djam Mas');
 assert.strictEqual(markdownEnriched[0].trainee.name,'Jean Troudeau');
 assert.strictEqual(markdownEnriched[0].importable,true);
});
test('Le format Markdown exact ajoute Jean au bloc Opération, à la liste Pillbox et +1 formation à Djam',()=>{
 const built=imp.buildCommitPatch(markdownEnriched,{}, {data:{'id:108':{formations:7,recrutements:0}}}, {}, {}, employees, {discordId:'owner',name:'Test'},1800000000000);
 assert.ok(built.patch.rosterEmsSpecialSelection.selectedEmployees.some(e=>e.name==='Jean Troudeau'));
 assert.ok(built.patch.formationOperationList.text.includes('Jean Troudeau : 111'));
 assert.strictEqual(built.patch.activiteSuivi.data['id:108'].formations,8);
});
test('L’import Opération préserve les personnes déjà présentes dans formationOperationList',()=>{
 const built=imp.buildCommitPatch(markdownEnriched,{}, {data:{'id:108':{formations:0,recrutements:0}}}, {}, {text:'Léa Salvatore : 109',savedAt:1}, employees, {discordId:'owner',name:'Test'},1800000000000);
 assert.ok(built.patch.formationOperationList.text.includes('Léa Salvatore : 109'));
 assert.ok(built.patch.formationOperationList.text.includes('Jean Troudeau : 111'));
});
test('Une formation non reconnue crédite quand même le formateur mais ne touche jamais la liste Opération',()=>{
 const p=imp.parseDiscordFormationText('[RF] Djam Mas — 18/10/2026 22:05\n@[A] Jean Troudeau Formation Operatoin Validée ✅');
 const e=imp.enrichParsed(p,employees,{});
 const built=imp.buildCommitPatch(e,{}, {data:{'id:108':{formations:7,recrutements:0}}}, {}, {text:'Léa Salvatore : 109'}, employees, {discordId:'owner',name:'Test'},1800000000000);
 assert.strictEqual(built.patch.activiteSuivi.data['id:108'].formations,8);
 assert.ok(!built.patch.rosterEmsSpecialSelection);
 assert.ok(!built.patch.formationOperationList);
});

test('Seul le RF actuel est créditable dans le compteur hebdo Formateur',()=>{
 const credits=enriched.filter(r=>r.activityEligible); assert.strictEqual(credits.length,2); assert.ok(credits.every(r=>r.trainer.name==='Djam Mas'));
});
test('La Formation Opération est identifiée pour le bloc Opération',()=>assert.deepStrictEqual(enriched.filter(r=>r.type==='operation').map(r=>r.trainee.name),['Léa Salvatore']));
test('L’empreinte anti-doublon ne dépend pas de la date du message',()=>{
 const a=imp.fingerprintFor(employees[0],employees[1],'mup'); const b=imp.fingerprintFor(employees[0],employees[1],'mup'); assert.strictEqual(a,b); assert.strictEqual(a.length,32);
});
test('Un historique existant transforme la même formation en doublon',()=>{
 const fp=imp.fingerprintFor(employees[0],employees[1],'mup'); const e=imp.enrichParsed(parsed,employees,{[fp]:{type:'mup'}}); assert.strictEqual(e[0].duplicate,true); assert.strictEqual(e[0].importable,false);
});
test('Le résumé sépare nouvelles, doublons, opérations et crédits',()=>{
 const sum=imp.summarize(enriched); assert.strictEqual(sum.detected,6); assert.strictEqual(sum.importable,6); assert.strictEqual(sum.operations,1); assert.strictEqual(sum.activityCredits,2); assert.strictEqual(sum.historyOnlyCredits,4); assert.strictEqual(sum.unrecognized,0);
});
test('employeeKey préfère l’ID unique pour survivre à un changement de nom',()=>assert.strictEqual(imp.employeeKey(employees[7]),'id:108'));

test('Le patch final conserve les sélections Opération déjà présentes',()=>{
 const currentSpecial={selectedEmployees:[employees[1]],savedAt:1};
 const currentActivity={data:{'id:108':{formations:4,recrutements:2}},streak:{'id:108':{streak:0,lastSignaledThreshold:0}}};
 const built=imp.buildCommitPatch(enriched,{},currentActivity,currentSpecial,{},employees,{discordId:'owner',name:'Test'},1800000000000);
 const selected=built.patch.rosterEmsSpecialSelection.selectedEmployees.map(e=>e.name);
 assert.ok(selected.includes('Pablo Akada')); assert.ok(selected.includes('Léa Salvatore'));
});
test('Le patch final ajoute exactement les crédits Formateur attendus',()=>{
 const built=imp.buildCommitPatch(enriched,{}, {data:{'id:108':{formations:4,recrutements:2}}}, {}, {}, employees, {discordId:'owner',name:'Test'},1800000000000);
 assert.strictEqual(built.patch.activiteSuivi.data['id:108'].formations,6);
 assert.strictEqual(built.patch.activiteSuivi.data['id:108'].recrutements,2);
 assert.strictEqual(Object.values(built.trainerCredits).reduce((a,b)=>a+b,0),2);
});
test('Les formations faites par un haut-gradé non MF/RF restent dans l’expérience sans polluer le compteur hebdo',()=>{
 const built=imp.buildCommitPatch(enriched,{}, {}, {}, {}, employees, {discordId:'owner',name:'Test'},1800000000000);
 assert.ok(Object.values(built.patch.rosterFormationExperience).some(r=>r.trainerName==='Aaron Stopenski'));
 assert.ok(!built.patch.activiteSuivi || !built.patch.activiteSuivi.data['id:101']);
});
test('Chaque nouvelle formation crée une entrée d’expérience distincte',()=>{
 const built=imp.buildCommitPatch(enriched,{}, {}, {}, {}, employees, {discordId:'owner',name:'Test'},1800000000000);
 assert.strictEqual(Object.keys(built.patch.rosterFormationExperience).length,6);
});
test('Les statistiques d’expérience attribuent bien les formations au formateur auteur',()=>{
 const built=imp.buildCommitPatch(enriched,{}, {}, {}, {}, employees, {discordId:'owner',name:'Test'},1800000000000);
 const stats=imp.historyStats(built.patch.rosterFormationExperience);
 const aaron=stats.find(x=>x.trainerName==='Aaron Stopenski');
 const djam=stats.find(x=>x.trainerName==='Djam Mas');
 assert.strictEqual(aaron.total,2); assert.strictEqual(djam.total,2); assert.strictEqual(djam.operation,1); assert.strictEqual(djam.pilote,1);
});
test('Une ligne déjà marquée doublon n’est jamais écrite ni recréditée',()=>{
 const clone=enriched.map((r,i)=>i===4?{...r,duplicate:true,importable:false}:r);
 const built=imp.buildCommitPatch(clone,{}, {data:{'id:108':{formations:0,recrutements:0}}}, {}, {}, employees, {discordId:'owner',name:'Test'},1800000000000);
 assert.strictEqual(Object.keys(built.patch.rosterFormationExperience).length,5);
 assert.strictEqual(built.patch.activiteSuivi.data['id:108'].formations,1);
 assert.ok(!built.patch.rosterEmsSpecialSelection);
});

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
test('Le bloc Opération contient la zone d’import Discord',()=>assert.ok(html.includes('Importer les formations Discord')));
test('La zone contient prévisualisation, import et historique expérience',()=>['formationDiscordImportPreview','btnFormationDiscordImport','formationExperienceHistory'].forEach(x=>assert.ok(html.includes(x),x)));
test('Le client appelle la fonction serveur pour preview et commit',()=>{assert.ok(html.includes('formationDiscordRequest("preview"'));assert.ok(html.includes('formationDiscordRequest("commit"'));});
test('Le collage déclenche automatiquement une prévisualisation temporisée',()=>assert.ok(html.includes('formationDiscordPreviewTimer=setTimeout')));
test('La prévisualisation affiche +1 formation pour le formateur et Formation non reconnue si nécessaire',()=>{assert.ok(html.includes('+1 formation pour ${trainer}'));assert.ok(html.includes('Formation non reconnue'));});
test('Le message après import sait afficher Formation Opération validée sans modifier la phrase UP de Pillbox',()=>assert.ok(html.includes('Formation Opération validée pour ${r.traineeName}')));
test('Le message de réussite reste affiché après la re-prévisualisation anti-doublon',()=>assert.ok(html.includes('status.textContent=successText;')));

const rules=JSON.parse(fs.readFileSync(path.join(__dirname,'..','firebase-rules.permissions-regroupees.json'),'utf8')).rules;
test('Firebase possède une branche serveur dédiée à l’historique formations',()=>{assert.ok(rules.rosterFormationExperience);assert.strictEqual(rules.rosterFormationExperience['.write'],'auth != null && auth.token.server == true');});
test('Les règles Firebase autorisent le champ formationKey réellement écrit par l’import',()=>{
 const r=rules.rosterFormationExperience['$formationId'];
 assert.ok(r.formationKey); assert.ok(String(r.formationKey['.validate']).includes('newData.isString()'));
});
test('Les règles Firebase autorisent aussi le type unknown prévu par le parseur',()=>{
 const typeRule=String(rules.rosterFormationExperience['$formationId'].type['.validate']);
 assert.ok(typeRule.includes("newData.val() == 'unknown'"));
});
test('Tous les champs d’une entrée importée sont déclarés dans les règles Firebase',()=>{
 const p=imp.parseDiscordFormationText('[RF] Djam Mas — 18/10/2026 22:05\n@[A] Jean Troudeau Formation Co-Pilote Validée ✅');
 const e=imp.enrichParsed(p,employees,{});
 const built=imp.buildCommitPatch(e,{}, {data:{'id:108':{formations:1,recrutements:0}}}, {}, {}, employees, {discordId:'owner',name:'Test'},1800000000000);
 const rec=Object.values(built.patch.rosterFormationExperience)[0];
 const rr=rules.rosterFormationExperience['$formationId'];
 const missing=Object.keys(rec).filter(k=>!Object.prototype.hasOwnProperty.call(rr,k));
 assert.deepStrictEqual(missing,[]);
});
test('Une formation inconnue produit une formationKey bornée compatible Firebase',()=>{
 const veryLong='X'.repeat(1000);
 const p=imp.parseDiscordFormationText(`[RF] Djam Mas — 18/10/2026 22:05\n@[A] Jean Troudeau Formation ${veryLong} Validée ✅`);
 assert.strictEqual(p.records[0].type,'unknown');
 assert.ok(p.records[0].formationKey.length<200);
});
test('La liste Formation Opération déjà utilisée par Pillbox reste écrivable uniquement côté serveur',()=>assert.strictEqual(rules.formationOperationList['.write'],'auth != null && auth.token.server == true'));
const backup=require('../netlify/functions/roster-backup.js');
test('L’historique formations est inclus dans les backups catastrophe',()=>assert.ok(backup.RESTORE_PATHS.includes('rosterFormationExperience')));

console.log(`\nImport formations Discord : ${ok} test(s) réussi(s), 0 échec.`);
