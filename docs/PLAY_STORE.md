# Publishing ShapeCoach on Google Play

ShapeCoach for Android is a **Trusted Web Activity**: a small Android app that opens
`https://shapecoach-theta.vercel.app/app.html?source=android` full screen in Chrome. The camera,
the on-device pose model and the coach's voice work exactly as on the website. Inside the app,
the live coach and video analysis need **ShapeCoach Premium**, a US$14.99 monthly subscription
sold through Google Play Billing. The demo stays free.

| What | Value |
| --- | --- |
| App name | ShapeCoach |
| Package name | `net.shapecoach.app` (permanent once uploaded) |
| Subscription product ID | `shapecoach_premium` |
| Base plan | `monthly`, auto-renewing, 1 month, US$14.99 |
| Website (app content) | https://shapecoach-theta.vercel.app |
| Privacy policy | https://shapecoach-theta.vercel.app/privacy.html |
| Terms | https://shapecoach-theta.vercel.app/terms.html |
| Target / min Android | Android 16 (API 36) / Android 6 (API 23) |
| Play Billing | Android Browser Helper billing 1.2.0 (Play Billing Library 8.3) |

## Files

- **`shapecoach-1.0.0.aab`**: the signed release bundle to upload. It is built by the
  *Android app* GitHub workflow (unsigned, on the `android-build` branch) and then signed with the
  upload key.
- **`shapecoach-upload.jks`** and its password: the **upload key**. Keep both private and backed
  up (for example in a password manager). Never commit them. You need them to publish every
  update; if you lose them, Play Console support can reset the upload key, which takes days.
- **`store/`**: Play Store icon (512×512), feature graphic (1024×500) and four phone screenshots
  (1080×1920).

## 1. Set up the Play Console account

1. Create a developer account at https://play.google.com/console ($25 one-time) and complete
   identity verification.
2. **Personal accounts created after November 2023 must run a closed test with at least 12 testers
   for 14 days in a row** before they can publish to production. Plan for this.
3. Set up a **payments profile** (Settings → Payments profile) so Google can pay you. Selling
   subscriptions requires it.

## 2. Create the app

