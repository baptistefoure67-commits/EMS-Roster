// Source unique des valeurs par défaut de paie partagée entre le panneau Roster
// et le relais Pillbox. Toute modification d'une valeur par défaut se fait ici.
const DEFAULT_PAY_RULES = Object.freeze({
  reaRate: 14000,
  fixedSalaryByGrade: Object.freeze({
    STG: 5000000, A: 6000000, INF: 7000000, M: 8000000,
    MF: 9000000, MP: 9000000, MLP: 9000000,
    RF: 10000000, RP: 10000000, RL: 10000000,
    MC: 11500000, ADD: 11500000, CD: 13500000, D: 15000000, DG: 15000000,
  }),
  bonusByRank: Object.freeze({ "1": 3000000, "2": 2000000, "3": 1000000 }),
  ppaEligibleGrades: Object.freeze(["MP","MLP","RP","RF","RL","MC","ADD","CD","D","DG"]),
  ppaWeeklyCap: 10000000,
  quotaStandard: 70,
  quotaStaff: 30,
  exemptGrades: Object.freeze(["MC","ADD","CD","D","DG"]),
  nearMissGrades: Object.freeze(["STG","A","INF","M"]),
  nearMissThreshold: 65,
  stgProposalThreshold: 2,
  stgAutoThreshold: 3,
  aProposalThreshold: 3,
  infProposalEnabled: false,
  infProposalThreshold: 3,
  extraQProposalGrades: Object.freeze([]),
  extraQProposalThreshold: 3,
  qaCumulThreshold: 3,
  // (26/10, audit confirmé) Manquaient ici malgré le commentaire "source
  // unique des valeurs par défaut" — Roster/Pillbox avaient chacun leur
  // propre valeur de secours codée en dur (500000/70000), exactement ce
  // que ce fichier est censé éviter.
  recruitmentPrice: 500000,
  formationPrice: 70000,
  updatedAt: null,
  updatedBy: null,
});

function cloneDefaultPayRules(){
  return {
    ...DEFAULT_PAY_RULES,
    fixedSalaryByGrade: { ...DEFAULT_PAY_RULES.fixedSalaryByGrade },
    bonusByRank: { ...DEFAULT_PAY_RULES.bonusByRank },
    ppaEligibleGrades: [...DEFAULT_PAY_RULES.ppaEligibleGrades],
    exemptGrades: [...DEFAULT_PAY_RULES.exemptGrades],
    nearMissGrades: [...DEFAULT_PAY_RULES.nearMissGrades],
    extraQProposalGrades: [...DEFAULT_PAY_RULES.extraQProposalGrades],
  };
}

module.exports = { DEFAULT_PAY_RULES, cloneDefaultPayRules };
