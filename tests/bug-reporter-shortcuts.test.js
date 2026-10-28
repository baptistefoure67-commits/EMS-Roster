// Suite autonome : le raccourci clavier du rapporteur de bug doit
// fonctionner — Ctrl+Shift+B (conservé pour compatibilité, mais Chrome
// peut le réserver à la barre de favoris) ET Ctrl+Alt+D (nouveau
// raccourci fiable ajouté en diagnostic), sur Roster ET Pillbox.
const path = require("path"), http = require("http"), fs = require("fs");
const { pillboxHtmlPath } = require("./_helpers");
let chromiumMod;
try{ ({ chromium: chromiumMod } = require("playwright")); }
catch(e){ console.log("⏭️  SKIP navigateur : paquet playwright absent (npm i playwright)."); process.exit(0); }

const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

// (correction du test lui-même) index.html charge un fichier séparé
// (bug-reporter-roster.js / bug-reporter-pillbox.js) — un serveur qui ne
// sert QUE index.html le laisse en 404, donc le script ne se charge
// jamais et window.EMSBugReport n'existe pas : rien à voir avec le
// raccourci lui-même. Sert maintenant tout fichier du même dossier que
// index.html, comme un vrai serveur statique.
function makeServer(filePath){
  const root = path.dirname(filePath);
  return http.createServer((req,res)=>{
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const rel = urlPath === "/" ? path.basename(filePath) : urlPath.replace(/^\/+/, "");
    const resolved = path.join(root, rel);
    if(!resolved.startsWith(root)){ res.writeHead(403); res.end(); return; }
    fs.readFile(resolved, (err,data)=>{
      if(err){ res.writeHead(404); res.end(); return; }
      const ext = path.extname(resolved);
      const type = ext===".js" ? "application/javascript" : ext===".json" ? "application/json" : "text/html; charset=utf-8";
      res.writeHead(200,{"Content-Type":type}); res.end(data);
    });
  });
}

async function checkSite(browser, filePath, label){
  const server = makeServer(filePath);
  await new Promise(r=>server.listen(0, r));
  const port = server.address().port;
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForTimeout(400);

  // Évènement synthétique plutôt que page.keyboard (simulation clavier
  // niveau OS, peu fiable en environnement automatisé) — teste EXACTEMENT
  // la même logique (le même window.addEventListener('keydown', ...)),
  // juste avec un déclenchement précis et reproductible.
  const r1 = await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, shiftKey: true, altKey: false, bubbles: true, cancelable: true }));
    const el = document.getElementById('emsBugReporterPanel');
    return el ? getComputedStyle(el).display : null;
  });
  t(`${label} : Ctrl+Shift+B ouvre bien le panneau (#emsBugReporterPanel visible)`, r1 === 'flex', r1);

  // Referme comme le bouton Fermer le ferait réellement (display:none,
  // sans retirer le nœud) — openPanel() réutilise le panneau existant,
  // le supprimer du DOM casserait sa logique de réouverture.
  await page.evaluate(() => { const p = document.getElementById('emsBugReporterPanel'); if(p) p.style.display = 'none'; });

  const r2 = await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, altKey: true, shiftKey: false, bubbles: true, cancelable: true }));
    const el = document.getElementById('emsBugReporterPanel');
    return el ? getComputedStyle(el).display : null;
  });
  t(`${label} : Ctrl+Alt+D (nouveau raccourci fiable) ouvre bien le panneau aussi (visible)`, r2 === 'flex', r2);

  t(`${label} : aucune erreur JS`, errors.length === 0, JSON.stringify(errors));
  await page.close();
  server.close();
}

(async()=>{
  const browser = await chromiumMod.launch();
  await checkSite(browser, path.join(__dirname, "..", "index.html"), "Roster");
  await checkSite(browser, pillboxHtmlPath(), "Pillbox");
  await browser.close();
  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis`);
  process.exit(failed ? 1 : 0);
})();