All apps → **Create app**: name *ShapeCoach*, default language English, **App**, **Free**.
(The download is free; Premium is an in-app subscription. Don't pick "Paid".)

## 3. Create the subscription

Monetize → Products → **Subscriptions** → Create subscription:

1. Product ID **`shapecoach_premium`** (must match exactly), name *ShapeCoach Premium*.
2. Add a base plan: ID **`monthly`**, auto-renewing, billing period **1 month**, price
   **US$14.99**. Let Play set local prices for other countries, then **Activate** it.
3. Optional: add a free-trial offer to the base plan. The app shows whatever Google Play offers.

Use one base plan only: through the Digital Goods API the app sees just the first eligible plan.

## 4. Let the website acknowledge purchases (required)

Google Play **refunds subscriptions that are not acknowledged within 3 days**. ShapeCoach
acknowledges each purchase from its server (`api/verify-purchase.js` on Vercel), which needs a
Play service account:

1. Play Console → Setup → **API access**: link (or create) a Google Cloud project.
2. Create a **service account** there, then in Play Console → Users and permissions, invite its
   email and grant **View financial data** and **Manage orders and subscriptions** for ShapeCoach.
3. In Google Cloud, create a **JSON key** for the service account.
4. In Vercel → project **shapecoach** → Settings → Environment Variables, add
   `GOOGLE_PLAY_SERVICE_ACCOUNT` (Production) with the full JSON as the value, then redeploy.

New service accounts can take up to a day before Google accepts them. Until this is set up, the
endpoint answers `503 not_configured` and purchases are **not** acknowledged.

## 5. Upload the bundle

1. Testing → **Internal testing** (for yourself first) or **Closed testing** → Create release.
2. When asked about app signing, keep **Google-generated key** (Play App Signing).
3. Upload `shapecoach-1.0.0.aab`, add release notes, save and roll out to the test track.

## 6. Add Google's signing key to the website (required)

Play re-signs the app with its own key, so the website must also trust that key, or the app opens
with a browser address bar and **purchases won't work**.

1. Setup → **App signing** → copy the **App signing key certificate SHA-256 fingerprint**.
2. Add it to `.well-known/assetlinks.json` next to the upload key's fingerprint and redeploy.
   (It's a public value: send it over and it will be added for you.)

Check it with Google's tool:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://shapecoach-theta.vercel.app&relation=delegate_permission/common.handle_all_urls`

## 7. Test the subscription

1. Settings → **License testing**: add the Gmail accounts of your testers. Their purchases are free
   test purchases that renew every few minutes.
2. Install the app from the test track's opt-in link, tap **Start coaching**, subscribe, and check
   the coach unlocks. Settings → ShapeCoach Premium shows *Active* and a **Manage** link.
3. In Play Console → Order management, the test order should show as acknowledged.

## 8. App content (Policy → App content)

- **Privacy policy**: `https://shapecoach-theta.vercel.app/privacy.html`
- **Ads**: no ads.
- **App access**: all features can be reviewed without an account. Tell reviewers that the free
  demo (*Watch a demo*) shows the full coaching experience, and that the live camera coach is part
  of ShapeCoach Premium.
- **Data safety**: camera frames are processed on the device and never leave it; settings and set
  history stay on the device; there are no accounts, analytics or ads. Purchases are processed by
  Google Play, and the purchase token is only checked with Google and not stored. Review the form
  answers yourself before submitting.
- **Health apps** declaration: ShapeCoach is a fitness app giving general exercise guidance; it is
  not a medical device.
- **Target audience**: 18+ (or 13+), not designed for children.
- Complete the **content rating** questionnaire.

## 9. Store listing

- **App name**: ShapeCoach
- **Short description** (80 characters max):
  `Your AI personal trainer: counts reps and fixes your form as you train.`
- **Full description**:

  > ShapeCoach turns your phone into a personal trainer that watches every rep.
  >
  > Prop up your phone, press start and move. There's no exercise to pick: ShapeCoach recognises
  > squats, push-ups, lunges, bicep curls and overhead presses on its own, counts every rep, and
  > talks you through your form mid-set, with cues like "Push your knees out" and "Brace your core".
  >
  > • Automatic exercise recognition from your first rep
  > • Rep counting that only counts full range of motion
  > • Real-time form checks: knees caving in, chest dropping, hips sagging, elbows drifting,
  >   swinging and rushing
  > • A coach's voice that corrects you mid-set, so you don't have to look at the screen
  > • Workout summaries with form score, clean reps and time per rep
  > • Private by design: pose tracking runs on your phone and video is never uploaded
  >
  > ShapeCoach Premium unlocks the live camera coach and video analysis for US$14.99 a month
  > (shown in your local currency before you subscribe). The subscription renews monthly until you
  > cancel in Google Play. The demo is free.
  >
  > ShapeCoach gives general fitness guidance and is not medical advice.

- **App icon**: `store/play-icon-512.png`
- **Feature graphic**: `store/feature-graphic-1024x500.png`
- **Phone screenshots**: `store/screenshot-1-home.png` … `store/screenshot-4-premium.png`
- **Category**: Health & Fitness. Add your contact email.

## Updating the app later

Most changes (the coach, the paywall, copy) are website changes: deploy the website and every
installed app gets them immediately. Rebuild the Android bundle only to change the app itself
(name, icon, colours, domain or library versions):

1. Increase `versionCode` (and `versionName`) in `android/app/build.gradle` and
   `android/twa-manifest.json`.
2. Push; the *Android app* workflow publishes the unsigned bundle to the `android-build` branch.
3. Sign it: `scripts/sign-android.sh shapecoach-unsigned.aab shapecoach-upload.jks shapecoach-1.0.1.aab`.
4. Upload it as a new release.

### Moving to your own domain

If you buy a domain such as `shapecoach.net`, connect it in Vercel, serve the same
`.well-known/assetlinks.json` there, change `hostName` in `android/app/build.gradle` (and `host`
in `android/twa-manifest.json`), and publish an app update.
