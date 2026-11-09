require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const sharp = require('sharp');

for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SESSION_SECRET']) {
  if (!process.env[k]) {
    console.error(`Faltou ${k} no arquivo .env (veja o .env.example).`);
    process.exit(1);
  }
}

const db = require('./src/db');
const spotify = require('./src/spotify');
const { startPoller, pollUser } = require('./src/poller');
const { fmtDuration, escapeXml } = require('./src/format');

const PORT = Number(process.env.PORT || 3000);
const MAX_GROUP_SIZE = Number(process.env.MAX_GROUP_SIZE || 5);
const RANGES = ['short_term', 'medium_term', 'long_term'];

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  cookieSession({
    name: 'vitrola',
    keys: [process.env.SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
  })
);

const baseUrl = (req) =>
  (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const erro = (res, status, titulo, mensagem) => res.status(status).render('erro', { titulo, mensagem });

// ---------- "Ouvindo agora" com cache curto, para não estourar o limite da API ----------
const nowCache = new Map();
async function nowCached(user) {
  const hit = nowCache.get(user.id);
  if (hit && Date.now() - hit.at < 8000) return hit.value;
  let value = null;
  try {
    value = await spotify.nowPlaying(user);
  } catch (e) {
    if (hit) return hit.value;
  }
  nowCache.set(user.id, { at: Date.now(), value });
  return value;
}

async function buildRank(groupId, withNow) {
  const users = db.usersInGroup(groupId);
  const list = await Promise.all(
    users.map(async (u) => {
      const s = db.userStats(u.id);
      return {
        id: u.id,
        name: u.display_name || 'Sem nome',
        image: u.image_url,
        totalMs: s.totalMs,
        plays: s.plays,
        topTrack: s.topTrack,
        now: withNow ? await nowCached(u) : undefined,
      };
    })
  );
  return list.sort((a, b) => b.totalMs - a.totalMs || b.plays - a.plays);
}

// ---------- Login ----------
app.get('/convite/:code', (req, res) => {
  if (!db.getGroupByInvite(req.params.code)) {
    return erro(res, 404, 'Convite inválido', 'Esse link de convite não existe mais. Peça um novo para quem te convidou.');
  }
  req.session.invite = req.params.code;
  res.redirect('/');
});

app.get('/', (req, res) => {
  const user = req.session.userId && db.getUser(req.session.userId);
  if (!user) return res.render('login', { convidado: !!req.session.invite });
  res.render('index', { user });
});

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  res.redirect(spotify.authUrl(state));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return erro(res, 400, 'Entrada cancelada', 'Você não autorizou o acesso ao Spotify. Tente entrar de novo quando quiser.');
  }
  if (!code || !state || state !== req.session.state) {
    return erro(res, 400, 'Sessão expirada', 'Não deu para confirmar o login. Volte à página inicial e entre de novo.');
  }
  try {
    const t = await spotify.exchangeCode(code);
    const temp = {
      id: null,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000,
    };
    const me = await spotify.me(temp);

    const existing = db.getUserBySpotifyId(me.id);
    let groupId;
    if (existing) {
      groupId = existing.group_id;
    } else if (req.session.invite) {
      const g = db.getGroupByInvite(req.session.invite);
      if (!g) return erro(res, 404, 'Convite inválido', 'Esse link de convite não existe mais. Peça um novo para quem te convidou.');
      if (db.countUsers(g.id) >= MAX_GROUP_SIZE) {
        return erro(res, 403, 'Grupo cheio', `Esse grupo já tem ${MAX_GROUP_SIZE} pessoas, que é o limite do modo de desenvolvimento do Spotify.`);
      }
      groupId = g.id;
    } else {
      groupId = db.createGroup().id;
    }

    const user = db.upsertUser({
      spotifyId: me.id,
      displayName: me.display_name || me.id,
      imageUrl: me.images && me.images[0] ? me.images[0].url : null,
      groupId,
      accessToken: temp.access_token,
      refreshToken: temp.refresh_token,
      expiresAt: temp.expires_at,
    });

    req.session = { userId: user.id };
    pollUser(user).catch(() => {});
    res.redirect('/');
  } catch (e) {
    console.error('[callback]', e.message);
    if (e.status === 403) {
      return erro(
        res, 403, 'O Spotify recusou o acesso',
        'Enquanto o app está em modo de desenvolvimento, o e-mail da sua conta do Spotify precisa ser adicionado em "User Management" no painel do app. Peça para quem criou o app fazer isso e tente de novo.'
      );
    }
    erro(res, 500, 'Não deu para entrar', 'Algo falhou na conversa com o Spotify. Tente de novo em instantes.');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ---------- API ----------
function requireAuth(req, res, next) {
  const user = req.session.userId && db.getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'login' });
  req.user = user;
  next();
}

