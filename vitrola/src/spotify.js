const db = require('./db');

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-top-read',
  'user-read-recently-played',
  'user-read-currently-playing',
  'user-read-playback-state',
].join(' ');

const redirectUri = () => `${(process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')}/auth/callback`;

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
  });
  return `${ACCOUNTS}/authorize?${p}`;
}

async function tokenRequest(params) {
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const e = new Error(`Token request falhou (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

const exchangeCode = (code) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });

async function accessToken(user, force = false) {
  if (!force && user.expires_at && user.expires_at - Date.now() > 60_000) return user.access_token;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: user.refresh_token });
  user.access_token = t.access_token;
  user.expires_at = Date.now() + t.expires_in * 1000;
  if (t.refresh_token) user.refresh_token = t.refresh_token;
  if (user.id) {
    db.updateTokens(user.id, {
      accessToken: user.access_token,
      refreshToken: t.refresh_token || null,
      expiresAt: user.expires_at,
    });
  }
  return user.access_token;
}

let blockedUntil = 0; // pausa global quando o Spotify responde 429

async function get(user, pathname) {
  if (Date.now() < blockedUntil) {
    const e = new Error('rate_limited');
    e.status = 429;
    throw e;
  }
  const call = async (token) => fetch(API + pathname, { headers: { Authorization: `Bearer ${token}` } });

  let res = await call(await accessToken(user));
  if (res.status === 401) res = await call(await accessToken(user, true));

  if (res.status === 204) return null;
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 5);
    blockedUntil = Date.now() + wait * 1000;
    const e = new Error('rate_limited');
    e.status = 429;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Spotify ${res.status} em ${pathname}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

const img = (images) => (images && (images[1] || images[0]) ? (images[1] || images[0]).url : null);

const me = (user) => get(user, '/me');

async function topArtists(user, range = 'medium_term') {
  const d = await get(user, `/me/top/artists?time_range=${range}&limit=10`);
  return (d?.items || []).map((a) => ({
    id: a.id, name: a.name, image: img(a.images), url: a.external_urls?.spotify || null,
  }));
}

async function topTracks(user, range = 'medium_term') {
  const d = await get(user, `/me/top/tracks?time_range=${range}&limit=10`);
  return (d?.items || []).map((t) => ({
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    image: img(t.album?.images),
    url: t.external_urls?.spotify || null,
  }));
}

async function nowPlaying(user) {
  const d = await get(user, '/me/player/currently-playing');
  if (!d || !d.item) return null;
  const it = d.item;
  return {
    isPlaying: !!d.is_playing,
    name: it.name,
    artists: it.artists ? it.artists.map((a) => a.name).join(', ') : it.show?.name || '',
    image: img(it.album?.images || it.images),
    url: it.external_urls?.spotify || null,
  };
}

async function recentlyPlayed(user, after) {
  return get(user, `/me/player/recently-played?limit=50&after=${after}`);
}

module.exports = { authUrl, exchangeCode, me, topArtists, topTracks, nowPlaying, recentlyPlayed };
