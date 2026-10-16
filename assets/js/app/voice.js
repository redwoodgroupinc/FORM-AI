// The coach's voice: spoken cues via the Web Speech API (built into iOS, Android and
// desktop browsers). She is female: voice-select.js picks the best female voice on the
// device. Cues are short and rate-limited per cue, and a form correction may interrupt a
// rep count, never the other way round.

import { pickCoachVoice } from './voice-select.js';

export const PRIORITY = Object.freeze({ count: 1, info: 2, partial: 2, fault: 3 });

// Without a female voice installed, a raised pitch keeps the closest voice nearer hers.
const FEMALE_PITCH = 1.05;
const FALLBACK_PITCH = 1.25;
// getVoices() is often empty at first, and iOS Safari may never fire 'voiceschanged'.
const VOICE_RETRY_MS = [250, 1000, 2500, 5000];

export class VoiceCoach {
  constructor({ enabled = true, countReps = true, voiceURI = 'auto' } = {}) {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.enabled = enabled;
    this.countReps = countReps;
    this.voiceURI = voiceURI;
    this.voice = null;
    this.female = false;
    this.femaleVoices = [];
    this.loadingVoices = true;
    this.onvoiceschange = null;
    this.currentPriority = 0;
    this.lastSpokenAt = new Map();
    if (this.supported) {
      this.pickVoice();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this.pickVoice());
      VOICE_RETRY_MS.forEach((ms, i) => window.setTimeout(() => {
        if (i === VOICE_RETRY_MS.length - 1) this.loadingVoices = false;
        if (!this.voice || !this.loadingVoices) this.pickVoice();
      }, ms));
    }
  }

  pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    const picked = pickCoachVoice(voices, {
      preferredURI: this.voiceURI === 'auto' ? null : this.voiceURI,
      lang: navigator.language || 'en-US',
    });
    this.voice = picked.voice;
    this.female = picked.female;
    this.femaleVoices = picked.femaleVoices;
    this.onvoiceschange?.(this);
  }

  /** Choose a specific voice by voiceURI, or 'auto' for the best female voice. */
  setVoice(voiceURI) {
    this.voiceURI = voiceURI || 'auto';
    if (this.supported) this.pickVoice();
  }

  /** iOS only allows speech after a user gesture, so prime it from the Start button. */
  unlock() {
    if (!this.supported) return;
    const primer = new SpeechSynthesisUtterance(' ');
    primer.volume = 0;
    window.speechSynthesis.speak(primer);
  }

  /**
   * Speak several cues from the same moment as one utterance, e.g. "Squats. One.".
   * Items still on their cooldown are dropped.
   * @param {Array<{text: string, key?: string, priority?: number, cooldownMs?: number}>} items
   */
  sayAll(items) {
    if (!this.supported || !this.enabled) return false;
    const now = performance.now();
    // One line per key, keeping the latest (e.g. the higher rep count).
    const latest = new Map();
    for (const item of items) if (item?.text) latest.set(item.key ?? item.text, item);
    const fresh = [...latest.values()].filter((item) => {
      const last = this.lastSpokenAt.get(item.key ?? item.text);
      return last === undefined || now - last >= (item.cooldownMs ?? 4000);
    });
    if (fresh.length === 0) return false;
    const priority = Math.max(...fresh.map((item) => item.priority ?? PRIORITY.info));

    const synth = window.speechSynthesis;
    if (!this.voice) this.pickVoice();
    // iOS can leave the synthesizer paused after the app was in the background.
    if (synth.paused) synth.resume();
    if (synth.speaking || synth.pending) {
      if (priority <= this.currentPriority) return false;
      synth.cancel();
    }
    const text = fresh.map((item) => item.text.replace(/[.!?]?$/, '.')).join(' ');
    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) {
      utterance.voice = this.voice;
      utterance.lang = this.voice.lang;
    }
    utterance.rate = 1.05;
    utterance.pitch = this.female ? FEMALE_PITCH : FALLBACK_PITCH;
    const done = () => { if (this.currentUtterance === utterance) this.currentPriority = 0; };
    utterance.onend = done;
    utterance.onerror = done;
    this.currentUtterance = utterance;
    this.currentPriority = priority;
    for (const item of fresh) this.lastSpokenAt.set(item.key ?? item.text, now);
    synth.speak(utterance);
    return true;
  }

  say(text, { key = text, priority = PRIORITY.info, cooldownMs = 4000 } = {}) {
    return this.sayAll([{ text, key, priority, cooldownMs }]);
  }

  count(n) {
    if (!this.countReps) return false;
    return this.say(String(n), { key: 'count', priority: PRIORITY.count, cooldownMs: 0 });
  }

  cancel() {
    if (this.supported) window.speechSynthesis.cancel();
    this.currentPriority = 0;
  }
}
