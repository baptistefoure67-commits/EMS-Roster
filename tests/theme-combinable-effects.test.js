const fs=require('fs'),path=require('path'),vm=require('vm');
let fail=0; const ok=(n,c,e='')=>{console.log((c?'✅ ':'❌ ')+n+(c?'':e?' -> '+e:'')); if(!c)fail++;};
function scriptOf(f){const h=fs.readFileSync(f,'utf8');return {h,s:(h.match(/<script>([\s\S]*?)<\/script>/i)||[])[1]||''};}
function ctx(){const store=new Map(),props=new Map(),classes=new Set(); const c={console,localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},document:{documentElement:{style:{setProperty:(k,v)=>props.set(k,String(v))},classList:{toggle:(k,on)=>on?classes.add(k):classes.delete(k),contains:k=>classes.has(k)}},querySelectorAll:()=>[]}}; c.__store=store;c.__props=props;c.__classes=classes;vm.createContext(c);return c;}
function run(file,kind){const {h,s}=scriptOf(file),c=ctx();vm.runInContext(s,c);
 const fn=kind==='roster'?'rosterApplyThemePalette':'pillboxApplyThemePalette', key=kind==='roster'?'rosterThemePaletteV2':'pillboxThemePaletteV2';
 vm.runInContext(`__a=${fn}({primary:'#ff74d4',primaryEffect:'holographic',secondary:'#d4af37',secondaryEffect:'gold'},{persist:true}); __g=document.documentElement.style;`,c);
 const grad=c.__props.get('--theme-logo-gradient')||'';
 ok(kind+' : Holographique + Or est réellement combiné',grad.includes('#ff74d4')&&grad.includes('#d4af37')&&grad.includes('#fffbe6'),grad);
 ok(kind+' : animation holographique activée',c.__classes.has('theme-holographic'));
 ok(kind+' : effet métallique activé',c.__classes.has('theme-metallic'));
 const stored=JSON.parse(c.__store.get(key)); ok(kind+' : effets sauvegardés séparément',stored.primaryEffect==='holographic'&&stored.secondaryEffect==='gold',JSON.stringify(stored));
 vm.runInContext(`${fn}({primary:'#dc2626',secondary:'#ff74d4',secondaryEffect:'holographic'},{persist:false});`,c);
 const grad2=c.__props.get('--theme-button-gradient')||''; ok(kind+' : Rouge + Holographique conserve le rouge',grad2.includes('#dc2626')&&grad2.includes('#72ddf7'),grad2);
 ok(kind+' : UI présente Holographique et Or dans les deux colonnes', (h.match(/data-effect="\$\{p\.effect/g)||[]).length>=1 && h.includes('SecondaryPresets'));
}
run(path.join(__dirname,'..','index.html'),'roster'); run(path.join(__dirname,'..','__pillbox_for_test.html'),'pillbox');
console.log(`\n${fail?'ÉCHEC':'OK'} — ${fail} échec(s)`);process.exit(fail?1:0);
