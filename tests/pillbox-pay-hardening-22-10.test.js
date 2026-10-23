const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname,'..');
const PILLBOX = '/mnt/data/pillbox12_work/index.html';
const html = fs.readFileSync(PILLBOX,'utf8');
const proxy = fs.readFileSync(path.join(ROOT,'netlify/functions/pillbox-proxy.js'),'utf8');
const del = fs.readFileSync(path.join(ROOT,'netlify/functions/pillbox-delete-week.js'),'utf8');
const reopen = fs.readFileSync(path.join(ROOT,'netlify/functions/pillbox-reopen-week.js'),'utf8');
const callback = fs.readFileSync(path.join(ROOT,'netlify/functions/discord-callback.js'),'utf8');
const renew = fs.readFileSync(path.join(ROOT,'netlify/functions/renew-session.js'),'utf8');
const perms = fs.readFileSync(path.join(ROOT,'netlify/functions/permissions.js'),'utf8');

let passed=0;
function ok(cond,msg){ assert.ok(cond,msg); passed++; }
function has(src, re, msg){ ok(re.test(src),msg); }
function lacks(src,re,msg){ ok(!re.test(src),msg); }

// P1: every decision category + closure hard guard
for(const token of ['unansweredQ','unansweredNearMiss','unansweredUp','unansweredStgLicence','unansweredALicence','unansweredInfLicence','unansweredExtraQLicence','unansweredMcAdd','unansweredSignalementGroups','unansweredAbsenceGroups','unansweredStgAbsenceGroups','unansweredLongAbsenceGroups']){
  has(html,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`decision category ${token} present`);
}
has(html,/if\(ctx\.hasUnresolvedDecisions\)[\s\S]{0,500}Impossible de terminer la semaine/,'finish-week rechecks unresolved decisions');

// P2: numerical weekly total used, no function coercion in closure
has(html,/totalPaye:\s*ctx\.totalPaye/,'history stores numeric totalPaye');
has(html,/Math\.round\(ctx\.totalPaye\)/,'closure confirmation uses numeric totalPaye');
lacks(html,/Math\.round\(ctx\.finalPaye\)/,'closure never rounds finalPaye function');

// P3: rules errors are blocking and no silent read-error fallback
has(html,/payRulesReady\s*=\s*false/,'pay rules begin not-ready');
has(html,/readStatus\?\.payRules\s*===\s*"error"[\s\S]{0,180}analyse bloquée/,'pay-rule read failure blocks analysis');
has(html,/if\(!payRulesReady\)[\s\S]{0,180}analyse bloquée/,'analyze click guarded by payRulesReady');
has(proxy,/payRulesRead\.state === "error"\s*\?\s*null/,'proxy returns null on pay-rules read error');

