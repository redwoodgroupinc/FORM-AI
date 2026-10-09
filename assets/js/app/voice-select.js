// Picks the coach's voice. The coach is female, but SpeechSynthesisVoice exposes no
// gender, so it is inferred from the voice name across Apple, Google, Microsoft and
// Android voice catalogues. Pure functions, unit-tested in Node.

/** Whole-word name tokens of known female voices. */
export const FEMALE_TOKENS = new Set([
  // Apple (iOS, iPadOS, macOS)
  'samantha', 'karen', 'moira', 'tessa', 'fiona', 'victoria', 'allison', 'ava', 'susan', 'zoe',
  'serena', 'kate', 'nicky', 'veena', 'kathy', 'vicki', 'agnes', 'princess', 'catherine', 'martha',
  'isha', 'sangeeta', 'amelie', 'audrey', 'aurelie', 'anna', 'petra', 'alice', 'federica',
  'paola', 'kyoko', 'otoya', 'yuna', 'sora', 'tingting', 'meijia', 'sinji', 'monica', 'paulina',
  'marisol', 'luciana', 'joana', 'catarina', 'milena', 'katya', 'zuzana', 'laura', 'ioana',
  'sara', 'nora', 'alva', 'klara', 'satu', 'ellen', 'claire', 'xander_f', 'mariska', 'melina',
  'yelda', 'carmit', 'lekha', 'damayanti', 'kanya', 'linh', 'lana', 'tamar', 'amira', 'mei',
  // Microsoft (Windows SAPI and Edge online voices)
  'zira', 'hazel', 'heera', 'aria', 'jenny', 'libby', 'sonia', 'natasha', 'clara', 'emma',
  'michelle', 'neerja', 'linda', 'heather', 'elizabeth', 'nancy', 'jane', 'sara', 'amber',
  'ashley', 'cora', 'monica', 'abbie', 'bella', 'hollie', 'maisie', 'olivia', 'molly', 'ana',
  'leah', 'luna', 'yan', 'emily', 'imani', 'ezinne', 'zuri', 'rehema', 'sonia', 'mia', 'jessa',
  'rosa', 'asilia', 'ava', 'harper', 'irina', 'hedda', 'katja', 'helena', 'elsa', 'denise',
  'julie', 'sabina', 'dalia', 'elvira', 'helle', 'hulda', 'mehwish', 'nanami', 'xiaoxiao',
  'xiaoyi', 'huihui', 'yaoyao', 'hanhan', 'heami', 'sunhi',
  // Amazon / Google Cloud / others occasionally surfaced by browsers
  'salli', 'kimberly', 'kendra', 'ivy', 'joanna', 'amy', 'raveena', 'nicole', 'olivia',
  // Android Google TTS voice codes (en-us-x-sfg-local etc.)
  'sfg', 'iob', 'iog', 'tpc', 'tpf', 'gba', 'gbc', 'gbg', 'fis', 'aua', 'auc', 'cxx', 'ahp',
  'enc', 'ene', 'end',
]);

/** Whole-word name tokens of known male voices. */
export const MALE_TOKENS = new Set([
  'alex', 'daniel', 'fred', 'tom', 'aaron', 'arthur', 'gordon', 'rishi', 'oliver', 'evan',
  'nathan', 'thomas', 'jacques', 'xander', 'diego', 'jorge', 'juan', 'luca', 'yuri', 'maged',
  'david', 'mark', 'george', 'james', 'richard', 'ravi', 'guy', 'ryan', 'william', 'liam',
  'christopher', 'eric', 'roger', 'steffan', 'brian', 'andrew', 'connor', 'prabhat', 'mitchell',
  'brandon', 'davis', 'jason', 'tony', 'jacob', 'kai', 'ralf', 'bruce', 'albert', 'junior',
  'reed', 'rocko', 'ralph', 'grandpa', 'eddy', 'stefan', 'pablo', 'raul', 'henri', 'paul',
  'claude', 'hans', 'markus', 'ichiro', 'kangkang', 'yunxi', 'yunyang', 'injoon',
  'matthew', 'joey', 'justin', 'brian', 'russell', 'geraint',
  'iol', 'iom', 'tpd', 'gbb', 'gbd', 'rjs', 'aub', 'aud', 'gbe',
]);

/** Full names whose gender isn't in the name. */
const FEMALE_NAMES = new Set([
  'google us english', // Chrome's default US voice is female
  'google español', 'google español de estados unidos', 'google français', 'google deutsch',
  'google italiano', 'google 日本語', 'google 한국의', 'google português do brasil',
  'google nederlands', 'google polski', 'google русский', 'google हिन्दी',
  'google bahasa indonesia', 'google 普通话（中国大陆）', 'google 粤語（香港）', 'google 國語（臺灣）',
]);
const MALE_NAMES = new Set([]);

const QUALITY = /\b(natural|neural|enhanced|premium|online|wavenet|studio|siri)\b/i;

function tokens(name) {
  return name.toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter(Boolean);
}

/** 'female', 'male' or null when the name gives nothing away. */
export function voiceGender(voice) {
  const name = String(voice?.name ?? '').toLowerCase().trim();
  if (FEMALE_NAMES.has(name)) return 'female';
  if (MALE_NAMES.has(name)) return 'male';
  const words = tokens(name);
  if (words.includes('female') || words.includes('woman')) return 'female';
  if (words.includes('male') || words.includes('man')) return 'male';
  let female = false;
  let male = false;
  for (const word of words) {
    if (FEMALE_TOKENS.has(word)) female = true;
    if (MALE_TOKENS.has(word)) male = true;
  }
  if (female && !male) return 'female';
  if (male && !female) return 'male';
  return null;
}

const langBase = (lang) => String(lang ?? '').toLowerCase().split(/[-_]/)[0];

/**
 * Rank voices for the coach: female first, then the user's language, then quality.
 * @param {SpeechSynthesisVoice[]} voices
 * @param {{lang?: string}} [opts] the user's preferred language, e.g. navigator.language
 */
export function rankVoices(voices, { lang = 'en-US' } = {}) {
  const wanted = String(lang).toLowerCase().replace('_', '-');
  const wantedBase = langBase(wanted);
  // The cues are written in English, so English voices always qualify.
  const usable = voices.filter((v) => ['en', wantedBase].includes(langBase(v.lang)));
  return usable
    .map((voice) => {
      const gender = voiceGender(voice);
      const voiceLang = String(voice.lang).toLowerCase().replace('_', '-');
      let score = gender === 'female' ? 100 : gender === 'male' ? -100 : 0;
      if (langBase(voiceLang) === 'en') score += 20;
      if (voiceLang === wanted) score += 10;
      if (voiceLang === 'en-us' || voiceLang === 'en-gb') score += 4;
      if (QUALITY.test(voice.name)) score += 8;
      // On-device voices start speaking instantly and work offline: cues land on time.
      if (voice.localService) score += 3;
      if (voice.default) score += 1;
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
  const best = ranked[0] ?? null;
  return { voice: best?.voice ?? null, female: best?.gender === 'female', femaleVoices };
}
