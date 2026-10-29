// Suite autonome (demandé — pseudos Discord en police stylisée, ex.
// Khaleb Jonhson en gras-italique mathématique) : normalizeNameForMatch
// doit reconnaître ces caractères Unicode spéciaux et les ramener à
// leurs lettres normales, pour un rapprochement automatique à l'étape 3
// sans confirmation manuelle répétée chaque semaine.
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
    return {
      khaleb: normalizeNameForMatch('𝑲𝒉𝒂𝒍𝒆𝒃 𝑱𝒐𝒏𝒉𝒔𝒐𝒏'),
      bold: normalizeNameForMatch('𝐉𝐞𝐚𝐧 𝐃𝐮𝐩𝐨𝐧𝐭'),
      script: normalizeNameForMatch('𝒥𝑒𝒶𝓃'), // script capital J (exception) + italique
      frakturC: normalizeNameForMatch('ℭ'), // fraktur C (exception)
      doubleStruck: normalizeNameForMatch('𝔸𝔹ℂ'), // double-barre A,B,C(exception)
      monospace: normalizeNameForMatch('𝙹𝚎𝚊𝚗'),
      digits: normalizeNameForMatch('𝟏𝟐𝟑'),
      normal: normalizeNameForMatch('Jean Dupont'),
      accented: normalizeNameForMatch('José Müller'),
    };
  });
  t('Khaleb Jonhson (gras-italique) -> khalebjonhson', r.khaleb === 'khalebjonhson', r.khaleb);
  t('Jean Dupont en gras -> jeandupont', r.bold === 'jeandupont', r.bold);
  t('Lettres script (y compris exception J) -> jean', r.script === 'jean', r.script);
  t('Fraktur exception C -> c', r.frakturC === 'c', r.frakturC);
  t('Double-barré A,B,C -> abc', r.doubleStruck === 'abc', r.doubleStruck);
  t('Monospace Jean -> jean', r.monospace === 'jean', r.monospace);
  t('Chiffres stylisés 123 -> 123', r.digits === '123', r.digits);
  t('Texte normal inchangé', r.normal === 'jeandupont', r.normal);
  t('Accents toujours geres (non-regression)', r.accented === 'josemuller', r.accented);

  const re2e = await page.evaluate(() => {
    const weekStart = new Date('2026-10-17');
    const { rows } = parseTableau('📂:dossier1\t[A] Khaleb Jonhson\t100001\tA\t\t\tf0\t01/01\t0\t01/01\tf4', weekStart);
    const reaByName = parseReanimationsByName('1. \ud835\udc72\ud835\udc89\ud835\udc82\ud835\udc8d\ud835\udc86\ud835\udc83 \ud835\udc71\ud835\udc90\ud835\udc8f\ud835\udc89\ud835\udc94\ud835\udc90\ud835\udc8f - Réa : 120');
    const rowKey = normalizeNameForMatch(rows[0].name);
    return reaByName.map[rowKey];
  });
  t('Khaleb du tableau EMS trouve directement sa réa malgré le pseudo stylisé — reconnu automatiquement', re2e === 120, re2e);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