app.get('/api/me', requireAuth, async (req, res) => {
  const user = req.user;
  const range = RANGES.includes(req.query.range) ? req.query.range : 'medium_term';
  const stats = db.userStats(user.id);
  const [artists, tracks, now] = await Promise.allSettled([
    spotify.topArtists(user, range),
    spotify.topTracks(user, range),
    nowCached(user),
  ]);
  res.json({
    user: { name: user.display_name, image: user.image_url },
    since: user.joined_at,
    range,
    stats,
    topPlayed: db.topTracks(user.id, 5),
    topArtists: artists.status === 'fulfilled' ? artists.value : null,
    topTracks: tracks.status === 'fulfilled' ? tracks.value : null,
    now: now.status === 'fulfilled' ? now.value : null,
  });
});

app.get('/api/rank', requireAuth, async (req, res) => {
  const group = db.getGroup(req.user.group_id);
  const base = baseUrl(req);
  res.json({
    me: req.user.id,
    members: await buildRank(group.id, true),
    maxSize: MAX_GROUP_SIZE,
    inviteUrl: `${base}/convite/${group.invite_code}`,
    shareUrl: `${base}/r/${group.share_token}`,
    cardUrl: `${base}/r/${group.share_token}/card.png`,
  });
});

// ---------- Página pública de compartilhamento ----------
app.get('/r/:token', async (req, res) => {
  const group = db.getGroupByShare(req.params.token);
  if (!group) return erro(res, 404, 'Rank não encontrado', 'Esse link de rank não existe.');
  const base = baseUrl(req);
  const members = (await buildRank(group.id, false)).slice(0, 10);
  res.render('share', {
    members,
    fmt: fmtDuration,
    base,
    url: `${base}/r/${group.share_token}`,
    image: `${base}/r/${group.share_token}/card.png`,
  });
});

function cardSvg(members) {
  const rows = members
    .slice(0, 5)
    .map((m, i) => {
      const y = 215 + i * 74;
      const cor = i === 0 ? '#1ed760' : '#eefaf1';
      return `
        <text x="80" y="${y}" font-size="52" font-weight="800" fill="${cor}">${i + 1}</text>
        <text x="160" y="${y}" font-size="38" font-weight="700" fill="#eefaf1">${escapeXml(m.name.slice(0, 22))}</text>
        <text x="1120" y="${y}" font-size="38" font-weight="700" fill="${cor}" text-anchor="end">${escapeXml(fmtDuration(m.totalMs))}</text>
        <line x1="80" y1="${y + 24}" x2="1120" y2="${y + 24}" stroke="#eefaf1" stroke-opacity="0.18"/>`;
    })
    .join('');
  const vazio = members.length && members.some((m) => m.totalMs > 0)
    ? ''
    : '<text x="80" y="260" font-size="34" fill="#8ea896">O rank começa a contar quando a galera entra.</text>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Arial, Helvetica, sans-serif">
    <rect width="1200" height="630" fill="#070907"/>
    <text x="80" y="115" font-size="60" font-weight="800" fill="#eefaf1">Quem mais ouviu música?</text>
    ${rows}${vazio}
    <text x="80" y="590" font-size="28" font-weight="700" fill="#8ea896">Vitrine</text>
  </svg>`;
}

app.get('/r/:token/card.png', async (req, res) => {
  const group = db.getGroupByShare(req.params.token);
  if (!group) return res.sendStatus(404);
  try {
    const members = await buildRank(group.id, false);
    const png = await sharp(Buffer.from(cardSvg(members))).png().toBuffer();
    res.set('Cache-Control', 'public, max-age=300').type('png').send(png);
  } catch (e) {
    console.error('[card]', e.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Vitrine rodando em ${process.env.BASE_URL || `http://127.0.0.1:${PORT}`}`);
  startPoller();
});
