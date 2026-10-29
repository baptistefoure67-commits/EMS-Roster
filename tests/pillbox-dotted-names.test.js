// Suite autonome (demandé — Tio War renommé "..TioWar" sur Discord,
// plusieurs points cette fois) : normalizeNameForMatch supprime déjà
// toute ponctuation (pas seulement les accents), donc n'importe quel
// nombre de points, à n'importe quelle position, pour N'IMPORTE QUI (pas
// seulement Tio), doit déjà être reconnu automatiquement sans confirmation
// manuelle à l'étape 3. Ce test verrouille ce comportement.
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
    const weekStart = new Date('2026-10-17');
    const { rows } = parseTableau('📂:dossier1\tTio War\t100001\tD\t\t\tf0\t01/01\t0\t01/01\tf4', weekStart);
    const rowKey = normalizeNameForMatch(rows[0].name);
    const cases = [
      '1. .TioWar - Réa : 50',
      '1. ..TioWar - Réa : 50',
      '1. .......... TioWar - Réa : 50',
      '1. Tio..War - Réa : 50',
      '1. ..Tio War.. - Réa : 50',
      '1. T.i.o. War - Réa : 50',
    ];
    return cases.map(line => ({ line, matched: parseReanimationsByName(line).map[rowKey] }));
  });
  for(const { line, matched } of r){
    t(`Reconnu malgré la ponctuation : "${line}"`, matched === 50, matched);
  }

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close();
  server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
