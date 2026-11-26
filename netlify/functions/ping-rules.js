// Règles communes des listes de ping (serveur) : qui peut être dans quelle liste,
// et comment une formation validée y ajoute automatiquement la personne formée.
const STAFF = ["DG","D","CD","ADD","MC","RF","RP","RL","MF","MP","MLP","M"];
// Co-Pilote dès Ambulancier, Pilote dès Infirmier, MUP dès Médecin, formateurs MF et au-dessus.
// Jamais de stagiaire (STG) ni WDV.
const ELIGIBLE = {
  pilote: [...STAFF,"BNVL","INF"],
  coPilote: [...STAFF,"BNVL","INF","A"],
  mup: STAFF,
  formateurPilote: ["DG","D","CD","ADD","MC","RF","MF"],
  formateurMup: ["DG","D","CD","ADD","MC","RF","MF"],
};
const FIELDS = { pilote:"pingPilote", coPilote:"pingCoPilote", mup:"pingMup", formateurPilote:"pingFormateurPilote", formateurMup:"pingFormateurMup" };
const LABELS = { pilote:"Pilote", coPilote:"Co-Pilote", mup:"MUP", formateurPilote:"Formateur Pilote", formateurMup:"Formateur MUP" };
// Type de formation validée (historique Discord) -> listes concernées.
// Un Pilote est toujours aussi Co-Pilote dans les compositions de référence.
const FORMATION_TYPE_LISTS = { pilote:["pilote","coPilote"], copilote:["coPilote"], mup:["mup"] };

function applyPingFlags(employees, records){
  const byId = new Map();
  const skipped = [];
  (records||[]).forEach(r=>{
    const lists = FORMATION_TYPE_LISTS[r && r.type];
    if(!lists || !r.trainee) return;
    const idx = employees.findIndex(e=>e && String(e.id)===String(r.trainee.id));
    if(idx===-1) return;
    const e = employees[idx];
    if(e.licencie) return;
    lists.forEach(list=>{
      if(!ELIGIBLE[list].includes(e.grade)){
        if(list===lists[0]) skipped.push({id:e.id,name:e.name,grade:e.grade,list});
        return;
      }
      const field = FIELDS[list];
      if(e[field]===true) return;
      e[field] = true;
      const item = byId.get(e.id) || {id:e.id,name:e.name,lists:[],fields:[],trainerName:(r.trainer&&r.trainer.name)||""};
      item.lists.push(list); item.fields.push(field);
      byId.set(e.id,item);
    });
  });
  const added=[...byId.values()];
  return {employees, changed:added.length>0, added, skipped};
}
module.exports = { STAFF, ELIGIBLE, FIELDS, LABELS, FORMATION_TYPE_LISTS, applyPingFlags };
