// Vérifie que le résumé "Vérifier avant de sauvegarder" affiche le vrai
// nom de la personne pour un changement de suivi d'activité — corrige
// un bug où ça affichait "ID 146389" au lieu du nom, parce que
// activityDisplayName() appelait resolveActiviteIdentity(), une
// fonction qui n'a jamais existé dans ce fichier (le typeof échouait
// toujours silencieusement, sans jamais remonter d'erreur visible).
const http = require("http"), fs = require("fs"), path = require("path");
let chromiumMod;
try{ ({ chromium: chromiumMod } = require("playwright")); }
catch(e){ console.log("⏭️  SKIP navigateur : paquet playwright absent (npm i playwright)."); process.exit(0); }
const ROSTER_HTML = path.join(__dirname, "..", "index.html");
const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

(async()=>{
  const server = http.createServer((req,res)=>{
    fs.readFile(ROSTER_HTML, (err,data)=>{ if(err){ res.writeHead(404); res.end(); return; } res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); res.end(data); });
  });
  await new Promise(r=>server.listen(0, r));
  const PORT = server.address().port;
  const browser = await chromiumMod.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);

  const byId = await page.evaluate(() => {
    employees.push({id:'1', name:'Baptiste Fore', idUnique:'146389', grade:'ADD', licencie:false});
    return activityDisplayName('id:146389');
  });
  t('Clé id: résolue vers le vrai nom (plus "ID 146389")', byId === 'Baptiste Fore', byId);

  const byName = await page.evaluate(() => activityDisplayName('name:baptiste fore'));
  t('Clé name: résolue vers le vrai nom', byName === 'Baptiste Fore', byName);

  const unknownKey = await page.evaluate(() => activityDisplayName('id:000000'));
  t('Personne introuvable : message clair, jamais une erreur JS', typeof unknownKey === 'string' && unknownKey.length > 0, unknownKey);

  // "Unexpected token '<'" est un artefact connu de ce mini-serveur de
  // test (il ne sert que index.html — un fetch("/.netlify/functions/...")
  // reçoit donc du HTML 404 au lieu du JSON attendu, même sans rien
  // toucher). Rien à voir avec ce test ; en production ces fonctions
  // existent et répondent normalement.
  const realErrors = errors.filter(e => !/Unexpected token/.test(e));
  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS inattendues: ${realErrors.length}`);
  realErrors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || realErrors.length ? 1 : 0);
})();
