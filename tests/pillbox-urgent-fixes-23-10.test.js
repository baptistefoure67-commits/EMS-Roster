const fs=require('fs'),path=require('path'),assert=require('assert');
const ROOT=path.resolve(__dirname,'..');
const FN=path.join(ROOT,'netlify/functions');
const PB='/mnt/data/pillbox_urgent_work/index.html';
const html=fs.readFileSync(PB,'utf8');
let n=0; const ok=(v,m)=>{assert.ok(v,m);n++}; const has=(s,r,m)=>ok(r.test(s),m); const lacks=(s,r,m)=>ok(!r.test(s),m);
const proxySrc=fs.readFileSync(path.join(FN,'pillbox-proxy.js'),'utf8');
const permSrc=fs.readFileSync(path.join(FN,'permissions.js'),'utf8');
const gemSrc=fs.readFileSync(path.join(FN,'gemini-ocr-proxy.js'),'utf8');
const delSrc=fs.readFileSync(path.join(FN,'pillbox-delete-week.js'),'utf8');
const reSrc=fs.readFileSync(path.join(FN,'pillbox-reopen-week.js'),'utf8');
const defaultsSrc=fs.readFileSync(path.join(FN,'pay-rules-defaults.js'),'utf8');
const payActionsSrc=fs.readFileSync(path.join(FN,'pay-rules-actions.js'),'utf8');

// P1 / P2 financial source of truth
has(html,/const sortedRea = actifs\.filter\(e=>!e\.benevole && e\.reaCount>0\)/,'Top3 excludes zero rea');
has(html,/const totalPaye = payesPopulation\.reduce\(\(sum,e\) => sum \+ finalPaye\(e\), 0\)/,'total uses exact payes population');
lacks(html,/payesPopulation[\s\S]{0,160}filter\(e => !\(EXEMPT\.has\(e\.grade\) && e\.reaCount===0\)\)/,'no hidden HG zero rea exclusion');

// P3 / P7 / P11 decisions
has(html,/const unansweredHgRetrograde = hgRetrogradeList\.filter/,'unanswered HG list exists');
has(html,/unansweredHgRetrograde\.length>0 \|\| unansweredMcAdd/,'blocking uses unanswered HG');
has(html,/const unansweredStgLicence = pendingStgLicenceList\.filter/,'STG partial decisions use filter');
has(html,/const unansweredALicence = pendingALicenceList\.filter/,'A partial decisions use filter');
has(html,/const unansweredInfLicence = pendingInfLicenceList\.filter/,'INF partial decisions use filter');
has(html,/const unansweredExtraQLicence = pendingExtraQLicenceList\.filter/,'extra Q partial decisions use filter');
has(html,/const nbAValider = unansweredQ\.length[\s\S]{0,500}unansweredLongAbsenceGroups\.length/,'summary counter uses real unresolved categories');
lacks(html,/const nbAValider =[\s\S]{0,250}hgRetrogradeList\.length/,'summary no raw HG list');

