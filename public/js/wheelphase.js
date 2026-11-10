'use strict';
/* 観覧車の回転位相（純粋関数モジュール: ブラウザ/Node共通）
 *
 * 観覧車は周期12秒・半径3mの円軌道でゴンドラが回る。角度は
 * 「サーバー時刻（絶対時刻ms）ベースの共通関数 ＋ 位相オフセット」で決まる。
 *
 * 以前は計算の基準が場所ごとにバラバラで、確定の瞬間に位相がズレていた:
 *   - プレビュー（ゴースト）: 絶対時刻ベース  a = (serverNow()/1000) * (2π/12)
 *   - 配置後の実体: 配置時刻 placedAt 起点   a = (t - placedAt)/1000 * (2π/12)
 *     → 確定した瞬間に角度が 0 へ戻り、プレビューで見えていた位置から
 *       最大で1周期分ゴンドラが跳んでいた。
 *
 * 現在はプレビュー・配置後の実体（クライアントの描画/支持判定）・サーバー
 * （BOT/物理代行の platformApproxPos）がすべて wheelAngleAt / wheelPosAt に
 * 同じ位相オフセットを渡す。オフセットはプレビュー中にマウスホイールで
 * 調整でき、配置確定時に足場データ（pl.phaseOffset, rad, [0, 2π) 正規化）として
 * サーバーへ送られ、全クライアントへ同期される。placedAt は位相計算に使わない
 * ため、ネットワーク遅延や確定処理のタイミングに左右されず、確定の前後で
 * 位相が完全一致する。
 *
 * オフセットを持たない既存データ（BOT配置・旧データ）はオフセット0として
 * 扱われ、絶対時刻ベースで従来どおり回転する。
 */
(function (global) {
  var PERIOD_MS = 12000;                 // 回転周期 12秒
  var RADIUS = 3;                        // 円軌道の半径 (m)
  var OMEGA = Math.PI * 2 / (PERIOD_MS / 1000); // 角速度 (rad/s)
  var TAU = Math.PI * 2;
  var PHASE_STEP = TAU / 12;             // ホイール1ノッチ = 周期の1/12 = 30°

  /* 位相オフセットを [0, 2π) へ正規化する（数値でない入力は 0） */
  function normalizePhase(rad) {
    var r = Number(rad);
    if (!Number.isFinite(r)) return 0;
    r = r % TAU;
    if (r < 0) r += TAU;
    return r;
  }

  /* 時刻 tMs（サーバー時刻ms）における観覧車の角度 (rad)。
   * プレビューと配置後でこの関数とオフセットを共有することが位相一致の要 */
  function wheelAngleAt(tMs, phaseOffset) {
    return (Number(tMs) / 1000) * OMEGA + normalizePhase(phaseOffset);
  }

  /* 時刻 tMs におけるゴンドラ（足場本体）の中心位置。center は回転中心 */
  function wheelPosAt(center, tMs, phaseOffset) {
    var a = wheelAngleAt(tMs, phaseOffset);
    return { x: center.x + Math.cos(a) * RADIUS, y: center.y + Math.sin(a) * RADIUS, z: center.z };
  }

  /* ホイール入力のノッチ換算（トラックパッドの連続量を蓄積する）。
   * 1ノッチ相当 = 100px換算。deltaMode: 0=ピクセル / 1=行（約34px/行） / 2=ページ。
   * 端数は state.acc に残り、次の入力へ持ち越される。
   * 戻り値が正 = 位相を進める（ホイールを奥へ回した = deltaY が負の方向） */
  var NOTCH_PX = 100;
  function createScrubber() { return { acc: 0 }; }
  function scrubNotches(state, deltaY, deltaMode) {
    var scale = deltaMode === 1 ? 34 : deltaMode === 2 ? 300 : 1;
    var dy = Number(deltaY);
    if (!Number.isFinite(dy)) dy = 0;
    state.acc += -dy * scale; // 奥（deltaY<0）で正＝進める
    var steps = Math.trunc(state.acc / NOTCH_PX);
    state.acc -= steps * NOTCH_PX;
    return steps;
  }

  /* ノッチ数だけ位相オフセットを進退させ、[0, 2π) に正規化して返す */
  function scrubPhase(current, steps) {
    return normalizePhase(normalizePhase(current) + steps * PHASE_STEP);
  }

  var api = {
    PERIOD_MS: PERIOD_MS,
    RADIUS: RADIUS,
    OMEGA: OMEGA,
    PHASE_STEP: PHASE_STEP,
    NOTCH_PX: NOTCH_PX,
    normalizePhase: normalizePhase,
    wheelAngleAt: wheelAngleAt,
    wheelPosAt: wheelPosAt,
    createScrubber: createScrubber,
    scrubNotches: scrubNotches,
    scrubPhase: scrubPhase,
  };
  global.WheelPhase = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
