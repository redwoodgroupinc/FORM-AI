import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import {
  inAndroidApp, formatPrice, periodLabel, premiumStatus, subscribe, verifyPurchase, acknowledgeOwned,
  PREMIUM_ID, PLAY_BILLING, LIST_PRICE,
} from '../assets/js/app/billing.js';
import handler, { signedAssertion, verifyAndAcknowledge, PACKAGE_NAME, PRODUCT_ID } from '../api/verify-purchase.js';

function fakeWindow({ search = '', referrer = '', session = {}, service, PaymentRequest } = {}) {
  const store = { ...session };
  return {
    location: { search },
    document: { referrer },
    sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    getDigitalGoodsService: service === undefined ? undefined : async (method) => {
      assert.equal(method, PLAY_BILLING);
      return service;
    },
    PaymentRequest,
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('the app is recognised from its launch URL or referrer, and remembered for the visit', () => {
  const win = fakeWindow({ search: '?source=android' });
  assert.equal(inAndroidApp(win), true);
  win.location.search = '';
  assert.equal(inAndroidApp(win), true, 'remembered after navigating');
  assert.equal(inAndroidApp(fakeWindow({ referrer: 'android-app://net.shapecoach.app/' })), true);
  assert.equal(inAndroidApp(fakeWindow({ search: '?demo' })), false, 'the website is not the app');
});

test('prices and periods are shown the way Google Play reports them', () => {
  assert.equal(formatPrice({ currency: 'USD', value: '14.99' }, 'en-US'), '$14.99');
  assert.match(formatPrice({ currency: 'PKR', value: '4200' }, 'en-US'), /^PKR\s4,200\.00$/);
  assert.equal(formatPrice(null), null);
  assert.equal(periodLabel('P1M'), 'a month');
  assert.equal(periodLabel('P1Y'), 'a year');
  assert.equal(periodLabel('P3M'), 'every 3 months');
  assert.equal(periodLabel(undefined), null);
});

test('premium status: no Play billing outside the app', async () => {
  const status = await premiumStatus(fakeWindow());
  assert.deepEqual(status, { billing: false, active: false, price: LIST_PRICE, purchases: [] });
});

test('premium status: active when Play lists the subscription, with Play\'s local price', async () => {
  const service = {
    listPurchases: async () => [{ itemId: PREMIUM_ID, purchaseToken: 'tok-123456789' }, { itemId: 'other', purchaseToken: 'x' }],
    getDetails: async (ids) => {
      assert.deepEqual(ids, [PREMIUM_ID]);
      return [{ itemId: PREMIUM_ID, price: { currency: 'USD', value: '14.99' }, subscriptionPeriod: 'P1M' }];
    },
  };
  const status = await premiumStatus(fakeWindow({ service }));
  assert.equal(status.billing, true);
  assert.equal(status.active, true);
  assert.match(status.price, /14\.99 a month$/);
  assert.equal(status.purchases.length, 1);

  const none = await premiumStatus(fakeWindow({ service: { listPurchases: async () => [], getDetails: async () => [] } }));
  assert.equal(none.active, false);
  assert.equal(none.price, LIST_PRICE);
});

test('subscribing verifies the purchase with our server before completing the payment', async () => {
  const calls = [];
  class FakePaymentRequest {
    constructor(methods, details) {
      calls.push(['request', methods[0].supportedMethods, methods[0].data.sku, details.total.amount.currency]);
    }

    async show() {
      return { details: { purchaseToken: 'purchase-token-123' }, complete: async (r) => calls.push(['complete', r]) };
    }
  }
  const fetchImpl = async (url, init) => {
    calls.push(['verify', url, JSON.parse(init.body).purchaseToken]);
    return jsonResponse(200, { ok: true, active: true });
  };
  const result = await subscribe(fakeWindow({ PaymentRequest: FakePaymentRequest }), { fetchImpl });
  assert.deepEqual(result, { purchased: true, verified: true });
  assert.deepEqual(calls, [
    ['request', PLAY_BILLING, PREMIUM_ID, 'USD'],
    ['verify', '/api/verify-purchase', 'purchase-token-123'],
    ['complete', 'success'],
  ]);
});

test('closing the Play sheet is a cancel, not an error', async () => {
  class Cancelled {
    async show() { throw new DOMException('closed', 'AbortError'); }
  }
  assert.deepEqual(await subscribe(fakeWindow({ PaymentRequest: Cancelled })), { purchased: false, cancelled: true });
});

test('verification failures are reported, not thrown', async () => {
  assert.equal((await verifyPurchase('t', { fetchImpl: async () => { throw new Error('offline'); } })).ok, false);
  assert.equal((await verifyPurchase('t', { fetchImpl: async () => jsonResponse(503, { ok: false, error: 'not_configured' }) })).ok, false);
});

test('owned purchases are acknowledged once, then remembered', async () => {
  const saved = new Map();
  const storage = { get: (k, d) => saved.get(k) ?? d, set: (k, v) => saved.set(k, v) };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(200, { ok: true }); };
  const purchases = [{ itemId: PREMIUM_ID, purchaseToken: 'abc' }];
  await acknowledgeOwned(purchases, { fetchImpl, storage });
  await acknowledgeOwned(purchases, { fetchImpl, storage });
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Server: /api/verify-purchase

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  client_email: 'shapecoach@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
};
const TOKEN = 'abcdefghijklmnop.AO-J1Oz_token';

test('the Google sign-in assertion is a valid RS256 JWT for the Play Developer API', () => {
  const jwt = signedAssertion(credentials, 1_800_000_000);
  const [h, c, sig] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${c}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(sig, 'base64url')), true);
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, credentials.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher');
  assert.equal(claims.exp - claims.iat, 3600);
});

