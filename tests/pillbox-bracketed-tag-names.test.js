// Suite autonome (demandé — Tio War renommé "..[D] Tio War" sur Discord,
// le grade entre crochets collait au nom et cassait le rapprochement) :
// normalizeNameForMatch retire maintenant tout segment entre crochets ou
// parenthèses, où qu'il soit dans le nom, pour n'importe qui.
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

  const r = await page.evaluate(() => ({
    tio: normalizeNameForMatch('..[D] Tio War'),
    tioTable: normalizeNameForMatch('Tio War'),
    bracketMid: normalizeNameForMatch('Jean [ADD] Dupont'),
    bracketEnd: normalizeNameForMatch('Jean Dupont [RF]'),
    parens: normalizeNameForMatch('Jean Dupont (CD)'),
    normal: normalizeNameForMatch('Jean Dupont'),
  }));
  t('Tio avec ..[D] devant -> identique au nom du tableau', r.tio === r.tioTable, JSON.stringify(r));
  t('Crochet au milieu du nom géré aussi', r.bracketMid === 'jeandupont', r.bracketMid);
  t('Crochet à la fin géré aussi', r.bracketEnd === 'jeandupont', r.bracketEnd);
  t('Parenthèses gérées aussi', r.parens === 'jeandupont', r.parens);
  t('Nom normal inchangé', r.normal === 'jeandupont', r.normal);

  // Bout en bout : reconnaissance reelle via parseReanimationsByName
  const r2 = await page.evaluate(() => {
    const weekStart = new Date('2026-10-17');
    const { rows } = parseTableau('📂:dossier1\tTio War\t100001\tD\t\t\tf0\t01/01\t0\t01/01\tf4', weekStart);
    const rowKey = normalizeNameForMatch(rows[0].name);
    const reaByName = parseReanimationsByName('1. ..[D] Tio War - Réa : 184');
    return reaByName.map[rowKey];
  });
  t('Bout en bout : Tio War du tableau trouve bien sa réa malgré ..[D] devant', r2 === 184, r2);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
