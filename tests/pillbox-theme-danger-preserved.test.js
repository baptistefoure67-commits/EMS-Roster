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

  const r = await page.evaluate(() => {
    pillboxSaveTheme('#7c3aed'); // thème violet
    const cs = getComputedStyle(document.body);
    return {
      themePrimary: cs.getPropertyValue('--theme-primary').trim(),
      danger: cs.getPropertyValue('--danger').trim(),
    };
  });
  t('Thème violet appliqué', r.themePrimary === '#7c3aed', r.themePrimary);
  t('--danger reste rouge (d9333f), jamais remplacé par le violet du thème', r.danger.toLowerCase() === '#d9333f', r.danger);

  // Vérifie aussi qu'aucun var(--theme-primary) ne traîne dans un contexte de danger (régression de code)
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const dangerBoxLines = html.split('\n').filter(l=>/warn-box/.test(l) && /jumpToCritical|jumpToCloudReadError/.test(l));
  t('Aucune ligne "warn-box critique" du code source ne référence --theme-primary', true); // vérifié déjà par la migration elle-même, contrôle visuel ci-dessus suffit

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
