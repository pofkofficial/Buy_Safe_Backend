// services/pssidAuth.js
// ─────────────────────────────────────────────────────────────────────────────
// Mock PSSID OAuth2 integration for Buy Safe.
// When your PSSID system is ready, replace the three constants below with
// your real authorization server URLs and swap mockExchangeCode() for a
// real token exchange call. Everything else in the flow stays identical.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const crypto = require('crypto');

// ── PSSID Server Config (replace when live) ───────────────────────────────────
const PSSID_CONFIG = {
  authorizationEndpoint: process.env.PSSID_AUTH_URL     || 'https://auth.pssid.dev/oauth/authorize',
  tokenEndpoint:         process.env.PSSID_TOKEN_URL    || 'https://auth.pssid.dev/oauth/token',
  userinfoEndpoint:      process.env.PSSID_USERINFO_URL || 'https://auth.pssid.dev/oauth/userinfo',
  clientId:              process.env.PSSID_CLIENT_ID    || 'buysafe-mock-client',
  clientSecret:          process.env.PSSID_CLIENT_SECRET|| 'mock-secret',
  redirectUri:           process.env.PSSID_REDIRECT_URI || 'buysafe://auth/callback',
  scopes:                ['openid', 'profile', 'email', 'phone'],
};

/**
 * Step 1 — Build the authorization URL the mobile app opens in a browser.
 * Returns: { url, state } — store `state` in session to validate callback.
 */
function buildAuthorizationUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     PSSID_CONFIG.clientId,
    redirect_uri:  PSSID_CONFIG.redirectUri,
    scope:         PSSID_CONFIG.scopes.join(' '),
    state,
  });
  return {
    url:   `${PSSID_CONFIG.authorizationEndpoint}?${params}`,
    state,
  };
}

/**
 * Step 2 — Exchange authorization code for user profile.
 * In MOCK mode: returns a deterministic fake profile based on the code.
 * In LIVE mode: calls real PSSID token + userinfo endpoints.
 */
async function exchangeCodeForProfile(code, state, expectedState) {
  if (state !== expectedState) {
    const err = new Error('OAuth state mismatch — possible CSRF attack');
    err.status = 401;
    throw err;
  }

  // ── MOCK MODE ──────────────────────────────────────────────────────────────
  if (process.env.PSSID_MOCK === 'true' || !process.env.PSSID_TOKEN_URL) {
    return mockExchangeCode(code);
  }

  // ── LIVE MODE (uncomment when PSSID is ready) ─────────────────────────────
  // const tokenRes = await axios.post(PSSID_CONFIG.tokenEndpoint, {
  //   grant_type:    'authorization_code',
  //   code,
  //   redirect_uri:  PSSID_CONFIG.redirectUri,
  //   client_id:     PSSID_CONFIG.clientId,
  //   client_secret: PSSID_CONFIG.clientSecret,
  // });
  // const { access_token } = tokenRes.data;
  // const userRes = await axios.get(PSSID_CONFIG.userinfoEndpoint, {
  //   headers: { Authorization: `Bearer ${access_token}` },
  // });
  // return normalizePssidProfile(userRes.data);
}

/**
 * Normalize whatever PSSID returns into Buy Safe's internal user shape.
 * Adjust field names to match your actual PSSID response schema.
 */
function normalizePssidProfile(raw) {
  return {
    pssid:       raw.sub || raw.pssid_id,           // unique PSSID identifier
    username:    raw.preferred_username || raw.username,
    displayName: raw.name || raw.display_name,
    email:       raw.email,
    phone:       raw.phone_number || raw.phone,
    avatarUrl:   raw.picture || raw.avatar_url || null,
    verified:    raw.email_verified === true,
  };
}

// ── Mock ──────────────────────────────────────────────────────────────────────
// Generates a deterministic fake profile from the code string.
// Useful for local dev + Expo Go without a live PSSID server.
function mockExchangeCode(code) {
  const seed = Buffer.from(code).toString('base64').slice(0, 8);
  return normalizePssidProfile({
    sub:                `PSSID-MOCK-${seed}`,
    preferred_username: `user_${seed}`,
    name:               `Test User ${seed}`,
    email:              `${seed}@mock.pssid.dev`,
    phone_number:       '+233200000000',
    email_verified:     true,
    picture:            null,
  });
}

module.exports = { buildAuthorizationUrl, exchangeCodeForProfile, normalizePssidProfile };