const fs=require('fs'), path=require('path'), assert=require('assert');
const root=path.resolve(__dirname,'..');
const src=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert(src.includes('applyUniqueIdMemoryUpdates(result)'), 'capture automatique ID unique absente');
assert(src.includes('ID EMS</span>${esc(e.idUnique)}'), 'ID EMS non affiché dans la ligne principale');
assert(src.includes('if(!currentUnique)'), 'les IDs déjà mémorisés ne sont pas protégés');
assert(src.includes('currentUnique !== incomingUnique'), 'détection conflit ID unique absente');
assert(src.includes('.normalize("NFKD").toLowerCase()'), 'normalisation unicode stylisée absente');
assert(src.includes('replace(/^[^\\p{L}\\p{N}]*\\[[^\\]]*\\]\\s*/u'), 'préfixes de grade parasites non nettoyés');
function norm(s){return String(s??'').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g,'');}
assert.strictEqual(norm('𝑲𝒉𝒂𝒍𝒆𝒃 𝑱𝒐𝒏𝒉𝒔𝒐𝒏'),'khaleb jonhson');
console.log('✅ ID unique EMS : affichage + mémoire + conflits + noms stylisés');
