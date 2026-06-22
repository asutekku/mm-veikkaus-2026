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
  porugali: ['portugal'],   // common misspelling in the sheet
  potugali: ['portugal'],
  equador: ['ecuador'],     // common misspelling in the sheet
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

// English (API) team name -> Finnish display name, keyed by normalized English.
const EN_TO_FI = {
  mexico: 'Meksiko', southafrica: 'Etelä-Afrikka', southkorea: 'Etelä-Korea', korearepublic: 'Etelä-Korea',
  czechia: 'Tšekki', czechrepublic: 'Tšekki', canada: 'Kanada',
  bosniaherzegovina: 'Bosnia ja Hertsegovina', bosniaandherzegovina: 'Bosnia ja Hertsegovina',
  unitedstates: 'Yhdysvallat', unitedstatesofamerica: 'Yhdysvallat', usa: 'Yhdysvallat',
  paraguay: 'Paraguay', qatar: 'Qatar', switzerland: 'Sveitsi', brazil: 'Brasilia', morocco: 'Marokko',
  haiti: 'Haiti', scotland: 'Skotlanti', australia: 'Australia', turkey: 'Turkki', turkiye: 'Turkki',
  germany: 'Saksa', curacao: 'Curaçao', netherlands: 'Hollanti', holland: 'Hollanti', japan: 'Japani',
  ivorycoast: 'Norsunluurannikko', cotedivoire: 'Norsunluurannikko', ecuador: 'Ecuador', sweden: 'Ruotsi',
  tunisia: 'Tunisia', spain: 'Espanja', capeverde: 'Kap Verde', caboverde: 'Kap Verde', capeverdeislands: 'Kap Verde',
  belgium: 'Belgia', egypt: 'Egypti', saudiarabia: 'Saudi-Arabia', uruguay: 'Uruguay', iran: 'Iran',
  newzealand: 'Uusi-Seelanti', france: 'Ranska', senegal: 'Senegal', iraq: 'Irak', norway: 'Norja',
  argentina: 'Argentiina', algeria: 'Algeria', austria: 'Itävalta', jordan: 'Jordania', portugal: 'Portugali',
  congo: 'Kongo', drcongo: 'Kongo', congodr: 'Kongo', democraticrepublicofcongo: 'Kongo', republicofcongo: 'Kongo',
  england: 'Englanti', croatia: 'Kroatia', ghana: 'Ghana', panama: 'Panama', uzbekistan: 'Uzbekistan', colombia: 'Kolumbia',
};
function fiTeam(name) { return EN_TO_FI[norm(name)] || name; }

const Teams = { norm, aliasesFor, teamMatches, fiTeam, FI_TO_EN, EN_TO_FI };
if (typeof module !== 'undefined' && module.exports) module.exports = Teams;
if (typeof window !== 'undefined') window.Teams = Teams;
