// Vercel serverless function: verify a ShapeCoach Premium purchase with Google Play and
// acknowledge it. Google Play refunds subscriptions that are not acknowledged within three
// days, and a Trusted Web Activity can only acknowledge them through this server-side API.
//
// Setup (once): in Play Console → Setup → API access, link a Google Cloud project, create a
// service account, grant it "View financial data" and "Manage orders and subscriptions",
// then paste its JSON key into the Vercel environment variable GOOGLE_PLAY_SERVICE_ACCOUNT.

import { createSign } from 'node:crypto';

export const PACKAGE_NAME = 'net.shapecoach.app';
export const PRODUCT_ID = 'shapecoach_premium';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases`;
const ACTIVE_STATES = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);
// Play purchase tokens are long strings of letters, digits, dots, dashes and underscores.
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{10,4096}$/;

const base64url = (value) => Buffer.from(value).toString('base64url');

/** A signed JWT asking Google for an access token to the Play Developer API. */
export function signedAssertion(credentials, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: credentials.client_email,
    scope: SCOPE,
    aud: credentials.token_uri || DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function accessToken(credentials, fetchImpl, nowMs) {
  const response = await fetchImpl(credentials.token_uri || DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedAssertion(credentials, Math.floor(nowMs / 1000)),
    }).toString(),
  });
  if (!response.ok) throw new Error(`Google sign-in failed (${response.status})`);
  return (await response.json()).access_token;
}

/**
 * Look the purchase up with Google Play and acknowledge it if it is still pending.
 * @returns {Promise<{ok: boolean, status: number, active?: boolean, state?: string, expiresAt?: string, error?: string}>}
 */
export async function verifyAndAcknowledge(purchaseToken, { credentials, fetchImpl = fetch, nowMs = Date.now() }) {
  const token = await accessToken(credentials, fetchImpl, nowMs);
  const auth = { authorization: `Bearer ${token}` };
  const encoded = encodeURIComponent(purchaseToken);

  const lookup = await fetchImpl(`${API}/subscriptionsv2/tokens/${encoded}`, { headers: auth });
  if (lookup.status === 400 || lookup.status === 404 || lookup.status === 410) {
    return { ok: false, status: 400, error: 'unknown_purchase' };
  }
  if (!lookup.ok) return { ok: false, status: 502, error: `play_lookup_failed_${lookup.status}` };
  const subscription = await lookup.json();
  const item = (subscription.lineItems ?? []).find((line) => line.productId === PRODUCT_ID);
  if (!item) return { ok: false, status: 400, error: 'wrong_product' };

  if (subscription.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
    const ack = await fetchImpl(`${API}/subscriptions/${PRODUCT_ID}/tokens/${encoded}:acknowledge`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    });
    if (!ack.ok) return { ok: false, status: 502, error: `play_acknowledge_failed_${ack.status}` };
  }

  return {
    ok: true,
    status: 200,
    active: ACTIVE_STATES.has(subscription.subscriptionState),
    state: subscription.subscriptionState,
    expiresAt: item.expiryTime,
  };
}

function readCredentials(env) {
  try {
    const credentials = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT ?? '');
    return credentials.client_email && credentials.private_key ? credentials : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res, { env = process.env, fetchImpl = fetch } = {}) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body ?? {});
  const { purchaseToken, productId, packageName } = body;
  if (typeof purchaseToken !== 'string' || !TOKEN_PATTERN.test(purchaseToken)
    || (productId !== undefined && productId !== PRODUCT_ID)
    || (packageName !== undefined && packageName !== PACKAGE_NAME)) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }
  const credentials = readCredentials(env);
  if (!credentials) return res.status(503).json({ ok: false, error: 'not_configured' });
  try {
    const { status, ...result } = await verifyAndAcknowledge(purchaseToken, { credentials, fetchImpl });
    return res.status(status).json(result);
  } catch (error) {
    console.error('verify-purchase failed', error);
    return res.status(502).json({ ok: false, error: 'play_unreachable' });
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
