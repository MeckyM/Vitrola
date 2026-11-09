const db = require('./db');
const spotify = require('./spotify');

const INTERVAL_MS = 3 * 60 * 1000; // a API devolve no máximo 50 faixas por consulta

async function pollUser(user) {
  const data = await spotify.recentlyPlayed(user, user.poll_cursor);
  const items = data?.items || [];
  if (!items.length) return 0;

  const rows = items
    .filter((i) => i.track)
    .map((i) => ({
      playedAt: Date.parse(i.played_at),
      trackId: i.track.id,
      trackName: i.track.name,
      artistNames: (i.track.artists || []).map((a) => a.name).join(', '),
      imageUrl: (i.track.album?.images?.[1] || i.track.album?.images?.[0])?.url || null,
      durationMs: i.track.duration_ms || 0,
    }));
  if (!rows.length) return 0;

  db.insertPlays(user.id, rows);
  const latest = Math.max(...rows.map((r) => r.playedAt));
  db.setCursor(user.id, latest);
  user.poll_cursor = latest;
  return rows.length;
}

async function pollAll() {
  for (const user of db.allUsers()) {
    try {
      await pollUser(user);
    } catch (e) {
      console.warn(`[poller] ${user.display_name || user.spotify_id}: ${e.message}`);
    }
  }
}

function startPoller() {
  setTimeout(pollAll, 5_000);
  setInterval(pollAll, INTERVAL_MS);
}

module.exports = { startPoller, pollUser };
