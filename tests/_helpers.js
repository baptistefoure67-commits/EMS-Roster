// Aide commune aux tests : retrouve le index.html de Pillbox sans chemin figé.
// Priorité : variable PILLBOX_HTML (ou PILLBOX_TEST_HTML), puis les dossiers voisins
// habituels. Exemple : PILLBOX_HTML=../pillbox/index.html node tests/security-hardening.test.js
const fs = require('fs'), path = require('path');
function candidates(){
  return [
    process.env.PILLBOX_HTML, process.env.PILLBOX_TEST_HTML,
    path.join(__dirname, '..', '..', 'pillbox', 'index.html'),
    path.join(__dirname, '..', '..', '..', 'pillbox', 'index.html'),
    path.join(__dirname, '..', 'pillbox', 'index.html'),
    path.join(__dirname, '..', '..', '__pillbox_for_test.html'),
    path.join(__dirname, '..', '__pillbox_for_test.html'),
  ].filter(Boolean);
}
function pillboxHtmlPath(){
  const list = candidates();
  for(const p of list){ try{ if(fs.statSync(p).isFile()) return p; }catch(e){} }
  throw new Error('Pillbox index.html introuvable. Définis PILLBOX_HTML=/chemin/vers/pillbox/index.html. Chemins essayés : ' + list.join(' , '));
}
module.exports = { pillboxHtmlPath, readPillbox: () => fs.readFileSync(pillboxHtmlPath(), 'utf8') };
