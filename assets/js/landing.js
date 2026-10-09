// Landing page: navigation, scroll reveals and the live hero preview.
// The hero phone is not a video. A procedural squatter is analysed frame by frame by the
// same FormCoach engine the app uses, so the rep count and cues on screen are real output.

import { FormCoach, EXERCISES } from './engine/index.js';
import { demoFrame } from './demo/synthetic.js';
import { drawSkeleton, faultJointsFor } from './render/skeleton.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

setupNav();
setupReveal();
setupHero();

const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());

function setupNav() {
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  if (!header) return;

  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  toggle?.addEventListener('click', () => {
    const open = header.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  header.querySelectorAll('.nav-links a').forEach((link) => {
    link.addEventListener('click', () => {
      header.classList.remove('is-open');
      toggle?.setAttribute('aria-expanded', 'false');
    });
  });
}

function setupReveal() {
  const items = document.querySelectorAll('.reveal');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      const siblings = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
      el.style.transitionDelay = `${Math.min(siblings.indexOf(el), 5) * 70}ms`;
      el.classList.add('is-in');
      observer.unobserve(el);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  items.forEach((el) => observer.observe(el));
}

function setupHero() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const repsEl = document.getElementById('hero-reps');
  const scoreEl = document.getElementById('hero-score');
  const depthEl = document.getElementById('hero-depth');
  const cueEl = document.getElementById('hero-cue');
  const cueText = document.getElementById('hero-cue-text');
  const voiceEl = document.getElementById('hero-voice');

  const RESET_AFTER_REPS = 12;
  const MAX_FRAME_MS = 50;
  const FRAMING = { frameScale: 0.32, floor: 0.84 };
  let coach = new FormCoach(EXERCISES.squat);
  // Animation clock: advances with frames but never jumps, even after jank or a pause.
  let clock = 0;
  let setStartedAt = 0;
  let lastFrameAt = null;
  let cueHideAt = 0;
  let running = false;
  let rafId = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  function showCue(text, tone, now, ms) {
    cueText.textContent = text;
    cueEl.classList.toggle('is-good', tone === 'good');
    cueEl.classList.add('is-visible');
    cueHideAt = now + ms;
  }

  function step(now) {
    const elapsed = now - setStartedAt;
    const aspect = canvas.width / canvas.height;
    const frame = demoFrame(elapsed, { aspect, ...FRAMING });
    const result = coach.update(frame.pose, now);

    for (const event of result.events) {
      if (event.type === 'fault') {
        showCue(event.check.cue, 'bad', now, 1700);
        voiceEl.textContent = `“${event.check.cue}”`;
      } else if (event.type === 'rep') {
        repsEl.textContent = String(event.count);
        repsEl.classList.remove('bump');
        void repsEl.offsetWidth; // restart the animation
        repsEl.classList.add('bump');
        if (event.rep.faults.length === 0) {
          voiceEl.textContent = `“${event.count}.”`;
          if (now > cueHideAt) showCue('Good rep', 'good', now, 800);
        }
      }
    }
    if (now > cueHideAt) cueEl.classList.remove('is-visible');

    scoreEl.textContent = result.formScore === null ? '--' : String(result.formScore);
    depthEl.style.height = `${Math.round((result.progress ?? 0) * 100)}%`;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawSkeleton(ctx, frame.pose.landmarks, {
      width: canvas.width,
      height: canvas.height,
      faultJoints: faultJointsFor(result.activeFaults),
      arc: result.arc,
      angle: result.value ?? null,
      time: now,
    });

    if (coach.reps >= RESET_AFTER_REPS && result.state === 'rest') {
      coach = new FormCoach(EXERCISES.squat);
      setStartedAt = now;
      repsEl.textContent = '0';
    }
  }

  function loop(timestamp) {
    if (!running) return;
    clock += lastFrameAt === null ? 0 : Math.min(timestamp - lastFrameAt, MAX_FRAME_MS);
    lastFrameAt = timestamp;
    step(clock);
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running || reducedMotion) return;
    running = true;
    lastFrameAt = null;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  resize();
  window.addEventListener('resize', resize);

  if (reducedMotion) {
    // Static frame: bottom of the third rep, where the knees cave in.
    const target = 2600 * 2 + 2600 * 0.55;
    for (let t = 0; t <= target; t += 33) step(t);
    cueHideAt = Infinity;
    return;
  }

  let inView = false;
  const observer = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView && !document.hidden) start();
    else stop();
  });
  observer.observe(canvas);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (inView) start();
  });
}
