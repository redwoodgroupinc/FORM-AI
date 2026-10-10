# Form AI Coach

A personal trainer in your phone camera. Prop the phone up, press **Start coaching** and move.
There is no exercise to pick: the coach recognises what you're doing from your first rep, counts
reps, spots bad form ("knees caving in", "back rounding") and talks you through it mid-set in a
female voice. Pose estimation runs **on-device**, so video never leaves the phone.

This repository is the website:

| Page | What it is |
| --- | --- |
| `index.html` | Marketing landing page. The animated phone in the hero is a procedural athlete switching between squats, presses and curls, recognised live by the real coaching engine. It isn't a video. |
| `app.html` | The working coach. One Start button, then automatic exercise recognition. Camera, video-file and demo modes, live HUD, her voice cues, per-set summaries and history. |

## Run it locally

```bash
npm start          # http://localhost:5173
npm test           # engine unit tests (Node 20+)
```

No build step and no runtime dependencies: it is plain HTML, CSS and ES modules. Camera access
needs a secure context, so use `http://localhost` locally and HTTPS in production.

## Compatible devices

Shown at the top of the landing page, with a live **This device** check (`assets/js/compat.js`)
that feature-detects the visitor's browser without asking for permissions. The app's start screen
runs the same check.

| | Best | Works |
| --- | --- | --- |
| **iPhone / iPad** (iOS 17+) | iPhone 13 and newer; iPad Pro M1+, iPad Air 5+, iPad mini 6+, iPad (A16) | iPhone XS, XR, 11, 12, SE 2; iPad 8–10, Air 3/4, mini 5, 2018/2020 iPad Pros |
| **Android** (10+, current Chrome) | Pixel 6–9, Galaxy S21–S24, Snapdragon 888 / 8 Gen 1–3, Tensor | Galaxy A54/A55/A56 and similar 2022+ mid-range; other phones with 4 GB+ RAM, slower |
| **Laptops** (Windows 10/11, macOS 13+, ChromeOS, Linux) | Apple silicon; Core i5 11th gen / Ryzen 5 5000+; any dGPU; Chromebook Plus | Core i3/i5 8th gen / Ryzen 3 3000+, 8 GB RAM, graphics acceleration on |

Minimum browsers: Safari 17, Chrome/Edge 108, Samsung Internet 21, Firefox 101 (svh units set the
floor; MediaPipe's fast paths need Safari 17). Not supported: iPhone 8/X and older (stuck on
iOS 16), Celeron/Pentium/Atom laptops, VMs without a GPU, in-app browsers.

**Known engine bug.** MediaPipe's web GPU path stalls on Snapdragon 8 Elite / 8 Elite Gen 5 / 8s Gen 3
(Adreno 830/840/735: Galaxy S25, OnePlus 13, Xiaomi 15), as reported in
google-ai-edge/mediapipe#5908 and #5867. The coach detects these GPUs and uses the CPU delegate
("Compatibility mode"). It also switches automatically if the GPU engine keeps throwing errors
mid-session. Users can force it in Settings.

The tiers come from OS support lists and chip generations, not device testing. Re-check them if
`@mediapipe/tasks-vision` is upgraded from 0.10.35.

## Deploy

Any static host works (GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3). For GitHub Pages:
**Settings → Pages → Deploy from a branch**, pick the branch and `/ (root)`.

## How it works

```
camera frame ─► MediaPipe Pose Landmarker (WASM/WebGL, on-device)
             ─► 33 landmarks (image + metric 3D "world" coordinates)
             ─► AutoCoach
                  ├─ one FormCoach per exercise, all running every frame:
                  │    joint angle → One Euro smoothing → rep state machine
                  │    + per-exercise form checks (debounced over frames)
                  └─ when any of them completes a rep, the frames of that rep are
                     classified; the rep only counts if it really was that exercise
             ─► HUD, skeleton overlay, her voice (Web Speech API), per-set summary
```

### Automatic exercise recognition

There is no exercise picker. `engine/classifier.js` reduces each frame to a few posture
features and scores a span of frames (one rep) against each exercise:

| Question | Feature |
| --- | --- |
| Lying or standing? | Torso **and** legs far from vertical (a deep, rounded squat tips the torso but keeps the legs under the hips) |
| Legs or arms doing the work? | Range of knee angle plus hip drop vs range of elbow angle |
| Squat or lunge? | Feet side by side vs split front-to-back while the knees are bent |
| Curl or overhead press? | Hands stay below the shoulders vs travel above the head |

Because every exercise's FormCoach is already counting, the first rep is never lost: it's
counted the moment it's recognised. Lunges are never counted as squats (or vice versa) because
each rep must classify as its own exercise. Accepted reps are grouped into **sets**. A new set
starts when you switch exercise or rest for 30 seconds, and each set is saved to history.

Mid-rep corrections come from the exercise being coached, and are only spoken once the rep so
far is clearly that exercise. So switching from squats to lunges doesn't trigger a squat cue.

**Robustness to pose jitter.** Real landmarks wobble from frame to frame, especially in depth.
To cope with that:

- Features are smoothed over a few frames before range of motion is measured, so idle limbs
  don't look like they're moving.
- Legs and arms are compared by which one does more of the work.
- The coached exercise keeps a borderline rep unless another exercise scores clearly
  better, so one odd rep can't split a set.
- Naming or switching exercise takes a full rep at a controlled pace.
- Half reps must last at least 0.7 s.

A noise harness (2–3 cm image-plane and 10–15 cm depth jitter, 10–30 fps) shows automatic
recognition counting as well as a coach told the exercise in advance, with no reps
attributed to the wrong exercise.

### Her voice

The coach is female. Browsers don't expose a voice's gender, so `app/voice-select.js` infers
it from voice names across Apple, Google, Microsoft and Android catalogues (e.g. Samantha,
Karen, Zira, Aria, Google UK English Female, Android `sfg`). It picks the best female English
voice, preferring on-device voices because they speak with no network delay. Users can choose another female voice in Settings.
If a device has no female voice installed, she falls back to the closest voice at a higher
pitch, and Settings says so.

- **Angles are measured in 3D** using MediaPipe's world landmarks, so they hold up when the
  user is not perfectly side-on. Without world landmarks the engine falls back to
  aspect-corrected image coordinates.
- **Rep counting** maps the primary joint angle to 0–1 progress between an exercise's `rest`
  and `peak` angles, with hysteresis. A rep only counts if it reaches the peak and returns. A
  rep that turns back between 40% and 100% is reported as a *partial rep* with a cue.
- **Form checks** must fail for ≥150 ms across ≥2 frames before they fire, and each fires at
  most once per rep. Checks are scoped to the whole rep (`active`) or near the target position
  (`peak`).
- **Tempo:** reps faster than the exercise's `minRepMs` are flagged as rushed. Reps that were
  only partly seen because tracking dropped are not judged for tempo.
- **Form score** is the average rep score. Each rep starts at 100, loses 30 per form fault and
  15 for rushing.
- **Voice cues** are rate-limited per cue. A form correction can interrupt a rep count, never
  the reverse.

### Exercises she recognises

| Exercise | Primary angle | Form checks |
| --- | --- | --- |
| Squat | Knee | Knees caving in, back rounding (torso lean), depth, tempo |
| Push-up | Elbow | Hips sagging, hips piking, depth, tempo |
| Lunge | Front knee | Leaning forward, depth, tempo |
| Bicep curl | Elbow (working arm) | Elbows drifting, torso swing, range, tempo |
| Overhead press | Elbow | Lower-back arch, uneven arms, lockout, tempo |

### Adding an exercise

1. Add an entry to `assets/js/engine/exercises.js` with `name`/`plural`, `rest`/`peak`
   angles, a `measure(points)` function that returns `{ value, arc, metrics }`, and a list of
   `checks`. Add its id to `EXERCISE_ORDER`.
2. Teach `classifySpan` in `assets/js/engine/classifier.js` to score it, using the frame
   features or new ones.
3. Add a synthetic poser in `assets/js/demo/synthetic.js` so the tests can check that it's
   recognised from several camera angles and never confused with the other exercises.

The app UI, panel and summaries pick it up automatically.

## Project layout

```
assets/
  css/            base tokens + components, landing page, app
  js/engine/      pure coaching engine (no DOM, unit-tested in Node)
    geometry.js   landmark indices, vector math, joint angles
    filters.js    One Euro filter
    exercises.js  exercise definitions and form checks
    coach.js      FormCoach: rep state machine, fault debouncing, scoring, summary
    classifier.js exercise recognition from posture features
    auto-coach.js AutoCoach: runs every exercise's coach, accepts recognised reps, builds sets
  js/demo/        procedural athlete (all five exercises, with faults) for the hero, demo and tests
  js/render/      canvas skeleton / fault / angle renderer
  js/app/         camera + MediaPipe wrapper, her voice + female-voice selection, storage, controller
  js/landing.js   landing page behaviour and live hero preview
tests/            node:test suites
scripts/serve.mjs zero-dependency static dev server
```

## Mobile apps

Google ML Kit Pose Detection (iOS and Android) outputs the same 33-point BlazePose topology as
MediaPipe, so `assets/js/engine` maps directly onto the native apps. Port the exercise
thresholds and checks as they are, and feed them ML Kit's 3D landmarks.

## Privacy

- Frames are processed in memory by the on-device model and discarded. Nothing is recorded or
  uploaded.
- The only network requests are for the page itself, Google Fonts, the MediaPipe library
  (jsDelivr) and the pose model file (Google Cloud Storage). The browser caches them after the
  first load.
- Settings and set history are stored in `localStorage` on the device only.

To serve the library and model from your own origin, define this before `app.html` loads
`assets/js/app/main.js`:

```html
<script>
  window.FORM_AI_CONFIG = {
    mediapipeBase: '/vendor/tasks-vision',   // contains vision_bundle.mjs and wasm/
    models: { lite: '/models/pose_landmarker_lite.task', full: '/models/pose_landmarker_full.task' },
  };
</script>
```

## Disclaimer

Form feedback is general fitness guidance, not medical advice.
