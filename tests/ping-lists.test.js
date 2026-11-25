const assert=require("assert");
const ping=require("../ping-lists.js");
const formation=require("../netlify/functions/formation-import.js")._test;
const sample=[
 {id:"1",name:"Baptiste Fore",discordId:"514871271352434699",grade:"DG"},
 {id:"2",name:"Aaron Stopenski",discordId:"408669016039882752",grade:"DG"},
 {id:"3",name:"Moussa Sako",discordId:"873209274023690303",grade:"D"},
 {id:"4",name:"Leyah Akada",discordId:"861557966083850250",grade:"CD"},
 {id:"5",name:"Eliot",discordId:"451073171194511370",grade:"MC"},
 {id:"6",name:"Manuel Bénévole",discordId:"701698983466106903",grade:"BNVL"},
 {id:"7",name:"Inès Infirmière",discordId:"227444055594893312",grade:"INF"},
 {id:"8",name:"Aline Ambulancière",discordId:"881570935679909918",grade:"A"},
 {id:"9",name:"Stagiaire Test",discordId:"871023722520264714",grade:"STG"},
 {id:"10",name:"Sans Discord",discordId:"",grade:"M"},
 {id:"11",name:"Exclusion manuelle",discordId:"263758146177204225",grade:"M",excludeFromPingLists:true},
 {id:"12",name:"Ancien",discordId:"747513913221972081",grade:"M",licencie:true},
 {id:"13",name:"Zoé M",discordId:"888085010949738536",grade:"M"},
 {id:"14",name:"Émile M",discordId:"1377062633890381885",grade:"M"},
 {id:"15",name:"No ID format",discordId:"12345",grade:"M"}
];
const date=new Date(2026,10,25);
function test(name,fn){try{fn();console.log("✅",name);}catch(e){console.error("❌",name);throw e;}}
test("configuration contient cinq listes",()=>assert.strictEqual(Object.keys(ping.PING_LIST_CONFIG).length,5));
test("filtrage des grades M.U.P",()=>assert(ping.getPingListEmployees("mup",sample).employees.every(e=>ping.PING_LIST_CONFIG.mup.grades.includes(e.grade))));
test("filtrage des grades Formateurs M.U.P",()=>assert(ping.getPingListEmployees("formateurMup",sample).employees.every(e=>ping.PING_LIST_CONFIG.formateurMup.grades.includes(e.grade))));
test("filtrage des grades Formateurs Pilote",()=>assert(ping.getPingListEmployees("formateurPilote",sample).employees.every(e=>ping.PING_LIST_CONFIG.formateurPilote.grades.includes(e.grade))));
test("filtrage des grades Pilotes",()=>assert(ping.getPingListEmployees("pilote",sample).employees.every(e=>ping.PING_LIST_CONFIG.pilote.grades.includes(e.grade))));
test("filtrage des grades Co-Pilotes",()=>assert(ping.getPingListEmployees("coPilote",sample).employees.every(e=>ping.PING_LIST_CONFIG.coPilote.grades.includes(e.grade))));
test("exclusion automatique par Discord ID",()=>assert(!ping.getPingListEmployees("mup",sample).employees.some(e=>e.discordId==="451073171194511370")));
test("exclusion manuelle",()=>assert(!ping.getPingListEmployees("mup",sample).employees.some(e=>e.excludeFromPingLists)));
test("exclusions indépendantes et ancien champ absent accepté",()=>{
 const a={name:"Ancien champ",discordId:"100000000000000001",grade:"M"};
 assert.strictEqual(a.excludeFromPingLists,undefined);
 assert(ping.getPingListEmployees("mup",[a]).employees.some(e=>e===a));
 assert(ping.getPingListEmployees("mup",[{...a,excludeFromPingLists:true}]).employees.length===0);
 assert(ping.getPingListEmployees("mup",[{...a,discordId:"451073171194511370"}]).employees.length===0);
});
test("BNVL est placé après M et avant INF",()=>{
 const m={name:"M",grade:"M"}, b={name:"BNVL",grade:"BNVL"}, inf={name:"INF",grade:"INF"};
 assert(ping.pingCompareEmployees(m,b)<0);
 assert(ping.pingCompareEmployees(b,inf)<0);
});
test("Discord IDs manquants ou invalides exclus du ping",()=>{
 const r=ping.getPingListEmployees("mup",sample);
 assert(!r.employees.some(e=>["10","15"].includes(e.id)));
 assert(r.missingIds.some(e=>e.id==="10")&&r.missingIds.some(e=>e.id==="15"));
});
test("tri par grade décroissant puis prénom sans accents/casse",()=>{
 const arr=ping.getPingListEmployees("mup",sample).employees;
 assert.deepStrictEqual(arr.slice(0,2).map(e=>e.name),["Aaron Stopenski","Baptiste Fore"]);
 assert(arr.findIndex(e=>e.grade==="D")<arr.findIndex(e=>e.grade==="CD"));
});
test("texte copié suit exactement le tri de la fonction de génération",()=>{
 const text=ping.buildPingListText("mup",sample,date);
 assert(text.indexOf("<@408669016039882752>")<text.indexOf("<@514871271352434699>"));
 assert(text.indexOf("<@873209274023690303>")>text.indexOf("<@514871271352434699>"));
});
test("format exact du bloc individuel",()=>{
 const only=[{name:"Aaron Stopenski",discordId:"408669016039882752",grade:"DG"}];
 assert.strictEqual(ping.buildPingListText("mup",only,date),
 "**LISTE des M.U.P :**\n\n<@408669016039882752>\n\nMis à jour le 25/11/2026\n<@&1168614318846267492>");
});
test("format Discord : pings sur lignes consécutives, titre exact et rôle sur sa propre ligne",()=>{
 const only=[
  {name:"Aaron Stopenski",discordId:"408669016039882752",grade:"DG"},
  {name:"Baptiste Fore",discordId:"514871271352434699",grade:"DG"}
 ];
 assert.strictEqual(ping.buildPingListText("formateurPilote",only,date),
  "**LISTE des Formateurs Pilote :**\n\n<@408669016039882752>\n<@514871271352434699>\n\nMis à jour le 25/11/2026\n<@&1168614318846267492>");
});
test("Copier tout contient cinq blocs et une seule date finale",()=>{
 const text=ping.buildAllPingListsText(sample,date);
 assert.strictEqual((text.match(/Mis à jour le/g)||[]).length,1);
 assert.strictEqual((text.match(/\*\*LISTE /g)||[]).length,5);
 assert(text.endsWith("Mis à jour le 25/11/2026\n<@&1168614318846267492>"));
 assert(text.indexOf("LISTE des M.U.P")<text.indexOf("LISTE des Formateurs M.U.P"));
 assert(text.indexOf("LISTE des Formateurs M.U.P")<text.indexOf("LISTE des Formateurs Pilote"));
 assert(text.indexOf("LISTE des Formateurs Pilote")<text.indexOf("LISTE des Pilotes"));
 assert(text.indexOf("LISTE des Pilotes")<text.indexOf("LISTE des Co-Pilotes"));
});
console.log("Tous les tests des listes de ping sont terminés.");

