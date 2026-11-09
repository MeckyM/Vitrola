const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_code TEXT UNIQUE NOT NULL,
    share_token TEXT UNIQUE NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    spotify_id    TEXT UNIQUE NOT NULL,
    display_name  TEXT,
    image_url     TEXT,
    group_id      INTEGER NOT NULL REFERENCES groups(id),
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    INTEGER,
    poll_cursor   INTEGER NOT NULL,
    joined_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plays (
    user_id      INTEGER NOT NULL REFERENCES users(id),
    played_at    INTEGER NOT NULL,
    track_id     TEXT,
    track_name   TEXT,
    artist_names TEXT,
    image_url    TEXT,
    duration_ms  INTEGER NOT NULL,
    PRIMARY KEY (user_id, played_at)
  );
  CREATE INDEX IF NOT EXISTS idx_plays_user ON plays(user_id);
`);

const code = () => crypto.randomBytes(9).toString('base64url');

const st = {
  insertGroup: db.prepare('INSERT INTO groups (invite_code, share_token, created_at) VALUES (?, ?, ?)'),
  groupById: db.prepare('SELECT * FROM groups WHERE id = ?'),
  groupByInvite: db.prepare('SELECT * FROM groups WHERE invite_code = ?'),
  groupByShare: db.prepare('SELECT * FROM groups WHERE share_token = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userBySpotify: db.prepare('SELECT * FROM users WHERE spotify_id = ?'),
  usersInGroup: db.prepare('SELECT * FROM users WHERE group_id = ? ORDER BY joined_at'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users WHERE group_id = ?'),
  allUsers: db.prepare('SELECT * FROM users'),
  insertUser: db.prepare(`INSERT INTO users
    (spotify_id, display_name, image_url, group_id, access_token, refresh_token, expires_at, poll_cursor, joined_at)
    VALUES (@spotifyId, @displayName, @imageUrl, @groupId, @accessToken, @refreshToken, @expiresAt, @now, @now)`),
  updateProfile: db.prepare(`UPDATE users SET display_name = @displayName, image_url = @imageUrl,
    access_token = @accessToken, refresh_token = COALESCE(@refreshToken, refresh_token), expires_at = @expiresAt
    WHERE spotify_id = @spotifyId`),
  updateTokens: db.prepare(`UPDATE users SET access_token = @accessToken,
    refresh_token = COALESCE(@refreshToken, refresh_token), expires_at = @expiresAt WHERE id = @id`),
  setCursor: db.prepare('UPDATE users SET poll_cursor = ? WHERE id = ?'),
  insertPlay: db.prepare(`INSERT OR IGNORE INTO plays
    (user_id, played_at, track_id, track_name, artist_names, image_url, duration_ms)
    VALUES (@userId, @playedAt, @trackId, @trackName, @artistNames, @imageUrl, @durationMs)`),
  totals: db.prepare('SELECT COALESCE(SUM(duration_ms), 0) AS total_ms, COUNT(*) AS plays FROM plays WHERE user_id = ?'),
  topTracks: db.prepare(`SELECT track_id AS id, MAX(track_name) AS name, MAX(artist_names) AS artists,
      MAX(image_url) AS image, COUNT(*) AS count
    FROM plays WHERE user_id = ? AND track_id IS NOT NULL
    GROUP BY track_id ORDER BY count DESC, MAX(played_at) DESC LIMIT ?`),
};

function createGroup() {
  const r = st.insertGroup.run(code(), code(), Date.now());
  return st.groupById.get(r.lastInsertRowid);
}

function upsertUser({ spotifyId, displayName, imageUrl, groupId, accessToken, refreshToken, expiresAt }) {
  const existing = st.userBySpotify.get(spotifyId);
  if (existing) {
    st.updateProfile.run({ spotifyId, displayName, imageUrl, accessToken, refreshToken, expiresAt });
  } else {
    st.insertUser.run({ spotifyId, displayName, imageUrl, groupId, accessToken, refreshToken, expiresAt, now: Date.now() });
  }
  return st.userBySpotify.get(spotifyId);
}

const insertPlays = db.transaction((userId, rows) => {
  for (const r of rows) st.insertPlay.run({ userId, ...r });
});

function topTracks(userId, limit = 5) {
  return st.topTracks.all(userId, limit);
}

function userStats(userId) {
  const t = st.totals.get(userId);
  return { totalMs: t.total_ms, plays: t.plays, topTrack: topTracks(userId, 1)[0] || null };
}

module.exports = {
  createGroup,
  upsertUser,
  insertPlays,
  topTracks,
  userStats,
  getUser: (id) => st.userById.get(id),
  getUserBySpotifyId: (id) => st.userBySpotify.get(id),
  getGroupByInvite: (c) => st.groupByInvite.get(c),
  getGroupByShare: (t) => st.groupByShare.get(t),
  getGroup: (id) => st.groupById.get(id),
  usersInGroup: (gid) => st.usersInGroup.all(gid),
  countUsers: (gid) => st.countUsers.get(gid).n,
  allUsers: () => st.allUsers.all(),
  updateTokens: (id, t) => st.updateTokens.run({ id, ...t }),
  setCursor: (id, cursor) => st.setCursor.run(cursor, id),
};
