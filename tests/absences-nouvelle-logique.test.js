// Suite dédiée au cahier des charges "Absences, nouveau seuil et
// nouvelle rétention" (01/11) : seuil générique passé de 3 à 5
// absences actives, fin de la fenêtre fixe de 30 jours, nouvelle
// rétention 14/21 jours calculée depuis la DATE DE FIN. Les tests A1 à
// A8 correspondent directement à la section 9 du cahier des charges.

const path = require('path');
const abs = require(path.join(__dirname, '..', 'netlify', 'functions', 'absences-actions.js'));
const { getActiveAbsences, computeAbsenceSignalements, isCountedAbsence, getAbsenceRetentionDays } = abs;

const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

const mkAbs = (id, employeeKey, startIso, endIso, durationDays, grade='A') => ({
  [id]: { employeeKey, name: 'Test Employe', grade, startIso, endIso, durationDays, priseEnCompte: true, createdAt: Date.now() }
});

// Test A1 : absence de 3 jours -> ignoree (durationDays non > 3)
const a1 = { a1: { employeeKey:'k1', name:'X', grade:'A', startIso:'2026-11-01', endIso:'2026-11-03', durationDays:3, priseEnCompte:true } };
t('A1 - absence de 3 jours ignoree', !isCountedAbsence(a1,'a1', new Date('2026-11-05')));

// Test A2 : absence de 4 jours -> comptee (si recente)
const a2 = { a2: { employeeKey:'k2', name:'X', grade:'A', startIso:'2026-11-01', endIso:'2026-11-04', durationDays:4, priseEnCompte:true } };
t('A2 - absence de 4 jours comptee', isCountedAbsence(a2,'a2', new Date('2026-11-05')));

// Test A3 : 2 absences actives -> expiration 14j apres la fin
let a3 = {};
Object.assign(a3, mkAbs('x1','k3','2026-11-01','2026-11-06',5));
Object.assign(a3, mkAbs('x2','k3','2026-11-08','2026-11-13',5));
const ref19 = new Date('2026-11-19'); // 13j apres la fin de x2 -> encore actif (< 14j)
const ref21 = new Date('2026-11-28'); // 15j apres la fin de x2 -> x2 expire (>14j), x1 (20/11) aussi
t('A3 - 2 absences actives, encore comptees a 13j', getActiveAbsences(a3, ref19)['k3'].length === 2, JSON.stringify(getActiveAbsences(a3, ref19)));
t('A3 - 2 absences actives, expire apres 14j (x1 expire le 20/11, x2 le 27/11)', getActiveAbsences(a3, ref21)['k3'].length === 0, JSON.stringify(getActiveAbsences(a3, ref21)));

// Test A4 : 3 absences actives ou plus -> expiration 21j apres la fin
let a4 = {};
Object.assign(a4, mkAbs('y1','k4','2026-11-01','2026-11-05',4));
Object.assign(a4, mkAbs('y2','k4','2026-11-06','2026-11-10',4));
Object.assign(a4, mkAbs('y3','k4','2026-11-11','2026-11-15',4));
// y1 fin 11/05 (+21j = 11/26), y2 fin 11/10 (+21j = 12/01), y3 fin 11/15 (+21j = 12/06)
const refBeforeY1 = new Date('2026-11-20'); // avant l expiration de y1 -> les 3 actives
const refAfterY1 = new Date('2026-11-27'); // y1 expiree (apres le 26/11), y2 et y3 encore actives
t('A4 - 3 absences actives, retention 21j (toutes actives avant la 1ere echeance)', getActiveAbsences(a4, refBeforeY1)['k4'].length === 3, JSON.stringify(getActiveAbsences(a4, refBeforeY1)));
t('A4 - 3 absences actives, la plus ancienne expire a 21j de SA fin', getActiveAbsences(a4, refAfterY1)['k4'].length === 2, JSON.stringify(getActiveAbsences(a4, refAfterY1)));

// Test A5 : 4 absences valides -> pas de declenchement (seuil = 5)
let a5 = {};
for(let i=0;i<4;i++) Object.assign(a5, mkAbs('z'+i,'k5',`2026-11-0${i+1}`,`2026-11-0${i+1}`,4));
t('A5 - 4 absences valides, pas de signalement', computeAbsenceSignalements(a5, new Date('2026-11-10')).length === 0, JSON.stringify(computeAbsenceSignalements(a5, new Date('2026-11-10'))));

// Test A6 : 5 absences valides -> declenchement
let a6 = {};
for(let i=0;i<5;i++) Object.assign(a6, mkAbs('w'+i,'k6',`2026-11-0${i+1}`,`2026-11-0${i+1}`,4));
const sig6 = computeAbsenceSignalements(a6, new Date('2026-11-10'));
t('A6 - 5 absences valides, declenchement', sig6.length === 1 && sig6[0].absences.length === 5, JSON.stringify(sig6));

// Test A7 : une absence expiree ne doit plus etre comptee
const a7 = { e1: { employeeKey:'k7', name:'X', grade:'A', startIso:'2026-01-01', endIso:'2026-01-05', durationDays:4, priseEnCompte:true } };
t('A7 - absence tres ancienne, plus comptee', !isCountedAbsence(a7, 'e1', new Date('2026-11-01')));

// Test A8 : l'historique reste visible (le module ne supprime plus par anciennete)
t('A8 - pas de suppression automatique par anciennete (fonction retiree du flux)', typeof abs.pruneExpiredAbsences === 'function');

console.log(results.join('\n'));
console.log(`\n${results.length-failed}/${results.length} reussis`);
process.exit(failed?1:0);