test("Pilote et Co-Pilote sont distingués par les formations validées existantes",()=>{
 const membership=formation.buildPingMembership({
  a:{type:"pilote",traineeId:"1",traineeDiscordId:"100000000000000001"},
  b:{type:"copilote",traineeId:"2",traineeDiscordId:"100000000000000002"},
  c:{type:"operation",traineeId:"3",traineeDiscordId:"100000000000000003"},
  d:{type:"pilote",traineeId:"4",traineeDiscordId:"invalid"}
 });
 assert.deepStrictEqual(membership.piloteEmployeeIds,["1","4"]);
 assert.deepStrictEqual(membership.copiloteEmployeeIds,["2"]);
 assert(!membership.piloteDiscordIds.includes("100000000000000002"));
 assert(!membership.copiloteDiscordIds.includes("100000000000000001"));
});
test("appartenance pilote/co-pilote produit deux listes réellement distinctes",()=>{
 const p=ping.PING_FORMATION_MEMBERSHIP;
 p.loaded=true;
 p.piloteEmployeeIds=new Set(["1"]); p.piloteDiscordIds=new Set();
 p.copiloteEmployeeIds=new Set(["2"]); p.copiloteDiscordIds=new Set();
 const people=[
  {id:"1",name:"Alice Alpha",discordId:"100000000000000001",grade:"M"},
  {id:"2",name:"Benoit Beta",discordId:"100000000000000002",grade:"M"}
 ];
 assert.deepStrictEqual(ping.getPingListEmployees("pilote",people).employees.map(e=>e.id),["1"]);
 assert.deepStrictEqual(ping.getPingListEmployees("coPilote",people).employees.map(e=>e.id),["2"]);
 p.loaded=false; p.piloteEmployeeIds.clear(); p.copiloteEmployeeIds.clear();
});

test("une liste vide conserve un espacement propre sans lignes parasites",()=>{
 assert.strictEqual(ping.buildPingListText("mup",[],date),
 "**LISTE des M.U.P :**\n\nMis à jour le 25/11/2026\n<@&1168614318846267492>");
});
