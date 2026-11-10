'use strict';
/* リモートプレイヤーのスナップショット補間（純粋関数モジュール: ブラウザ/Node共通）
 *
 * サーバーは pos:batch で 100ms 周期に各プレイヤーの位置（サーバー時刻 t つき）を
 * 配信する。以前のクライアントは「最新の受信位置へ毎フレーム lerp(0.35) で寄せる」
 * 方式だったため、等速で直進する相手でも、スナップショットが届いた直後は
 * 大きく進み、その後しばらくほぼ止まる、というフレーム間移動量の脈動が
 * そのまま描画のカクつきになっていた。
 *
 * 本モジュールは標準的なスナップショット補間を行う:
 *  - 受信スナップショットをサーバー時刻順の履歴として保持する
 *  - 描画位置は「現在サーバー時刻 − INTERP_DELAY_MS（補間遅延）」の時刻に
 *    ついて、前後のスナップショットから線形補間して求める。等速運動なら
 *    フレーム間移動量は完全に一定になる
 *  - 描画時刻が最新スナップショットより先（履歴枯渇）の場合は、直近2点の
 *    速度で最大 EXTRAPOLATE_MAX_MS 分まで外挿し、その先は外挿上限の位置に
 *    留める（無制限に飛ばさない）
 *  - 描画時刻が最古スナップショットより前なら最古の位置を返す
 *
 * 時刻はすべてサーバー時刻（ms）で統一する。キーは到着時刻ではなく、
 * その位置をサーバーが受信した時刻（pos:batch の lastSeenAt）を使うため、
 * ネットワークの到着ジッタが描画位置のジッタに化けない（時刻同期の
 * 精度の影響は受ける）。
 */
(function (global) {
  var INTERP_DELAY_MS = 120;      // 補間遅延: 配信周期100ms＋到着ジッタを吸収する標準的な値
  var EXTRAPOLATE_MAX_MS = 250;   // 履歴枯渇時の外挿上限
  var HISTORY_MS = 1000;          // 保持する履歴の長さ
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function createBuffer() {
    var snaps = []; // {t, x, y, z, moving}（t 昇順）
    function push(t, pos, moving) {
      if (!isNum(t) || !pos || !isNum(pos.x) || !isNum(pos.y) || !isNum(pos.z)) return;
      var last = snaps[snaps.length - 1];
      if (last && t <= last.t) return; // 時刻が巻き戻る/重複するスナップショットは捨てる（順序保証）
      snaps.push({ t: t, x: pos.x, y: pos.y, z: pos.z, moving: !!moving });
      var cutoff = t - HISTORY_MS;
      while (snaps.length > 2 && snaps[0].t < cutoff) snaps.shift();
    }
    function point(s, moving) { return { x: s.x, y: s.y, z: s.z, moving: moving !== undefined ? moving : s.moving }; }
    function sample(rt) {
      if (!snaps.length || !isNum(rt)) return null;
      var first = snaps[0], lastS = snaps[snaps.length - 1];
      if (rt <= first.t) return point(first);
      if (rt >= lastS.t) {
        var over = rt - lastS.t;
        if (over > 0 && snaps.length >= 2) {
          var prev = snaps[snaps.length - 2];
          var span = lastS.t - prev.t;
          if (span > 0) {
            var ext = Math.min(over, EXTRAPOLATE_MAX_MS) / 1000;
            return {
              x: lastS.x + (lastS.x - prev.x) / (span / 1000) * ext,
              y: lastS.y + (lastS.y - prev.y) / (span / 1000) * ext,
              z: lastS.z + (lastS.z - prev.z) / (span / 1000) * ext,
              moving: lastS.moving,
            };
          }
        }
        return point(lastS);
      }
      // 二分探索で rt を挟む区間を探す
      var lo = 0, hi = snaps.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (snaps[mid].t <= rt) lo = mid; else hi = mid; }
      var a = snaps[lo], b = snaps[hi];
      var f = (rt - a.t) / (b.t - a.t);
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        moving: b.moving,
      };
    }
    function clear() { snaps = []; }
    function size() { return snaps.length; }
    return { push: push, sample: sample, clear: clear, size: size };
  }
  var api = { INTERP_DELAY_MS: INTERP_DELAY_MS, EXTRAPOLATE_MAX_MS: EXTRAPOLATE_MAX_MS, HISTORY_MS: HISTORY_MS, createBuffer: createBuffer };
  global.RemoteInterp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
