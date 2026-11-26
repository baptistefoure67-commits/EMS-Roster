const fs=require('fs'),vm=require('vm');
const h=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(startRe){const m=h.match(startRe);let i=m.index,d=0,started=false,j=i;for(;j<h.length;j++){const c=h[j];if(c=='{'){d++;started=true}else if(c=='}'){d--;if(started&&d==0){j++;break}}}return h.slice(i,j)}
const lines=h.split('\n');
const code=[lines.find(l=>l.startsWith('const GRADE_ORDER')),lines.find(l=>l.startsWith('const GRADE_ALIASES')),grab(/function norm\(s\)/),grab(/function employeeNameMatches/),grab(/function cleanEmsName/),grab(/function splitEmsLine/),grab(/function extractEmsRowsForImport/),grab(/function parseEmsTableForImport/)].join('\n');
const rows=[
["..[D] Tio War","","tio-war",81533,"D"],["[A] James Cruz","","james-cruz",263534,"A"],["[A] Leon Kennedy","Avertissement 2","léon-kennedy",151475,"A"],
["[A] Miguel Rodriguez","","miguel-rodriguez",74890,"A"],["[A] Nima Babidi","Avertissement 3","nima-babidi",94192,"A"],["[A] Peter Nox","Avertissement 1","peter-nox",265476,"WDV"],
["[ADD] Baptiste Babidi","","baptiste-babidi",251031,"ADD"],["[ADD] Moussa Sako","","moussa-sako",200661,"ADD"],["[BNVL] Apu Sparrow","","bnvl-apu-sparrow",177969,"M"],
["[CD] Aaron Stopenski","","aaron-stopenski",30410,"CD"],["[DG] Eliot","","eliot-luciano",170262,"DG"],["[DG/S] Papy Alucard Saotome 🐧","","alucard-saotome",138020,"DG"],
["[INF] Fatima Smith","","fatima-smith",249864,"INF"],["[INF] Jean Troudeau","","jean-troudeau",184893,"INF"],["[INF] John Smith","","john-smith",239346,"INF"],
["[INF] Léa Daley","","léa-daley",265072,"INF"],["[INF] Léo Skibidiruben","","léo-skibidiruben",176580,"INF"],["[INF] Rog MACLEN","Avertissement 1","rog-maclen",43585,"INF"],
["[M] 𝐾ℎ𝑎𝑙𝑒𝑏 𝐽𝑜𝑛ℎ𝑠𝑜𝑛","","khaleb-johnson",251472,"M"],["[M] Zakaria El Mkhntr","","zakaria-el-mkhntr",10,"M"],["[MC] Aiden Ishigami","","aiden-ishigami",239431,"MC"],
["[MC] Cloé White","","cloe-white",65630,"MC"],["[𝓜𝓒] 𝓓𝓳𝓪𝓶 𝓜𝓪𝓼","","djam-mas",153556,"MC"],["[MC] Leto Mendez","","leto-mendez",249954,"MC"],
["[MF] Lucas Babidi","","lucas-babidi",235830,"MF"],["[MF] William Bradford","","william-bradford",260836,"MF"],["[MP] Aaliyah Akada","","aaliyah-akada",243087,"MP"],
["[MP] Elena Vergaa","","elena-vergaa",188939,"MP"],["[MP] Ray Cooper","","ray-cooper",146389,"MP"],["[MP] Simonee Babidi","","simonee-babidi",247144,"MP"],
["[RP] Ava Stopenski","Avertissement 2","ava-stopenski",218250,"RP"],["[RP] Eve Gunther","","eve-gunther",62733,"RP"],["[STG] Mehmet Turk","Avertissement 1","mehmet-turk",233735,"STG"],
["[STG] Mike Daley","Avertissement 1","mike-daley",232459,"STG"],["[STG] Rodrigo-Da Silva","Avertissement 1","rodrigo-da-silva",266471,"STG"]];
let txt="Employé\tID unique\tGrade\tInfo\tAbsences\tRéa\tUp\tPaie estimée\tArrivée\t\n";
rows.forEach(r=>{txt+=r[0]+"\n\n"+(r[1]?r[1]+"\n\n":"")+"📂︰"+r[2]+"\n\n"+r[3]+"\n\n"+r[4]+"\n22/11 - 27/11\n0\n\n—\n6 000 000 $\t01/11/2026\t\n \n \n \n \n"});
const ctx={};vm.createContext(ctx);
const names=["Tio War","James Cruz","Leon Kennedy","Louis Carter","Miguel Rodriguez","Nima Babidi","Peter Nox","Baptiste Babidi","Moussa Sako","Apu Sparrow","Aaron Stopenski","Eliot","Papy Alucard Saotome","Fatima Smith","Jean Troudeau","John Smith","Léa Daley","Léo Skibidiruben","Rog MACLEN","Khaleb Jonhson","Zakaria El Mkhntr","Aiden Ishigami","Cloé White","Djam Mas","Leto Mendez","Lucas Babidi","William Bradford","Aaliyah Akada","Elena Vergaa","Ray Cooper","Simonee Babidi","Ava Stopenski","Eve Gunther","Mehmet Turk","Mike Daley","Rodrigo-Da Silva","Pablo O'Connor","Yanisse Doumbia","Reda Avery"];
ctx.employees=names.map((n,i)=>({id:"e"+i,name:n,grade:"M",discordId:"1"+i,licencie:false}));
vm.runInContext(code+";this.parse=parseEmsTableForImport;this.extract=extractEmsRowsForImport;",ctx);
const ex=ctx.extract(txt);console.log("lues",ex.rows.length,"/",rows.length,"erreurs",ex.errors.length);
const r=ctx.parse(txt);
const assert=require('assert');
assert.strictEqual(ex.rows.length,35);assert.strictEqual(ex.errors.length,0);
assert.strictEqual(JSON.stringify(r.toLicencier.map(x=>x.name)),JSON.stringify(['Peter Nox']));
assert.strictEqual(JSON.stringify(r.absentList.map(x=>x.name).sort()),JSON.stringify(["Louis Carter","Pablo O'Connor","Reda Avery","Yanisse Doumbia"]));
const partiel=ctx.parse(txt.split("\n").slice(0,60).join("\n"));
assert.strictEqual(partiel.absentList.length,0,"collage partiel : aucune proposition de départ");
console.log("✅ import tableau EMS : 35 fiches lues, WDV détecté, absents listés (jamais auto-appliqués)");
