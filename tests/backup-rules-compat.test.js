const fs=require('fs');
const path=require('path');
const rules=JSON.parse(fs.readFileSync(path.join(__dirname,'..','firebase-rules.permissions-regroupees.json'),'utf8')).rules;
const backup=require(path.join(__dirname,'..','netlify','functions','roster-backup.js'));
let fail=0;
for(const p of backup.RESTORE_PATHS){
  const w=rules[p] && rules[p]['.write'];
  if(!w){console.error(`FAIL ${p}: aucune .write au niveau de la branche, incompatible avec la restauration multi-emplacements`);fail++;}
  else console.log(`OK ${p}`);
}
if(fail) process.exit(1);
console.log(`OK ${backup.RESTORE_PATHS.length}/${backup.RESTORE_PATHS.length}`);
