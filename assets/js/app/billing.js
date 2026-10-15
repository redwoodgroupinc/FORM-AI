// ShapeCoach Premium: a Google Play subscription sold inside the ShapeCoach Android app.
//
// The Android app is a Trusted Web Activity: it opens this website in Chrome and lets the
// page reach Google Play Billing through the Digital Goods API (prices and owned purchases)
// and the Payment Request API (buying). Play refunds subscriptions that are not
// acknowledged within three days, and only the Play Developer API can acknowledge them, so
// each new purchase is sent to /api/verify-purchase (see api/verify-purchase.js).

export const PLAY_BILLING = 'https://play.google.com/billing';
export const PREMIUM_ID = 'shapecoach_premium';
export const ANDROID_PACKAGE = 'net.shapecoach.app';
export const LIST_PRICE = 'US$14.99 a month';
export const MANAGE_URL = `https://play.google.com/store/account/subscriptions?sku=${PREMIUM_ID}&package=${ANDROID_PACKAGE}`;
export const VERIFY_URL = '/api/verify-purchase';

// The Android app opens app.html?source=android. Remember that for the rest of the visit so
// pages reached by links (for example the landing page and back) still know.
const APP_FLAG = 'shapecoach.androidApp';

/** True when this page is running inside the ShapeCoach Android app. */
export function inAndroidApp(win = globalThis.window) {
  try {
    const fromLaunch = new URLSearchParams(win.location.search).get('source') === 'android';
    const fromReferrer = String(win.document?.referrer ?? '').startsWith(`android-app://${ANDROID_PACKAGE}`);
    if (fromLaunch || fromReferrer) win.sessionStorage.setItem(APP_FLAG, '1');
    return fromLaunch || fromReferrer || win.sessionStorage.getItem(APP_FLAG) === '1';
  } catch {
    return false;
  }
}

/** "US$14.99" style price from a Digital Goods API price ({ currency, value }). */
export function formatPrice(price, locale) {
  if (!price?.currency || price.value === undefined) return null;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency }).format(Number(price.value));
  } catch {
    return `${price.value} ${price.currency}`;
  }
}

/** "a month" from an ISO 8601 period such as P1M; null when unknown. */
export function periodLabel(iso) {
  const match = /^P(\d+)([DWMY])$/.exec(String(iso ?? ''));
  if (!match) return null;
  const count = Number(match[1]);
  const unit = { D: 'day', W: 'week', M: 'month', Y: 'year' }[match[2]];
  return count === 1 ? `a ${unit}` : `every ${count} ${unit}s`;
}

async function connect(win) {
  if (typeof win.getDigitalGoodsService !== 'function') return null;
  try {
    return (await win.getDigitalGoodsService(PLAY_BILLING)) ?? null;
  } catch {
    return null;
  }
}

/**
 * What Google Play says about ShapeCoach Premium on this device.
 * @returns {Promise<{billing: boolean, active: boolean, price: string, purchases: Array}>}
 * `billing` is false when Google Play Billing can't be reached (e.g. outside the app).
 */
export async function premiumStatus(win = globalThis.window) {
  const service = await connect(win);
  if (!service) return { billing: false, active: false, price: LIST_PRICE, purchases: [] };
  const [purchases, details] = await Promise.all([
    service.listPurchases().catch(() => []),
    service.getDetails([PREMIUM_ID]).catch(() => []),
  ]);
  const owned = purchases.filter((p) => p.itemId === PREMIUM_ID);
  const item = details.find((d) => d.itemId === PREMIUM_ID);
  const amount = formatPrice(item?.price);
  const period = periodLabel(item?.subscriptionPeriod);
  return {
    billing: true,
    active: owned.length > 0,
    price: amount ? `${amount} ${period ?? 'a month'}` : LIST_PRICE,
    purchases: owned,
  };
}

/**
 * Ask our server to verify a purchase with Google Play and acknowledge it.
 * Resolves to the server's answer, or { ok: false } if it couldn't be reached.
 */
export async function verifyPurchase(purchaseToken, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purchaseToken, productId: PREMIUM_ID, packageName: ANDROID_PACKAGE }),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && body.ok === true, ...body };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Open Google Play's purchase sheet for ShapeCoach Premium.
 * @returns {Promise<{purchased: boolean, cancelled?: boolean, verified?: boolean}>}
 */
export async function subscribe(win = globalThis.window, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof win.PaymentRequest !== 'function') throw new Error('Google Play Billing is not available');
  const request = new win.PaymentRequest(
    [{ supportedMethods: PLAY_BILLING, data: { sku: PREMIUM_ID } }],
    // Play shows and charges its own price; Payment Request just needs a total.
    { total: { label: 'ShapeCoach Premium', amount: { currency: 'USD', value: '0' } } },
  );
  let response;
  try {
    response = await request.show();
  } catch (error) {
    if (error?.name === 'AbortError') return { purchased: false, cancelled: true };
    throw error;
  }
  const token = response.details?.purchaseToken;
  const result = token ? await verifyPurchase(token, { fetchImpl }) : { ok: false };
  // Play has charged the user either way; the purchase shows up in listPurchases().
  await response.complete(token ? 'success' : 'fail');
  return { purchased: Boolean(token), verified: result.ok };
}

/**
 * Make sure every owned purchase has been acknowledged, in case the verification after
 * buying didn't get through (for example the connection dropped). Cheap and idempotent.
 */
export async function acknowledgeOwned(purchases, { fetchImpl = globalThis.fetch, storage } = {}) {
  for (const purchase of purchases) {
    const key = `shapecoach.ack.${purchase.purchaseToken}`;
    if (storage?.get(key, false)) continue;
    const result = await verifyPurchase(purchase.purchaseToken, { fetchImpl });
    if (result.ok) storage?.set(key, true);
  }
}
