// Finnish team names -> English aliases, with tolerant matching.
// Used to map football-data.org match teams onto our spreadsheet matches.

// Normalize any name: lowercase, strip diacritics, keep only a-z0-9.
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Canonical English alias list per team. Keys are normalized Finnish names.
// Multiple Finnish spelling variants can map to the same English aliases.
const FI_TO_EN = {
  meksiko: ['mexico'],
  etelaafrikka: ['southafrica'],
  etelakorea: ['southkorea', 'korearepublic', 'korea'],
  korea: ['southkorea', 'korearepublic', 'korea'],
  tsekki: ['czechrepublic', 'czechia'],
  kanada: ['canada'],
  bosnia: ['bosniaandherzegovina', 'bosniaherzegovina', 'bosnia'],
  bosniajahertsegovina: ['bosniaandherzegovina', 'bosniaherzegovina', 'bosnia'],
  usa: ['unitedstates', 'usa', 'unitedstatesofamerica', 'unitedstatesamerica'],
  paraguay: ['paraguay'],
  qatar: ['qatar'],
  sveitsi: ['switzerland'],
  brasilia: ['brazil'],
  marokko: ['morocco'],
  haiti: ['haiti'],
  skotlanti: ['scotland'],
  australia: ['australia'],
  turkki: ['turkey', 'turkiye'],
  saksa: ['germany'],
  curacao: ['curacao'],
  hollanti: ['netherlands', 'holland'],
  japani: ['japan'],
  norsunluuran: ['ivorycoast', 'cotedivoire'],
  norsunluurannikko: ['ivorycoast', 'cotedivoire'],
  ecuador: ['ecuador'],
  ruotsi: ['sweden'],
  tunisia: ['tunisia'],
  espanja: ['spain'],
  capverde: ['capeverde', 'caboverde'],
  belgia: ['belgium'],
  egypti: ['egypt'],
  saudiarabia: ['saudiarabia'],
  saudia: ['saudiarabia'],
  uruguay: ['uruguay'],
  iran: ['iran', 'iranislamicrepublic'],
  uusiseelanti: ['newzealand'],
  ranska: ['france'],
  senegal: ['senegal'],
  irak: ['iraq'],
  norja: ['norway'],
  argentiina: ['argentina'],
  algeria: ['algeria'],
  itavalta: ['austria'],
  jordania: ['jordan'],
  portugali: ['portugal'],
  kongo: ['congo', 'drcongo', 'congodr', 'democraticrepublicofcongo', 'republicofcongo'],
  englanti: ['england'],
  kroatia: ['croatia'],
  ghana: ['ghana'],
  panama: ['panama'],
  uzbekistan: ['uzbekistan'],
  kolumbia: ['colombia'],
};

// Return the set of normalized English aliases accepted for a Finnish team name.
function aliasesFor(finnishName) {
  const key = norm(finnishName);
  if (FI_TO_EN[key]) return FI_TO_EN[key];
  // Fallback: try the normalized Finnish itself (covers names already in English form).
  return [key];
}

// Does an API team name (any language) match our Finnish team name?
function teamMatches(finnishName, apiName) {
  const a = norm(apiName);
  const accepted = aliasesFor(finnishName);
  if (accepted.includes(a)) return true;
  // Loose contains check both ways for compound names.
  return accepted.some(x => x && (a.includes(x) || x.includes(a)) && Math.min(a.length, x.length) >= 4);
}

module.exports = { norm, aliasesFor, teamMatches, FI_TO_EN };