function playApi({ state = 'SUBSCRIPTION_STATE_ACTIVE', ack = 'ACKNOWLEDGEMENT_STATE_PENDING', productId = PRODUCT_ID, lookupStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')}`);
    if (url.includes('oauth2')) return jsonResponse(200, { access_token: 'access' });
    if (url.includes('subscriptionsv2')) {
      assert.equal(init.headers.authorization, 'Bearer access');
      return jsonResponse(lookupStatus, {
        subscriptionState: state, acknowledgementState: ack, lineItems: [{ productId, expiryTime: '2026-11-15T00:00:00Z' }],
      });
    }
    if (url.endsWith(':acknowledge')) return jsonResponse(200, {});
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

test('a new purchase is looked up and acknowledged with Google Play', async () => {
  const { calls, fetchImpl } = playApi();
  const result = await verifyAndAcknowledge(TOKEN, { credentials, fetchImpl });
  assert.deepEqual(result, { ok: true, status: 200, active: true, state: 'SUBSCRIPTION_STATE_ACTIVE', expiresAt: '2026-11-15T00:00:00Z' });
  assert.deepEqual(calls, [
    'POST /token',
    `GET /androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${encodeURIComponent(TOKEN)}`,
    `POST /androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptions/${PRODUCT_ID}/tokens/${encodeURIComponent(TOKEN)}:acknowledge`,
  ]);
});

test('an already acknowledged purchase is not acknowledged again', async () => {
  const { calls, fetchImpl } = playApi({ ack: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', state: 'SUBSCRIPTION_STATE_EXPIRED' });
  const result = await verifyAndAcknowledge(TOKEN, { credentials, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.active, false);
  assert.equal(calls.length, 2);
});

test('unknown tokens and other products are rejected', async () => {
  assert.equal((await verifyAndAcknowledge(TOKEN, { credentials, fetchImpl: playApi({ lookupStatus: 404 }).fetchImpl })).error, 'unknown_purchase');
  assert.equal((await verifyAndAcknowledge(TOKEN, { credentials, fetchImpl: playApi({ productId: 'other' }).fetchImpl })).error, 'wrong_product');
});

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('the endpoint validates input and explains when it is not configured yet', async () => {
  const env = { GOOGLE_PLAY_SERVICE_ACCOUNT: JSON.stringify(credentials) };
  let res = fakeRes();
  await handler({ method: 'GET' }, res, { env });
  assert.equal(res.statusCode, 405);

  res = fakeRes();
  await handler({ method: 'POST', body: { purchaseToken: 'bad token!' } }, res, { env });
  assert.equal(res.statusCode, 400);

  res = fakeRes();
  await handler({ method: 'POST', body: { purchaseToken: TOKEN, productId: 'free_stuff' } }, res, { env });
  assert.equal(res.statusCode, 400);

  res = fakeRes();
  await handler({ method: 'POST', body: { purchaseToken: TOKEN } }, res, { env: {} });
  assert.deepEqual([res.statusCode, res.body.error], [503, 'not_configured']);

  res = fakeRes();
  await handler({ method: 'POST', body: JSON.stringify({ purchaseToken: TOKEN, productId: PRODUCT_ID, packageName: PACKAGE_NAME }) }, res, { env, fetchImpl: playApi().fetchImpl });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.headers['cache-control'], 'no-store');
});
