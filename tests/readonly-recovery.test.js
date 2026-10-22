const fs=require('fs');
const path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let ok=0, fail=0;
function test(name,cond){ if(cond){console.log('✅',name);ok++;} else {console.error('❌',name);fail++;} }
const start=src.indexOf('async function refreshEmployeesFromCloud(){');
const end=src.indexOf('\n}\n\n// (10/10, demandé) Présence du Roster',start)+2;
const fn=src.slice(start,end);
test('refreshEmployeesFromCloud existe', start>=0 && end>start);
test('Une lecture Firebase valide confirme le cloud même sans nouvelle version', fn.includes('setRosterCloudConfirmed(true,"✓ Roster vérifié avec Firebase")'));
test('La confirmation cloud est hors du test savedAt plus récent', fn.indexOf('setRosterCloudConfirmed(true') < fn.indexOf('if(data.savedAt && data.savedAt >'));
test('La protection anti-Roster vide reste active', fn.includes('data.employees.length===0 && employees.length>0') && fn.includes('mode lecture seule de sécurité'));
test('Le rafraîchissement périodique reste à 3 secondes', src.includes('}, 3000); // (10/10, demandé) descendu de 25s à 3s'));
console.log(`\n${ok} OK, ${fail} échec(s)`); process.exit(fail?1:0);
