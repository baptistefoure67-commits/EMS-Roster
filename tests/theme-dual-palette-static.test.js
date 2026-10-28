const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function t(name, cond, extra=''){
  if(cond) console.log('✅ '+name);
  else { failed++; console.log('❌ '+name+(extra?' -> '+extra:'')); }
}
function firstInlineScript(html){
  const m = html.match(/<script>([\s\S]*?)<\/script>/i);
  if(!m) throw new Error('script inline introuvable');
  return m[1];
}
function makeContext(){
  const store = new Map();
  const props = new Map();
  const classes = new Set();
  const context = {
    console,
    localStorage: {
      getItem:k=>store.has(k)?store.get(k):null,
      setItem:(k,v)=>store.set(k,String(v)),
      removeItem:k=>store.delete(k),
    },
    document: {
      documentElement: {
        style: { setProperty:(k,v)=>props.set(k,String(v)) },
        classList: { toggle:(k,on)=>{ if(on) classes.add(k); else classes.delete(k); }, contains:k=>classes.has(k) },
      },
      querySelectorAll:()=>[],
    },
  };
  context.__store = store; context.__props = props; context.__classes = classes;
  vm.createContext(context);
  return context;
}
function runTheme(file, kind){
  const html = fs.readFileSync(file,'utf8');
  const ctx = makeContext();
  vm.runInContext(firstInlineScript(html), ctx, {filename:file});
  if(kind==='roster'){
    vm.runInContext(`
      __r = rosterApplyThemePalette({primary:'#ff3b81', secondary:'#7c4dff'}, {persist:true});
      __legacy = localStorage.getItem('rosterThemeColor');
      __v2 = JSON.parse(localStorage.getItem('rosterThemePaletteV2'));
      __dual = document.documentElement.classList.contains('theme-dual');
      localStorage.removeItem('rosterThemePaletteV2'); localStorage.setItem('rosterThemeColor','#7c3aed');
      __legacyRead = rosterReadStoredTheme();
      for(const p of [{primary:'#ffff00',secondary:'#000080'},{primary:'#ff0000',secondary:'#00ff00'},{primary:'#ff0000',secondary:'#ff0000'},{primary:'#000000',secondary:null},{primary:'#ffffff',secondary:null}]) rosterApplyThemePalette(p,{persist:false});
    `, ctx);
    t('Roster : duo appliqué', ctx.__dual === true);
    t('Roster : ancienne clé conservée', ctx.__legacy === '#ff3b81', ctx.__legacy);
    t('Roster : palette V2 sauvegardée', JSON.stringify(ctx.__v2) === JSON.stringify({primary:'#ff3b81',secondary:'#7c4dff'}), JSON.stringify(ctx.__v2));
    t('Roster : ancienne valeur relue en mode 1 couleur', JSON.stringify(ctx.__legacyRead) === JSON.stringify({primary:'#7c3aed',secondary:null}), JSON.stringify(ctx.__legacyRead));
    t('Roster : variables gradient créées', String(ctx.__props.get('--theme-logo-gradient')||'').includes('linear-gradient'));
    t('Roster : contrôles UI duo présents', html.includes('rosterThemeAddSecondaryBtn') && html.includes('rosterThemeSecondaryInput'));
    t('Roster : logo lié au thème avec fallback @supports', html.includes('roster-logo-wrap') && html.includes('@supports (mix-blend-mode:color) and ((-webkit-mask-image'));
  } else {
    vm.runInContext(`
      __r = pillboxApplyThemePalette({primary:'#ff3b81', secondary:'#7c4dff'}, {persist:true});
      __legacy = localStorage.getItem('pillboxThemeColor');
      __v2 = JSON.parse(localStorage.getItem('pillboxThemePaletteV2'));
      __dual = document.documentElement.classList.contains('theme-dual');
      localStorage.removeItem('pillboxThemePaletteV2'); localStorage.setItem('pillboxThemeColor','#db2777');
      __legacyRead = pillboxReadStoredTheme();
      for(const p of [{primary:'#ffff00',secondary:'#000080'},{primary:'#ff0000',secondary:'#00ff00'},{primary:'#ff0000',secondary:'#ff0000'},{primary:'#000000',secondary:null},{primary:'#ffffff',secondary:null}]) pillboxApplyThemePalette(p,{persist:false});
    `, ctx);
    t('Pillbox : duo appliqué', ctx.__dual === true);
    t('Pillbox : ancienne clé conservée', ctx.__legacy === '#ff3b81', ctx.__legacy);
    t('Pillbox : palette V2 sauvegardée', JSON.stringify(ctx.__v2) === JSON.stringify({primary:'#ff3b81',secondary:'#7c4dff'}), JSON.stringify(ctx.__v2));
    t('Pillbox : ancienne valeur relue en mode 1 couleur', JSON.stringify(ctx.__legacyRead) === JSON.stringify({primary:'#db2777',secondary:null}), JSON.stringify(ctx.__legacyRead));
    t('Pillbox : variables gradient créées', String(ctx.__props.get('--theme-logo-gradient')||'').includes('linear-gradient'));
    t('Pillbox : contrôles UI duo présents', html.includes('pillboxThemeAddSecondaryBtn') && html.includes('pillboxThemeSecondaryInput'));
    t('Pillbox : logo duo protégé par @supports', html.includes('pillbox-logo-wrap') && html.includes('@supports (mix-blend-mode:color)'));
    t('Pillbox : couleurs métier non redéfinies par le JS thème', !firstInlineScript(html).includes('setProperty("--green"') && !firstInlineScript(html).includes('setProperty("--danger"'));
  }
}

runTheme(path.join(__dirname,'..','index.html'),'roster');
runTheme(path.join(__dirname,'..','__pillbox_for_test.html'),'pillbox');
console.log(`\n${failed ? 'ÉCHEC' : 'OK'} — ${failed} test(s) en échec`);
process.exit(failed ? 1 : 0);
