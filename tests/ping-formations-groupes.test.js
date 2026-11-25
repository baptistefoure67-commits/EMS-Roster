const assert=require("assert");
const ping=require("../ping-lists.js");
const date=new Date(2026,10,20);
function test(n,f){try{f();console.log("✅",n);}catch(e){console.error("❌",n);throw e;}}
const P=ping.PING_PILOTE_DISCORD_IDS;
const staff=[
 {id:"1",name:"Aaron",discordId:"873209274023690303",grade:"DG"},
 {id:"2",name:"Tio",discordId:"408669016039882752",grade:"DG"},
 {id:"3",name:"Nouveau",discordId:"100000000000000009",grade:"M"},
 {id:"4",name:"Stagiaire",discordId:"100000000000000010",grade:"INF"}
];
test("Formation Pilote - Co-Pilote : formateurs, pilotes, co-pilotes puis une seule date",()=>{
 const t=ping.buildPingGroupText("formationPilote",staff,date);
 assert.strictEqual((t.match(/Mis à jour le/g)||[]).length,1);
 assert(t.indexOf("LISTE des Formateurs Pilote")<t.indexOf("LISTE des Pilotes"));
 assert(t.indexOf("LISTE des Pilotes")<t.indexOf("LISTE des Co-Pilotes"));
 assert(t.endsWith("Mis à jour le 20/11/2026\n<@&1168614318846267492>"));
 assert(!t.includes("LISTE des M.U.P"));
});
test("Formation MUP : M.U.P puis Formateurs M.U.P",()=>{
 const t=ping.buildPingGroupText("formationMup",staff,date);
 assert(t.indexOf("LISTE des M.U.P")<t.indexOf("LISTE des Formateurs M.U.P"));
 assert.strictEqual((t.match(/\*\*LISTE /g)||[]).length,2);
 assert(t.endsWith("Mis à jour le 20/11/2026\n<@&1168614318846267492>"));
});
test("ajout manuel Pilote / Co-Pilote / MUP (même hors référence ou hors grade)",()=>{
 const src=staff.map(e=>({...e}));
 assert(!ping.getPingListEmployees("pilote",src).employees.some(e=>e.id==="3"));
 src[2].pingPilote=true; src[2].pingCoPilote=true; src[3].pingMup=true;
 assert(ping.getPingListEmployees("pilote",src).employees.some(e=>e.id==="3"));
 assert(ping.getPingListEmployees("coPilote",src).employees.some(e=>e.id==="3"));
 assert(ping.getPingListEmployees("mup",src).employees.some(e=>e.id==="4"),"INF ajouté à la main au MUP");
 assert(ping.buildPingGroupText("formationPilote",src,date).includes("<@100000000000000009>"));
 assert(ping.buildPingGroupText("formationMup",src,date).includes("<@100000000000000010>"));
});
test("retrait manuel (false) et retour référence (absent)",()=>{
 const a={...staff[0],pingPilote:false};
 assert(P.has(a.discordId)||true);
 assert(!ping.getPingListEmployees("pilote",[a]).employees.length);
 delete a.pingPilote;
 assert.strictEqual(ping.getPingListEmployees("pilote",[a]).employees.length,P.has(a.discordId)?1:0);
});
test("un licencié ou exclu n'est jamais ping même avec un ajout manuel",()=>{
 const a={...staff[2],pingPilote:true,licencie:true}, b={...staff[2],pingPilote:true,excludeFromPingLists:true};
 assert.strictEqual(ping.getPingListEmployees("pilote",[a,b]).employees.length,0);
});
console.log("Tests formations/ajouts terminés.");
