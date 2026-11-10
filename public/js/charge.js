'use strict';
/* 溜めジャンプの倍率カーブと跳躍パラメータ（純粋関数モジュール: ブラウザ/Node共通）
*
* 溜め時間 t（秒）→ 跳躍倍率 m。直線（一次関数）で上昇する。
* 跳躍力（頂点の高さ）と水平速度の両方に同じ倍率が掛かる。通常ジャンプを 1.0 とする。
*
* 0〜4秒: m = t / 4
* 0 から 1.0 へ直線的に上昇。t=0 で 0（跳躍力なし）、
* t=2 で 0.5、t=4 で通常ジャンプと同じ 1.0 に到達する。
* 4〜5秒: m = 1 + 9 * (t - 4)
* 1.0 から 10 へ直線的に急上昇。t=4.5 で 5.5、
* t=5 で約10倍（通常ジャンプの約10倍）に達する。
* 5秒での自動発動（auto=true）: 倍率は 1.0 に戻る。
* 「満タンまで溜め切ると自動で弱く発動する」リスク設計。
*
*
* 「跳躍し始めた足場から頂点に達し、跳躍し始めた足場の高さに戻るまで」が、
* 溜め時間（倍率）に関わらず常に 0.3秒（上昇0.15秒＋下降0.15秒）。
* 頂点の高さ H は倍率で変わる: H = 通常ジャンプの頂点高さ × m。
* 往復時間が一定になるよう、垂直初速と跳躍中の重力を倍率から導出する:
* v0 = 2H / T_up, g_leap = v0 / T_up （T_up = 0.15）
* 跳躍中に足場へ着地できず奈落へ落ちる場合は、この重力・速度のまま
* 落下し続ける（通常の重力へは切り替えない）。
*
* クライアント（client.js）とロジックテスト（test/logic_test.js）が
* 同じ定義を参照するための単一の置き場所。
*/
(function (global) {
var MAX_CHARGE_SEC = 5;
function chargeMultiplier(t, auto) {
if (auto) return 1.0; // 5秒経過の自動発動は通常ジャンプ程度に戻る
var tt = Number(t);
if (!Number.isFinite(tt) || tt < 0) tt = 0;
if (tt > MAX_CHARGE_SEC) tt = MAX_CHARGE_SEC;
if (tt <= 4) return tt / 4; // 0→1 の直線
return 1 + 9 * (tt - 4); // 1→10 の直線
}

/* 跳躍の物理パラメータ。通常ジャンプの基準値は client.js の
* JUMP_VY（垂直初速）と重力 20 に一致させること */
var NORMAL_JUMP_VY = 8.6; // 通常ジャンプの垂直初速
var NORMAL_GRAVITY = 20; // 通常の重力
var LEAP_ROUND_TRIP_SEC = 0.3; // 跳躍の往復時間（上昇+下降）
function normalJumpApex() { return NORMAL_JUMP_VY * NORMAL_JUMP_VY / (2 * NORMAL_GRAVITY);}
/* 倍率 m → { apex: 頂点の高さ, v0: 垂直初速, g: 跳躍中の重力, tUp: 上昇時間} */
function leapParams(m) {
var mm = Number(m);
if (!Number.isFinite(mm) || mm < 0) mm = 0;
var apex = normalJumpApex() * mm;
var tUp = LEAP_ROUND_TRIP_SEC / 2;
var v0 = 2 * apex / tUp;
return { apex: apex, v0: v0, g: tUp > 0? v0 / tUp: 0, tUp: tUp};
}
/* ルール設定「溜めジャンプ力」の適用係数（純粋関数）。
* 適用されるのは「4 < t < 5 秒の手動リリース発動」の飛行だけ:
* その場合のみ rulePower（0.5〜3.0・0.1刻みへ正規化）を返し、
* それ以外（t<=4、t=4ちょうども含む／5秒自動発動 auto=true）は常に 1 を返す。
* この係数は飛行中の水平速度（入力方向 × 基準速度 × 倍率 m）にさらに掛かり、
* 垂直方向の跳躍力・滞空時間・空中制御の方式には影響しない。
* 発動時に確定した値を飛行状態へ保持し、飛行中のルール変更では変えないこと */
function leapHSpeedFactor(chargeSec, autoFired, rulePower) {
if (autoFired) return 1; // 5秒自動発動は係数1.0相当で固定
var t = Number(chargeSec);
if (!Number.isFinite(t) || t <= 4 || t >= MAX_CHARGE_SEC) return 1;
var p = Number(rulePower);
if (!Number.isFinite(p)) return 1;
p = Math.min(3, Math.max(0.5, p));
return Math.round(p * 10) / 10;
}
var api = {
MAX_CHARGE_SEC: MAX_CHARGE_SEC,
chargeMultiplier: chargeMultiplier,
leapHSpeedFactor: leapHSpeedFactor,
NORMAL_JUMP_VY: NORMAL_JUMP_VY,
NORMAL_GRAVITY: NORMAL_GRAVITY,
LEAP_ROUND_TRIP_SEC: LEAP_ROUND_TRIP_SEC,
normalJumpApex: normalJumpApex,
leapParams: leapParams,
};
global.ChargeLib = api;
if (typeof module!== 'undefined' && module.exports) module.exports = api;
})(typeof window!== 'undefined'? window: globalThis);
