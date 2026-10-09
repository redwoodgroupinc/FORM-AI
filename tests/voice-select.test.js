import { test } from 'node:test';
import assert from 'node:assert/strict';

import { voiceGender, rankVoices, pickCoachVoice } from '../assets/js/app/voice-select.js';

const v = (name, lang, extra = {}) => ({ name, lang, voiceURI: `${name}|${lang}`, default: false, localService: true, ...extra });

// Representative getVoices() results per platform.
const MAC_SAFARI = [
  v('Alex', 'en-US', { default: true }), v('Daniel', 'en-GB'), v('Fred', 'en-US'),
  v('Karen', 'en-AU'), v('Moira', 'en-IE'), v('Samantha', 'en-US'), v('Thomas', 'fr-FR'),
  v('Rishi', 'en-IN'), v('Tessa', 'en-ZA'),
];
const IOS_MALE_DEFAULT = [v('Daniel', 'en-GB', { default: true }), v('Arthur', 'en-GB'), v('Martha', 'en-GB'), v('Gordon', 'en-AU')];
const CHROME_WINDOWS = [
  v('Microsoft David - English (United States)', 'en-US', { default: true }),
  v('Microsoft Mark - English (United States)', 'en-US'),
  v('Microsoft Zira - English (United States)', 'en-US'),
  v('Google US English', 'en-US', { localService: false }),
  v('Google UK English Female', 'en-GB', { localService: false }),
  v('Google UK English Male', 'en-GB', { localService: false }),
];
const EDGE = [
  v('Microsoft Guy Online (Natural) - English (United States)', 'en-US'),
  v('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
  v('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB'),
  v('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
  v('Microsoft David - English (United States)', 'en-US', { default: true }),
];
const ANDROID = [
  v('English United States', 'en-US', { default: true }),
  v('en-us-x-iol-local', 'en-US'),
  v('en-us-x-iom-network', 'en-US'),
  v('en-us-x-sfg-local', 'en-US'),
  v('en-gb-x-rjs-local', 'en-GB'),
];

test('reads gender from voice names across platforms', () => {
  const cases = {
    Samantha: 'female', Karen: 'female', Alex: 'male', Daniel: 'male',
    'Google UK English Female': 'female', 'Google UK English Male': 'male', 'Google US English': 'female',
    'Microsoft Zira - English (United States)': 'female', 'Microsoft David - English (United States)': 'male',
    'Microsoft Aria Online (Natural) - English (United States)': 'female',
    'Microsoft Guy Online (Natural) - English (United States)': 'male',
    'en-us-x-sfg-local': 'female', 'en-us-x-iol-local': 'male', 'en-gb-x-rjs-local': 'male',
    'English United States': null, 'Bad News': null,
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(voiceGender({ name }), expected, name);
  }
});

test('picks a female voice on every platform', () => {
  const platforms = { MAC_SAFARI, CHROME_WINDOWS, EDGE, ANDROID };
  const expected = {
    MAC_SAFARI: 'Samantha',
    CHROME_WINDOWS: 'Microsoft Zira - English (United States)',
    EDGE: 'Microsoft Aria Online (Natural) - English (United States)',
    ANDROID: 'en-us-x-sfg-local',
  };
  for (const [platform, voices] of Object.entries(platforms)) {
    const picked = pickCoachVoice(voices, { lang: 'en-US' });
    assert.equal(picked.voice.name, expected[platform], platform);
    assert.equal(picked.female, true, platform);
  }
});

test('prefers a female voice in the user\'s own accent', () => {
  assert.equal(pickCoachVoice(CHROME_WINDOWS, { lang: 'en-GB' }).voice.name, 'Google UK English Female');
  // Network voices still win when they're the only female option.
  assert.equal(pickCoachVoice(CHROME_WINDOWS.filter((voice) => !voice.name.includes('Zira')), { lang: 'en-US' }).voice.name, 'Google US English');
  assert.equal(pickCoachVoice(EDGE, { lang: 'en-GB' }).voice.name, 'Microsoft Sonia Online (Natural) - English (United Kingdom)');
  assert.equal(pickCoachVoice(MAC_SAFARI, { lang: 'en-AU' }).voice.name, 'Karen');
});

test('never picks a known male voice over a female one, even the default', () => {
  const picked = pickCoachVoice(IOS_MALE_DEFAULT, { lang: 'en-GB' });
  assert.equal(picked.voice.name, 'Martha');
  assert.equal(picked.female, true);
});

test('lists only female voices for the voice picker', () => {
  const { femaleVoices } = pickCoachVoice([...CHROME_WINDOWS, ...EDGE], { lang: 'en-US' });
  assert.ok(femaleVoices.length >= 4);
  assert.ok(femaleVoices.every((voice) => voiceGender(voice) === 'female'));
});

test('cues are English, so an English female voice beats a local-language one', () => {
  const voices = [v('Amélie', 'fr-CA'), v('Thomas', 'fr-FR'), v('Samantha', 'en-US')];
  assert.equal(pickCoachVoice(voices, { lang: 'fr-FR' }).voice.name, 'Samantha');
});

test('with no female voice installed, falls back and says so', () => {
  const picked = pickCoachVoice([v('English United States', 'en-US'), v('Daniel', 'en-GB')], { lang: 'en-US' });
  assert.equal(picked.voice.name, 'English United States');
  assert.equal(picked.female, false);
  assert.deepEqual(pickCoachVoice([], {}).voice, null);
});

test('an explicit choice wins', () => {
  const zira = CHROME_WINDOWS.find((voice) => voice.name.includes('Zira'));
  const picked = pickCoachVoice(CHROME_WINDOWS, { preferredURI: zira.voiceURI });
  assert.equal(picked.voice, zira);
  assert.equal(picked.female, true);
  // A stale choice (voice no longer installed) falls back to automatic.
  assert.equal(pickCoachVoice(CHROME_WINDOWS, { preferredURI: 'gone' }).voice.name, 'Microsoft Zira - English (United States)');
});

test('ranking ignores non-English, non-local voices', () => {
  const ranked = rankVoices([v('Kyoko', 'ja-JP'), v('Samantha', 'en-US')], { lang: 'en-US' });
  assert.deepEqual(ranked.map((r) => r.voice.name), ['Samantha']);
});

test('handles the naming traps found across real voice lists', () => {
  const cases = [
    // Chrome's Chinese Google voices use a no-break space after "Google".
    [{ name: 'Google\u00a0普通话（中国大陆）' }, 'female'],
    // Edge multilingual voices are one word.
    [{ name: 'Microsoft AvaMultilingual Online (Natural) - English (United States)' }, 'female'],
    [{ name: 'Microsoft AndrewMultilingual Online (Natural) - English (United States)' }, 'male'],
    // Legacy Android suffix overrides the (female) voice code.
    [{ name: 'en-us-x-sfg#male_1-local' }, 'male'],
    [{ name: 'en-us-x-iol#female_2-local' }, 'female'],
    // Apple Siri voices carry gender in the voiceURI only.
    [{ name: 'Nicky', voiceURI: 'com.apple.ttsbundle.siri_female_en-US_compact' }, 'female'],
    [{ name: 'Aaron', voiceURI: 'com.apple.ttsbundle.siri_male_en-US_compact' }, 'male'],
    // Numbered Google Natural voices: gender only via the exact name.
    [{ name: 'Google US English 3 (Natural)' }, 'male'],
    [{ name: 'Google US English 5 (Natural)' }, 'female'],
    // Substrings must not match: Evan is not Eva, Samantha is not Sam, Markus is not Mark.
    [{ name: 'Evan' }, 'male'],
    [{ name: 'Samantha' }, 'female'],
    // Unisex names stay unknown.
    [{ name: 'Microsoft Ashley Online (Natural) - English (United States)' }, null],
    // eSpeak variants.
    [{ name: 'English (America)+female2' }, 'female'],
    [{ name: 'English (America)+male3' }, 'male'],
  ];
  for (const [voice, expected] of cases) assert.equal(voiceGender(voice), expected, voice.name);
});

test('never picks novelty voices', () => {
  const voices = [v('Superstar', 'en-US', { voiceURI: 'com.apple.speech.synthesis.voice.Princess' }), v('Bad News', 'en-US'), v('Fred', 'en-US')];
  const picked = pickCoachVoice(voices, { lang: 'en-US' });
  assert.equal(picked.voice.name, 'Fred');
  assert.equal(picked.female, false);
  assert.deepEqual(picked.femaleVoices, []);
});

test('prefers a natural adult voice over robotic or child voices', () => {
  const voices = [v('Shelley', 'en-US'), v('Microsoft Ana Online (Natural) - English (United States)', 'en-US'), v('Samantha', 'en-US')];
  assert.equal(pickCoachVoice(voices, { lang: 'en-US' }).voice.name, 'Samantha');
  // On devices where Eloquence voices are all there is, a robotic female voice still wins.
  assert.equal(pickCoachVoice([v('Shelley', 'en-US'), v('Eddy', 'en-US')], { lang: 'en-US' }).voice.name, 'Shelley');
});

test('ignores voice.default, which is often a male voice', () => {
  const voices = [v('Microsoft David - English (United States)', 'en-US', { default: true }), v('Microsoft Zira - English (United States)', 'en-US')];
  assert.match(pickCoachVoice(voices, { lang: 'en-US' }).voice.name, /Zira/);
});

test('understands Android language tags with underscores', () => {
  const picked = pickCoachVoice([v('en-gb-x-gba-local', 'en_GB'), v('en-us-x-iom-local', 'en_US')], { lang: 'en-US' });
  assert.equal(picked.voice.name, 'en-gb-x-gba-local');
  assert.equal(picked.female, true);
});

