const fs=require('fs');
const path=require('path');
let ok=0,fail=0;
function t(name,cond){if(cond){console.log('✅',name);ok++;}else{console.error('❌',name);fail++;}}
const roster=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const pill=fs.readFileSync(path.join(__dirname,'..','..','__pillbox_for_test.html'),'utf8');
const indiv=fs.readFileSync(path.join(__dirname,'..','netlify','functions','manage-individual-permissions.js'),'utf8');
const proxy=fs.readFileSync(path.join(__dirname,'..','netlify','functions','pillbox-proxy.js'),'utf8');

t('Ctrl+S intercepte la sauvegarde navigateur', roster.includes('String(event.key).toLowerCase() !== "s"') && roster.includes('event.preventDefault()'));
t('Ctrl+S clique le vrai bouton Sauvegarder', roster.includes('const btn=document.getElementById("btnSaveAll")') && roster.includes('btn.click()'));
t('Ctrl+S respecte les verrous de sauvegarde', roster.includes('rosterSaveInProgress || rosterSaveReviewOpen'));
t('Le style individuel est stocké séparément des permissions booléennes', indiv.includes('animation_portrait_style'));
t('Seul OWNER peut modifier le style côté serveur', indiv.includes('action === "setAnimationStyle"') && indiv.includes('session.level !== "OWNER"'));
t('Le serveur limite le style aux personnages disposant des deux portraits', indiv.includes('ANIMATION_CHARACTER_IDS') && indiv.includes('Cette personne n\'a pas les deux portraits'));
t('Le profil Roster affiche Dessin IA / Personnage RP uniquement à OWNER', roster.includes('currentUserLevel === "OWNER"') && roster.includes('data-set-anim-style') && roster.includes('🖌️ Dessin IA') && roster.includes('🎭 Personnage RP'));
t('Le panneau de permissions individuelles contient le choix OWNER', roster.includes('data-indiv-animation-style="illustration"') && roster.includes('data-indiv-animation-style="real"'));
t('Sans choix OWNER, le comportement 50/50 reste disponible', roster.includes('configuredAnimationPortraitStyle(ownerDiscordId) || pickAnimationPortraitStyle()'));
t('La scène Roster applique le style du personnage connecté aux deux portraits', roster.includes('animationPortraitStyleForScene(currentUserDiscordId)') && roster.includes('syncColleaguePortrait"), colleagueId, portraitStyle'));
t('Pillbox reçoit le style individuel depuis le proxy', proxy.includes('animPortraitStyleSelf') && proxy.includes('animationPortraitStyles'));
t('Pillbox préfère le style OWNER puis retombe en 50/50', pill.includes('pillboxAnimPortraitStyleSelf || pickAnimationPortraitStyle()'));
t('Le collègue reste équilibré/aléatoire indépendamment du style', roster.includes('pickBalancedEmsColleague(currentUserDiscordId, "roster-sync")') && roster.includes('emsColleagueCycle:${scope||"default"}'));
t('L’exclusion totale des animations est toujours présente', roster.includes('exclude_animations') && pill.includes('pillboxAnimExcludedSelf'));
console.log(`\nRésultat style/shortcut : ${ok} réussi(s), ${fail} échec(s).`); if(fail)process.exit(1);
