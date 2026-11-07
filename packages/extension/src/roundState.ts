/**
 * Review-round collapse state for the Loop panel webview (injected as-is).
 *
 * Saved per PR as `{ [round]: collapsed }`. Only explicit deviations from the
 * default (latest round open, older rounds collapsed) are stored, so the
 * render-time `toggle` of the default-open round never becomes "explicit open".
 */
export const ROUND_STATE_BODY = `
  function roundLatestKey(rounds) {
    return rounds && rounds.length ? String(rounds[rounds.length - 1].round) : undefined;
  }
  function pruneRoundCollapsed(saved, rounds, previousLatest) {
    var latest = roundLatestKey(rounds);
    if (!latest) return { collapsed: Object.assign({}, saved || {}), latest: previousLatest };
    // A new latest round: explicit-open state is stale and explicit-collapse of
    // older rounds now equals the default, so everything falls back to default.
    if (previousLatest !== undefined && previousLatest !== latest) {
      return { collapsed: {}, latest: latest };
    }
    var next = {};
    for (var i = 0; i < rounds.length; i++) {
      var key = String(rounds[i].round);
      if (saved && Object.prototype.hasOwnProperty.call(saved, key)) next[key] = !!saved[key];
    }
    return { collapsed: next, latest: latest };
  }
  function roundCollapsedAfterToggle(saved, round, collapsed, isLast) {
    var next = Object.assign({}, saved || {});
    var key = String(round);
    if (!!collapsed === !isLast) delete next[key];
    else next[key] = !!collapsed;
    return next;
  }
  function isRoundExpandedIn(saved, round, isLast) {
    var key = String(round);
    if (saved && Object.prototype.hasOwnProperty.call(saved, key)) return !saved[key];
    return !!isLast;
  }
`;
