const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const pillboxPath = path.join(root, '..', '__pillbox_for_test.html');
const pillbox = fs.readFileSync(pillboxPath, 'utf8');
const proxy = fs.readFileSync(path.join(root, 'netlify', 'functions', 'pillbox-proxy.js'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'firebase-rules.permissions-regroupees.json'), 'utf8');
let ok = 0;
function test(name, fn){ try{ fn(); ok++; console.log(`✅ ${name}`); } catch(e){ console.error(`❌ ${name}`); throw e; } }

test('Le bouton/fenêtre de configuration Rôles Discord a disparu de Pillbox', ()=>{
  ['discordRolesConfigBtn','discordRolesModal','pillboxDiscordRoles'].forEach(s=>assert.ok(!pillbox.includes(s), s));
});

test('Le proxy ne charge ni ne sauvegarde pillboxDiscordRoles', ()=>{
  ['saveDiscordRoles','pillboxDiscordRoles','DISCORD_ROLES_URL'].forEach(s=>assert.ok(!proxy.includes(s), s));
});

test('Les règles Firebase ne contiennent plus pillboxDiscordRoles', ()=>{
  assert.ok(!rules.includes('pillboxDiscordRoles'));
});

test('Le mode daltonien ne rajoute plus une deuxième coche/croix', ()=>{
  assert.ok(!pillbox.includes('body.colorblind-mode [data-val="true"]::before'));
  assert.ok(!pillbox.includes('body.colorblind-mode [data-val="false"]::before'));
});

test('Tous les boutons Oui/Non portent déjà leur symbole visible', ()=>{
  const re=/<button[^>]*data-val="(true|false)"[^>]*>([\s\S]*?)<\/button>/g;
  let m, count=0;
  while((m=re.exec(pillbox))){
    count++;
    const text=m[2].replace(/<[^>]+>/g,'').trim();
    assert.ok(text.startsWith(m[1]==='true'?'✓':'✕'), `${m[1]}: ${text}`);
  }
  assert.ok(count>=10, `seulement ${count} boutons trouvés`);
});

console.log(`\nCorrectifs 22/10 : ${ok} test(s) réussi(s), 0 échec.`);
