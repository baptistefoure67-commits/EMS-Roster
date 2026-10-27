// Suite autonome (26/10, personnalisation de couleur Pillbox) : lance son
// propre petit serveur HTTP local pour servir le Pillbox fourni via
// PILLBOX_HTML (ou le dossier voisin par défaut) ; saute proprement si
// playwright est absent.
const path = require("path"), http = require("http"), fs = require("fs");
const { pillboxHtmlPath } = require("./_helpers");
let chromiumMod;
try{ ({ chromium: chromiumMod } = require("playwright")); }
catch(e){ console.log("⏭️  SKIP navigateur : paquet playwright absent (npm i playwright)."); process.exit(0); }
const PB_PATH = pillboxHtmlPath();
const server = http.createServer((req,res)=>{
  const p = (req.url.split("?")[0]==="/"||req.url.split("?")[0]==="/index.html") ? PB_PATH : null;
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
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);

  // Applique un thème personnalisé (vert) PUIS active le mode daltonien
  const r1 = await page.evaluate(() => {
    pillboxSaveTheme('#16a34a'); // thème vert
    document.body.classList.add('colorblind-mode');
    const cs = getComputedStyle(document.body);
    return {
      themePrimary: cs.getPropertyValue('--theme-primary').trim(),
      green: cs.getPropertyValue('--green').trim(),
      amber: cs.getPropertyValue('--amber').trim(),
      danger: cs.getPropertyValue('--danger').trim(),
    };
  });
  t('Thème vert reste appliqué sous mode daltonien', r1.themePrimary === '#16a34a', r1.themePrimary);
  t('Mode daltonien : --green devient bien la palette Okabe-Ito (0072B2), pas écrasé par le thème', r1.green.toLowerCase() === '#0072b2', r1.green);
  t('Mode daltonien : --amber devient bien E69F00, indépendant du thème', r1.amber.toLowerCase() === '#e69f00', r1.amber);
  t('Mode daltonien : --danger devient bien D55E00, indépendant du thème', r1.danger.toLowerCase() === '#d55e00', r1.danger);

  // Désactive le daltonisme -> --green/--amber/--danger reviennent aux couleurs sémantiques normales, thème toujours vert
  const r2 = await page.evaluate(() => {
    document.body.classList.remove('colorblind-mode');
    const cs = getComputedStyle(document.body);
    return { themePrimary: cs.getPropertyValue('--theme-primary').trim(), green: cs.getPropertyValue('--green').trim() };
  });
  t('Daltonisme désactivé : thème vert toujours là', r2.themePrimary === '#16a34a', r2.themePrimary);
  t('Daltonisme désactivé : --green redevient la couleur sémantique normale (pas Okabe-Ito)', r2.green.toLowerCase() !== '#0072b2', r2.green);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