// P6 / P8
has(html,/Formation Opération non vérifiable/,'unverifiable operation wording exists');
has(html,/const upDetails = `\$\{GRADE_LABEL\[e\.grade\]\}[\s\S]{0,500}formationOperationUnverifiable/,'real UP question includes unverifiable operation state');
has(html,/function activiteVerification\(row\)/,'activity tri-state helper exists');
has(html,/activité Formateur\/Psychologue non vérifiable/,'activity failure explicit wording');

// P12 legacy volunteer propagated
has(html,/const effectiveBenevole = !!\(row\.benevole \|\| ov\.benevole\)/,'legacy volunteer effective status');
has(html,/\.\.\.row, benevole: effectiveBenevole/,'legacy volunteer propagated to employee');
has(html,/if\(e\.benevole\) return 0/,'effective volunteer final pay zero');

// P13 PPA XSS
has(html,/const safeList = \(arr, sep\) => arr\.map\(x=>esc\(String\(x\)\)\)\.join\(sep\)/,'PPA feedback escape helper');
lacks(html,/notFound\.join\([^\n]*<br>/,'raw notFound not joined into innerHTML');

// P4/P5 absence targeted write + permission context
has(proxySrc,/const decisionUrl = `\$\{decisionBase\}\/\$\{encodeURIComponent\(alertKey\)\}\.json\?auth=\$\{idToken\}`/,'absence writes targeted key');
has(proxySrc,/can\(session\.level, "manage_absences", permCtx\.custom, session\.discordId, permCtx\.individual\)/,'absence uses fine permissions');
lacks(proxySrc,/setAbsenceAlertDecision[\s\S]{0,1200}current\[alertKey\]/,'absence no whole-branch read-modify-write');

// P9 fail closed
has(permSrc,/async function canFor[\s\S]{0,900}loadPermissionContext\(tok, \{strict:true\}\)/,'canFor strict permission read');

// P10 Gemini strict contract
has(gemSrc,/const GEMINI_OCR_MODEL = process\.env\.GEMINI_OCR_MODEL \|\| "gemini-3\.6-flash"/,'Gemini model server side');
has(gemSrc,/allowedKeys = new Set\(\["imageBase64", "mimeType", "rosterNames"\]\)/,'Gemini request allowlist');
has(gemSrc,/MAX_IMAGE_BYTES = 6 \* 1024 \* 1024/,'Gemini image size bounded');
lacks(gemSrc,/body\.model|body\.payload|body\.prompt/,'Gemini ignores client model/payload/prompt');
has(html,/JSON\.stringify\(\{ imageBase64: base64, mimeType: file\.type \|\| "image\/png", rosterNames: rosterNamesForOcr \}\)/,'frontend sends strict OCR contract');

// P14 shared defaults, delete/reopen diagnostics + ETag, ADD message honesty
has(defaultsSrc,/extraQProposalGrades/,'shared defaults include extra Q grades');
has(defaultsSrc,/extraQProposalThreshold/,'shared defaults include extra Q threshold');
has(proxySrc,/require\("\.\/pay-rules-defaults"\)/,'proxy uses shared defaults');
has(payActionsSrc,/require\("\.\/pay-rules-defaults"\)/,'pay rules action uses shared defaults');
has(delSrc,/X-Firebase-ETag/,'delete requests ETag');
has(delSrc,/If-Match/,'delete uses conditional delete');
has(delSrc,/Lecture Firebase impossible/,'delete distinguishes read failure');
has(reSrc,/Lecture Firebase impossible/,'reopen distinguishes read failure');
has(reSrc,/ADD et au-dessus par défaut/,'reopen message matches actual ADD permission default');

// Semantic filter tests for partial decisions and HG answered state
const people=[{key:'a'},{key:'b'}];
let ov={a:{stgLicenceDecision:false},b:{}};
eqLen(people.filter(e=>ov[e.key]?.stgLicenceDecision===undefined),1,'STG partial remains unresolved');
ov={a:{aLicenceDecision:true},b:{}}; eqLen(people.filter(e=>ov[e.key]?.aLicenceDecision===undefined),1,'A partial remains unresolved');
ov={a:{infLicenceDecision:false},b:{}}; eqLen(people.filter(e=>ov[e.key]?.infLicenceDecision===undefined),1,'INF partial remains unresolved');
ov={a:{extraQLicenceDecision:true},b:{}}; eqLen(people.filter(e=>ov[e.key]?.extraQLicenceDecision===undefined),1,'extraQ partial remains unresolved');
function eqLen(arr,len,msg){assert.strictEqual(arr.length,len,msg);n++;}
const hg=[{key:'h'}];
for(const [o,expected,label] of [[{},1,'HG unanswered'],[{hgManualFire:true},0,'HG manual fire answered'],[{manualPromoteTarget:'MC'},0,'HG downgrade answered'],[{hgRetrogradeDismissed:true},0,'HG dismiss answered']]){
  const ovs={h:o}; const unresolved=hg.filter(e=>{const x=ovs[e.key]||{};return x.hgManualFire!==true&&!x.manualPromoteTarget&&x.hgRetrogradeDismissed!==true});
  eqLen(unresolved,expected,label);
}

console.log(`✅ Urgent Pillbox fixes: ${n} checks passed`);
