// Spoken coaching cues via the Web Speech API (built into iOS, Android and desktop browsers).
// Cues are short, rate-limited per cue, and a form correction may interrupt a rep count,
// but never the other way round.

export const PRIORITY = Object.freeze({ count: 1, info: 2, partial: 2, fault: 3 });

export class VoiceCoach {
  constructor({ enabled = true, countReps = true } = {}) {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.enabled = enabled;
    this.countReps = countReps;
    this.voice = null;
    this.currentPriority = 0;
    this.lastSpokenAt = new Map();
    if (this.supported) {
      this.pickVoice();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
  }

  pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    const english = voices.filter((v) => /^en[-_]/i.test(v.lang));
    this.voice = english.find((v) => /natural|neural|enhanced|premium|google/i.test(v.name))
      ?? english.find((v) => v.default)
      ?? english[0]
      ?? null;
  }

  /** iOS only allows speech after a user gesture, so prime it from the Start button. */
  unlock() {
    if (!this.supported) return;
    const primer = new SpeechSynthesisUtterance(' ');
    primer.volume = 0;
    window.speechSynthesis.speak(primer);
  }

  say(text, { key = text, priority = PRIORITY.info, cooldownMs = 4000 } = {}) {
    if (!this.supported || !this.enabled || !text) return false;
    const now = performance.now();
    const last = this.lastSpokenAt.get(key);
    if (last !== undefined && now - last < cooldownMs) return false;

    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) {
      if (priority <= this.currentPriority) return false;
      synth.cancel();
    }
    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) utterance.voice = this.voice;
    utterance.rate = 1.08;
    utterance.pitch = 1;
    const done = () => { if (this.currentUtterance === utterance) this.currentPriority = 0; };
    utterance.onend = done;
    utterance.onerror = done;
    this.currentUtterance = utterance;
    this.currentPriority = priority;
    this.lastSpokenAt.set(key, now);
    synth.speak(utterance);
    return true;
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
