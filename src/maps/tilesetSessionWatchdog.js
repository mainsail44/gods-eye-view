/**
 * Keep Google Photorealistic 3D Tiles alive in a long-running tab.
 *
 * Google issues a session when the root tileset is fetched and expires it a
 * few hours later; Cesium never renews it. After that, tiles already in the
 * cache still draw but every newly visited area fails to load and renders
 * black — exactly what an operator sees when an intel answer flies the camera
 * somewhere new after the tab has been open all day. This watchdog recreates
 * the tileset (a fresh root fetch, a fresh session) when tile requests start
 * failing with auth-style errors, and proactively before the session ages out.
 */
const AUTH_FAILURE = /Status Code: (400|401|403)\b/;
const FAILURE_WINDOW_MS = 20_000;
const FAILURES_TO_TRIGGER = 6;
const MIN_REFRESH_GAP_MS = 60_000;
const PROACTIVE_REFRESH_MS = 150 * 60_000; // Google sessions last ~3 h

/**
 * @param {object} options
 * @param {object} options.tileset The live tileset to watch.
 * @param {() => Promise<object|null>} options.recreate Builds a fresh tileset.
 * @param {(fresh: object, stale: object) => void} options.onReplaced Swaps it into the scene.
 * @param {(message: string) => void} [options.log]
 * @returns {() => void} Stops watching.
 */
export function installTilesetSessionWatchdog({
  tileset,
  recreate,
  onReplaced,
  log = (message) => console.info(`[Tiles] ${message}`),
}) {
  let current = tileset;
  let failures = [];
  let refreshing = false;
  let lastRefresh = Date.now();
  let removeListener = () => {};

  const refresh = async (reason) => {
    if (refreshing) return;
    if (Date.now() - lastRefresh < MIN_REFRESH_GAP_MS) return;
    refreshing = true;
    log(`refreshing Google 3D Tiles session (${reason})`);
    try {
      const fresh = await recreate();
      if (!fresh) throw new Error('no tileset returned');
      const stale = current;
      removeListener();
      current = fresh;
      watch(fresh);
      onReplaced(fresh, stale);
      lastRefresh = Date.now();
      failures = [];
      log('Google 3D Tiles session refreshed');
    } catch (error) {
      log(`Google 3D Tiles refresh failed: ${error?.message || error}`);
    } finally {
      refreshing = false;
    }
  };

  const onTileFailed = (event) => {
    if (!AUTH_FAILURE.test(String(event?.message || ''))) return;
    const now = Date.now();
    failures = failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    failures.push(now);
    if (failures.length >= FAILURES_TO_TRIGGER) void refresh(`${failures.length} tile auth failures`);
  };

  const watch = (target) => {
    removeListener = target.tileFailed.addEventListener(onTileFailed);
  };
  watch(current);

  const timer = setInterval(() => void refresh('scheduled'), PROACTIVE_REFRESH_MS);
  return () => {
    clearInterval(timer);
    removeListener();
  };
}
