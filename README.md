# Form AI Coach

A personal trainer in your phone camera. Prop the phone up and start an exercise: the coach tracks
your body in real time, counts reps, spots bad form ("knees caving in", "back rounding") and gives
voice cues mid-set. Pose estimation runs **on-device**, so video never leaves the phone.

This repository is the website:

| Page | What it is |
| --- | --- |
| `index.html` | Marketing landing page. The animated phone in the hero is a procedural squatter analysed live by the real coaching engine, not a video. |
| `app.html` | The working coach. Camera, video-file and demo modes, live HUD, voice cues, set summaries and history. |

## Run it locally

```bash
npm start          # http://localhost:5173
npm test           # engine unit tests (Node 20+)
```

No build step and no runtime dependencies: it is plain HTML, CSS and ES modules. Camera access
needs a secure context, so use `http://localhost` locally and HTTPS in production.

## Deploy

Any static host works (GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3). For GitHub Pages:
**Settings → Pages → Deploy from a branch**, pick the branch and `/ (root)`.

## How it works

```
camera frame ─► MediaPipe Pose Landmarker (WASM/WebGL, on-device)
             ─► 33 landmarks (image + metric 3D "world" coordinates)
             ─► FormCoach: joint angle → One Euro smoothing → rep state machine
                           + per-exercise form checks (debounced over frames)
             ─► HUD, skeleton overlay, voice cues (Web Speech API), set summary
```

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

### Exercises at launch

| Exercise | Primary angle | Form checks |
| --- | --- | --- |
| Squat | Knee | Knees caving in, back rounding (torso lean), depth, tempo |
| Push-up | Elbow | Hips sagging, hips piking, depth, tempo |
| Lunge | Front knee | Leaning forward, depth, tempo |
| Bicep curl | Elbow (working arm) | Elbows drifting, torso swing, range, tempo |
| Overhead press | Elbow | Lower-back arch, uneven arms, lockout, tempo |

### Adding an exercise

Add an entry to `assets/js/engine/exercises.js` with `rest`/`peak` angles, a `measure(points)`
function that returns `{ value, arc, metrics }`, and a list of `checks`. Then add its id to
`EXERCISE_ORDER`. The app UI, panel and summaries pick it up automatically. Add a test in
`tests/exercises.test.js`.

## Project layout

```
assets/
  css/            base tokens + components, landing page, app
  js/engine/      pure coaching engine (no DOM, unit-tested in Node)
    geometry.js   landmark indices, vector math, joint angles
    filters.js    One Euro filter
    exercises.js  exercise definitions and form checks
    coach.js      FormCoach: rep state machine, fault debouncing, scoring, summary
  js/demo/        procedural 33-point squatter used by the hero, demo mode and tests
  js/render/      canvas skeleton / fault / angle renderer
  js/app/         camera + MediaPipe wrapper, voice, storage, app controller
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
