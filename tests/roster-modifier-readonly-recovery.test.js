const fs=require('fs'),path=require('path'); const h=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8'); let f=0;function t(n,c){console.log((c?'✅ ':'❌ ')+n);if(!c)f++;}
t('Modifier explicitement réactivé en mode Firebase lecture seule',/roster-cloud-readonly[\s\S]{0,500}\[data-edit\][\s\S]{0,250}pointer-events:auto!important/.test(h));
t('Champs de modification réactivés sans autoriser Enregistrer',h.includes('#rosterView [data-edit-slot] input')&&h.includes('#rosterView [data-save]')===false);
t('Enregistrement vérifie rosterCloudConfirmed',h.includes('if(!rosterCloudConfirmed){ toast("⏳ Firebase est encore en vérification'));
t('Récupération Firebase automatique présente',h.includes('scheduleRosterFirebaseRecovery')&&h.includes('refresh-firebase-token'));
t('Récupération limitée en nombre de tentatives',h.includes('rosterFirebaseRecoveryAttempts < 8'));
t('Fond Roster enrichi avec grille discrète',h.includes('--theme-bg-grid')&&h.includes('48px 48px')&&h.includes('96px 96px'));
console.log(`\n${f?'ÉCHEC':'OK'} — ${f} échec(s)`);process.exit(f?1:0);
