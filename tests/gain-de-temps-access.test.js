const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const permissions=fs.readFileSync(path.join(root,'netlify/functions/permissions.js'),'utf8');
const manage=fs.readFileSync(path.join(root,'netlify/functions/manage-individual-permissions.js'),'utf8');
const index=fs.readFileSync(path.join(root,'index.html'),'utf8');

test('Gain de Temps est une permission individuelle, jamais une permission de grade',()=>{
  assert.match(permissions,/INDIVIDUAL_ONLY_KEYS[^\n]*use_gain_de_temps/);
  const gradeBlock=index.match(/const GRADE_PERMISSION_KEYS_UI = \[([\s\S]*?)\];/);
  assert.ok(gradeBlock); assert.doesNotMatch(gradeBlock[1],/use_gain_de_temps/);
});
test('serveur réserve l’attribution à OWNER et limite les grades MF→DG',()=>{
  assert.match(manage,/canonical === GAIN_ACCESS_PERMISSION && session\.level !== "OWNER"/);
  assert.match(manage,/GAIN_ACCESS_GRADES = new Set\(\["MF","MP","MLP","RF","RP","RL","MC","ADD","CD","D","DG"\]\)/);
  assert.match(manage,/assertGainAccessTargetEligible/);
});
test('la fiche Modifier du Roster expose le raccourci OWNER',()=>{
  assert.match(index,/⏱️ Gain de Temps/);
  assert.match(index,/data-gain-access-toggle/);
  assert.match(index,/currentUserLevel === "OWNER"/);
});
