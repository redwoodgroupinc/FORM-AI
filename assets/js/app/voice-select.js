// Picks the coach's voice. The coach is female, but SpeechSynthesisVoice exposes no
// gender, so it is inferred from the voice name. The name lists were compiled from Apple,
// Google (Chrome/ChromeOS/Android), Microsoft (SAPI, OneCore, Edge Natural) and eSpeak
// voice catalogues and cross-checked against Chromium's voice manifest and real
// getVoices() dumps. Pure functions, unit-tested in Node.

/** Whole-word tokens of known female voices (after lowercasing and stripping accents). */
const FEMALE_TOKENS = new Set(`
female female1 female2 female3 female4 female5
samantha ava avamultilingual zoe allison susan nicky kathy vicki victoria agnes jill karen
matilda catherine moira tessa fiona veena isha sangeeta tara kate serena stephanie martha
emily shelley flo sandy grandma joelle noelle
aria jenny michelle emma emmamultilingual ana sonia libby maisie mia natasha hayley clara
heather neerja priya leah molly yan asilia ezinne rosa luna imani zira hazel linda heera
anna mary eva jessa amber cora elizabeth jane nancy sara monica amanda evelyn lola phoebe
abbi bella hollie olivia ada annette carly elsie freya joanne tina aarti aashi ananya kavya
sfg iob iog tpc tpf gba gbc gbg aua auc ena enc
alicia annie anika anikarobot auntie belinda steph steph2 steph3 us-mbrola-1 slt clb
sabrina isabel virginie silvia amelie chantal marie audrey aurelie aude helena petra alice
federica paola kyoko o-ren marisol paulina angelica isabela francisca soledad jimena luciana
fernanda joana catarina milena katya yuna suhyun tingting ting-ting yu-shu lili lilian
tiantian shasha lanlan shanshan dongmei panpan nannan sinji sin-ji meijia mei-jia zuzana
iveta melina satu carmit lekha kiyara lana mariska damayanti amira nora ellen claire zosia
ewa ioana laura alva klara kanya narisa yelda lesya linh daria montse laila mariam vani
geeta soumya piya jaya aru miren carmela
`.trim().split(/\s+/));

/** Whole-word tokens of known male voices. */
const MALE_TOKENS = new Set(`
male male1 male2 male3 male4 male5 male6 male7 male8
daniel rishi alex fred ralph junior albert bruce aaron arthur gordon evan nathan tom jamie
oliver lee aman eddy grandpa reed rocko jacques guy andrew andrewmultilingual brian
brianmultilingual christopher eric roger steffan ryan thomas william williammultilingual
liam prabhat connor luke mitchell sam chilemba abeo james wayne elimu david mark george
richard ravi sean mike benjamin brandon davis jacob jason tony kai adam derek dustin lewis
samuel alfie elliot ethan noah ollie darren duncan ken neil tim aarav arjun kunal rehaan
iol iom tpd rjs gbb gbd aub aud end ene
andy anxiousandy demonic denis diogo henrique hugo marco storm universalrobot antonio croak
michel miguel sandro travis victor michael paul robert john edward ian max pablo pedro boris
caleb gustave marcelo norbert gene mario us-mbrola-2 us-mbrola-3 bdl alan nicolas xander
majed maged tarik markus viktor yannick martin jorge juan diego carlos luca hattori otoya
minsu yuri felipe joaquim krzysztof henrik magnus onni nikos neel cem oskar li-mu han bobo
taotao binbin haohao aasing dariush jordi
`.trim().split(/\s+/));

/** Unisex names and codes that collide with other words: never decide gender from these. */
const AMBIGUOUS_TOKENS = new Set(`
pau jian sora yue lisheng tunde andrea kim ashley blue fable shelby katrin fis tfn
`.trim().split(/\s+/));

/** Novelty and effect voices: never use them for coaching. */
const NOVELTY = [
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news', 'jester',
  'organ', 'superstar', 'superestrella', 'trinoids', 'whisper', 'female_whisper', 'wobble',
  'zarvox', 'monster', 'deranged', 'hysterical', 'princess',
];

/** Full names (whitespace-normalised) whose gender isn't in the name. */
const FEMALE_NAMES = new Set([
  'Google US English', 'Google UK English Female', 'Google Deutsch', 'Google français',
  'Google italiano', 'Google español de Estados Unidos', 'Google 日本語', 'Google 한국의',
  'Google हिन्दी', 'Google Bahasa Indonesia', 'Google polski', 'Google português do Brasil',
  'Google русский', 'Google 普通话（中国大陆）', 'Google 粤語（香港）', 'Google 國語（臺灣）',
  'Google US English 1 (Natural)', 'Google US English 2 (Natural)', 'Google US English 5 (Natural)',
  'Google US English 7 (Natural)', 'Chrome OS US English 1', 'Chrome OS US English 2',
  'Chrome OS US English 5', 'Chrome OS US English 7', 'Chrome OS US English 8',
  'Google UK English 2 (Natural)', 'Google UK English 4 (Natural)', 'Google UK English 6 (Natural)',
  'Chrome OS UK English 2', 'Chrome OS UK English 4', 'Chrome OS UK English 6', 'Chrome OS UK English 7',
  'Google Australian English 1 (Natural)', 'Google Australian English 3 (Natural)',
  'Chrome OS Australian English 1', 'Chrome OS Australian English 3',
]);
const MALE_NAMES = new Set([
  'Google UK English Male', 'Google español', 'Google Nederlands',
  'Google US English 3 (Natural)', 'Google US English 4 (Natural)', 'Google US English 6 (Natural)',
  'Chrome OS US English 3', 'Chrome OS US English 4', 'Chrome OS US English 6',
  'Google UK English 1 (Natural)', 'Google UK English 3 (Natural)', 'Google UK English 5 (Natural)',
  'Chrome OS UK English 1', 'Chrome OS UK English 3', 'Chrome OS UK English 5',
  'Google Australian English 2 (Natural)', 'Google Australian English 4 (Natural)',
  'Chrome OS Australian English 2', 'Chrome OS Australian English 4', 'Chrome OS Australian English 5',
]);

