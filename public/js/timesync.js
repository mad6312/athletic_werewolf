'use strict';
/* サーバー時刻オフセットの平滑化（純粋関数モジュール: ブラウザ/Node共通）
 *
 * クライアントは state:sync の serverTime から timeOffset（サーバー時刻 -
 * 自分時刻）を求め、serverNow() で水平移動・観覧車・テレポ・竹輪の位置や
 * 発表/カウントダウン表示を決めている。以前は同期のたびに
 *   timeOffset = s.serverTime - Date.now()
 * と上書きしていたため、この値に含まれる片道遅延のばらつき（ジッタ）が
 * そのままオフセットのばらつきになり、遅延が ±100ms 揺れる環境では
 * 動く足場が 16〜20cm 瞬間的にずれて見えた。
 *
 * nextOffset は1サンプルごとの変化を抑える平滑化:
 *  - 通常時: 指数移動平均（差分の25%）かつ1回あたりの変化を ±20ms に
 *    クランプする。±100ms のジッタではオフセットは最大でも ±20ms しか
 *    動かず、足場の跳びは数cm以下に収まる。
 *  - 大きな乖離（>1秒）が続く場合: 1回あたり ±250ms まで追従を許し、
 *    数回の同期で実時刻へ収束する（タブ復帰や時計の大きなずれへの追従）。
 * 初回（current が null/非数値）はサンプルをそのまま採用する。
 */
(function (global) {
  var STEP_MS = 20;       // 通常時の1回あたり最大変化
  var BIG_DIFF_MS = 1000; // 「大きな乖離」とみなす差分
  var BIG_STEP_MS = 250;  // 大きな乖離が続く場合の1回あたり最大変化
  var RATIO = 0.25;       // 指数移動平均の係数
  function clampNum(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function nextOffset(current, sample) {
    var s = Number(sample);
    if (!Number.isFinite(s)) return Number.isFinite(current) ? current : 0;
    var cur = Number(current);
    if (current === null || current === undefined || !Number.isFinite(cur)) return s;
    var diff = s - cur;
    var limit = Math.abs(diff) > BIG_DIFF_MS ? BIG_STEP_MS : STEP_MS;
    return cur + clampNum(diff * RATIO, -limit, limit);
  }
  /* ping/pong による RTT 補正つきオフセット推定（純粋関数）。
   * クライアントが時刻 c0 に time:ping を送り、サーバーが受信直後の
   * serverTime を返す。往復が対称なら、サーバーが受け取った時刻は
   * 往路の中点 (sentAt + RTT/2) に対応するので、
   *   offset = serverTime - (sentAt + (recvAt - sentAt) / 2)
   * で片道遅延を差し引ける。state:sync 由来の推定
   * （serverTime - 到着時刻）は片道遅延の全量だけ真値からずれるが、
   * こちらは非対称な経路でも誤差が往復差の半分に収まる。
   * 入力が不正な場合は null を返す */
  function pingOffset(serverTime, sentAt, recvAt) {
    var st = Number(serverTime), s0 = Number(sentAt), s1 = Number(recvAt);
    if (!Number.isFinite(st) || !Number.isFinite(s0) || !Number.isFinite(s1) || s1 < s0) return null;
    return st - (s0 + (s1 - s0) / 2);
  }
  var api = { nextOffset: nextOffset, pingOffset: pingOffset, STEP_MS: STEP_MS, BIG_DIFF_MS: BIG_DIFF_MS, BIG_STEP_MS: BIG_STEP_MS };
  global.TimeSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
