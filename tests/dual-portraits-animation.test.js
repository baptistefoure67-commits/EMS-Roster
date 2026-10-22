const fs=require('fs');
const path=require('path');
let ok=0, fail=0;
function t(name, cond){ if(cond){console.log('✅',name);ok++;} else {console.error('❌',name);fail++;} }
const roster=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8') + '\n' + fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const pill=fs.readFileSync(path.join(__dirname,'..','..','__pillbox_for_test.html'),'utf8');
const perm=fs.readFileSync(path.join(__dirname,'..','netlify','functions','permissions.js'),'utf8');
const indiv=fs.readFileSync(path.join(__dirname,'..','netlify','functions','manage-individual-permissions.js'),'utf8');
const proxy=fs.readFileSync(path.join(__dirname,'..','netlify','functions','pillbox-proxy.js'),'utf8');
function objKeys(src,name){
  const start=src.indexOf(`const ${name} = {`); if(start<0)return [];
  const bs=src.indexOf('{',start);let dep=0,inq=null,esc=false,end=-1;
  for(let i=bs;i<src.length;i++){const c=src[i];if(inq){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===inq)inq=null;}else{if(c==='"'||c==="'"||c==='`')inq=c;else if(c==='{')dep++;else if(c==='}'&&--dep===0){end=i;break;}}}
  if(end<0)return[]; const block=src.slice(bs+1,end); return [...block.matchAll(/"(\d+)"\s*:/g)].map(m=>m[1]);
}
const ai=objKeys(roster,'CHARACTER_PORTRAITS');
const real=objKeys(roster,'CHARACTER_REAL_PORTRAITS');
t('Roster contient un deuxième objet de photos réelles', roster.includes('const CHARACTER_REAL_PORTRAITS = {'));
t('Les 9 clés réelles correspondent exactement aux 9 clés IA', ai.length===9 && real.length===9 && [...ai].sort().join(',')===[...real].sort().join(','));
t('Pillbox possède aussi les deux objets', pill.includes('const CHARACTER_REAL_PORTRAITS = {') && objKeys(pill,'CHARACTER_REAL_PORTRAITS').length===9);
t('Le style est résolu une seule fois au début d’une animation Roster (choix OWNER ou 50/50)', roster.includes('let portraitStyle = animationPortraitStyleForScene(currentUserDiscordId)'));
t('Synchroniser applique le même portraitStyle aux deux personnes', roster.includes('syncMePortrait"), currentUserDiscordId, portraitStyle') && roster.includes('syncColleaguePortrait"), colleagueId, portraitStyle'));
t('Sauvegarder applique le même portraitStyle aux deux personnes', roster.includes('saveRosterPortrait"), currentUserDiscordId, portraitStyle') && roster.includes('saveRosterColleaguePortrait"), colleagueId, portraitStyle'));
t('Pillbox applique le même portraitStyle aux deux personnes', pill.includes("payrollPortrait'), myId, portraitStyle") && pill.includes("guestPortrait'), guestId, portraitStyle"));
t('Le style réel retombe en dessin pour toute la scène si un participant n’a pas de photo', roster.includes('normalizeAnimationPortraitStyle') && pill.includes('normalizeAnimationPortraitStyle'));
t('La rotation équilibrée ne contient pas le style dans sa clé', roster.includes('emsColleagueCycle:${scope||"default"}') && !roster.includes('emsColleagueCycle:${portraitStyle'));
t('Roster filtre les personnes exclues avant le tirage', roster.includes('!isAnimationCharacterExcluded(id)'));
t('Pillbox filtre les personnes exclues avant le tirage', pill.includes('!isAnimationCharacterExcluded(id)'));
const gradeStart=perm.indexOf('const GRADE_PERMISSION_KEYS = ['); const gradeEnd=perm.indexOf('];',gradeStart)+2; const gradeBlock=perm.slice(gradeStart,gradeEnd);
t('La permission exclusion est individuelle uniquement', perm.includes('\"exclude_animations\"') && !gradeBlock.includes('exclude_animations') && perm.includes('const INDIVIDUAL_ONLY_KEYS = [\"owner_delegate\", \"manage_troll\", \"exclude_animations\"]'));
t('D/DG/OWNER peuvent gérer l’exclusion sans ouvrir les autres permissions', indiv.includes('canManageAnimationExclusion = ["D","DG","OWNER"].includes(session.level)') && indiv.includes('canonical !== "exclude_animations" && !canManagePermissions'));
t('Le panneau individuel affiche clairement l’exclusion', roster.includes('🚫 Exclure des animations') && roster.includes('N’apparaît ni comme personnage connecté'));
t('Pillbox reçoit la liste d’exclusion via le proxy', proxy.includes('animationExcludedIds') && proxy.includes('animExcludedSelf'));
t('Une personne exclue ne voit pas sa propre animation Roster', roster.includes('hasCap("exclude_animations")') || roster.includes('isAnimationCharacterExcluded(currentUserDiscordId)'));
t('Une personne exclue ne voit pas sa propre animation Pillbox', pill.includes('pillboxAnimExcludedSelf || reduced'));
t('Alias Papy du document est accepté sans doubler la rotation', roster.includes('514871271352434699') && roster.includes('51487127135243469'));
console.log(`\nRésultat portraits/animations : ${ok} réussi(s), ${fail} échec(s).`); if(fail)process.exit(1);