/** Female but robotic (Eloquence, legacy MacinTalk, eSpeak, pico): use only as a last resort. */
const LOW_QUALITY = new Set(`
shelley flo sandy grandma kathy vicki victoria agnes jill mary female1 female2 female3
female4 female5 alicia annie anika anikarobot auntie belinda steph steph2 steph3
us-mbrola-1 slt clb
`.trim().split(/\s+/));

/** Child voices: female, but wrong for an adult coach. */
const CHILD = new Set(['ana', 'maisie', 'joelle', 'noelle']);

const QUALITY = /\b(natural|neural|enhanced|premium|wavenet|studio)\b/i;

/** Collapse whitespace (some Google names contain a no-break space). */
const tidy = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();

/** Lowercase, strip accents and Edge's "Multilingual" suffix, then split into words. */
function tokensOf(name) {
  const key = tidy(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])multilingual\b/g, '$1');
  // Keep '-' inside tokens so codes like "o-ren" or "us-mbrola-1" survive; split on the rest.
  const words = key.split(/[^a-z0-9-]+/).filter(Boolean);
  const parts = words.flatMap((w) => (w.includes('-') ? [w, ...w.split('-')] : [w]));
  return new Set(parts.filter(Boolean));
}

function isNovelty(voice) {
  const name = tidy(voice?.name).toLowerCase();
  const uri = String(voice?.voiceURI ?? '').toLowerCase();
  const words = tokensOf(voice?.name);
  return NOVELTY.some((n) => (n.includes(' ') ? name.includes(n) : words.has(n) || uri.endsWith(`.${n}`)));
}

/** 'female', 'male' or null when the name gives nothing away. */
export function voiceGender(voice) {
  const name = tidy(voice?.name);
  if (FEMALE_NAMES.has(name)) return 'female';
  if (MALE_NAMES.has(name)) return 'male';

  const lower = name.toLowerCase();
  const uri = String(voice?.voiceURI ?? '').toLowerCase();
  // Legacy Android suffixes override the voice code ("en-us-x-sfg#male_1-local" is male).
  if (lower.includes('#male_') || uri.includes('siri_male')) return 'male';
  if (lower.includes('#female_') || uri.includes('siri_female')) return 'female';

  const words = tokensOf(name);
  let female = false;
  let male = false;
  for (const word of words) {
    if (AMBIGUOUS_TOKENS.has(word)) continue;
    if (FEMALE_TOKENS.has(word)) female = true;
    if (MALE_TOKENS.has(word)) male = true;
  }
  if (female && !male) return 'female';
  if (male && !female) return 'male';
  return null;
}

const normLang = (lang) => String(lang ?? '').toLowerCase().replace(/_/g, '-');
const isEnglish = (lang) => /^en(-|$)/.test(normLang(lang));
const ENGLISH_ORDER = ['en-us', 'en-gb', 'en-au', 'en-ca', 'en-ie', 'en-nz', 'en-za', 'en-in'];

/**
 * Rank voices for the coach: female first, then the user's own English accent, then quality.
 * Cues are written in English, so only English voices qualify (unless there are none).
 * @param {SpeechSynthesisVoice[]} voices
 * @param {{lang?: string}} [opts] the user's preferred language, e.g. navigator.language
 */
export function rankVoices(voices, { lang = 'en-US' } = {}) {
  const wanted = normLang(lang);
  const usable = voices.filter((v) => !isNovelty(v));
  const english = usable.filter((v) => isEnglish(v.lang));
  const pool = english.length ? english : usable;
  return pool
    .map((voice) => {
      const gender = voiceGender(voice);
      const voiceLang = normLang(voice.lang);
      const words = tokensOf(voice.name);
      let score = gender === 'female' ? 100 : gender === 'male' ? -100 : 0;
      if (voiceLang === wanted) score += 10;
      const regional = ENGLISH_ORDER.indexOf(voiceLang);
      if (regional >= 0) score += 6 - Math.min(regional, 6) * 0.5;
      if (QUALITY.test(voice.name)) score += 8;
      // On-device voices start speaking instantly and work offline, so cues land on time.
      if (voice.localService) score += 3;
      if ([...words].some((w) => LOW_QUALITY.has(w))) score -= 20;
      if ([...words].some((w) => CHILD.has(w))) score -= 30;
      // voice.default is deliberately ignored: Safari marks every voice default, and on
      // Windows the default is usually a male voice.
      return { voice, gender, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Choose the coach voice. Honours an explicit choice; otherwise the best female voice.
 * @returns {{voice: SpeechSynthesisVoice|null, female: boolean, femaleVoices: SpeechSynthesisVoice[]}}
 */
export function pickCoachVoice(voices, { preferredURI = null, lang = 'en-US' } = {}) {
  const ranked = rankVoices(voices, { lang });
  const femaleVoices = ranked.filter((r) => r.gender === 'female').map((r) => r.voice);
  const preferred = preferredURI ? voices.find((v) => v.voiceURI === preferredURI) : null;
  if (preferred) return { voice: preferred, female: voiceGender(preferred) === 'female', femaleVoices };
  // Without a known female voice, use the best voice that isn't known to be male.
  const best = ranked.find((r) => r.gender !== 'male') ?? ranked[0] ?? null;
  return { voice: best?.voice ?? null, female: best?.gender === 'female', femaleVoices };
}
