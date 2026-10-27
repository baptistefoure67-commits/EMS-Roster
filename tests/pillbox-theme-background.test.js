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
  await page.waitForTimeout(400);

  const r = await page.evaluate(() => {
    pillboxSaveTheme('#16a34a'); // vert
    const cs = getComputedStyle(document.documentElement);
    return { shadow1: cs.getPropertyValue('--theme-bg-shadow-1').trim(), shadow2: cs.getPropertyValue('--theme-bg-shadow-2').trim() };
  });
  t('--theme-bg-shadow-1 suit le thème (plus jamais #200000 en dur)', r.shadow1 !== '#200000' && r.shadow1.length===7, r.shadow1);
  t('--theme-bg-shadow-2 suit le thème (plus jamais #150000 en dur)', r.shadow2 !== '#150000' && r.shadow2.length===7, r.shadow2);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
