// Corrige un cas réel rapporté le 01/11 : le texte Discord collé
// "@[MP] Aaliyah Akada formation M.U.P validée" était importé comme
// "Leyah Akada" (MC) au lieu de rester "à vérifier" — la correspondance
// approximative par nom ne vérifiait jamais le grade annoncé dans le
// message, et "M.U.P" (avec points) n'était pas reconnu comme type de
// formation (devenait "formation non reconnue").
const imp = require('../netlify/functions/formation-import.js')._test;
const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

const employees = [
  { id:'e1', name:"Pablo O'Connor", discordId:'1', grade:'MF', licencie:false },
  { id:'e2', name:'Aaliyah Babidi', discordId:'2', grade:'MP', licencie:false },
  { id:'e3', name:'Leyah Akada', discordId:'3', grade:'MC', licencie:false },
];

// --- extractGradeTag ---
t('extractGradeTag lit "[MP]" en tête de nom', imp.extractGradeTag('[MP] Aaliyah Akada')==='MP');
t('extractGradeTag lit "@[MC]" (avec arobase)', imp.extractGradeTag('@[MC] Jean Dupont')==='MC');
t('extractGradeTag renvoie null sans tag', imp.extractGradeTag('Jean Dupont')===null);
t('extractGradeTag ignore un tag non reconnu', imp.extractGradeTag('[XYZ] Jean Dupont')===null);

// --- matchEmployee : le grade annoncé écarte une fausse correspondance ---
const withGrade = imp.matchEmployee('Aaliyah Akada', employees, 'MP');
t('Avec le grade annoncé (MP), ne matche plus à tort "Leyah Akada" (MC)', withGrade.employee===null, JSON.stringify(withGrade));
const withoutGrade = imp.matchEmployee('Aaliyah Akada', employees, null);
t('Sans grade annoncé, l\'ancien comportement (bug) est bien reproductible — confirme la cause', withoutGrade.employee?.name==='Leyah Akada', JSON.stringify(withoutGrade));

// Non-régression : une correspondance exacte par nom n'est jamais affectée par le grade
const exactMatch = imp.matchEmployee("Pablo O'Connor", employees, 'MP'); // grade volontairement faux
t('Une correspondance EXACTE par nom reste prioritaire, même si le grade annoncé est faux', exactMatch.employee?.name==="Pablo O'Connor", JSON.stringify(exactMatch));

// --- formationTypeFromLine : M.U.P avec points ---
t('"formation M.U.P validée" (avec points) reconnu comme MUP', imp.formationTypeFromLine('formation M.U.P validée')==='mup');
t('"formation MUP validée" (sans points) toujours reconnu', imp.formationTypeFromLine('formation MUP validée')==='mup');
t('"formation Pilote validée" non affecté (non-régression)', imp.formationTypeFromLine('formation Pilote validée')==='pilote');
t('"formation Opération validée" non affecté (non-régression)', imp.formationTypeFromLine('formation Operation validée')==='operation');

// --- Cas réel complet, texte exact collé par l'utilisateur ---
const rawText = `[MF] Pablo O'Connor [LS],  — 21:46
@[MP] Aaliyah Akada  formation M.U.P validée
[MF] Pablo O'Connor [LS],  — 22:11
@[MP] Aaliyah Akada Formation Pilote validée`;
const parsed = imp.parseDiscordFormationText(rawText, Date.now());
t('Les 2 lignes sont bien détectées', parsed.records.length===2, JSON.stringify(parsed.records.length));
t('Le type "mup" est bien détecté sur la 1ère ligne malgré les points', parsed.records[0]?.type==='mup', parsed.records[0]?.type);
const enriched = imp.enrichParsed(parsed, employees, {});
t('Les 2 lignes restent "à vérifier" (aucune fausse correspondance)', enriched.every(r=>!r.trainee), JSON.stringify(enriched.map(r=>r.trainee?.name||null)));

console.log(results.join('\n'));
console.log(`\n${results.length-failed}/${results.length} réussis.`);
if(failed) process.exit(1);