// P4: explicit per-resource read state; no false empty for critical datasets
has(proxy,/readStatus\s*=\s*\{[\s\S]*roster:[\s\S]*payRules:[\s\S]*formationOperation:[\s\S]*weekHistory:[\s\S]*signalements:/,'proxy exposes per-resource readStatus');
has(proxy,/weekHistoryRead\.state === "error" \? null/,'week history error is null, not empty');
has(proxy,/signalementsRead\.state === "error" \? null/,'signalements error is null, not empty');
has(html,/hasCriticalCloudReadError/,'critical cloud read failures block final outputs');
has(html,/Données cloud non vérifiables — fichiers bloqués/,'cloud failure has explicit UI blocker');

// P5: operation training tri-state while preserving empty-list neutrality
has(html,/formationOperationLoadState === "error"[\s\S]{0,120}return "unverifiable"/,'operation training has unverifiable state');
has(html,/formationOperationLoadState === "absent"[\s\S]{0,120}return "present"/,'real empty/absent list preserves historical neutral behavior');
has(html,/Formation Opération non vérifiable/,'promotion text exposes unverifiable state');

// P6 BNVL
has(html,/const effectiveBenevole = !!\(row\.benevole \|\| ov\.benevole\)/,'BNVL legacy override becomes effective status');
has(html,/if\(effectiveBenevole\) paye = 0/,'BNVL base pay forced to zero');
has(html,/if\(e\.benevole\) return 0/,'BNVL final pay forced to zero');
has(html,/function bonusOf\(e\)\{ return e\.benevole \? 0/,'BNVL bonus forced to zero');
has(html,/actifs\.filter\(e=>!e\.benevole && e\.reaCount>0\)\.sort/,'BNVL and zero-rea employees excluded from Top3 ranking');
has(html,/ppaEligibles = actifs\.filter\(e=>!e\.benevole/,'BNVL excluded from PPA manual assignment');
has(html,/financialActifs = actifs\.filter\(e=>!e\.benevole\)/,'BNVL excluded from optional financial bonus selector');

// P7 absence below quota
has(html,/isAbsentThisWeek && !quotaMet[\s\S]{0,500}deduction = FIXED_PAY\[row\.grade\] \|\| 0/,'absent below quota loses fixed salary');
has(html,/let paye = payeTableau - deduction \+ reaCount\*REA_RATE/,'rea pay remains after fixed deduction');

// P8 Top3 source of truth
has(html,/const bonuses=\[BONUS_BY_RANK_CONFIG\[1\]\|\|0,BONUS_BY_RANK_CONFIG\[2\]\|\|0,BONUS_BY_RANK_CONFIG\[3\]\|\|0\]/,'Discord Top3 announcement uses config');
has(html,/const top3Bonuses = \[BONUS_BY_RANK_CONFIG\[1\]\|\|0, BONUS_BY_RANK_CONFIG\[2\]\|\|0, BONUS_BY_RANK_CONFIG\[3\]\|\|0\]/,'Top3 UI uses config');
lacks(html,/3 000 000 \$ \/ 2 000 000 \$ \/ 1 000 000 \$/,'no hardcoded Top3 copy remains');

// P9/P10 strict archive/reopen
has(del,/if\(!archiveRes\.ok\)[\s\S]{0,220}suppression ANNULÉE/,'week delete refuses to delete when archive fails');
const archivePos=del.indexOf('if(!archiveRes.ok)'); const deletePos=del.indexOf('method: "DELETE"');
ok(archivePos>=0 && deletePos>archivePos,'archive success check occurs before DELETE');
has(reopen,/if\(!patchRes\.ok\)[\s\S]{0,200}Réouverture refusée/,'reopen reports Firebase PATCH failure');

// P11 permissions unified
for(const src of [proxy,del,reopen,callback]) has(src,/loadPermissionContext\([^\n]*strict:true/,'sensitive endpoint reads strict shared permission context');
has(del,/can\(session\.level, "manage_pay_weeks", permCtx\.custom, session\.discordId, permCtx\.individual\)/,'delete uses grade+individual permission matrix');
has(reopen,/can\(session\.level, "manage_pay_weeks", permCtx\.custom, session\.discordId, permCtx\.individual\)/,'reopen uses grade+individual permission matrix');
has(callback,/can\(level, "use_pillbox_terminal", permCtx\.custom, discordId, permCtx\.individual\)/,'login uses same permission matrix');
has(perms,/async function loadPermissionContext\(idToken, options=\{\}\)/,'shared permission loader supports strict mode');

// P12 session grade refresh
has(renew,/ROSTER_URL[\s\S]{0,2200}resolveUserLevel/,'renew-session rereads roster and resolves current level');
has(renew,/can\(currentLevel, "use_pillbox_terminal"/,'renew-session rechecks Pillbox access');
has(renew,/level:currentLevel/,'renewed token stores current level');
has(html,/body:JSON\.stringify\(\{token:pillboxSessionToken, app:"pillbox"\}\)/,'frontend identifies Pillbox during renewal');
has(html,/pillboxCurrentLevel = data\.level/,'frontend refreshes displayed/current level');

// P13 cleanup/security
lacks(callback,/params\.set\("firebase_token"|firebase_token\s*:/,'firebase token is not returned in callback URL');
has(html,/hasBlockingDuplicateId/,'duplicate unique dossier ID has blocking state');
has(html,/ID dossier dupliqué — fichiers de paie bloqués/,'duplicate dossier ID blocks pay files visibly');
has(html,/if\(ctx\.hasBlockingDuplicateId\)/,'duplicate dossier ID blocks week closure');
lacks(html,/function buildContexte\s*\(/,'Contexte builder removed');
lacks(html,/Les 7 fichiers|CONTEXTE\.txt|fichier Contexte/i,'Contexte/7-file copy removed');
lacks(html,/manifest\.json|installAppBtn|beforeinstallprompt|serviceWorker\.register/,'PWA install machinery removed');
lacks(html,/hors-ligne|aucun compte requis|rien n['’]est envoyé nulle part/i,'false offline/privacy claims removed');
has(html,/Discord\/Firebase\/Netlify|Netlify\/Firebase/,'visible/copy mentions real cloud dependencies');
lacks(html,/"RLP"/,'RLP typo removed');
has(html,/"RL"/,'RL grade present');

console.log(`✅ Pillbox hardening: ${passed} checks passed`);
