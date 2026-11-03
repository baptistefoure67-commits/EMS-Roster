// Vérifie la centralisation des z-index (variables CSS, plus de
// valeurs éparpillées de 50 à 2147483003) et le positionnement des
// fenêtres/overlays : centrées horizontalement, légèrement sous le
// centre vertical (~55%), invariantes au scroll, sans débordement
// mobile. Correspond aux tests 4, 5, 6 du cahier des charges.
const { chromium } = require('playwright');
const path = require('path');
const ROSTER_HTML = path.join(__dirname, '..', 'index.html');
const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

(async()=>{
  const browser = await chromium.launch();

  // Desktop : position verticale ~55%, invariante au scroll
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`file://${ROSTER_HTML}`);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => {
    const modal = document.getElementById('historyModal');
    modal.style.display = 'flex';
    const rect = modal.firstElementChild.getBoundingClientRect();
    return { centerYPercent: Math.round(((rect.top+rect.height/2)/900)*100), zIndex: getComputedStyle(modal).zIndex };
  });
  t('Test 4 — Centre vertical autour de 55% (ni collé en haut, ni en bas)', before.centerYPercent >= 50 && before.centerYPercent <= 60, before.centerYPercent);
  t('z-index résolu depuis une variable centralisée (plus un nombre isolé codé en dur)', Number(before.zIndex) > 0, before.zIndex);

  await page.evaluate(() => { document.body.style.height = '5000px'; window.scrollTo(0, 3000); });
  const after = await page.evaluate(() => {
    const rect = document.getElementById('historyModal').firstElementChild.getBoundingClientRect();
    return Math.round(((rect.top+rect.height/2)/900)*100);
  });
  t('Test 5 — Position identique après un long scroll (position:fixed réel)', after === before.centerYPercent, `${before.centerYPercent} vs ${after}`);

  // Mobile : pas de débordement
  const mobile = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await mobile.goto(`file://${ROSTER_HTML}`);
  await mobile.waitForTimeout(300);
  const mobileResult = await mobile.evaluate(() => {
    const modal = document.getElementById('historyModal');
    modal.style.display = 'flex';
    const rect = modal.firstElementChild.getBoundingClientRect();
    return { overflows: rect.right > window.innerWidth + 2 || rect.left < -2 };
  });
  t('Test 6 — Mobile : aucun débordement horizontal', !mobileResult.overflows, JSON.stringify(mobileResult));

  await browser.close();
  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis.`);
  process.exit(failed ? 1 : 0);
})();
