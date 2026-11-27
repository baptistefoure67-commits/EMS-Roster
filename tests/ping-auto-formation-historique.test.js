const assert=require("assert"),path=require("path"),crypto=require("crypto");
const DIR=path.join(__dirname,"..","netlify","functions");
const rules=require(path.join(DIR,"ping-rules.js"));
const ping=require("../ping-lists.js");
function test(n,f){return Promise.resolve().then(f).then(()=>console.log("✅",n),e=>{console.error("❌",n);throw e;});}
const emps=()=>[
 {id:"1",name:"Ambu",discordId:"100000000000000001",grade:"A"},
 {id:"2",name:"Inf",discordId:"100000000000000002",grade:"INF"},
 {id:"3",name:"Medecin",discordId:"100000000000000003",grade:"M"},
 {id:"4",name:"Stagiaire",discordId:"100000000000000004",grade:"STG"},
 {id:"5",name:"Ancien",discordId:"100000000000000005",grade:"M",licencie:true}
];
const rec=(type,id)=>({type,trainee:{id},trainer:{name:"Formateur X"}});
(async()=>{
await test("formation Pilote => Pilote + Co-Pilote ; Co-Pilote => Co-Pilote ; MUP => MUP",()=>{
 const e=emps();
 const r=rules.applyPingFlags(e,[rec("pilote","2"),rec("copilote","1"),rec("mup","3")]);
 assert.strictEqual(e[1].pingPilote,true);assert.strictEqual(e[1].pingCoPilote,true);
 assert.strictEqual(e[0].pingCoPilote,true);assert.strictEqual(e[0].pingPilote,undefined);
 assert.strictEqual(e[2].pingMup,true);
 assert.strictEqual(r.added.length,3);
});
await test("grade insuffisant, stagiaire et licencié : jamais ajoutés",()=>{
 const e=emps();
 const r=rules.applyPingFlags(e,[rec("pilote","1"),rec("mup","2"),rec("copilote","4"),rec("mup","5")]);
 assert.strictEqual(e[0].pingPilote,undefined,"ambulancier pas Pilote");
 assert.strictEqual(e[0].pingCoPilote,true,"mais Co-Pilote via la formation Pilote");
 assert.strictEqual(e[1].pingMup,undefined,"infirmier pas MUP");
 assert.strictEqual(e[3].pingCoPilote,undefined);assert.strictEqual(e[4].pingMup,undefined);
 assert(r.skipped.some(x=>x.name==="Inf")&&r.skipped.some(x=>x.name==="Stagiaire"));
});
await test("rejouer la même formation ne change rien (idempotent) ; opération ignorée",()=>{
 const e=emps(); rules.applyPingFlags(e,[rec("mup","3")]);
 assert.strictEqual(rules.applyPingFlags(e,[rec("mup","3"),rec("operation","3")]).changed,false);
});
await test("applyPingToRoster écrit le Roster avec ETag et gère un conflit 412",async()=>{
 const {privateKey}=crypto.generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
 Object.assign(process.env,{SESSION_SECRET:"x",FIREBASE_CLIENT_EMAIL:"t@e.com",FIREBASE_PRIVATE_KEY:privateKey,FIREBASE_WEB_API_KEY:"k"});
 let db={employees:emps(),savedAt:1},puts=0;
 global.fetch=async(url,opts={})=>{
  const m=opts.method||"GET";
  if(String(url).includes("rosterEmsData")){
   if(m==="GET")return{ok:true,status:200,headers:{get:()=>"etag"},json:async()=>JSON.parse(JSON.stringify(db))};
   puts++; if(puts===1)return{ok:false,status:412,text:async()=>""};
   db=JSON.parse(opts.body);return{ok:true,status:200,text:async()=>""};
  }
  return{ok:true,status:200,json:async()=>({})};
 };
 const fi=require(path.join(DIR,"formation-import.js"))._test;
 const res=await fi.applyPingToRoster("tok",[rec("pilote","2")]);
 assert.strictEqual(res.added.length,1);assert.strictEqual(puts,2,"un 412 puis un succès");
 assert.strictEqual(db.employees[1].pingPilote,true);assert(db.savedAt>=1);
});
await test("historique : seules les entrées liste_ping, plus récentes d'abord",()=>{
 const hist=require(path.join(DIR,"ping-history.js")).pickPingEntries({
  a:{action:"connexion",createdAt:5},b:{action:"liste_ping",createdAt:10,targetName:"A",details:"Pilote ajouté — source : ajout manuel",authorName:"Z"},
  c:{action:"liste_ping",createdAt:20,targetName:"B",details:"MUP retiré — source : ajout manuel"}});
 assert.deepStrictEqual(hist.map(x=>x.targetName),["B","A"]);
});
await test("aperçu : noms à la place des ID, rôle Employés, gras, échappement HTML",()=>{
 const src=[{name:"Aaron <b>",discordId:"408669016039882752",grade:"DG"}];
 const html=ping.buildPingPreviewHtml("**LISTE des M.U.P :**\n\n<@408669016039882752>\n<@999999999999999999>\n\nMis à jour\n<@&1168614318846267492>",src);
 assert(html.includes("<strong>LISTE des M.U.P :</strong>"));
 assert(html.includes("@[DG] Aaron &lt;b&gt;")&&!html.includes("<b>"),"grade entre crochets avant le nom");
 assert(html.includes("@inconnu")&&html.includes("@Employés")&&!html.includes("408669016039882752"));
});
await test("historique : rendu des lignes (ajout / retrait / source)",()=>{
 const html=ping.buildPingHistoryHtml([{targetName:"Léa",details:"Pilote retiré — source : ajout manuel",authorName:"Papy",createdAt:Date.now()}]);
 assert(html.includes("➖")&&html.includes("Léa")&&html.includes("ajout manuel")&&html.includes("par Papy"));
});
await test("liste d'ajout : masque ceux qui ont déjà tout, garde Aiden (Pilote manquant), jamais de stagiaire",()=>{
 const full={id:"f",name:"Complet",discordId:"100000000000000020",grade:"M",pingPilote:true,pingCoPilote:true,pingMup:true};
 const mfFull={id:"g",name:"MF complet",discordId:"100000000000000021",grade:"MF",pingPilote:true,pingCoPilote:true,pingMup:true,pingFormateurPilote:true,pingFormateurMup:true};
 const aiden={id:"a",name:"Aiden",discordId:"227444055594893312",grade:"MC"}; // Co-Pilote de référence, pas Pilote
 const stg={id:"s",name:"Stag",discordId:"100000000000000022",grade:"STG"};
 const retire={...full,id:"r",name:"Retiré",pingPilote:false};
 const r=ping.pingAddableEmployees([full,mfFull,aiden,stg,retire]);
 const names=r.people.map(e=>e.name);
 assert(!names.includes("Complet")&&!names.includes("MF complet")&&!names.includes("Stag"));
 assert(names.includes("Aiden")&&names.includes("Retiré"),"retiré à la main => redevient ajoutable");
 assert.strictEqual(r.hidden,2);
 assert(ping.pingAddableLists(aiden).includes("pilote")&&!ping.pingAddableLists(aiden).includes("coPilote"));
});
await test("liste Opération : suit la sélection « Formation Opération » du Roster, format ping",()=>{
 const src=[
  {id:"1",name:"Aaron",discordId:"873209274023690303",grade:"CD"},
  {id:"2",name:"Léa",discordId:"1311123243775557652",grade:"INF"},
  {id:"3",name:"Pas coché",discordId:"100000000000000030",grade:"M"},
  {id:"4",name:"Sans ID",discordId:"",grade:"M"},
  {id:"5",name:"Licencié",discordId:"100000000000000031",grade:"M",licencie:true}];
 const ids=new Set(["1","2","4","5"]);
 const txt=ping.buildPingListText("operation",src,new Date(2026,10,27),false,ids);
 assert.strictEqual(txt,"**LISTE Opération :**\n\n<@873209274023690303>\n<@1311123243775557652>");
 assert(ping.buildPingListText("operation",src,new Date(2026,10,27),true,ids).endsWith("Mis à jour le 27/11/2026\n<@&1168614318846267492>"));
 assert.strictEqual(ping.getPingListEmployees("operation",src,ids).missingIds.length,1,"sans ID signalé");
 assert.strictEqual(ping.getPingListEmployees("operation",src,new Set()).employees.length,0);
 assert(!ping.buildAllPingListsText(src,new Date()).includes("Opération"),"Copier tout inchangé");
});
console.log("Tests ajout automatique / aperçu / historique terminés.");
})().catch(e=>{console.error(e);process.exit(1);});
