// Suite autonome (signalé par l'utilisateur, 401 Firebase) : la lecture
// des propositions de signalement en attente doit envoyer un jeton
// d'authentification — cassé depuis le durcissement de
// signalementPropositions.read ("auth != null" au lieu de "true") lors
// de l'audit du 26/10, car cette lecture n'envoyait jamais de jeton.
const path = require("path"), http = require("http"), fs = require("fs");
let chromiumMod;
try{ ({ chromium: chromiumMod } = require("playwright")); }
catch(e){ console.log("⏭️  SKIP navigateur : paquet playwright absent (npm i playwright)."); process.exit(0); }
const ROSTER_PATH = path.join(__dirname, "..", "index.html");
const server = http.createServer((req,res)=>{
  const p = (req.url.split("?")[0]==="/"||req.url.split("?")[0]==="/index.html") ? ROSTER_PATH : null;
  if(!p){ res.writeHead(404); res.end(); return; }
  fs.readFile(p, (err,data)=>{ if(err){ res.writeHead(404); res.end(); return; } res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); res.end(data); });
});


const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

(async()=>{
  await new Promise(r=>server.listen(0, r));
  const PORT = server.address().port;
  const browser = await chromiumMod.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  let capturedUrl = null;
  await page.route('**/signalementPropositions.json*', async route=>{
    capturedUrl = route.request().url();
    route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    document.getElementById('accessGate').style.display='none';
    document.getElementById('appContent').style.display='';
    currentFirebaseIdToken = 'FAKE_TOKEN_FOR_TEST';
  });
  // force l'affichage du bouton/carte propositions pour pouvoir appeler la fonction
  await page.evaluate(() => {
    window.__canValidateBackup = canValidateSignalement;
    canValidateSignalement = () => true;
    document.getElementById('propositionsCard').style.display = '';
  });
  await page.evaluate(() => loadPropositionsPending());
  await page.waitForTimeout(200);

  t('La lecture de signalementPropositions envoie bien un jeton (?auth=)', capturedUrl && capturedUrl.includes('auth=FAKE_TOKEN_FOR_TEST'), capturedUrl);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
