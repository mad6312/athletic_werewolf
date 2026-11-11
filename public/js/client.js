'use strict';
/* アスレチック人狼 クライアント */
const $ = (s) => document.querySelector(s);

/* ============ セッション・設定 ============ */
// セッションIDはタブ単位の sessionStorage に保存する（localStorage だと全タブで共有され
// 複数タブを開いても1人分しか認識されなかった）。同一タブのリロードでは同じIDで再接続できる。
let sessionId = sessionStorage.getItem('aw_session');
if (!sessionId) { sessionId = 'p' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); sessionStorage.setItem('aw_session', sessionId); }
const DEFAULT_BINDS = {
  forward: { main: 'KeyW', mods: [] }, back: { main: 'KeyS', mods: [] },
  left: { main: 'KeyA', mods: [] }, right: { main: 'KeyD', mods: [] },
  jump: { main: 'Space', mods: [] }, punch: { main: 'Mouse0', mods: [] },
  chargeJump: { main: 'Shift', mods: [] },
};
/* パンチの初期設定は左クリック（Mouse0）、溜めジャンプの初期設定は Shift
 * （修飾キー単独バインド。長押しで溜め、離した瞬間に発動する。押下エッジ
 * でのみ開始する仕組みは actionDown／chargeInputHeld がそのまま担う）。
 * 既存ユーザーの保存済み設定は書き換えず、不足分だけ初期値を補う */
const ACTION_LABELS = { forward: '前進', back: '後退', left: '左移動', right: '右移動', jump: 'ジャンプ', punch: 'パンチ', chargeJump: '溜めジャンプ' };
const DEFAULT_PAD_BINDS = { jump: 'Pad3', punch: 'Pad2', chargeJump: 'Pad0' };
const PAD_ACTION_LABELS = { jump: 'ジャンプ（コントローラー）', punch: 'パンチ（コントローラー）', chargeJump: '溜めジャンプ（コントローラー）' };
/* ボタン名は PadMap（padmap.js）の標準 index 対応から生成する。
 * standard mapping: Pad0=×, Pad1=○, Pad2=□, Pad3=△ が正しい対応（項目5） */
const PAD_LABELS = {}; for (let _pi = 0; _pi < 17; _pi++) PAD_LABELS['Pad' + _pi] = PadMap.padButtonName(_pi);
let settings = { name: '', invertY: true, sickness: true, mouseLook: false, sensitivity: 1, swapSticks: false, binds: JSON.parse(JSON.stringify(DEFAULT_BINDS)), padBinds: { ...DEFAULT_PAD_BINDS } };
try { const s = JSON.parse(localStorage.getItem('aw_settings_v1')); if (s) settings = Object.assign(settings, s); if (!settings.binds) settings.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS)); if (!settings.padBinds) settings.padBinds = { ...DEFAULT_PAD_BINDS }; } catch (e) {}
/* 保存済み設定に新アクション（溜めジャンプ）の割当が無い場合は、その項目だけ
 * 初期値を補う。既存の割当（ユーザー変更分を含む）は一切書き換えない */
for (const a of Object.keys(DEFAULT_BINDS)) if (!settings.binds[a]) settings.binds[a] = JSON.parse(JSON.stringify(DEFAULT_BINDS[a]));
for (const a of Object.keys(DEFAULT_PAD_BINDS)) if (!settings.padBinds[a]) settings.padBinds[a] = DEFAULT_PAD_BINDS[a];
function saveSettings() { localStorage.setItem('aw_settings_v1', JSON.stringify(settings)); }

/* ============ ゲーム定数（サーバーと一致） ============ */
const CARD_LABEL = { stable: ['安定', '立方体・静止'], island: ['浮島', '安定の4倍面積'], chikuwa: ['竹輪', '乗って2秒で落下'], slide: ['水平移動', '往復スライド'], wheel: ['観覧車', '円軌道を移動'], long: ['細長', 'ドラッグで回転'], teleport: ['テレポ', '2地点を瞬間移動'] };
const ROLE_LABEL = { villager: '村人', knight: '騎士', wolf: '人狼', madman: '狂人' };
const ROLE_RANGES = { 3: { knight: [0, 2], madman: [0, 0], wolf: [1, 1] }, 4: { knight: [0, 3], madman: [0, 0], wolf: [1, 1] }, 5: { knight: [0, 4], madman: [0, 1], wolf: [1, 2] }, 6: { knight: [0, 5], madman: [0, 1], wolf: [1, 2] }, 7: { knight: [0, 6], madman: [0, 2], wolf: [1, 3] }, 8: { knight: [0, 7], madman: [0, 2], wolf: [1, 3] }, 9: { knight: [0, 8], madman: [0, 3], wolf: [1, 4] }, 10: { knight: [0, 9], madman: [0, 3], wolf: [1, 4] } };
const START = { x: -30, z: 0 }, GOAL = { x: 30, z: 0 };
const SLIDE_DIST = 8;

function toast(msg, ms = 2600, cls = '') {
  const d = document.createElement('div'); d.className = 'toast ' + cls; d.textContent = msg;
  $('#toast-wrap').appendChild(d); setTimeout(() => d.remove(), ms);
}

/* ============ Socket ============ */
const socket = io();
let S = null;          // 公開状態
let PRIV = null;       // 個人情報
let myId = sessionId;
let timeOffset = null; // サーバー時刻との差（平滑化済み。初回同期までは null）
const serverNow = () => Date.now() + (timeOffset || 0);

socket.on('connect', () => { socket.emit('join', { sessionId, name: settings.name || undefined }); sendTimePing(); });
socket.on('joined', (d) => { myId = d.id; });
socket.on('toast', (d) => toast(d.msg, 3200, d.type === 'warn' ? 'warn' : ''));
/* サーバー時刻オフセットは平滑化して取り込む（timesync.js）。
 * 以前は同期のたびに serverTime - Date.now() で上書きしており、片道遅延の
 * ばらつきがそのままオフセットのばらつきになって、水平移動・観覧車・
 * テレポ・竹輪などの「動く足場」が瞬間的に跳んで見えた */
socket.on('state:sync', (s) => { S = s; timeOffset = TimeSync.nextOffset(timeOffset, s.serverTime - Date.now()); renderUI(); rebuildPlatforms(); });
/* 時刻同期専用 ping/pong: クライアント送信時刻を送り、サーバーの受信時刻が
 * 返る。オフセット推定は RTT/2 を差し引く TimeSync.pingOffset で行い
 * （片道遅延の全量だけずれる state:sync 由来の推定はフォールバックとして
 * 残す）、最小RTTに近いサンプルだけを採用して平滑化（nextOffset）へ流す */
let pingBestRtt = Infinity, pingBestAt = 0;
function sendTimePing() { try { socket.emit('time:ping', { c0: Date.now() }); } catch (e) { /* 未接続等は無視 */ } }
setInterval(sendTimePing, 5000);
socket.on('time:pong', (d) => {
  if (!d || typeof d.c0 !== 'number') return;
  const recvAt = Date.now();
  const rtt = recvAt - d.c0;
  const off = TimeSync.pingOffset(d.serverTime, d.c0, recvAt);
  if (off === null || rtt < 0 || rtt > 2000) return;
  if (recvAt - pingBestAt > 30000) { pingBestRtt = Infinity; pingBestAt = recvAt; } // 最小RTTの基準は定期的に取り直す
  if (rtt <= pingBestRtt + 20) { // 最小に近いサンプルだけ採用（キュー遅延の混入を避ける）
    if (rtt < pingBestRtt) pingBestRtt = rtt;
    timeOffset = TimeSync.nextOffset(timeOffset, off);
  }
});
socket.on('player:private', (p) => { PRIV = p; renderUI(); if (p.pos && athletic.active && !athletic.started) { setPlayerPos(p.pos); } if (p.pos && S && S.phase === 'role') setPlayerPos(p.pos); /* 新試合開始時: サーバーがリセットした開始位置へ合わせる（項目11） */ });
socket.on('role:reveal', () => {
  if (!PRIV || !PRIV.role) return;
  $('#role-big').textContent = ROLE_LABEL[PRIV.role];
  $('#role-desc').textContent = PRIV.camp === 'wolf' ? 'あなたは人狼陣営です。村人陣営のゴール到達を阻止しましょう。' : 'あなたは村人陣営です。アスレチックを走り抜けてゴールを目指しましょう。';
  $('#role-allies').textContent = (PRIV.role === 'wolf' && PRIV.wolfAllies.length) ? '仲間の人狼: ' + PRIV.wolfAllies.map(id => nameOf(id)).join('、') : '';
  $('#role-overlay').classList.remove('hidden');
  setTimeout(() => $('#role-overlay').classList.add('hidden'), 2800);
});
socket.on('athletic:start', () => startAthleticClient());
socket.on('game:result', () => {
  athletic.active = false; $('#athletic-banner').classList.add('hidden'); const ba = $('#banned-announce'); if (ba) ba.classList.add('hidden');
  resetChargeState(false); // 試合終了: 溜め状態を破棄する（終了の瞬間に押し続けていた入力も持ち越さない）
  /* 試合終了時は全キャラクターのアニメーション状態をアイドルへ戻す（項目10）。
   * 歩行速度の残量（自分の moveVx/moveVz、リモートの serverMoving）が残っていると
   * 終了後も歩行モーションが再生され続けるため、ここで明示的に停止させる */
  athletic.moveVx = 0; athletic.moveVz = 0; athletic.vel.set(0, 0, 0);
  for (const r of remotePlayers.values()) { r.intentSpeed = 0; r.serverMoving = false; r.speedSm = 0; }
});
socket.on('destroy:anim', (d) => { if (d.destroyed) spawnShatter(d); });
/* 投票結果の表示は結果パネル（vote:result）に一本化したため、以前あった
 * 「投票により ○○ が脱落しました」「脱落者はいませんでした」の結果トーストは
 * 削除した（サーバーの vote:eliminated / vote:no-elimination イベント自体は
 * テスト等のために残っているが、クライアントでは表示に使わない）。
 * 投票結果の開示（結果発表時のみ）: 「投票先（カラー＋名前）／パス：投票者（カラー）」
 * 形式で結果パネルに表示する。投票先ごとにグルーピングし、投票者はカラーのみで
 * 並べる。投票の最中は従来どおり非公開で、このイベントは集計完了後にだけ届く */
let voteResultTimer = null;
let votePanelCloseAt = 0; // 結果パネルが閉じるサーバー時刻（サーバーが一元管理する。直後にアスレチックへ入るケースでは8秒→4秒に短縮される）
function scheduleVoteResultHide() {
  const el = $('#vote-result'); if (!el) return;
  clearTimeout(voteResultTimer);
  if (el.classList.contains('hidden') || !votePanelCloseAt) return;
  const remain = votePanelCloseAt - serverNow();
  if (remain <= 0) { el.classList.add('hidden'); return; }
  voteResultTimer = setTimeout(() => el.classList.add('hidden'), remain);
}
socket.on('vote:result', (d) => {
  const el = $('#vote-result'); if (!el || !d) return;
  const pub = (id) => S && S.players.find(p => p.id === id);
  const chip = (id) => { const p = pub(id); return p ? `<span class="color-chip" style="background:${p.color.hex}"></span>${escapeHtml(p.name)}` : escapeHtml(String(id)); };
  const dot = (id) => { const p = pub(id); return p ? `<span class="color-chip" title="${escapeHtml(p.name)}" style="background:${p.color.hex}"></span>` : ''; };
  const elim = d.eliminatedIds || [];
  const head = elim.length
    ? `投票により ${elim.map(id => { const p = pub(id); return p ? escapeHtml(p.name) : escapeHtml(String(id)); }).join('、')} が脱落しました`
    : '投票の結果、脱落者はいませんでした';
  // 投票先ごとにグルーピング（出現順を保持）。各行は「投票先／パス：投票者のカラー列」
  const groups = new Map();
  for (const b of d.ballots || []) {
    const key = b.target || '__pass__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b.voter);
  }
  const rows = [...groups.entries()].map(([key, voters]) => {
    const left = key === '__pass__' ? '<span class="vr-pass">パス</span>' : chip(key);
    return `<div class="vr-row">${left}<span class="vr-colon">：</span><span class="vr-voters">${voters.map(dot).join('')}</span></div>`;
  }).join('');
  el.innerHTML = `<div class="vr-title">🗳 投票結果</div><div class="vr-head">${head}</div><div class="vr-list">${rows}</div>`;
  el.classList.remove('hidden');
  // 消去はサーバー時刻ベース（標準は結果+8秒）。アスレチック直行で短縮された場合は
  // 状態同期（S.votePanelCloseAt）で新しい終了時刻が届き、renderUI 側で再スケジュールされる
  votePanelCloseAt = d.panelCloseAt || (serverNow() + 8000);
  scheduleVoteResultHide();
});

/* ============ 足場の粉砕アニメーション（人狼の破壊・投票による一括破壊で共通） ============ */
const shatterBursts = [];
function spawnShatter(d) {
  if (!scene) return;
  const mesh = platformMeshes.get(d.platformId);
  const pos = d.pos || (mesh ? mesh.position : null);
  if (!pos) return;
  const dims = DIMS[d.type] || [2, 1, 2];
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: d.ownerColor || '#cccccc', transparent: true, opacity: 1 });
  const frags = [];
  for (let i = 0; i < 14; i++) {
    const s = 0.22 + Math.random() * 0.34;
    const f = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat);
    f.position.set(pos.x + (Math.random() - 0.5) * dims[0] * 0.7, pos.y + (Math.random() - 0.5) * dims[1] * 0.7, pos.z + (Math.random() - 0.5) * dims[2] * 0.7);
    const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 2.6;
    frags.push({ m: f, vx: Math.cos(a) * r, vy: 2.2 + Math.random() * 3.2, vz: Math.sin(a) * r, rx: (Math.random() - 0.5) * 9, rz: (Math.random() - 0.5) * 9 });
    group.add(f);
  }
  scene.add(group);
  shatterBursts.push({ group, mat, frags, born: performance.now() });
  if (mesh) mesh.visible = false; // 本体は即座に隠す（状態同期の再構築でも除去される）
}
function updateShatters(dt) {
  const nowMs = performance.now();
  for (let i = shatterBursts.length - 1; i >= 0; i--) {
    const b = shatterBursts[i];
    const age = (nowMs - b.born) / 1000;
    if (age > 0.95) { scene.remove(b.group); disposeObject3D(b.group); shatterBursts.splice(i, 1); continue; } // 破片ごとの Geometry と共有マテリアルを破棄（以前はマテリアルのみで Geometry が残っていた）
    for (const f of b.frags) {
      f.vy -= 14 * dt;
      f.m.position.x += f.vx * dt; f.m.position.y += f.vy * dt; f.m.position.z += f.vz * dt;
      f.m.rotation.x += f.rx * dt; f.m.rotation.z += f.rz * dt;
    }
    b.mat.opacity = Math.max(0, 1 - age / 0.95);
  }
}

/* ============ 守護・破壊のホバー強調 ============ */
let panelHoverId = null; // 自陣UIボタン側のホバー
let rayHoverId = null;   // 3D画面側のホバー
let lastHoverEff = null;
function updateGuardHover(t) {
  if (!scene || !S) return;
  const active = (S.phase === 'guard' && PRIV && PRIV.isGuardTurn) || (S.phase === 'destroy' && PRIV && PRIV.isDestroyer);
  if (active && mouseState.insideCanvas && !panelHoverId) {
    const ray = new THREE.Raycaster(); ray.setFromCamera(mouseState.ndc, cam);
    const hits = ray.intersectObjects([...platformMeshes.values()], true);
    rayHoverId = hits.length ? findPlatformId(hits[0].object) : null;
  } else if (!active) rayHoverId = null;
  const eff = active ? (panelHoverId || rayHoverId) : null;
  if (eff === lastHoverEff && !eff) return;
  const k = 0.72 + 0.28 * Math.sin(t * 0.012); // 発光パルス（常時しっかり光り、周期で強弱）
  for (const [id, m] of platformMeshes.entries()) {
    const on = id === eff;
    if (!on && id !== lastHoverEff) continue;
    m.traverse(ch => { if (ch.material && ch.material.emissive) { if (on) ch.material.emissive.setRGB(k, k * 0.72, k * 0.18); else ch.material.emissive.setRGB(0, 0, 0); } });
  }
  lastHoverEff = eff;
}
socket.on('pos:batch', (snap) => {
  remoteSnap = snap;
  /* 他プレイヤーのスナップショットを補間バッファへ積む。キーは「その位置
   * をサーバーが受信した時刻（lastSeenAt）」で、バッチ送信時刻ではない。
   * 送信者の申告周期（80ms）とサーバーのバッチ周期（100ms）は位相が
   * ずれるため、バッチ時刻をキーにすると (時刻, 位置) の対応が最大80ms
   * ばらついて補間が波打つ。到着時刻も使わない（到着ジッタが描画位置の
   * ジッタに化けるため）。lastSeenAt が無い相手（BOT等）はバッチ時刻 */
  if (Array.isArray(snap)) for (const s of snap) {
    if (!s || s.id === myId || !s.pos) continue;
    let buf = remoteInterpBuffers.get(s.id);
    if (!buf) { buf = RemoteInterp.createBuffer(); remoteInterpBuffers.set(s.id, buf); }
    buf.push(typeof s.lastSeenAt === 'number' ? s.lastSeenAt : (typeof s.t === 'number' ? s.t : serverNow()), s.pos, s.moving);
  }
});
socket.on('punch:fx', (d) => { const r = remotePlayers.get(d.from); if (r) r.punchAt = performance.now(); });
/* 溜めジャンプの同期: 他プレイヤーの溜め開始/キャンセルと発動を、そのキャラの
 * モーション（溜めポーズ／跳躍ポーズ）に反映する */
socket.on('charge:fx', (d) => { const r = remotePlayers.get(d.from); if (!r) return; if (d.state === 'start') r.chargeStartAt = performance.now(); else r.chargeStartAt = 0; });
socket.on('chargejump:fx', (d) => { const r = remotePlayers.get(d.from); if (r) { r.chargeStartAt = 0; r.cjAt = performance.now(); r.cjMult = d.mult || 1; } });
socket.on('knockback', (d) => { athletic.kb = { x: d.dir.x, z: d.dir.z, left: d.dist }; });
socket.on('resync:pos', (d) => { if (d.pos) setPlayerPos(d.pos); athletic.vel.set(0, 0, 0); athletic.vy = 0; athletic.kb = null; clearInputs(); resetChargeState(false); /* リスポーン等の瞬間に押し続けていた入力は持ち越さない */ });
socket.on('player:eliminated', (d) => {
  if (d.id === myId && d.respawn) { setPlayerPos(d.respawn); athletic.vy = 0; athletic.kb = null; resetChargeState(false); }
  /* 他プレイヤーのリスポーンは位置の不連続点: 補間履歴が残っていると、
   * 落下位置からスポーン位置まで空中を滑るように補間表示されてしまう。
   * 当該プレイヤーの履歴だけ破棄し、次のスナップショットでスナップさせる */
  if (d.id !== myId) { const buf = remoteInterpBuffers.get(d.id); if (buf) buf.clear(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearInputs(); athletic.vel.set(0, 0, 0); athletic.kb = null; socket.emit('resync'); refreshAthleticOverlays(); if (S && S.phase === 'athletic' && !athletic.active && S.goAt) startAthleticClient(); } });

function nameOf(id) { const p = S && S.players.find(x => x.id === id); return p ? p.name : id; }
function me() { return S && S.players.find(x => x.id === myId); }
/* 自分がゴーストかどうか: 脱落者、または観戦者（観戦者は常時ゴーストとして扱う・項目4） */
function selfIsGhost() { const m = me(); return !!((PRIV && PRIV.eliminated) || (m && m.spectator && !m.isParticipant)); }
function isHost() { return S && S.hostId === myId; }

/* ============ ロビー・UI描画 ============ */
$('#btn-entry').onclick = () => socket.emit('lobby:toggleEntry');
$('#btn-start').onclick = () => socket.emit('game:start');
$('#btn-rematch').onclick = () => socket.emit('result:rematch');
$('#btn-exit').onclick = () => socket.emit('result:exit');

function renderUI() {
  if (!S) return;
  if (S.phase !== lastPhaseSeen) {
    if (S.phase !== 'vote') voteSelection.clear();
    if (S.phase === 'role') snapPlayersToSpawn(); // 新しい試合: 全キャラを補間なしで開始位置へスナップ（項目11）
    lastPhaseSeen = S.phase;
  }
  /* 投票セッションの識別子（サーバーの voteSeq）が変わったら、前回
   * セッションの選択をクリアする。手番投票→最終投票のように投票
   * セッションが連続するとフェーズは 'vote' のまま遷移しないため、
   * フェーズ変化によるクリアだけでは前回の選択が残ってしまっていた */
  if (S.voteSession && typeof S.voteSession.seq === 'number' && S.voteSession.seq !== lastVoteSeqSeen) {
    voteSelection.clear();
    lastVoteSeqSeen = S.voteSession.seq;
  }
  const m = me();
  const showGame = !!m && ((['role', 'place', 'vote', 'guard', 'destroy', 'athletic'].includes(S.phase) && (m.isParticipant || m.spectator)) || (S.phase === 'result' && m.isParticipant));
  $('#lobby-view').classList.toggle('hidden', !!showGame);
  $('#game-view').classList.toggle('hidden', !showGame);
  if (showGame && !scene) initThree();
  // 「アスレチックを開始します」バナーと発表演出はアスレチック開始直後だけのもの。
  // 表示/消去が athletic:start と GO の2箇所だけで、フェーズ遷移でリセットされなかったため
  // 前試合の状態が2試合目の配置フェーズに漏れていた（項目19の原因）。フェーズで駆動する
  if (S.phase !== 'athletic') {
    $('#athletic-banner').classList.add('hidden');
    const ba = $('#banned-announce'); if (ba) ba.classList.add('hidden');
  }
  if (S.phase === 'result' || S.phase === 'lobby') { const vr = $('#vote-result'); if (vr) vr.classList.add('hidden'); }
  // 結果パネルの表示終了時刻がサーバー側で短縮されたら、表示中のパネルにも適用する
  if (typeof S.votePanelCloseAt === 'number' && S.votePanelCloseAt && S.votePanelCloseAt !== votePanelCloseAt) {
    votePanelCloseAt = S.votePanelCloseAt;
    scheduleVoteResultHide();
  }
  refreshAthleticOverlays(); // 発表/バナーはサーバー時刻ベースで状態同期のたびに正す

  /* ロビー */
  $('#entry-count').textContent = `エントリー ${S.entryCount} / 10`;
  $('#lobby-phase-note').textContent = S.phase === 'result' ? '（前の試合の結果表示中）' : (S.phase !== 'lobby' ? '（試合中：新規入室は観戦者）' : '');
  $('#player-list').innerHTML = S.players.filter(p => p.connected || p.entered).map(p => `
    <li><span class="color-chip" style="background:${p.color.hex}"></span>
    <span>${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>
    ${p.isHost ? '<span class="badge host">ホスト</span>' : ''}
    ${p.spectator && !p.entered ? '<span class="badge spec">観戦</span>' : ''}
    <span class="badge ${p.entered ? 'entered' : ''}">${p.entered ? '参加中' : '未エントリー'}</span></li>`).join('');
  if (m) {
    $('#btn-entry').textContent = m.entered ? '参加キャンセル' : '参加する';
    $('#btn-entry').disabled = !!m.inResult;
    $('#btn-start').classList.toggle('hidden', !(isHost() && S.entryCount >= 3 && m.entered && !m.inResult));
    $('#btn-rules').classList.toggle('hidden', !isHost());
  }
  /* 結果 */
  if (S.phase === 'result' && S.result && m && m.isParticipant) {
    $('#result-overlay').classList.remove('hidden');
    $('#result-title').textContent = S.result.winner === 'villager' ? '🎉 村人陣営の勝利！' : S.result.winner === 'wolf' ? '🐺 人狼陣営の勝利！' : '■ ゲーム終了';
    $('#result-reason').textContent = S.result.reason || '';
    $('#result-table tbody').innerHTML = (S.resultDetail || []).map(d => `<tr><td><span class="color-chip" style="background:${d.color.hex}"></span> ${escapeHtml(d.name)}</td><td>${ROLE_LABEL[d.role] || ''}</td><td>${d.camp === 'wolf' ? '人狼陣営' : '村人陣営'}</td><td>${d.eliminated ? '脱落' : '生存'}</td></tr>`).join('');
  } else if (!(m && m.inResult)) $('#result-overlay').classList.add('hidden');
  if (m && !m.inResult && S.phase === 'lobby') $('#result-overlay').classList.add('hidden');

  /* ゲーム画面: 相手バー（仕様12.2） */
  if (showGame) {
    const others = S.players.filter(p => p.isParticipant && p.id !== myId);
    $('#opponents-bar').innerHTML = others.map(p => `
      <span class="opp-chip ${S.turnId === p.id ? 'turn' : ''}"><span class="color-chip" style="background:${p.color.hex}"></span>${escapeHtml(p.name)}
      <small>手札${p.handCount}</small>
      ${PRIV && PRIV.role === 'wolf' && PRIV.wolfAllies.includes(p.id) ? '<span class="wolf-badge">人狼</span>' : ''}
      ${S.turnId === p.id ? '<span class="turn-badge">選択中</span>' : ''}</span>`).join('');
    /* 自分情報（仕様12.1） */
    if (m) {
      $('#self-color').style.background = m.color.hex;
      $('#self-name').textContent = m.name;
      $('#self-role').textContent = PRIV && PRIV.role ? ROLE_LABEL[PRIV.role] : '';
      $('#self-status').textContent = (PRIV && PRIV.eliminated) ? '👻 ゴースト' : ((m.spectator && !m.isParticipant) ? '👻 観戦中（ゴースト）' : '');
    }
    renderHand();
    renderPhaseUI();
  }
  /* ルールモーダルの範囲表示を最新人数で更新（仕様19.4） */
  if (!$('#rules-modal').classList.contains('hidden')) {
    fillRuleRanges();
    /* ルール適用の確定確認: 要求した設定がサーバーに受理されて
     * ruleConfig に反映されたら、その時点でモーダルを閉じる。
     * 拒否された場合は一致しないので開いたままになる */
    if (ruleApplyPending && ruleConfigMatches(ruleApplyPending)) { ruleApplyPending = null; $('#rules-modal').classList.add('hidden'); }
  }
  $('#btn-force-end').classList.toggle('hidden', !(isHost() && !['lobby', 'result'].includes(S.phase)));
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function phaseText() {
  if (!S) return '';
  switch (S.phase) {
    case 'role': return '役職を確認中…';
    /* 名前はエスケープせずそのまま埋め込む。この文字列の利用側は
     * renderPhaseUI と残り時間の定期更新の2箇所で、どちらも textContent
     * へ代入するため、ここで escapeHtml すると「O&#39;Neil の手番」の
     * ようにエスケープ済み文字列がそのまま表示される（二重エスケープ）。
     * textContent 代入は HTML として解釈されないため XSS 上も安全 */
    case 'place': { const t = S.players.find(p => p.id === S.turnId); return `配置フェーズ（${S.placedCount}/10）― ${t ? (t.id === myId ? 'あなたの手番です' : t.name + ' の手番') : ''}`; }
    case 'vote': return `投票イベント ― 人狼だと思う人を ${PRIV ? PRIV.voteNeed : ''} 人選ぶかパスしてください`;
    case 'guard': return PRIV && PRIV.isGuardTurn ? '騎士の守護 ― 守りたい足場をクリックしてください（他の人には見えません）' : '騎士が守護対象を選んでいます…';
    case 'destroy': return PRIV && PRIV.isDestroyer ? '人狼の破壊 ― 破壊したい足場をクリックしてください' : '人狼が破壊対象を選んでいます…';
    case 'athletic': { const remain = Math.max(0, (S.athleticEndsAt || 0) - serverNow()); const mm = Math.floor(remain / 60000), ss = String(Math.floor(remain % 60000 / 1000)).padStart(2, '0'); return `アスレチックフェーズ ― 残り ${mm}:${ss}（村人陣営がゴール島に着地すれば村人勝利！）`; }
    default: return '';
  }
}
function renderPhaseUI() {
  const b = $('#phase-banner');
  b.textContent = phaseText();
  b.classList.toggle('hidden', !b.textContent);
  $('#place-controls').classList.toggle('hidden', !(S.phase === 'place'));
  if (S.phase === 'place' && PRIV) {
    $('#btn-pass').disabled = !PRIV.myTurn || !PRIV.canPass;
    // 投票イベント発生ボタン: 自分の手番のときだけ有効。使用済み（1ゲーム1回）はグレーアウト
    const vt = $('#btn-vote-trigger');
    if (vt) {
      vt.disabled = !PRIV.myTurn || !!PRIV.voteTriggerUsed || !!(me() && me().eliminated);
      vt.textContent = PRIV.voteTriggerUsed ? '投票（使用済み）' : '投票';
      vt.title = PRIV.voteTriggerUsed ? '投票イベントは1ゲームに1回までです' : '投票イベントを発生させます（手番は消費しません）';
    }
  }
  // 自分の手番の視覚効果（項目5）: 画面枠のパルス発光＋バナー/自陣パネルの強調。相手の手番では出ない
  const mine = S.phase === 'place' && !!PRIV && !!PRIV.myTurn && !!(me() && me().isParticipant);
  document.body.classList.toggle('my-turn', mine);
  b.classList.toggle('my-turn', mine);
  $('#self-panel').classList.toggle('my-turn', mine);
  renderActionPanel();
}
/* アスレチックの残り時間を1秒ごとに更新（ルール設定の制限時間に従う） */
setInterval(() => { if (S && S.phase === 'athletic') { const b = $('#phase-banner'); if (b) b.textContent = phaseText(); } }, 1000);
let voteSelection = new Set();
let lastVoteSeqSeen = 0; // 最後に観測した投票セッション識別子（サーバー voteSeq）
let lastPhaseSeen = null;
let lastPanelSig = '__init__'; // アクションパネルの内容シグネチャ（再描画スキップ用）
function renderActionPanel() {
  const panel = $('#action-panel');
  if (S.phase === 'vote') {
    panel.classList.remove('hidden');
    const targets = S.players.filter(p => p.isParticipant && !p.eliminated); // 脱落者は投票対象にならない
    // 観戦者（試合不参加）は投票パネル自体は見られるが、対象ボタン・投票する・
    // パスのすべてをグレーアウトして押せないことを明確にする。
    // サーバー側でも参加者以外の投票は受理されない（二重の保護）
    const mPub = me();
    const iAmOut = !!(PRIV && PRIV.eliminated);
    // 投票済み（サーバーの hasVoted が正）なら選択肢ごと非活性化する。
    // 以前は送信後にローカルでパネルを書き換えるだけで、次の state:sync で
    // renderActionPanel が有効なパネルを再生成し、選び直せてしまっていた
    const voted = !!(PRIV && PRIV.hasVoted);
    /* 内容シグネチャが前回と同じなら再描画しない。state:sync のたびに
     * innerHTML を作り直すと、クリック途中のボタンが差し替わって無効化
     * されたり、ホバー強調の mouseleave が発火せず固着したりしうる */
    const sig = ['vote', !!(mPub && !mPub.isParticipant), iAmOut, voted, (PRIV && PRIV.voteNeed) || 0,
      targets.map(p => p.id + ':' + p.name + ':' + p.color.hex).join(','), [...voteSelection].sort().join(',')].join('|');
    if (sig === lastPanelSig) return;
    lastPanelSig = sig;
    if (mPub && !mPub.isParticipant) {
      panel.innerHTML = `<div>投票イベント ― 観戦中のため投票できません</div><div class="targets">${targets.map(p => `<button disabled><span class="color-chip" style="background:${p.color.hex}"></span>${escapeHtml(p.name)}</button>`).join('')}</div><button class="primary" disabled>投票する</button> <button disabled>パス（誰にも投票しない）</button>`;
      return;
    }
    if (iAmOut) { panel.innerHTML = '<div>あなたは脱落しているため投票できません。集計を待っています…</div>'; return; }
    if (voted) {
      panel.innerHTML = `<div>投票済み。集計を待っています…（投票先は変更できません）</div><div class="targets">${targets.map(p => `<button disabled class="vote-done ${voteSelection.has(p.id) ? 'picked' : ''}"><span class="color-chip" style="background:${p.color.hex}"></span>${escapeHtml(p.name)}</button>`).join('')}</div><button id="btn-vote" class="primary" disabled>投票する</button>`;
      return;
    }
    panel.innerHTML = `<div>投票 ― 人狼だと思う人を 1 人選ぶかパスしてください</div><div class="targets">${targets.map(p => `<button data-vote="${p.id}" class="${voteSelection.has(p.id) ? 'picked' : ''}"><span class="color-chip" style="background:${p.color.hex}"></span>${escapeHtml(p.name)}</button>`).join('')}</div><button id="btn-vote" class="primary" ${voteSelection.size !== (PRIV ? PRIV.voteNeed : -1) ? 'disabled' : ''}>投票する</button> <button id="btn-vote-pass">パス（誰にも投票しない）</button>`;
    panel.querySelectorAll('[data-vote]').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.vote;
      const need = PRIV ? PRIV.voteNeed : 0;
      if (voteSelection.has(id)) voteSelection.delete(id); // 選択済みを押したら解除（従来どおり）
      else if (voteSelection.size < need) voteSelection.add(id);
      else if (need > 0) {
        /* 上限到達時に別の対象を押したら、既存の選択を新しい対象で置き換える。
         * 以前は何も起きなかったため、誤クリックに気づいて選び直したつもり
         * でも古い選択のまま「投票する」を押してしまう事故が起きた。
         * voteNeed=1 では「選択の移し替え」になる。一般の上限では最も古い
         * 選択から押し出す。「投票する」を押した後の変更不可は従来どおり */
        while (voteSelection.size >= need) voteSelection.delete(voteSelection.values().next().value);
        voteSelection.add(id);
      }
      renderActionPanel();
    });
    const vb = $('#btn-vote'); if (vb) vb.onclick = () => { socket.emit('vote:submit', { targets: [...voteSelection] }); };
    const pb = $('#btn-vote-pass'); if (pb) pb.onclick = () => { voteSelection.clear(); socket.emit('vote:submit', { targets: [] }); };
  } else if (S.phase === 'guard' || S.phase === 'destroy') {
    const mine = (S.phase === 'guard' && PRIV && PRIV.isGuardTurn) || (S.phase === 'destroy' && PRIV && PRIV.isDestroyer);
    // 守護・破壊パネルも同じくシグネチャで再描画を抑止する
    const sig = [S.phase, !!mine, S.placed.map(pl => pl.id + ':' + pl.type).join(',')].join('|');
    if (sig === lastPanelSig) return;
    lastPanelSig = sig;
    panel.classList.remove('hidden');
    panel.innerHTML = mine
      ? `<div>${S.phase === 'guard' ? '守護する足場を選んでください' : '破壊する足場を選んでください'}（3D画面の足場クリックでも選択可。ボタン/足場にマウスを合わせると3D側が光ります）</div><div class="targets">${S.placed.map((pl, i) => `<button data-pick="${pl.id}">#${i + 1} ${CARD_LABEL[pl.type][0]}</button>`).join('')}</div>`
      : '<div>選択を待っています…</div>';
    panel.querySelectorAll('[data-pick]').forEach(btn => {
      btn.onclick = () => socket.emit(S.phase === 'guard' ? 'guard:pick' : 'destroy:pick', { platformId: btn.dataset.pick });
      // 自陣UIの足場ボタンのホバーで、対応する3D足場も強調表示する
      btn.onmouseenter = () => { panelHoverId = btn.dataset.pick; btn.classList.add('pick-hover'); };
      btn.onmouseleave = () => { if (panelHoverId === btn.dataset.pick) panelHoverId = null; btn.classList.remove('pick-hover'); };
    });
    // 再描画でホバー中のボタンが消えた場合は、強調状態が固着しないよう解除する
    if (panelHoverId && !panel.querySelector(`[data-pick="${panelHoverId}"]`)) panelHoverId = null;
  } else { panel.classList.add('hidden'); lastPanelSig = 'hidden'; panelHoverId = null; }
}
function renderHand() {
  const wrap = $('#hand-cards');
  if (!PRIV || !PRIV.hand) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = PRIV.hand.map((t, i) => `<div class="hand-card ${placement.selected === t && placement.selectedIdx === i ? 'selected' : ''}" data-hand="${i}">${CARD_LABEL[t][0]}<small>${CARD_LABEL[t][1]}</small></div>`).join('');
  wrap.querySelectorAll('[data-hand]').forEach(el => el.onclick = () => {
    const i = Number(el.dataset.hand);
    placement.selected = PRIV.hand[i]; placement.selectedIdx = i; resetPlacement(false);
    renderHand();
  });
}
$('#btn-pass').onclick = () => socket.emit('place:pass');
$('#btn-vote-trigger').onclick = () => socket.emit('vote:trigger');
/* 配置の高さ調整: スライダー（0.5刻み）と数値入力欄（0.1刻み）の同期。
 * 配置に使う高さの「正」は数値入力の 0.1 刻み値（placeHeightValue）。
 * - スライダーを動かす: その 0.5 刻み値がそのまま正になり、数値欄にも反映される。
 * - 数値を入力する: 0.1 単位に整えた値が正になる。スライダー表示は最も近い
 *   0.5 の位置へ寄せるだけで、0.1 値を 0.5 へ丸めて上書きはしない
 *   （スライダー値から高さを読み戻すと 0.1 刻みが消えてしまうため）。
 * 入力途中（空欄・非数値）では正の値を変えず、配置処理は壊れない */
const phSlider = $('#place-height'), phNum = $('#place-height-num');
const PH_MIN = 0.5, PH_MAX = 16;
let placeHeightValue = Number(phSlider.value) || 1.5;
const quantize01 = (v) => Math.round(v * 10) / 10;
const clampHeight = (v) => Math.min(PH_MAX, Math.max(PH_MIN, v));
function currentPlaceHeight() { return placeHeightValue; }
function syncSliderToHeight() { phSlider.value = Math.round(placeHeightValue / 0.5) * 0.5; } // 表示用に最も近い0.5位置へ
phSlider.oninput = () => { placeHeightValue = Number(phSlider.value); phNum.value = placeHeightValue.toFixed(1); };
phNum.oninput = () => {
  if (phNum.value === '') return; // 入力途中（空欄）では何もしない
  const n = Number(phNum.value);
  if (!Number.isFinite(n)) return;
  placeHeightValue = quantize01(clampHeight(n)); // 0.1刻みで即座に反映（配置高さはこの値が正）
  syncSliderToHeight();
};
phNum.onchange = () => {
  const n = Number(phNum.value);
  if (phNum.value !== '' && Number.isFinite(n)) placeHeightValue = quantize01(clampHeight(n));
  phNum.value = placeHeightValue.toFixed(1); // 正規化した 0.1 値を書き戻す
  syncSliderToHeight();
};

/* ============ ルール設定モーダル ============ */
$('#btn-rules').onclick = () => { ruleApplyPending = null; $('#rule-knight').value = S.ruleConfig.knight; $('#rule-madman').value = S.ruleConfig.madman; $('#rule-wolf').value = S.ruleConfig.wolf; $('#rule-time').value = String(S.ruleConfig.timeMin || 5); $('#rule-time-val').textContent = (S.ruleConfig.timeMin || 5) + '分'; $('#rule-bots').value = String(S.ruleConfig.botCount || 0); $('#rule-gauge').checked = !!S.ruleConfig.gauge; const cp = Number(S.ruleConfig.chargePower); $('#rule-power').value = String(Number.isFinite(cp) ? cp : 1); $('#rule-power-val').textContent = (Number.isFinite(cp) ? cp : 1).toFixed(1) + '倍'; fillRuleRanges(); $('#rules-modal').classList.remove('hidden'); };
$('#rule-time').oninput = (e) => { $('#rule-time-val').textContent = e.target.value + '分'; };
$('#rule-power').oninput = (e) => { $('#rule-power-val').textContent = Number(e.target.value).toFixed(1) + '倍'; };
/* BOT人数を変えるたびに範囲表示を再計算する（表示と検証の人数を揃える） */
$('#rule-bots').oninput = () => fillRuleRanges();
$('#btn-rules-close').onclick = () => { ruleApplyPending = null; $('#rules-modal').classList.add('hidden'); };
/* 検証・表示に使う人数は「BOT数変更を適用した後の人数」で統一する。
 * 範囲表示が現在のエントリー人数基準だった頃は、確定時の検証（BOT適用後
 * 基準）と食い違い、表示上は範囲外でも受理される（またはその逆）ように
 * 見えていた。適用ボタンの検証もこの関数を使う */
function ruleEffectiveCount(botCount) {
  if (!S) return 3;
  const botsEnteredNow = S.players.filter(p => p.isBot && p.entered).length;
  return Math.min(10, Math.max(3, (S.entryCount - botsEnteredNow) + (botCount | 0)));
}
function fillRuleRanges() {
  const n = ruleEffectiveCount(Number($('#rule-bots').value) | 0);
  const r = ROLE_RANGES[n];
  $('#rules-n-note').textContent = `現在のエントリー: ${S ? S.entryCount : 0} 人（範囲は ${n} 人用を表示）`;
  $('#range-knight').textContent = `（${r.knight[0]}〜${r.knight[1]}人）`;
  $('#range-madman').textContent = `（${r.madman[0]}〜${r.madman[1]}人）`;
  $('#range-wolf').textContent = `（${r.wolf[0]}〜${r.wolf[1]}人）`;
}
/* ルール適用の「確定待ち」。決定を押してもモーダルは即座には閉じず、
 * サーバーが受理して state:sync の ruleConfig が要求どおりになった時点で
 * 閉じる（renderUI 内で照合）。以前は emit と同時に閉じていたため、
 * サーバー側が拒否した場合（警告トーストは届く）にモーダルだけ閉じて
 * しまう不整合があった。特に、古いクライアント（人数が3未満だと検証を
 * 飛ばす版）がキャッシュに残っていると、2人以下のときだけ「警告は出る
 * のにモーダルが閉じる」症状になっていた。サーバーの受理を閉じる条件に
 * することで、どちらの検証で弾かれても挙動が「警告を表示して閉じない」
 * に統一される */
let ruleApplyPending = null;
function ruleConfigMatches(cfg) {
  const rc = S && S.ruleConfig;
  if (!rc || !cfg) return false;
  return rc.knight === cfg.knight && rc.madman === cfg.madman && rc.wolf === cfg.wolf
    && rc.timeMin === cfg.timeMin && rc.botCount === cfg.botCount && !!rc.gauge === !!cfg.gauge
    && Math.round(Number(rc.chargePower) * 10) === Math.round(Number(cfg.chargePower) * 10);
}
$('#btn-rules-apply').onclick = () => {
  const cfg = { knight: Number($('#rule-knight').value) | 0, madman: Number($('#rule-madman').value) | 0, wolf: Number($('#rule-wolf').value) | 0, timeMin: Number($('#rule-time').value) | 0, botCount: Number($('#rule-bots').value) | 0, gauge: $('#rule-gauge').checked, chargePower: Number($('#rule-power').value) };
  /* 検証人数は「この設定で BOT 数変更を適用した後の人数」を使う
   * （ruleEffectiveCount。範囲表示と共通）。現在の entryCount のままだと、
   * 人間3人＋BOT追加と役職増を同じ操作で設定できない（サーバー側の検証と
   * 同じ考え方に揃える）。最低3人基準のため、エントリー2人以下でも
   * モーダルに表示される3人用の範囲でチェックが常時適用される */
  const n = ruleEffectiveCount(cfg.botCount), r = ROLE_RANGES[n];
  if (cfg.knight + cfg.madman + cfg.wolf > n) { toast(`役職の合計が参加人数（${n}人）を超えています`, 3000, 'warn'); return; }
  if (cfg.wolf + cfg.madman > Math.ceil(n / 2) - 1) { toast(`人狼陣営は参加人数の半数未満までです（${n}人の場合は最大${Math.ceil(n / 2) - 1}人）`, 3000, 'warn'); return; }
  for (const k of ['knight', 'madman', 'wolf']) if (cfg[k] < r[k][0] || cfg[k] > r[k][1]) { toast('設定範囲外の人数があります', 3000, 'warn'); return; }
  ruleApplyPending = cfg;
  socket.emit('rule:set', cfg);
  /* モーダルはここでは閉じない。サーバーが受理すれば state:sync で
   * ruleConfig が一致し、その時点で renderUI が閉じる（受理時はサーバーが
   * 必ず syncAll するため、同値の再適用でも確認が届く）。拒否された場合は
   * 一致しないため開いたままになり、警告トーストだけが表示される */
};

/* ============ 設定モーダル ============ */
function openSettings() {
  $('#set-name').value = (me() && me().name) || settings.name || '';
  $('#set-invert-y').checked = settings.invertY;
  $('#set-sickness').checked = settings.sickness;
  $('#settings-modal').classList.remove('hidden');
}
$('#btn-settings-lobby').onclick = openSettings;
$('#btn-settings-game').onclick = openSettings;
$('#btn-settings-close').onclick = () => $('#settings-modal').classList.add('hidden');
$('#btn-apply-name').onclick = () => {
  const name = $('#set-name').value.trim();
  if (!name) return;
  settings.name = name; saveSettings();
  socket.emit('name:change', { name });
  toast('✔ 変更しました', 2000, 'ok');
};
$('#set-invert-y').onchange = (e) => { settings.invertY = e.target.checked; saveSettings(); };
$('#set-sickness').onchange = (e) => { settings.sickness = e.target.checked; saveSettings(); applySickness(); };
$('#btn-force-end').onclick = () => {
  $('#settings-modal').classList.add('hidden'); // 自分のモーダルを即座に閉じる
  if (confirm('ゲームを強制終了しますか？（勝敗は付きません）')) socket.emit('host:forceEnd');
};
function applySickness() {
  $('#sickness-ui').classList.toggle('hidden', !settings.sickness);
  if (cam) { cam.fov = settings.sickness ? 50 : 65; cam.updateProjectionMatrix(); }
}

/* ============ キーコンフィグ ============ */
let capture = null; // {action, mods:Set, mainSet:boolean}
let mouseAssignGuardUntil = 0;
function bindLabel(b) {
  if (!b) return '未設定';
  const parts = (b.mods || []).concat([b.main]).map(codeLabel);
  return parts.join(' + ');
}
function codeLabel(code) {
  if (!code) return '';
  if (code === 'Space') return 'Space';
  if (code.startsWith('Mouse')) return ['左クリック', '中クリック', '右クリック'][Number(code.slice(5))] || code;
  if (code.startsWith('Pad')) return PAD_LABELS[code] || code;
  return code.replace('Key', '').replace('Digit', '');
}
function renderBindList() {
  const capKb = capture && capture.device === 'kb' ? capture.action : null;
  const capPad = capture && capture.device === 'pad' ? capture.action : null;
  $('#bind-list').innerHTML = Object.keys(ACTION_LABELS).map(a => `
    <div class="bind-row"><span>${ACTION_LABELS[a]}</span>
    <button data-bind="${a}" class="${capKb === a ? 'capturing' : ''}">${capKb === a ? '入力待ち…（ESCで取消）' : bindLabel(settings.binds[a])}</button></div>`).join('');
  $('#bind-list').querySelectorAll('[data-bind]').forEach(btn => btn.onmousedown = (e) => {
    e.preventDefault();
    if (Date.now() < mouseAssignGuardUntil) return; // マウス割当直後のclick再突入防止
    startCapture(btn.dataset.bind, 'kb');
  });
  const padList = $('#pad-bind-list');
  if (padList) {
    padList.innerHTML = Object.keys(PAD_ACTION_LABELS).map(a => `
      <div class="bind-row"><span>${PAD_ACTION_LABELS[a]}</span>
      <button data-padbind="${a}" class="${capPad === a ? 'capturing' : ''}">${capPad === a ? 'ボタン入力待ち…（ESCで取消）' : codeLabel(settings.padBinds[a])}</button></div>`).join('');
    padList.querySelectorAll('[data-padbind]').forEach(btn => btn.onmousedown = (e) => {
      e.preventDefault();
      startCapture(btn.dataset.padbind, 'pad');
    });
  }
  const swap = $('#kc-swap-sticks'); if (swap) swap.checked = settings.swapSticks;
}
// 割当ボタンの mousedown で開始したキャプチャを、その同じイベントの window ハンドラが
// 「マウス割当の入力」として即座に消費してしまわないためのガード（項目10の不具合の原因）
let captureStartedByMouse = false;
function startCapture(action, device) { capture = { action, device: device || 'kb', mods: new Set(), main: null, modOrder: [] }; captureStartedByMouse = true; renderBindList(); }
function cancelCapture() { capture = null; renderBindList(); }
function finishCapture() {
  if (!capture || !capture.main) { cancelCapture(); return; }
  if (capture.device === 'pad') {
    if (!String(capture.main).startsWith('Pad')) { cancelCapture(); return; }
    for (const a of Object.keys(settings.padBinds)) {
      if (a !== capture.action && settings.padBinds[a] === capture.main) settings.padBinds[a] = settings.padBinds[capture.action]; // 自動入れ替え
    }
    settings.padBinds[capture.action] = capture.main;
  } else {
    const nb = { main: capture.main, mods: [...capture.mods].slice(0, 1) }; // 主キー+補助1 = 最大2個
    const same = (x, y) => x && x.main === y.main && JSON.stringify((x.mods || []).slice().sort()) === JSON.stringify((y.mods || []).slice().sort());
    for (const a of Object.keys(settings.binds)) {
      if (a !== capture.action && same(settings.binds[a], nb)) settings.binds[a] = settings.binds[capture.action]; // 自動入れ替え
    }
    settings.binds[capture.action] = nb;
  }
  saveSettings();
  capture = null;
  mouseAssignGuardUntil = Date.now() + 400;
  renderBindList();
}
const MOD_CODES = { ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt' };
window.addEventListener('keydown', (e) => {
  if (capture) {
    e.preventDefault();
    if (e.code === 'Escape') { cancelCapture(); return; }
    if (capture.device === 'pad') return; // パッド割当待ちのときはキーボード入力を無視する
    if (e.repeat) return; // オートリピート対策
    const mod = MOD_CODES[e.code];
    if (mod) { if (!capture.modOrder.includes(mod)) capture.modOrder.push(mod); capture.mods = new Set(capture.modOrder.slice(0, 1)); return; }
    // 補助キーを押しながら主キー
    for (const m of capture.modOrder) capture.mods.add(m);
    capture.main = e.code; finishCapture(); return;
  }
  trackKey(e, true);
});
window.addEventListener('keyup', (e) => {
  if (capture) {
    const mod = MOD_CODES[e.code];
    if (mod && !capture.main) { // 補助キー単独登録（押して離す）。最初に押したものを優先
      capture.main = capture.modOrder[0] || mod; capture.mods = new Set(); finishCapture(); return;
    }
    return;
  }
  trackKey(e, false);
});
window.addEventListener('mousedown', (e) => {
  // 割当ボタンを押したそのクリック自体は割当入力として扱わない（開始直後の同じイベントを消費）
  if (capture && captureStartedByMouse) { captureStartedByMouse = false; return; }
  if (capture && capture.device === 'pad') {
    if (!$('#keyconfig-modal').contains(e.target)) { cancelCapture(); return; }
    if (e.target.closest('#pad-bind-list') == null && e.target.closest('#keyconfig-modal')) { cancelCapture(); return; }
    return;
  }
  if (capture && !$('#keyconfig-modal').contains(e.target)) { cancelCapture(); return; }
  if (capture && e.target.closest('#bind-list') == null && e.target.closest('#keyconfig-modal')) { cancelCapture(); return; }
  if (capture) {
    const modNames = []; // 現在押下中の補助キー
    if (e.shiftKey) modNames.push('Shift'); if (e.ctrlKey) modNames.push('Ctrl'); if (e.altKey) modNames.push('Alt');
    capture.mods = new Set(modNames.slice(0, 1)); capture.main = 'Mouse' + e.button; finishCapture(); return;
  }
});
window.addEventListener('blur', () => { if (capture) cancelCapture(); clearInputs(); });
$('#btn-open-keyconfig').onclick = () => { renderBindList(); $('#keyconfig-modal').classList.remove('hidden'); };
$('#btn-keyconfig-close').onclick = () => { cancelCapture(); $('#keyconfig-modal').classList.add('hidden'); };
$('#btn-bind-reset').onclick = () => { settings.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS)); settings.padBinds = { ...DEFAULT_PAD_BINDS }; saveSettings(); renderBindList(); };
document.addEventListener('change', (e) => { if (e.target && e.target.id === 'kc-swap-sticks') { settings.swapSticks = e.target.checked; saveSettings(); } });
/* マウス設定（キーコンフィグから開く） */
$('#btn-open-mouse').onclick = () => { $('#set-mouselook').checked = settings.mouseLook; $('#set-sensitivity').value = settings.sensitivity; $('#sens-val').textContent = Number(settings.sensitivity).toFixed(1); $('#mouse-modal').classList.remove('hidden'); };
$('#btn-mouse-close').onclick = () => $('#mouse-modal').classList.add('hidden');
$('#set-mouselook').onchange = (e) => { settings.mouseLook = e.target.checked; saveSettings(); };
$('#set-sensitivity').oninput = (e) => { settings.sensitivity = Number(e.target.value); $('#sens-val').textContent = settings.sensitivity.toFixed(1); saveSettings(); };

/* ============ 入力トラッキング ============ */
const keysDown = new Set();
function typingActive() { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); }
function modalOpen() { return ['#settings-modal', '#keyconfig-modal', '#mouse-modal', '#rules-modal', '#place-confirm-modal'].some(s => !$(s).classList.contains('hidden')); }
function trackKey(e, down) {
  if (down) keysDown.add(e.code); else keysDown.delete(e.code);
  if (down && e.code === 'Space' && athletic.untilKeyUpSuppress) athletic.untilKeyUpSuppress = true;
  if (!down && e.code === 'Space') athletic.spaceHeldAtGo = false;
}
function clearInputs() {
  const heldAtClear = chargeInputHeld(); // クリア「前」の押下状態を持ち越し抑止に使う
  keysDown.clear(); mouseState.left = false; mouseState.right = false; athletic.jumpQueued = false; padHeld.chargeJump = false;
  resetChargeState(false); // 溜め状態も破棄する
  athletic.chargeSuppress = heldAtClear; // クリア時点で押し続けていた入力は、離すまで無効
}
function actionDown(action) {
  const b = settings.binds[action]; if (!b) return false;
  if (b.main.startsWith('Mouse')) { if (!(b.main === 'Mouse0' ? mouseState.left : b.main === 'Mouse2' ? mouseState.right : false)) return false; }
  else if (!keysDown.has(b.main) && !(b.mods && b.mods[0] && keysDown.has({ Shift: 'ShiftLeft', Ctrl: 'ControlLeft', Alt: 'AltLeft' }[b.mods[0]])) && b.main !== b.mods?.[0]) {
    // 補助キー単独登録の場合
    if (!keysDown.has(b.main)) {
      const modKey = { Shift: ['ShiftLeft', 'ShiftRight'], Ctrl: ['ControlLeft', 'ControlRight'], Alt: ['AltLeft', 'AltRight'] }[b.main];
      if (!(modKey && modKey.some(c => keysDown.has(c)))) return false;
    }
  }
  if (b.mods && b.mods.length) {
    const need = { Shift: ['ShiftLeft', 'ShiftRight'], Ctrl: ['ControlLeft', 'ControlRight'], Alt: ['AltLeft', 'AltRight'] }[b.mods[0]];
    if (need && !need.some(c => keysDown.has(c))) return false;
  }
  return true;
}

/* ============ 溜めジャンプの入力 ============ */
/* パッド側の「押下中」状態（pollPad が毎フレーム更新する）。エッジではなく
 * ホールドを扱う溜めジャンプ用 */
const padHeld = { chargeJump: false };
/* 溜めジャンプの入力が現在押されているか（キーボード/マウス＋パッド）。
 * ポインターロック取得のためのクリックを長押ししても溜めが始まらないよう、
 * ロック取得に使った Mouse0 の押下は mouseup まで入力として数えない */
function chargeInputHeld() {
  let kb = false;
  const b = settings.binds.chargeJump;
  if (b && !(athletic.lockClickSuppress && b.main === 'Mouse0')) kb = actionDown('chargeJump');
  return kb || !!padHeld.chargeJump;
}
/* 溜め状態を破棄する（フェーズ開始/終了・リスポーン・resync のたびに呼ぶ）。
 * その瞬間にボタンが押されていたら chargeSuppress を立て、完全に離されるまで
 * 溜め入力として数えない。これにより「使用不可の間に押し始めた入力」や
 * 「フェーズをまたいで押し続けていた入力」が持ち越されることは一切ない
 * （キーのオートリピートで keysDown に再登録されても、抑止が優先する） */
function resetChargeState(notify) {
  if (athletic.charge && notify) socket.emit('charge:fx', { state: 'cancel' });
  athletic.charge = null;
  athletic.chargeJumping = false; athletic.cjMult = 1; athletic.cjG = 0; athletic.cjHFactor = 1;
  athletic.chargeSuppress = chargeInputHeld();
  athletic.chargePrevHeld = false;
  const r0 = remotePlayers.get(myId);
  if (r0) { r0.chargeStartAt = 0; r0.cjAt = 0; }
}

/* ============ Three.js ============ */
let scene, cam, renderer, canvasEl;
const platformMeshes = new Map();
let platformsGroup = null, playersGroup = null;
let placedSignature = '';
const remotePlayers = new Map(); // id -> {group, target:Vector3, moving}
const remoteInterpBuffers = new Map(); // id -> RemoteInterp バッファ（他プレイヤーのスナップショット補間用）
let remoteSnap = [];
const mouseState = { left: false, right: false, x: 0, y: 0, ndc: new THREE.Vector2(), downPos: null, insideCanvas: false, lastClientX: null, lastClientY: null };
const placeCam = { yaw: 0.8, pitch: 0.85, dist: 44 };
const athCam = { yaw: 0, pitch: 0.32, dist: 6, smoothY: 1 };
const athletic = { active: false, locked: true, started: false, goAt: 0, vel: new THREE.Vector3(), vy: 0, grounded: false, standId: null, standLastCenter: null, kb: null, jumpQueued: false, punchQueued: false, prevPunchHeld: false, prevJump: false, prevPunch: false, spaceHeldAtGo: false, untilKeyUpSuppress: false, lastSend: 0, fallSentAt: 0, camTargetY: 1, faceYaw: 0, lastPunchAt: 0, moveVx: 0, moveVz: 0,
  /* 溜めジャンプ: charge={t} が溜め中、chargeJumping が発動後の着地まで。
   * chargePrevHeld は「押しっぱなしの持ち越し」を防ぐための前フレームの押下状態。
   * 入力は「新たに押した瞬間（エッジ）」でしか溜めを開始しない */
  charge: null, chargeJumping: false, cjMult: 1, cjG: 0, cjHFactor: 1, chargePrevHeld: false, chargeSuppress: false, lockClickSuppress: false };
/* ローカル物理の固定ステップ: 1/60秒刻み。1フレームで消費できる
 * ステップ数の上限は5（=1/12秒分）。それを超える蓄積は切り捨てる */
const PHYS_STEP = 1 / 60, PHYS_MAX_STEPS = 5;
let physAcc = 0;
/* 自キャラの描画補間（render interpolation）用アンカー。
 * 固定ステップ物理は位置が 1/60 秒刻みにしか進まないため、表示fps が
 * 60 の倍数でない環境（120Hz 等）では描画フレームごとのステップ数が
 * 0/1/2 とばらつき、描画位置の進み方が「止まる→2ステップ分跳ぶ」の
 * 繰り返しになって自キャラが震えて見える（ジャダー）。物理そのもの
 * （player.pos）と入力応答は変えず、描画位置だけを「前ステップ境界→
 * 現ステップ境界」の間を蓄積残り時間の割合で補間して決める。
 * selfPrevStepPos = 直近に完了したステップの1つ前の境界位置、
 * selfCurrStepPos = 直近に完了したステップ境界位置（= 最新の player.pos） */
const selfPrevStepPos = new THREE.Vector3(-30, 1, 0);
const selfCurrStepPos = new THREE.Vector3(-30, 1, 0);
const selfRenderPos = new THREE.Vector3(-30, 1, 0);
const JUMP_VY = 8.6; // 通常ジャンプの垂直初速（溜めジャンプの倍率 1.0 の基準）
const AIR_SPEED = 5.4; // 通常の空中移動速度（溜めジャンプの水平倍率 1.0 の基準）
const PUNCH_COOLDOWN_MS = 420; // サーバーと一致（モーション全長）
const PUNCH_RANGE = 1.35, PUNCH_COS = 0.5;
const PUNCH_KB_SPEED = 18; // ノックバックの水平移動速度（サーバーと一致。従来9の2倍）
const player = { pos: new THREE.Vector3(-30, 1, 0) }; // y=1 はスタート島上面（接地高さ・項目1）
const placement = { selected: null, selectedIdx: -1, anchor: null, endPt: null, ghost: null, ghostEnd: null, mouseWorld: null, rot: { x: 0, y: 0, z: 0 }, rotQ: null, longDrag: null, confirmClick: false, wheelPhase: 0, wheelScrub: WheelPhase.createScrubber() };
function resetPlacement(full) {
  placement.anchor = null; placement.endPt = null; placement.rot = { x: 0, y: 0, z: 0 }; placement.rotQ = null; placement.longDrag = null; placement.confirmClick = false;
  placement.wheelPhase = 0; placement.wheelScrub = WheelPhase.createScrubber(); // 観覧車の位相調整はカード選択ごとにリセット
  if (full) { placement.selected = null; placement.selectedIdx = -1; }
  updateGhost();
}

const DIMS = { stable: [2, 1, 2], island: [4, 1, 4], chikuwa: [2, 1, 2], slide: [2, 1, 2], wheel: [2, 1, 2], long: [5, 0.6, 1], teleport: [2, 1, 2] };

/* 配置制限（サーバー placementForbidden と同じ規則）: スタート/ゴール島の
 * XZ 範囲と重なり、足場の底面が島上面+2.2m より低い配置は禁止。
 * ゴーストの色を赤くして「置けない」ことを示し、確定送信も止める
 * （最終判定はサーバーが権威）。
 * 観覧車はゴンドラが XY 平面を半径3で公転するため、回転面方向（x）は
 * 半径3＋ゴンドラ半幅、回転軸方向（z）はゴンドラ半幅とし、軌道全体の
 * 外接範囲で判定する（サーバーの placementForbidden と同じ式） */
const ISLAND_RECTS_CLIENT = [{ cx: START.x, cz: START.z }, { cx: GOAL.x, cz: GOAL.z }];
function placementForbiddenClient(type, pos, rot) {
  const dims = DIMS[type]; if (!dims || !pos) return true;
  let ex = dims[0] / 2, ey = dims[1] / 2, ez = dims[2] / 2;
  if (type === 'wheel') { ex = 3 + dims[0] / 2; ez = dims[2] / 2; } // 観覧車は軌道全体の外接範囲で判定（サーバーと同じ式。下のコメント参照）
  if (type === 'long' && rot && typeof THREE !== 'undefined') {
    const e = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot.x || 0, rot.y || 0, rot.z || 0)).elements;
    ex = Math.abs(e[0]) * dims[0] / 2 + Math.abs(e[4]) * dims[1] / 2 + Math.abs(e[8]) * dims[2] / 2;
    ey = Math.abs(e[1]) * dims[0] / 2 + Math.abs(e[5]) * dims[1] / 2 + Math.abs(e[9]) * dims[2] / 2;
    ez = Math.abs(e[2]) * dims[0] / 2 + Math.abs(e[6]) * dims[1] / 2 + Math.abs(e[10]) * dims[2] / 2;
  }
  const bottom = pos.y - ey - (type === 'wheel' ? 3 : 0); // 観覧車はゴンドラ最下点で判定
  if (bottom >= 1 + 2.2) return false;
  return ISLAND_RECTS_CLIENT.some(isl => Math.abs(pos.x - isl.cx) < ex + 5 && Math.abs(pos.z - isl.cz) < ez + 5);
}
/* 配置制限の全体判定（サーバー placementForbiddenFull と同じ規則・同じ
 * 0.5m刻みのサンプリング）: 始点だけでなく終点（水平移動・テレポ）にも、
 * 水平移動については始点〜終点の通過範囲にも同じ制限を適用する */
const PLACE_SWEEP_STEP_CLIENT = 0.5;
function placementForbiddenFullClient(type, pos, end, rot) {
  if (!pos) return true;
  if (placementForbiddenClient(type, pos, rot)) return true;
  if (end) {
    if (placementForbiddenClient(type, end, rot)) return true;
    if (type === 'slide') {
      const dist = Math.hypot(end.x - pos.x, end.y - pos.y, end.z - pos.z);
      const n = Math.max(1, Math.ceil(dist / PLACE_SWEEP_STEP_CLIENT));
      for (let i = 1; i < n; i++) {
        const f = i / n;
        if (placementForbiddenClient(type, { x: pos.x + (end.x - pos.x) * f, y: pos.y + (end.y - pos.y) * f, z: pos.z + (end.z - pos.z) * f }, rot)) return true;
      }
    }
  }
  return false;
}
function applyGhostValidity() {
  if (!placement.ghost || !placement.selected) return;
  const base = placement.anchor || placement.mouseWorld;
  if (!base) return;
  const myColor = me() ? me().color.hex : '#ffffff';
  const bad = placementForbiddenClient(placement.selected, base, placement.rot);
  placement.ghost.traverse(ch => { if (ch.material && ch.material.color) ch.material.color.set(bad ? '#ef4444' : myColor); });
  /* 終点ゴーストは「終点＋通過範囲」込みの全体判定で色を決める */
  if (placement.ghostEnd && placement.anchor && (placement.selected === 'slide' || placement.selected === 'teleport')) {
    const end = placement.endPt || (placement.selected === 'slide' ? slideEnd(placement.anchor, placement.mouseWorld) : placement.mouseWorld);
    const badEnd = placementForbiddenFullClient(placement.selected, placement.anchor, end, placement.rot);
    placement.ghostEnd.traverse(ch => { if (ch.material && ch.material.color) ch.material.color.set(badEnd ? '#ef4444' : myColor); });
  }
}

function platformCurrent(pl, t) {
  const p = pl.pos;
  if (pl.type === 'slide' && pl.end) {
    // サーバー slideFactorAt と同一: 4秒移動→2秒停止→4秒移動(復路)→2秒停止 = 12秒サイクル
    const ph = (((t - pl.placedAt) / 1000) % 12 + 12) % 12;
    let f = 0; if (ph < 4) f = ph / 4; else if (ph < 6) f = 1; else if (ph < 10) f = 1 - (ph - 6) / 4;
    return { x: p.x + (pl.end.x - p.x) * f, y: p.y + (pl.end.y - p.y) * f, z: p.z + (pl.end.z - p.z) * f };
  }
  // 観覧車: プレビューと共通の関数＋保存済み位相オフセット（wheelphase.js）。placedAt は位相に使わない
  if (pl.type === 'wheel') return WheelPhase.wheelPosAt(p, t, pl.phaseOffset);
  if (pl.type === 'teleport' && pl.end) { const side = Math.floor(Math.max(0, t - pl.placedAt) / 3000) % 2; return side ? { ...pl.end } : { ...p }; }
  if (pl.type === 'chikuwa') {
    const trig = (S && (S.placed.find(x => x.id === pl.id) || {}).chikuwaTriggerAt) || pl.chikuwaTriggerAt;
    if (trig) {
      const dt = (t - trig) / 1000;
      // 落下はトリガーから2秒後〜5.2秒まで。5.2秒を過ぎたらその竹輪単独で復活する
      // （サーバーの chikuwaFallDy と同じサイクル。他の足場のイベントに依存しない・項目8）
      if (dt >= 2 && dt < 5.2) { const dy = -4.9 * (dt - 2) * (dt - 2); return { x: p.x, y: p.y + dy, z: p.z }; }
    }
    return { ...p };
  }
  return { ...p };
}
function makePlatformMesh(pl, ghost = false) {
  const [w, h, d] = DIMS[pl.type];
  const mat = new THREE.MeshLambertMaterial({ color: pl.ownerColor || '#cccccc', transparent: ghost, opacity: ghost ? 0.55 : 1 });
  if (pl.type === 'chikuwa') {
    // 竹輪: 上面は安定と同じ全面プレート（穴なし）。空洞は側面中央を貫く見た目だけのトンネル。
    // 上面板＋左右の脚で構成し、側面から見ると中央に開口があるように見える。
    const g = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), mat); plate.position.y = h / 2 - 0.15; g.add(plate);
    const legGeo = new THREE.BoxGeometry(0.45, h - 0.3, d);
    const legL = new THREE.Mesh(legGeo, mat); legL.position.set(-(w / 2 - 0.225), -(h / 2) + (h - 0.3) / 2, 0); g.add(legL);
    const legR = new THREE.Mesh(legGeo, mat); legR.position.set(w / 2 - 0.225, legL.position.y, 0); g.add(legR);
    // 選択用ヒットプロキシ: 側面中央の開口部は見た目どおりすり抜けるため、正面中央を
    // クリックすると足場本体をクリックしたのに選択できない。足場の外形全体を覆う
    // 透明な当たり判定を重ね、竹輪のどこをクリックしても選択できるようにする（項目9）
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
    proxy.userData.platformId = pl.id;
    g.add(proxy);
    g.children.forEach(ch => { ch.userData.platformId = pl.id; });
    g.userData.platformId = pl.id;
    return g;
  }
  const geo = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, mat);
  if (pl.rot && pl.type === 'long') mesh.rotation.set(pl.rot.x || 0, pl.rot.y || 0, pl.rot.z || 0);
  mesh.userData.platformId = pl.id;
  return mesh;
}
function initThree() {
  if (scene) return;
  const wrap = $('#canvas-wrap');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d9);
  scene.fog = new THREE.Fog(0x87b5d9, 80, 190);
  cam = new THREE.PerspectiveCamera(settings.sickness ? 50 : 65, 1, 0.1, 400);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  wrap.appendChild(renderer.domElement);
  canvasEl = renderer.domElement;
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7); sun.position.set(30, 60, 20); scene.add(sun);
  // スタート島・ゴール島
  const mkIsland = (x, color, label) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(10, 2, 10), new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, 0, 0); scene.add(m);
    const cvs = document.createElement('canvas'); cvs.width = 256; cvs.height = 64;
    const ctx = cvs.getContext('2d'); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, 256, 64); ctx.fillStyle = '#fff'; ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(label, 128, 44);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cvs) }));
    sp.scale.set(8, 2, 1); sp.position.set(x, 4.4, 0); scene.add(sp);
    /* 島とラベル（START/GOAL表示）は装飾専用オブジェクトとして、レイキャストを
     * 無効化する。視点操作・配置クリック・ホバー判定など、どの判定にも一切
     * ヒットさせない（START表示に視点が引っ掛かる問題への対策・項目12）。
     * 三.js の Sprite は標準で raycast 対象になるため、明示的に潰しておく */
    m.raycast = () => {};
    sp.raycast = () => {};
    m.userData.decorative = true; sp.userData.decorative = true;
  };
  mkIsland(START.x, 0x38bdf8, 'START'); mkIsland(GOAL.x, 0xfacc15, 'GOAL');
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshLambertMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.6 }));
  sea.rotation.x = -Math.PI / 2; sea.position.y = -16; scene.add(sea);
  platformsGroup = new THREE.Group(); scene.add(platformsGroup);
  playersGroup = new THREE.Group(); scene.add(playersGroup);
  applySickness();
  bindCanvasEvents();
  resize(); window.addEventListener('resize', resize);
  requestAnimationFrame(loop);
}
function resize() { if (!renderer) return; const w = $('#canvas-wrap'); const r = w.getBoundingClientRect(); renderer.setSize(Math.max(50, r.width), Math.max(50, r.height)); cam.aspect = r.width / Math.max(1, r.height); cam.updateProjectionMatrix(); }
/* シーンから除去するオブジェクトツリーの GPU リソースを破棄する。
 * 足場・プレイヤー・ゴースト等のメッシュは生成のたびに新しい Geometry /
 * Material / CanvasTexture を作るため、除去時に dispose しないと連戦や
 * 再構築のたびに GPU メモリへ残り続ける。同一ツリー内で共有されている
 * もの（竹輪の左右の脚ジオメトリ、プレイヤーの本体色・暗色マテリアル等）は
 * Set で重複を除き1回だけ破棄する。Sprite のジオメトリは three.js r128
 * では全スプライト共有の内部バッファのため破棄対象から外す
 * （スプライトはマテリアルとテクスチャのみ破棄する） */
function disposeObject3D(root) {
  if (!root) return;
  const geos = new Set(), mats = new Set(), texs = new Set();
  root.traverse(o => {
    if (o.geometry && !o.isSprite) geos.add(o.geometry);
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) { mats.add(m); if (m.map) texs.add(m.map); }
  });
  for (const t of texs) t.dispose();
  for (const m of mats) m.dispose();
  for (const g of geos) g.dispose();
}
function rebuildPlatforms() {
  if (!scene || !S) return;
  const sig = S.placed.map(p => p.id).join(',') + '|' + S.phase;
  if (sig === placedSignature) { return; }
  placedSignature = sig;
  while (platformsGroup.children.length) { const ch = platformsGroup.children[0]; platformsGroup.remove(ch); disposeObject3D(ch); }
  platformMeshes.clear();
  for (const pl of S.placed) { const m = makePlatformMesh(pl); platformsGroup.add(m); platformMeshes.set(pl.id, m); }
}
function setPlayerPos(p) {
  player.pos.set(p.x, p.y, p.z); athletic.vy = 0; athletic.standId = null; athletic.standLastCenter = null; athletic.stepStartStandId = null;
  /* 描画補間のアンカーも同じ位置へスナップする（テレポート/リスポーンで
   * 補間が旧位置から滑るのを防ぐ） */
  selfPrevStepPos.copy(player.pos); selfCurrStepPos.copy(player.pos); selfRenderPos.copy(player.pos); physAcc = 0;
  /* テレポート（リスポーン・開始位置合わせ）のたびにカメラの平滑化Yも現在位置へ
   * 同期させる。以前は smoothY が落下前の高さ等に残り、リスポーン後にカメラが
   * 数m分ゆっくり追いつく「すくい上げ」動作になっていた（項目4で実測:
   * リスポーン時点で smoothY が目標から 5.35m ずれていた） */
  athCam.smoothY = p.y + 1.0;
}
/* サーバーの spawnPos と同じ並びでスタート島上の開始位置を返す（y は島上面=1 で接地・項目1） */
function spawnPosClient(idx) { const col = idx % 4, row = Math.floor(idx / 4); return { x: START.x - 3 + col * 2, y: 1, z: START.z - 3 + row * 2 }; }
/* 新試合開始時、全キャラクターを前試合の位置・補間の残りごとリセットし、
 * 開始位置へ即座にスナップさせる（項目11）。落下したまま空中に残る表示を防ぐ */
function snapPlayersToSpawn() {
  remoteSnap = []; // 前試合の位置スナップショットを破棄
  remoteInterpBuffers.clear(); // 補間履歴も破棄（前試合の履歴でスナップが引っ張られないように）
  if (!S) return;
  S.players.filter(p => p.isParticipant).forEach((p, i) => {
    const sp = spawnPosClient(i);
    if (p.id === myId) setPlayerPos(sp);
    const r = remotePlayers.get(p.id);
    if (r) {
      r.target.set(sp.x, sp.y, sp.z);
      r.group.position.set(sp.x, sp.y, sp.z); // lerp を介さず即スナップ
      r.prevPos.copy(r.group.position);
      r.intentSpeed = 0; r.serverMoving = false; r.speedSm = 0;
    }
  });
}

/* ============ 配置操作 ============ */
function updateGhost() {
  if (!scene) return;
  if (placement.ghost) { scene.remove(placement.ghost); disposeObject3D(placement.ghost); placement.ghost = null; }
  if (placement.ghostEnd) { scene.remove(placement.ghostEnd); disposeObject3D(placement.ghostEnd); placement.ghostEnd = null; }
  if (!S || S.phase !== 'place' || !placement.selected || !placement.mouseWorld) return;
  const myColor = me() ? me().color.hex : '#ffffff';
  const fake = { id: 'ghost', type: placement.selected, pos: placement.anchor || placement.mouseWorld, end: null, rot: placement.rot, ownerColor: myColor };
  placement.ghost = makePlatformMesh(fake, true);
  if (placement.selected === 'long' && placement.rotQ) placement.ghost.quaternion.copy(placement.rotQ);
  scene.add(placement.ghost);
  // 始点を確定するまでは終点プレビューを一切表示しない（未確定時の終点ゴースト生成がちらつきの原因だった）
  if ((placement.selected === 'slide' || placement.selected === 'teleport') && placement.anchor) {
    const end = placement.endPt || (placement.selected === 'slide' ? slideEnd(placement.anchor, placement.mouseWorld) : placement.mouseWorld);
    const fake2 = { ...fake, pos: end };
    placement.ghostEnd = makePlatformMesh(fake2, true); scene.add(placement.ghostEnd);
  }
}
/* 配置座標のクランプ範囲。サーバー doPlace の pos/end クランプ
 * （x∈[-30,30]・y∈[0.5,16]・z∈[-18,18]、server.js の doPlace）と一致させる。
 * 以前はクライアントの終点だけがクランプなしで、範囲を超える終点では
 * プレビュー（8m移動）と実体（サーバーでクランプされた位置まで）が
 * 食い違い、斜め方向では移動方向自体が変わってしまっていた */
const PLACE_CLAMP = { x: 30, yMin: 0.5, yMax: 16, z: 18 };
function clampPlacePos(p) {
  return { x: Math.max(-PLACE_CLAMP.x, Math.min(PLACE_CLAMP.x, p.x)), y: Math.max(PLACE_CLAMP.yMin, Math.min(PLACE_CLAMP.yMax, p.y)), z: Math.max(-PLACE_CLAMP.z, Math.min(PLACE_CLAMP.z, p.z)) };
}
function slideEnd(anchor, dirPoint) {
  const dx = dirPoint.x - anchor.x, dz = dirPoint.z - anchor.z; const len = Math.hypot(dx, dz) || 1;
  return clampPlacePos({ x: anchor.x + dx / len * SLIDE_DIST, y: anchor.y, z: anchor.z + dz / len * SLIDE_DIST });
}
/* 配置の確定フロー（項目8）:
 * 安定・浮島・竹輪・観覧車: クリックで仮配置（固定）→ もう一度クリックで確定
 * 水平移動・テレポ: 始点→終点→もう一度クリックで確定
 * 細長: 仮配置→ドラッグで掴んで回す→クリックで確定
 * サーバーへの送信は確定時のみ1回 */
function canvasPlaceClick() {
  if (!placement.selected || !placement.mouseWorld) return;
  const pt = { ...placement.mouseWorld };
  const type = placement.selected;
  /* 配置禁止の位置ではクリック自体を受け付けずスルーする（仮配置状態に
   * 入らない）。以前は禁止位置でも仮配置でき、赤いゴーストのまま確定
   * クリック→確認ダイアログ→サーバー拒否、という無駄な往復になっていた。
   * 始点は始点自身、終点は終点＋通過範囲込みの全体判定で弾く
   * （サーバー側の拒否は最終防衛として残る） */
  if (type === 'slide' || type === 'teleport') {
    if (!placement.anchor) {
      if (placementForbiddenClient(type, pt, placement.rot)) return; // 始点クリックをスルー
      placement.anchor = pt; updateGhost(); return; // 始点決定（ダイアログなし）
    }
    if (!placement.endPt) {
      const candEnd = type === 'slide' ? slideEnd(placement.anchor, pt) : pt;
      if (placementForbiddenFullClient(type, placement.anchor, candEnd, placement.rot)) return; // 終点クリックをスルー
      placement.endPt = candEnd; updateGhost(); return; // 終点決定（ダイアログなし）
    }
    askConfirmPlace(type, placement.anchor, placement.endPt, { x: 0, y: 0, z: 0 }); // 確定（確認ダイアログ経由）
  } else if (type === 'long') {
    if (!placement.anchor) {
      if (placementForbiddenClient(type, pt, placement.rot)) return; // 仮配置クリックをスルー
      placement.anchor = pt; placement.rotQ = new THREE.Quaternion(); placement.rot = { x: 0, y: 0, z: 0 }; updateGhost(); return; // 仮配置
    }
    // 仮配置後の左クリックは「掴む」ドラッグの開始として扱い、確定は mouseup 側で判定する
  } else {
    if (!placement.anchor) {
      if (placementForbiddenClient(type, pt, placement.rot)) return; // 仮配置クリックをスルー
      placement.anchor = pt; updateGhost(); return; // 仮配置（位置も角度も固定・ダイアログなし）
    }
    askConfirmPlace(type, placement.anchor, null, { x: 0, y: 0, z: 0 }); // 確定（確認ダイアログ経由）
  }
}
function emitPlace(type, pos, end, rot) {
  if (placementForbiddenFullClient(type, pos, end, rot)) { toast('スタート/ゴール島の真上・低い位置には配置できません', 2600, 'warn'); return; }
  const payload = { type, pos, end, rot };
  // 観覧車はプレビューで調整した回転位相オフセットも送り、サーバーに保存・同期させる
  if (type === 'wheel') payload.phaseOffset = placement.wheelPhase;
  socket.emit('place:place', payload);
  resetPlacement(true);
  renderHand();
}
/* 配置確定の確認ダイアログ: 確定クリックのタイミングでのみ表示する。
 * 「はい」で初めてサーバーへ送信し、「いいえ」では仮配置の状態（anchor/endPt/rot）を
 * そのまま保持して戻る（キャンセルではない）。ダイアログ表示中は overlay が
 * 画面全体を覆うため、背後のキャンバス操作は受け付けない */
let pendingPlace = null;
function askConfirmPlace(type, pos, end, rot) {
  pendingPlace = { type, pos, end, rot };
  $('#place-confirm-modal').classList.remove('hidden');
}
$('#btn-place-yes').onclick = () => {
  $('#place-confirm-modal').classList.add('hidden');
  if (!pendingPlace) return;
  const p = pendingPlace; pendingPlace = null;
  emitPlace(p.type, p.pos, p.end, p.rot);
};
$('#btn-place-no').onclick = () => {
  $('#place-confirm-modal').classList.add('hidden');
  pendingPlace = null; // 仮配置は保持したまま戻る
};
/* 細長: バーを「掴んで回す」回転（項目7）。
 * 仮配置の中心を取っ手として、マウスレイが中心から指す3D方向へバーの長軸を直接向ける。
 * 何度でも掴み直せる */
function longDragDir() {
  if (!cam || !placement.anchor) return null;
  const ray = new THREE.Raycaster(); ray.setFromCamera(mouseState.ndc, cam);
  const anchor = new THREE.Vector3(placement.anchor.x, placement.anchor.y, placement.anchor.z);
  const dist = cam.position.distanceTo(anchor);
  const pt = ray.ray.at(dist, new THREE.Vector3());
  const dir = pt.sub(anchor);
  if (dir.lengthSq() < 0.04) return null;
  return dir.normalize();
}
function applyLongDrag() {
  const dir = longDragDir(); if (!dir) return;
  const yaw = Math.atan2(-dir.z, dir.x);          // 長軸(X)を水平方向へ
  const pitch = Math.asin(clamp(dir.y, -1, 1));   // 長軸を上下へ
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch));
  placement.rotQ = q;
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  placement.rot = { x: e.x, y: e.y, z: e.z };
  if (placement.ghost) placement.ghost.quaternion.copy(q);
}

/* ============ マウス視点操作（FPSスタイル）のポインターロック ============ */
/* mouseLook ON のときの視点回転はポインターロックの成否に依存させない（項目3）。
 * 以前は「ロックが取れている時だけ回転」だったため、フェーズ開始直後（まだクリック
 * していない）や、ロック取得が失敗する環境（埋め込みiframeのポリシー、ESC解除直後の
 * クールダウン等）では、マウスを動かしても視点が一切回らなかった。
 * ロックはカーソルを隠すためのものと位置づけ、取得を試みつつ、取れていない間も
 * mousemove の移動量で回転させる（mousemove ハンドラ側） */
let mouseLookFallback = false; // ロック取得に失敗した実績がある間は true（クリックをパンチに回す）
function tryPointerLock() {
  if (!canvasEl || document.pointerLockElement === canvasEl) return;
  try {
    const r = canvasEl.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(() => { mouseLookFallback = true; });
  } catch (e) { mouseLookFallback = true; }
}
document.addEventListener('pointerlockerror', () => { mouseLookFallback = true; });
document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement === canvasEl) mouseLookFallback = false; });

/* ============ キャンバス入力 ============ */
function bindCanvasEvents() {
  canvasEl.addEventListener('contextmenu', (e) => { e.preventDefault(); if (S && S.phase === 'place' && mouseState.rightDragDist < 5) { resetPlacement(true); renderHand(); } });
  canvasEl.addEventListener('mousedown', (e) => {
    if (e.button === 0) mouseState.left = true;
    if (e.button === 2) { mouseState.right = true; mouseState.rightDragDist = 0; }
    mouseState.downPos = { x: e.clientX, y: e.clientY };
    if (!S) return;
    if (S.phase === 'place' && e.button === 0 && PRIV && PRIV.myTurn && placement.selected === 'long' && placement.anchor) {
      /* 回転ドラッグは「仮配置中の細長本体を実際に掴んだ場合」だけ開始する。
       * 以前は仮配置中ならキャンバス上のどこで押し始めてもドラッグ扱いになり、
       * 確定しようとしたクリックの微小なマウス移動でも applyLongDrag が走って
       * 意図しない角度に変わってしまっていた（項目6の原因）。
       * 掴んでいない押し始めは通常クリックとして、確定だけを行う */
      const r0 = canvasEl.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r0.left) / r0.width) * 2 - 1, -((e.clientY - r0.top) / r0.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, cam);
      const hits = placement.ghost ? ray.intersectObject(placement.ghost, true) : [];
      if (hits.length) placement.longDrag = { startX: e.clientX, startY: e.clientY, moved: 0 }; // 掴んだ → 回転ドラッグ開始
      else placement.confirmClick = true; // 掴んでいない → mouseup で確定のみ
      return;
    }
    if (S.phase === 'place' && e.button === 0 && PRIV && PRIV.myTurn) canvasPlaceClick();
    else if (S.phase === 'guard' || S.phase === 'destroy') { if (e.button === 0) pickPlatformByRay(); }
    else if (S.phase === 'athletic' && e.button === 0) {
      if (settings.mouseLook && document.pointerLockElement !== canvasEl && !mouseLookFallback) {
        athletic.lockClickSuppress = true; // ロック取得のためのクリックではパンチしない＆その長押しで溜めも開始しない
        tryPointerLock(); // ロック取得のためのクリックではパンチしない
      } else if (settings.binds.punch.main === 'Mouse0' && !modalOpen() && !capture) athletic.punchQueued = true;
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) { mouseState.left = false; athletic.lockClickSuppress = false; }
    if (e.button === 2) mouseState.right = false;
    // 細長の「掴んで回す」終了: ほとんど動かさなかった場合はクリック=配置確定として扱う（確認ダイアログ経由）
    if (e.button === 0 && placement.longDrag) {
      const drag = placement.longDrag; placement.longDrag = null;
      if (drag.moved < 6 && S && S.phase === 'place' && placement.selected === 'long' && placement.anchor && PRIV && PRIV.myTurn) {
        askConfirmPlace('long', placement.anchor, null, { ...placement.rot });
      }
    }
    // 細長を掴まずに押し始めたクリック: 回転は一切させず、配置確定だけを行う（項目6・確認ダイアログ経由）
    if (e.button === 0 && placement.confirmClick) {
      placement.confirmClick = false;
      if (S && S.phase === 'place' && placement.selected === 'long' && placement.anchor && PRIV && PRIV.myTurn) {
        askConfirmPlace('long', placement.anchor, null, { ...placement.rot });
      }
    }
  });
  canvasEl.addEventListener('mousemove', (e) => {
    const r = canvasEl.getBoundingClientRect();
    mouseState.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    mouseState.x = e.clientX; mouseState.y = e.clientY;
    mouseState.insideCanvas = true;
    // movementX/Y が片軸だけ 0 で返る環境（ドライバ/リモートデスクトップ等）では、
    // その軸だけ視点が死ぬ（「水平にしか動かない」症状）。軸ごとに client 座標の
    // 差分へフォールバックして、入力が届いている限り必ず視点が応答するようにする
    const fbX = mouseState.lastClientX === null ? 0 : e.clientX - mouseState.lastClientX;
    const fbY = mouseState.lastClientY === null ? 0 : e.clientY - mouseState.lastClientY;
    mouseState.lastClientX = e.clientX; mouseState.lastClientY = e.clientY;
    const mvX = e.movementX || fbX, mvY = e.movementY || fbY;
    if (S && S.phase === 'athletic' && !modalOpen() && !capture && (settings.mouseLook || document.pointerLockElement === canvasEl)) {
      // mouseLook ON のときは右ドラッグ不要で、マウス移動だけで視点が回る。
      // ポインターロックが取れているかどうかは問わない（項目3）:
      // ロック中は movementX/Y、未ロック時は同じ movementX/Y か client 座標差分で回転する
      rotateAthCam(mvX, mvY); return;
    }
    if (mouseState.right && mouseState.downPos) {
      const dx = mvX, dy = mvY;
      mouseState.rightDragDist = (mouseState.rightDragDist || 0) + Math.abs(dx) + Math.abs(dy);
      if (S && S.phase === 'athletic') rotateAthCam(dx, dy);
      else { placeCam.yaw -= dx * 0.005; placeCam.pitch = clamp(placeCam.pitch + dy * 0.005, 0.15, 1.45); }
    }
    // 配置: 細長の「掴んで回す」ドラッグ中は、マウスレイの指す方向へバーを直接追従させる。
    // 微小なジッターでは回転させない（デッドゾーンを設け、クリック確定時の角度ブレを防ぐ）
    if (placement.longDrag && mouseState.left) {
      placement.longDrag.moved += Math.abs(mvX) + Math.abs(mvY);
      if (placement.longDrag.moved > 3) applyLongDrag();
    }
  });
  canvasEl.addEventListener('mouseleave', () => { mouseState.insideCanvas = false; mouseState.lastClientX = null; mouseState.lastClientY = null; });
  /* ポインターロックの取得/解除の瞬間は clientX/Y の基準が切り替わるため、
   * 差分フォールバック用の前回座標をリセットする（切り替わり直後の1イベントで
   * 大きな差分が出て視点が跳ぶのを防ぐ） */
  document.addEventListener('pointerlockchange', () => { mouseState.lastClientX = null; mouseState.lastClientY = null; });
  canvasEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    // 細長の仮配置中はホイールでバー自身の軸周りにひねる（ロール）
    if (S && S.phase === 'place' && placement.selected === 'long' && placement.anchor && placement.rotQ) {
      const twist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.sign(e.deltaY) * 0.18);
      placement.rotQ = placement.rotQ.clone().multiply(twist);
      const eu = new THREE.Euler().setFromQuaternion(placement.rotQ, 'XYZ');
      placement.rot = { x: eu.x, y: eu.y, z: eu.z };
      if (placement.ghost) placement.ghost.quaternion.copy(placement.rotQ);
      return;
    }
    // 観覧車のプレビュー中（ゴースト表示中〜配置確定前）は、ホイールで回転位相を
    // 進めたり戻したりする（カメラズームより優先）。1ノッチ＝周期の1/12（30°）。
    // ホイールを奥へ回す（deltaY<0）で位相が進み、手前（deltaY>0）で戻る。
    // トラックパッドの連続量は scrubNotches が蓄積してノッチ換算する
    if (S && S.phase === 'place' && placement.selected === 'wheel' && placement.ghost) {
      const steps = WheelPhase.scrubNotches(placement.wheelScrub, e.deltaY, e.deltaMode);
      if (steps) {
        placement.wheelPhase = WheelPhase.scrubPhase(placement.wheelPhase, steps);
        updateGhostPositionOnly(); // マウスを動かさなくてもその場でゴーストへ反映
      }
      return;
    }
    if (S && S.phase === 'athletic') athCam.dist = clamp(athCam.dist + Math.sign(e.deltaY) * 0.8, 3, 14);
    else placeCam.dist = clamp(placeCam.dist + Math.sign(e.deltaY) * 3, 24, 95);
  }, { passive: false });
}
/* 視点回転の単一経路。ピッチの自己復旧ウォッチドッグは誤発（正常な往復操作で
 * ピッチを既定値へ跳ばす）のため廃止済み。詳細は関数内の注記と loop 側の注記参照 */
function rotateAthCam(dx, dy) {
  // 入力が数値でない場合は 0 として扱う。以前はポインターロック経路で
  // movementY を無検証で渡しており、環境によって undefined/NaN が入ると
  // athCam.pitch が NaN 化し、clamp(NaN) は NaN を返すため二度と復旧せず、
  // 「上下だけ視点が効かない」状態になっていた（左右は movementX が正常な間は効く）
  dx = Number(dx); dy = Number(dy);
  if (!Number.isFinite(dx)) dx = 0;
  if (!Number.isFinite(dy)) dy = 0;
  // 1イベント分の移動量としてあり得ない大きさは異常値として切り捨てる。
  // ポインターロック取得直後のスパイク等で視点が一瞬跳ぶのを防ぐ
  dx = clamp(dx, -300, 300); dy = clamp(dy, -300, 300);
  if (!Number.isFinite(athCam.pitch)) athCam.pitch = 0.32;
  if (!Number.isFinite(athCam.yaw)) athCam.yaw = 0;
  const sens = Number(settings.sensitivity);
  const s = 0.0032 * (Number.isFinite(sens) && sens > 0 ? sens : 1);
  athCam.yaw -= dx * s;
  athCam.pitch = clamp(athCam.pitch + dy * s * (settings.invertY ? 1 : -1), -0.9, 1.2);
  /* 注: 以前ここにあった「ピッチ入力の意図が蓄積してもピッチが変化しない場合に
   * 既定値 0.32 へ戻すウォッチドッグ」は廃止した。実測（項目4の系統計測）で、
   * 見上げてから同じ高さまで視点を戻す操作をすると「開始ピッチ付近に戻った」
   * ことを「ピッチが壊れて変化していない」と誤判定し、入力の途中で
   * pitch を 0.32 へ跳ばす誤発が確認されたため（実測 resid 0.548 rad）。
   * pitch の代入は clamp 経由の直接代入であり、NaN ガードさえあれば
   * 「入力があるのに変化しない」状態はクランプ端以外では起こりえない */
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function findPlatformId(obj) {
  // 子メッシュから親をたどって platformId を持つオブジェクトを探す
  for (let o = obj; o; o = o.parent) if (o.userData && o.userData.platformId) return o.userData.platformId;
  return null;
}
function pickPlatformByRay() {
  const ray = new THREE.Raycaster(); ray.setFromCamera(mouseState.ndc, cam);
  // recursive=true が必須。竹輪は「上面プレート＋両脚」の Group 構成のため、
  // 非再帰の intersect では Group 自体に raycast が無く、子メッシュが一切ヒットせず
  // 3Dマップ上で竹輪だけ直接選択できなかった（項目9の原因）
  const hits = ray.intersectObjects([...platformMeshes.values()], true);
  if (hits.length) {
    const pid = findPlatformId(hits[0].object);
    if (pid) socket.emit(S.phase === 'guard' ? 'guard:pick' : 'destroy:pick', { platformId: pid });
  }
}
function updatePlacementMouse() {
  if (!S || S.phase !== 'place' || !cam) return;
  const ray = new THREE.Raycaster(); ray.setFromCamera(mouseState.ndc, cam);
  const h = currentPlaceHeight(); // 数値入力の 0.1 刻み値が正（スライダー表示は 0.5 位置に寄せてあるだけ）
  const o = ray.ray.origin, d = ray.ray.direction;
  if (Math.abs(d.y) < 1e-5) return;
  const t = (h - o.y) / d.y; if (t < 0) return;
  placement.mouseWorld = { x: clamp(o.x + d.x * t, -30, 30), y: h, z: clamp(o.z + d.z * t, -18, 18) };
  // 観覧車・水平移動などのゴースト位置更新（ゴースト自体は毎フレーム再配置）
  if (placement.ghost) {
    const base = placement.anchor || placement.mouseWorld;
    placement.ghost.position.set(base.x, base.y, base.z);
    if (placement.selected === 'wheel') { const wp = WheelPhase.wheelPosAt(base, serverNow(), placement.wheelPhase); placement.ghost.position.set(wp.x, wp.y, wp.z); }
    if (placement.ghostEnd && placement.anchor) {
      const end = placement.endPt || (placement.selected === 'slide' ? slideEnd(placement.anchor, placement.mouseWorld) : placement.mouseWorld);
      placement.ghostEnd.position.set(end.x, end.y, end.z);
    }
  }
}

/* ============ プレイヤーメッシュ（手足＋関節つき） ============ */
function makeNameplate(name, colorHex) {
  const cvs = document.createElement('canvas'); cvs.width = 320; cvs.height = 80;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = 'rgba(8,12,22,0.62)';
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(6, 10, 308, 60, 18); ctx.fill(); } else ctx.fillRect(6, 10, 308, 60);
  ctx.fillStyle = colorHex; ctx.beginPath(); ctx.arc(42, 40, 15, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  let size = 34; ctx.font = `bold ${size}px sans-serif`;
  while (ctx.measureText(name).width > 225 && size > 16) { size -= 2; ctx.font = `bold ${size}px sans-serif`; }
  ctx.fillText(name, 68, 42);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cvs), depthWrite: false }));
  sp.scale.set(2.05, 0.51, 1); sp.position.y = 2.3;
  return sp;
}
function makePlayerMesh(colorHex, ghost) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: colorHex, transparent: !!ghost, opacity: ghost ? 0.45 : 1 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1f2937, transparent: !!ghost, opacity: ghost ? 0.45 : 1 });
  /* 上半身（胴体・頭・両腕）は腰位置を原点とする upper グループにまとめる。
   * パンチの振りかぶりで体を捻じるアニメーション（項目9）はこのグループを
   * Y軸回転させることで表現する（脚は捻じらない） */
  const upper = new THREE.Group(); upper.position.y = 0.76; g.add(upper);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.75, 0.36), mat); torso.position.y = 1.08 - 0.76; upper.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 12, 12), mat); head.position.y = 1.74 - 0.76; upper.add(head);
  for (const sx of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), dark); eye.position.set(0.1 * sx, 1.78 - 0.76, 0.24); upper.add(eye); }
  const limb = (w, len, m) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, len, w), m); mesh.position.y = -len / 2; return mesh; };
  const mkArm = (side) => {
    const shoulder = new THREE.Group(); shoulder.position.set(0.42 * side, 1.42 - 0.76, 0);
    shoulder.add(limb(0.16, 0.34, mat));
    const elbow = new THREE.Group(); elbow.position.y = -0.34; elbow.add(limb(0.14, 0.32, mat)); shoulder.add(elbow);
    upper.add(shoulder); return { shoulder, elbow };
  };
  const mkLeg = (side) => {
    const hip = new THREE.Group(); hip.position.set(0.17 * side, 0.76, 0);
    hip.add(limb(0.2, 0.4, dark));
    const knee = new THREE.Group(); knee.position.y = -0.4; knee.add(limb(0.17, 0.38, dark)); hip.add(knee);
    g.add(hip); return { hip, knee };
  };
  const armL = mkArm(-1), armR = mkArm(1), legL = mkLeg(-1), legR = mkLeg(1);
  g.userData.parts = { armL, armR, legL, legR, upper };
  g.userData.mainMat = mat; // 本体色マテリアル（試合開始時の色再割当てに追従させるため）
  g.userData.colorHex = colorHex;
  return g;
}
function ensurePlayerMeshes() {
  if (!S) return;
  const ids = new Set(S.players.filter(p => p.isParticipant).map(p => p.id));
  // 観戦者もアスレチック中は「常時ゴースト」のキャラクターとして表示する（項目4）。
  // 以前は参加者しかメッシュが作られず、観戦者は本人視点でも完全に非表示だった
  if (S.phase === 'athletic') for (const p of S.players) if (p.spectator && p.connected) ids.add(p.id);
  for (const [id, r] of [...remotePlayers.entries()]) if (!ids.has(id)) { playersGroup.remove(r.group); disposeObject3D(r.group); remotePlayers.delete(id); remoteInterpBuffers.delete(id); } // 除去するキャラの Geometry/Material/ネームプレートのテクスチャも破棄する
  const participantsNow = S.players.filter(p => p.isParticipant);
  for (const p of S.players.filter(x => ids.has(x.id))) {
    if (!remotePlayers.has(p.id)) {
      const g = makePlayerMesh(p.color.hex, false);
      /* 生成直後の初期位置はスポーン位置にする。THREE.Group の既定位置は
       * 原点 (0,0,0) ＝ コース中間の空中であり、ここで初期化しないと、
       * role 遷移時の snapPlayersToSpawn より後に生成されたメッシュ
       * （初戦・新規参加者など）が、最初の pos:batch が届くアスレチック
       * 開始まで島と島の間の空中に浮いたまま表示されていた。
       * 割り当てはサーバーの spawnPos と同じ並び（参加者は参加順、
       * 観戦者は参加者数の後ろ） */
      const pIdx = participantsNow.findIndex(x => x.id === p.id);
      const sIdx = pIdx < 0 ? S.players.filter(x => x.spectator).findIndex(x => x.id === p.id) : -1;
      const sp = p.id === myId ? { x: player.pos.x, y: player.pos.y, z: player.pos.z }
        : spawnPosClient(pIdx >= 0 ? pIdx : participantsNow.length + Math.max(0, sIdx));
      g.position.set(sp.x, sp.y, sp.z);
      playersGroup.add(g);
      remotePlayers.set(p.id, { group: g, target: new THREE.Vector3(sp.x, sp.y, sp.z), moving: false, serverMoving: false, phase: Math.random() * 6, punchAt: 0, chargeStartAt: 0, cjAt: 0, cjMult: 1, prevPos: g.position.clone(), speedSm: 0, intentSpeed: 0, plateKey: '', ghostApplied: null, plate: null });
    }
    // 頭上ネームプレート（カラードット＋名前）。名前/色が変わったら作り直す
    const r = remotePlayers.get(p.id);
    /* 試合開始時の色重複解消で色が変わった場合、既存メッシュの本体色も
     * 追従させる（以前は生成時の色のままで名前札・足場色と食い違った） */
    if (r && r.group.userData.mainMat && r.group.userData.colorHex !== p.color.hex) {
      r.group.userData.mainMat.color.set(p.color.hex);
      r.group.userData.colorHex = p.color.hex;
    }
    const key = p.name + '|' + p.color.hex;
    if (r && r.plateKey !== key) {
      if (r.plate) { r.group.remove(r.plate); disposeObject3D(r.plate); } // 作り直す前のプレートのテクスチャ/マテリアルを破棄する
      r.plate = makeNameplate(p.name, p.color.hex);
      r.group.add(r.plate);
      r.plateKey = key;
    }
  }
}
/* 歩行・待機・パンチのモーションを1フレーム分適用する */
function animatePlayer(r, dt, t) {
  const parts = r.group.userData.parts; if (!parts) return;
  // 歩行判定は「足場に対する相対速度＝自分自身の移動入力」ベース（項目22）。
  // 以前はワールド座標の変化量から速度を推定していたため、移動する足場に乗って
  // 止まっているだけでも歩行モーションが再生されていた。
  // 向きは呼び出し側が入力方向（faceYaw / サーバー同期の yaw）で決める（項目21）。
  const speed = r.intentSpeed || 0;
  r.speedSm += (speed - r.speedSm) * 0.25;
  const walkAmp = Math.min(1, r.speedSm / 4.5);
  if (r.speedSm > 0.3) r.phase += dt * (5 + r.speedSm * 1.7);
  const sw = Math.sin(r.phase) * 0.62 * walkAmp;
  parts.legL.hip.rotation.x = sw; parts.legR.hip.rotation.x = -sw;
  parts.legL.knee.rotation.x = Math.max(0, -sw) * 0.85; parts.legR.knee.rotation.x = Math.max(0, sw) * 0.85;
  parts.armL.shoulder.rotation.x = -sw * 0.75;
  parts.armL.elbow.rotation.x = -0.25 - Math.max(0, sw) * 0.3;
  // パンチ（項目18）: 振りかぶり→素早い突き出し→戻り の3段階（全長420ms＝クールダウンと一致）
  // 項目9: 振りかぶりでは上半身（upper）も捻じる。右肩を後ろへ引く方向に捻れ、
  // 突き出しで反対側へ一気に捻り戻ることで、腕だけより自然な体の動きにする。
  // 他クライアントも punch:fx の punchAt 起点で同じ段階計算をするため同期する
  const pe = t - (r.punchAt || 0);
  if (pe >= 0 && pe < PUNCH_COOLDOWN_MS) {
    let shoulderX, elbowX, fwd, twist;
    if (pe < 140) { // 振りかぶり: 腕を後ろへ引き、肘を曲げ、体を捻る（右肩が後ろへ）
      const k = pe / 140;
      shoulderX = 0.95 * k; elbowX = -0.25 - 1.05 * k; fwd = -0.05 * k; twist = 0.5 * k;
    } else if (pe < 220) { // 突き出し: 一気に前方へ。体の捻りも反対側へ振り切る
      const k = (pe - 140) / 80;
      shoulderX = 0.95 + (-1.9 - 0.95) * k; elbowX = -1.3 + 1.2 * k; fwd = -0.05 + 0.22 * k; twist = 0.5 - 0.85 * k;
    } else { // 戻り
      const k = (pe - 220) / (PUNCH_COOLDOWN_MS - 220);
      shoulderX = -1.9 * (1 - k) + sw * 0.75 * k; elbowX = -0.1 + (-0.25 - -0.1) * k; fwd = 0.17 * (1 - k); twist = -0.35 * (1 - k);
    }
    parts.armR.shoulder.rotation.x = shoulderX;
    parts.armR.elbow.rotation.x = elbowX;
    parts.armR.shoulder.position.z = fwd;
    if (parts.upper) parts.upper.rotation.y = twist;
  } else {
    parts.armR.shoulder.rotation.x = sw * 0.75 + Math.sin(t * 0.0016 + r.phase * 0.1) * 0.05 * (1 - walkAmp);
    parts.armR.elbow.rotation.x = -0.25 - Math.max(0, -sw) * 0.3;
    parts.armR.shoulder.position.z = 0;
    if (parts.upper) parts.upper.rotation.y = Math.sin(r.phase) * 0.05 * walkAmp; // 歩行時のわずかな体の揺れ（静止時は0）
    if (walkAmp < 0.05) { // 待機: 軽い呼吸モーション
      parts.armL.shoulder.rotation.x = Math.sin(t * 0.0016) * 0.06;
      parts.legL.hip.rotation.x *= 0.2; parts.legR.hip.rotation.x *= 0.2;
    }
  }
  /* 溜めジャンプのモーション:
   * - 跳躍ポーズ（r.cjAt 起点）: 溜め時間に関わらず 0.3秒の専用ポーズ
   *   （両腕を上げ、脚を後ろへ伸ばす）。
   * - 溜め中（r.chargeStartAt 起点）: 固定ポーズで、溜め時間では変化させない。
   *   脚は折り曲げず（歩行中は歩行の脚モーションを継続）、腕は
   *   「右腕を前に折り曲げ、左腕を後ろに押し曲げる」ポーズにする。
   *   他クライアントも charge:fx の chargeStartAt 起点で同じポーズを出す */
  const cjElapsed = r.cjAt ? t - r.cjAt : Infinity;
  if (cjElapsed < 300) {
    parts.legL.hip.rotation.x = -0.55; parts.legR.hip.rotation.x = -0.4;
    parts.legL.knee.rotation.x = 0.25; parts.legR.knee.rotation.x = 0.35;
    parts.armL.shoulder.rotation.x = -2.7; parts.armR.shoulder.rotation.x = -2.7;
    parts.armL.elbow.rotation.x = -0.15; parts.armR.elbow.rotation.x = -0.15;
    parts.armR.shoulder.position.z = 0;
    if (parts.upper) { parts.upper.rotation.y = 0; parts.upper.position.y = 0.82; parts.upper.position.x = 0; }
  } else if (r.chargeStartAt) {
    if (parts.upper) { parts.upper.position.y = 0.76; parts.upper.position.x = 0; }
    // 右腕: 肘を曲げて前へ（拳を胸の前へ運ぶ形）。肩の前後オフセットも通常位置に戻す
    parts.armR.shoulder.rotation.x = -0.55; parts.armR.elbow.rotation.x = -1.85;
    parts.armR.shoulder.position.z = 0.05;
    // 左腕: 肘を曲げたまま後ろへ押し出す形
    parts.armL.shoulder.rotation.x = 0.85; parts.armL.elbow.rotation.x = -0.95;
  } else if (parts.upper) {
    parts.upper.position.y = 0.76; parts.upper.position.x = 0;
  }
  r.prevPos.copy(r.group.position);
}

/* ============ アスレチック ============ */
function startAthleticClient() {
  if (!S || S.phase !== 'athletic') return; // 前試合の残留状態では開始処理をしない
  remoteInterpBuffers.clear(); // 試合開始は位置の不連続点: 補間履歴を破棄してスナップさせる（前試合の位置から滑らせない）
  athletic.active = true; athletic.started = false; athletic.goAt = S ? S.goAt : Date.now() + 3500;
  athletic.locked = true; clearInputs(); // カウント中の入力を蓄積させない
  if (capture) cancelCapture(); // キーコンフィグの受付状態が残っていたら視点/入力が死ぬため解除
  if (settings.mouseLook) tryPointerLock(); // ユーザージェスチャでないため失敗しうるが、その場合も mousemove 回転（フォールバック）が効く（項目3）
  if (PRIV && PRIV.pos) setPlayerPos(PRIV.pos);
  refreshAthleticOverlays();
}
/* 発表・バナー・カウントダウンの表示状態を「サーバー時刻」から一意に決める。
 * 以前は表示/消去が rAF ループと setTimeout 頼みで、タブが非アクティブで
 * ループが止まると発表が表示されたまま固まっていた。サーバー時刻ベースにし、
 * 状態同期・タブ復帰・定期チェックのたびに正しい状態へ即座に合わせる */
function refreshAthleticOverlays() {
  const ba = $('#banned-announce');
  const banner = $('#athletic-banner');
  if (!S || S.phase !== 'athletic') { if (ba) ba.classList.add('hidden'); if (banner) banner.classList.add('hidden'); return; }
  const t = serverNow();
  const elim = (S.announceEliminated || []).map(id => S.players.find(p => p.id === id)).filter(Boolean);
  /* 発表・カウントダウンの開始はサーバーの presentAt 以降に限る。
   * 直近の投票結果パネルがまだ開いているタイミングでアスレチックに入る場合、
   * サーバーはパネル表示を4秒に短縮し、presentAt と goAt をその分だけ後ろ倒しに
   * するため、発表がパネルに重ならず「パネル→発表→カウントダウン」の順序になる
   * （パネル自体はサーバー時刻の votePanelCloseAt で閉じる） */
  const presentAt = S.presentAt || 0;
  if (ba) {
    // 直前の投票で脱落者がいる場合のみ、GOの3秒前まで発表する
    if (elim.length && t >= presentAt && t < (S.goAt || 0) - 3000) {
      const key = elim.map(p => p.id).join(',');
      if (ba.dataset.key !== key) {
        ba.dataset.key = key;
        ba.innerHTML = `<div class="ba-title">🗳 投票により脱落</div>` + elim.map(p => `<div class="ba-name"><span class="color-chip" style="background:${p.color.hex}"></span>${escapeHtml(p.name)}</div>`).join('');
        ba.classList.remove('ba-in'); void ba.offsetWidth; ba.classList.add('ba-in');
      }
      ba.classList.remove('hidden');
    } else { ba.classList.add('hidden'); ba.dataset.key = ''; }
  }
  if (banner) banner.classList.toggle('hidden', t < presentAt || t >= (S.goAt || 0));
  if (t > (S.goAt || 0) + 900) $('#countdown').classList.add('hidden'); // GO表示の消し忘れ防止
}
setInterval(refreshAthleticOverlays, 500); // 非アクティブ復帰直後などの取りこぼしを定期的に正す
const ISLANDS = [
  { cx: START.x, cy: 0, cz: START.z, w: 10, h: 2, d: 10, id: 'start' },
  { cx: GOAL.x, cy: 0, cz: GOAL.z, w: 10, h: 2, d: 10, id: 'goal' },
];
function colliders(t) {
  const list = ISLANDS.map(i => ({ ...i }));
  if (!S) return list;
  for (const pl of S.placed) {
    const c = platformCurrent(pl, t);
    const [w, h, d] = DIMS[pl.type];
    if (pl.type === 'long') {
      // 細長はAABB近似をやめOBB（有向ボックス）として別経路で判定する
      list.push({ kind: 'obb', cx: c.x, cy: c.y, cz: c.z, w, h, d, id: pl.id, type: pl.type, rot: pl.rot || { x: 0, y: 0, z: 0 }, center: c, hx: w / 2, hy: h / 2, hz: d / 2 });
      continue;
    }
    list.push({ cx: c.x, cy: c.y, cz: c.z, w, h, d, id: pl.id, type: pl.type, rot: null, center: c });
  }
  return list;
}
/* 細長OBB: プレイヤー座標を足場のローカル空間へ変換し、上面への着地・側面の接触を
 * ローカル軸で判定する（サーバーの obbTopAt と同じ考え方・同じ回転行列） */
const _obbV = new THREE.Vector3();
function longRotationMatrix(rot) { return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((rot && rot.x) || 0, (rot && rot.y) || 0, (rot && rot.z) || 0)); }
/* 上向きの面（法線Y >= 0.5）すべてを候補に、(x,z) の鉛直線との交点Yを返す。
 * 元の上面（ローカル+Y面）以外の面が上を向く配置（側面・端面が上、裏返し）
 * でも、その面が支持面になる（サーバーの obbTopAt と同じ方式・同じ式）。
 * 交点が面の矩形内にあるものを優先し、無ければ +0.4 マージン内のものから
 * 最も高いものを返す */
function longTopFromElements(e, cx, cy, cz, h, x, z) {
  const dx = x - cx, dz = z - cz;
  let bestExact = null, bestMargin = null;
  for (let a = 0; a < 3; a++) {
    for (let s = 1; s >= -1; s -= 2) {
      const ny = s * e[a * 4 + 1];
      if (ny < 0.5) continue; // 下向き・急な面（傾斜60度超）は支持面にしない
      const t = (s * h[a] - e[a * 4] * dx - e[a * 4 + 2] * dz) / e[a * 4 + 1];
      const o1 = (a + 1) % 3, o2 = (a + 2) % 3;
      const l1 = e[o1 * 4] * dx + e[o1 * 4 + 1] * t + e[o1 * 4 + 2] * dz;
      const l2 = e[o2 * 4] * dx + e[o2 * 4 + 1] * t + e[o2 * 4 + 2] * dz;
      const y = cy + t;
      if (Math.abs(l1) <= h[o1] && Math.abs(l2) <= h[o2]) { if (bestExact === null || y > bestExact) bestExact = y; }
      else if (Math.abs(l1) <= h[o1] + 0.4 && Math.abs(l2) <= h[o2] + 0.4) { if (bestMargin === null || y > bestMargin) bestMargin = y; }
    }
  }
  return bestExact !== null ? bestExact : bestMargin;
}
function longTopAtClient(x, z, pl) {
  const R = longRotationMatrix(pl.rot);
  const e = R.elements; // 列優先: R[row][col] = e[col*4+row]
  /* 支持面の平面と (x,z) の鉛直線の交点Y（見た目の上面Yそのもの）。
   * サーバーの obbTopAt と同じ式。旧式（ローカル座標における上面点の
   * 高さ）は傾斜時に見た目と最大約0.9mずれていた。また旧・厳密式は
   * ローカル+Y面しか見ておらず、側面や端面が上の配置では支持が無かった */
  return longTopFromElements(e, pl.pos.x, pl.pos.y, pl.pos.z, [2.5, 0.3, 0.5], x, z);
}
/* 細長の足元上面Y: ワールド (x,z) 地点でのOBB上面の高さを返す（範囲外は null）。
 * 上面は足位置だけの滑らかな関数なので、静止していれば毎フレーム同じ値になる */
function longTopAtCollider(c, x, z) {
  const R = longRotationMatrix(c.rot);
  const e = R.elements; // 列優先: R[row][col] = e[col*4+row]
  /* 支持面の平面と (x,z) の鉛直線の交点Yを返す（サーバーの obbTopAt と同じ式）。
   * 旧式は「足元XZのローカル座標における上面点の高さ」で、傾いた細長では
   * その点のワールドXZが足元とずれるため、見た目より浮く/埋まるずれが
   * 出ていた（実測: ロール0.6radで最大0.51m、複合回転で最大0.89m）。
   * 交点のローカル座標でフットプリントを判定する。支持面は元の上面に
   * 限らず、上を向いた面（側面・端面・裏返しの下面）も対象になる */
  return longTopFromElements(e, c.center.x, c.center.y, c.center.z, [c.hx, c.hy, c.hz], x, z);
}
function collideLong(c) {
  /* 支持判定を主経路にする（項目7）。
   * 旧実装はプレイヤー「中心」のローカル座標で最小侵入軸を決めて上面へスナップして
   * いたため、傾斜面では スナップ→中心のローカル座標がずれる→別の高さへスナップ を
   * 毎フレーム繰り返してブルブル振動し、接地フラグも軸の反転でフレームごとに
   * 付いたり外れたりしてジャンプが不発になっていた。
   * 新実装は「足元XZでの上面Y」へのスナップのみで接地を決める。上面Yは足位置の
   * 関数なので静止中は一定で、接地も安定する。さらに前フレーム同じ足場に接地して
   * いた場合は許容幅を広げるヒステリシスを持たせ、接地の反転を防ぐ */
  const top = longTopAtCollider(c, player.pos.x, player.pos.z);
  const feetY = player.pos.y;
  const wasStanding = athletic.prevStandId === c.id;
  if (top !== null) {
    const tolBelow = wasStanding ? 0.5 : 0.3; // 接地中はヒステリシスで広く取る
    // 落下して上面を跨いだ場合の着地（落下速度が大きくてもすり抜けない）
    const crossed = athletic.prevFeetY !== undefined && athletic.prevFeetY >= top - 0.05 && feetY <= top && athletic.vy <= 0;
    if ((athletic.vy <= 0.5 && feetY <= top + 0.25 && feetY >= top - tolBelow) || crossed) {
      player.pos.y = top; athletic.vy = 0; athletic.grounded = true; athletic.standId = c.id; athletic.standLastCenter = { ...c.center };
      return true; // 支持した（呼び出し側の支持対象の一本化に使う）
    }
    if (feetY > top + 0.25) return false; // 足場より十分上（ジャンプ中など）は干渉しない
  }
  // 側面・下面の押し出し（ローカル空間の最小侵入軸）。上面側は上の支持判定に任せ、
  // ここでは扱わない（二重処理による上下振動を防ぐ）
  const R = longRotationMatrix(c.rot);
  const Rt = R.clone().transpose();
  const center = new THREE.Vector3(c.center.x, c.center.y, c.center.z);
  const lp = new THREE.Vector3(player.pos.x, player.pos.y + 0.8, player.pos.z).sub(center).applyMatrix4(Rt);
  const ox = (c.hx + 0.4) - Math.abs(lp.x), oy = (c.hy + 0.8) - Math.abs(lp.y), oz = (c.hz + 0.4) - Math.abs(lp.z);
  if (ox <= 0 || oy <= 0 || oz <= 0) return false;
  const overlaps = [ox, oy, oz], lpv = [lp.x, lp.y, lp.z];
  const min = Math.min(ox, oy, oz);
  const minAxis = overlaps.indexOf(min);
  /* 支持面（最も上を向いた面: ローカル軸のうち法線Y成分が最大の面）側の
   * 押し出しは支持判定が担当する。以前は「ローカル+Y面の正側」決め打ち
   * だったため、側面や裏面が上を向く配置では、支持判定と押し出しが
   * 同じ面を取り合って干渉しうる状態だった */
  const e = R.elements;
  let upAxis = 1, upSign = 1, upNy = -1;
  for (let a = 0; a < 3; a++) { const v = e[a * 4 + 1]; if (Math.abs(v) > upNy) { upNy = Math.abs(v); upAxis = a; upSign = v >= 0 ? 1 : -1; } }
  if (minAxis === upAxis && Math.sign(lpv[minAxis]) === upSign) return false; // 支持面側は支持判定が担当
  let axis, pen;
  if (minAxis === 0) { axis = new THREE.Vector3(Math.sign(lp.x) || 1, 0, 0); pen = ox; }
  else if (minAxis === 1) { axis = new THREE.Vector3(0, Math.sign(lp.y) || 1, 0); pen = oy; }
  else { axis = new THREE.Vector3(0, 0, Math.sign(lp.z) || 1); pen = oz; }
  const world = axis.applyMatrix4(R); // 回転行列のみ（平行移動なし）なので方向変換として使える
  player.pos.x += world.x * pen; player.pos.y += world.y * pen; player.pos.z += world.z * pen;
  if (minAxis === upAxis && Math.sign(lpv[minAxis]) === -upSign) athletic.vy = Math.min(athletic.vy, 0); // 支持面の反対側（下向き面）への頭ぶつけ
  return false; // 側面・下面の押し出しのみ（支持はしていない）
}
/* ============ 溜めジャンプの開始・キャンセル・発動 ============ */
function startChargeLocal() {
  athletic.charge = { t: 0, startedAt: performance.now() }; // 経過時間は実時間差で測る（startedAt 起点）
  const r0 = remotePlayers.get(myId); if (r0) r0.chargeStartAt = performance.now();
  socket.emit('charge:fx', { state: 'start' }); // 他プレイヤーにも溜めポーズを見せる
}
function cancelChargeLocal() {
  if (!athletic.charge) return;
  athletic.charge = null;
  const r0 = remotePlayers.get(myId); if (r0) r0.chargeStartAt = 0;
  socket.emit('charge:fx', { state: 'cancel' });
}
/* 倍率ゲージの表示更新（本人の画面のみ）。
 * ルール設定「倍率ゲージ」が ON のときだけ、溜め中に表示する。
 * 溜め進捗（5秒で満タン）をバーの幅、現在の倍率をラベルに示し、
 * 4秒以降（倍率が急上昇する区間）は赤表示（hot）に切り替える */
function updateChargeGauge() {
  const el = $('#charge-gauge');
  const on = !!(S && S.ruleConfig && S.ruleConfig.gauge);
  if (!athletic.charge || !on) { el.classList.add('hidden'); return; }
  const t = athletic.charge.t;
  const m = ChargeLib.chargeMultiplier(t, false);
  el.classList.remove('hidden');
  el.classList.toggle('hot', t >= 4);
  $('#charge-gauge-fill').style.width = Math.min(100, (t / ChargeLib.MAX_CHARGE_SEC) * 100) + '%';
  $('#charge-gauge-label').textContent = `溜めジャンプ ×${m.toFixed(1)}`;
}
function launchCharge(auto) {
  const t = athletic.charge ? athletic.charge.t : 0;
  const m = ChargeLib.chargeMultiplier(t, auto); // 倍率カーブは charge.js が単一の定義
  athletic.charge = null;
  const r0 = remotePlayers.get(myId);
  if (r0) { r0.chargeStartAt = 0; }
  if (m <= 0) return; // 倍率0（溜め時間0）は跳躍力がなく発動しない（消費のみ）
  /* 跳躍の物理: 「頂点に達して開始した足場の高さに戻るまで」が常に0.3秒になるよう、
   * 垂直初速と跳躍中の重力を倍率から決める（charge.js の leapParams）。
   * 水平方向は発動時には与えず、跳躍中の移動キー入力がそのまま効く（無入力なら垂直） */
  const lp = ChargeLib.leapParams(m);
  athletic.cjMult = m; athletic.cjG = lp.g;
  /* ルール設定「溜めジャンプ力」: 4〜5秒溜めの手動発動のときだけ、飛行中の水平速度へ
   * 追加で掛かる係数。発動時点のルール値で確定し、飛行中は変えない */
  athletic.cjHFactor = ChargeLib.leapHSpeedFactor(t, auto, S && S.ruleConfig ? S.ruleConfig.chargePower : 1);
  athletic.vy = lp.v0;
  athletic.grounded = false; athletic.standId = null; athletic.standLastCenter = null;
  athletic.chargeJumping = true;
  if (r0) { r0.cjAt = performance.now(); r0.cjMult = m; }
  socket.emit('chargejump:fx', { mult: m });
}

/* 重力の適用と衝突解決を1ステップ分行う（stepAthletic から切り出し）。
 * 重力は通常時 20、溜めジャンプの跳躍中は leapParams で決めた cjG を使う
 * （往復0.3秒を保つため。着地できず奈落へ落ちる場合も、通常の重力へ切り替えず
 * 跳躍の重力・速度のまま落下し続ける）。跳躍中は呼び出し側がサブステップ分割する */
function applyGravityCollide(dt, t) {
  const g = athletic.chargeJumping ? (athletic.cjG || 20) : 20;
  athletic.prevFeetY = player.pos.y; // 細長の着地判定（上面を跨いだか）用に直前の足元高さを保持
  if (athletic.chargeJumping) {
    /* 跳躍中は速度Verletで積分する。一定加速度では解析解と一致するため、
     * 頂点高さが leapParams の H ちょうどになり、往復0.3秒も保たれる
     * （通常物理の半陰的オイラーでは頂点が数%低くなってしまう） */
    player.pos.y += athletic.vy * dt - 0.5 * g * dt * dt;
    athletic.vy -= g * dt;
  } else {
    athletic.vy -= g * dt; player.pos.y += athletic.vy * dt;
  }
  /* 衝突解決 */
  athletic.grounded = false; const prevStand = athletic.standId; athletic.standId = null;
  athletic.prevStandId = prevStand; // 細長の支持判定ヒステリシス用（前フレームの接地足場）
  /* 支持対象（standId/standLastCenter）の決定は、位置の押し出しとは切り離し、
   * 「このフレームで接触した中で最も高い上面」を持つ足場を1つだけ選ぶ。
   * 以前は重なった足場すべてが処理順に standId を上書きしていたため、同じ高さの
   * 足場同士が重なる場所（移動足場のすれ違い・隣接配置）で支持対象と追従中心が
   * 入れ替わり続け、移動足場の追従デルタが壊れて「足場にめり込んで沈み、
   * ある瞬間に上面へポップする」動きになっていた（項目4の系統計測で
   * 水平移動上で沈下0.75m→1.035mのポップを実測） */
  let support = null, supportTop = -Infinity, obbTop = -Infinity;
  const cols = colliders(t);
  for (const c of cols) {
    if (c.kind === 'obb') { if (collideLong(c)) obbTop = Math.max(obbTop, player.pos.y); continue; } // 細長はOBB判定（支持したら true が返る）
    // 竹輪も上面は全面が当たり判定（空洞は側面の見た目のみ）なので特別扱いしない
    const hw = c.w / 2, hd = c.d / 2;
    let ew = hw, ed = hd;
    const top = c.cy + c.h / 2, bottom = c.cy - c.h / 2;
    const px = 0.4, pz = 0.4, ph = 1.6;
    const overlapX = player.pos.x + px > c.cx - ew && player.pos.x - px < c.cx + ew;
    const overlapZ = player.pos.z + pz > c.cz - ed && player.pos.z - pz < c.cz + ed;
    const overlapY = player.pos.y + ph > bottom && player.pos.y < top;
    if (overlapX && overlapZ && overlapY) {
      const pushUp = top - player.pos.y, pushDown = (player.pos.y + ph) - bottom;
      const pushLeft = (player.pos.x + px) - (c.cx - ew), pushRight = (c.cx + ew) - (player.pos.x - px);
      const pushBack = (player.pos.z + pz) - (c.cz - ed), pushFwd = (c.cz + ed) - (player.pos.z - pz);
      const min = Math.min(pushUp, pushDown, pushLeft, pushRight, pushBack, pushFwd);
      /* 落下中に足元が上面を跨いだ場合は、最小押し出し軸が横押しでも
       * 「着地」を優先する。高速落下（溜めジャンプ高倍率では降下速度
       * 約240m/s）で足場の端付近に進入すると、横押し量（進入量
       * ≦0.2m）が押し上げ量より小さいために横押しが選ばれ続け、
       * 端に張り付いたまま足場をすり抜けて落下する実測があった。
       * 判定には「直前サブステップの足元」に加え「このステップ開始
       * 時点の足元」も使う（上面を跨ぐサブステップと足場の x 範囲へ
       * 入るサブステップが1つずれる角ケースを拾うため）。ただし
       * 足元が上面より 0.6m 以上下にある場合は対象外（側面からの
       * 進入を上に吸着させない）。「ステップ開始時点の足元が上面
       * 以上」は通常の側面衝突では成立しないため、通常速度の
       * 挙動は変わらない */
      const crossedTop = athletic.vy <= 0.5 && player.pos.y >= top - 0.6 &&
        (athletic.prevFeetY >= top - 0.02 || (athletic.stepStartFeetY !== undefined && athletic.stepStartFeetY >= top - 0.02));
      if ((min === pushUp || crossedTop) && athletic.vy <= 0.5) {
        player.pos.y = top; athletic.vy = 0; athletic.grounded = true;
        if (top >= supportTop) { supportTop = top; support = { id: c.id, center: c.center || { x: c.cx, y: c.cy, z: c.cz } }; }
      }
      else if (min === pushDown) player.pos.y = bottom - ph;
      else if (min === pushLeft) player.pos.x = c.cx - ew - px;
      else if (min === pushRight) player.pos.x = c.cx + ew + px;
      else if (min === pushBack) player.pos.z = c.cz - ed - pz;
      else player.pos.z = c.cz + ed + pz;
    } else if (overlapX && overlapZ && Math.abs(player.pos.y - top) < 0.08 && athletic.vy <= 0) {
      athletic.grounded = true;
      // 接地維持の申告は、既に確定した支持より高い上面のときだけ候補にする
      // （同高の隣接足場に支持を奪われないため）
      if (top > supportTop) { supportTop = top; support = { id: c.id, center: c.center || { x: c.cx, y: c.cy, z: c.cz } }; }
    }
  }
  // 支持の確定: AABB側の最良候補が細長の支持以上に高い場合だけ差し替える
  if (support && supportTop >= obbTop) { athletic.standId = support.id; athletic.standLastCenter = support.center; }
}

function stepAthletic(dt, t) {
  if (!athletic.active) return;
  const locked = t < athletic.goAt;
  if (!athletic.started && !locked) {
    athletic.started = true;
    $('#athletic-banner').classList.add('hidden'); // GOと同時にバナー消去
    if (keysDown.has('Space')) athletic.spaceHeldAtGo = true; // 長押しジャンプ防止
    showCountdown('GO!');
    setTimeout(() => $('#countdown').classList.add('hidden'), 700);
  }
  if (locked) { clearMovementOnly(); }
  /* 平台フォロー */
  if (athletic.standId && athletic.standLastCenter) {
    const pl = S.placed.find(x => x.id === athletic.standId);
    if (pl) {
      const c = platformCurrent(pl, t);
      /* 瞬間移動の検出は3次元距離で行う。以前は水平距離のみだったため、
       * 始点と終点の水平位置がほぼ同じで高さだけ違う「垂直テレポ」では
       * 移動が検出されず、乗員が取り残されずに運ばれてしまっていた */
      const jumpDist = Math.hypot(c.x - athletic.standLastCenter.x, c.y - athletic.standLastCenter.y, c.z - athletic.standLastCenter.z);
      if (pl.type === 'teleport' && jumpDist > 1) {
        // テレポの瞬間移動では乗員を運ばない（項目23）。運搬デルタを加算せず、
        // 足場だけが消えて乗員はその場に取り残され落下する
        athletic.standId = null; athletic.standLastCenter = c;
      } else {
        player.pos.x += c.x - athletic.standLastCenter.x; player.pos.y += c.y - athletic.standLastCenter.y; player.pos.z += c.z - athletic.standLastCenter.z; athletic.standLastCenter = c;
      }
    }
  }
  /* 入力方向（カメラ基準） */
  let ix = 0, iz = 0;
  if (!locked && !typingActive() && !modalOpen() && !capture) {
    if (actionDown('forward')) iz -= 1; if (actionDown('back')) iz += 1;
    if (actionDown('left')) ix -= 1; if (actionDown('right')) ix += 1;
    ix += padState.x; iz += padState.y;
  }
  const len = Math.hypot(ix, iz) || 1; if (len > 1) { ix /= len; iz /= len; }
  const sin = Math.sin(athCam.yaw), cos = Math.cos(athCam.yaw);
  const speed = AIR_SPEED;
  // カメラ前方 F=(-sin,-cos)、カメラ右方 R=(cos,-sin)。前入力(iz=-1)で F 方向へ進むのが正しい。
  // 以前は iz の符号が両成分とも逆で、前後移動だけがカメラと反対になっていた（項目13の原因）。
  const vx = (ix * cos + iz * sin) * speed, vz = (-ix * sin + iz * cos) * speed;
  athletic.moveVx = vx; athletic.moveVz = vz;
  // キャラクターの向きは「自分が出した移動入力の方向」だけで決める（項目21）。
  // 停止しても最後の進行方向を保持し、足場の移動やカメラ操作で向き直らない
  if (Math.hypot(vx, vz) > 0.5) athletic.faceYaw = Math.atan2(vx, vz);
  if (!athletic.chargeJumping) {
    player.pos.x += vx * dt; player.pos.z += vz * dt;
  }
  /* 溜めジャンプの跳躍中は水平移動を下のサブステップループの中で
   * 小刻みに加算する（1ステップ分をまとめて加算すると、ルール
   * 「溜めジャンプ力」3.0倍・倍率約9で水平速度が約150m/s＝1ステップ
   * 約2.5m になり、幅2m程度の足場を支持判定ごと飛び越えてしまうため） */
  /* ノックバック: サーバーから届いた総移動量（kb.x/kb.z は距離込みのベクトル、
   * 大きさ＝総距離 3.2m＝従来の2倍）を、PUNCH_KB_SPEED で消化しきるまで進む */
  if (athletic.kb && athletic.kb.left > 0) {
    const mag = Math.hypot(athletic.kb.x, athletic.kb.z) || 1; // 方向ベクトルの大きさ＝総距離
    const step = Math.min(athletic.kb.left, PUNCH_KB_SPEED * dt);
    player.pos.x += (athletic.kb.x / mag) * step; player.pos.z += (athletic.kb.z / mag) * step;
    athletic.kb.left -= step; if (athletic.kb.left <= 0) athletic.kb = null;
  }
  /* ジャンプ（押した瞬間1回・空中不可）。溜め中・溜めジャンプの跳躍中は実行できない */
  const jDown = (!athletic.spaceHeldAtGo || settings.binds.jump.main !== 'Space') && (actionDown('jump') || gamepadEdge.jump);
  if (!locked && jDown && !athletic.prevJump && athletic.grounded && !athletic.charge && !athletic.chargeJumping && !typingActive() && !modalOpen()) athletic.vy = JUMP_VY;
  athletic.prevJump = jDown;
  /* パンチ（押した瞬間1回・連打可）。Mouse0 は mousedown の punchQueued で拾い、
   * それ以外のキー/ボタン割当は actionDown の立ち上がりエッジで拾う。
   * 以前は Mouse0 以外に割り当てると入力経路自体が存在せず、押しても一切
   * パンチしなかった（キーコンフィグでキーを割り当てた場合の不発の原因） */
  const altHeld = settings.binds.punch.main !== 'Mouse0' && actionDown('punch');
  const pDown = !!athletic.punchQueued || gamepadEdge.punch || (altHeld && !athletic.prevPunchHeld);
  athletic.prevPunchHeld = altHeld;
  athletic.punchQueued = false;
  if (!locked && pDown && !athletic.charge && !athletic.chargeJumping && !typingActive() && !modalOpen()) doPunch(); // 溜め中・溜めジャンプの跳躍中はパンチ不可
  /* 重力と衝突解決（applyGravityCollide に切り出し）。
   * ステップ開始時点の足元高さを控える（着地優先判定 crossedTop 用:
   * 1ステップ内の複数サブステップをまたぐ上面横断を拾うため） */
  athletic.stepStartFeetY = player.pos.y;
  /* ステップ開始時点の接地足場も控える（竹輪の「乗った瞬間」検出用）。
   * prevStandId は applyGravityCollide の呼び出しごとに更新されるため、
   * 溜めジャンプのサブステップ分割では「着地したサブステップの次の
   * 呼び出し」で prevStandId が着地先と同じになってしまい、ステップ
   * 終了時の比較が「変化なし」になって platform:stand が送られなかった。
   * 比較の基準をステップ開始時点に固定すれば、ステップ内のどの
   * サブステップで着地しても「乗った瞬間」を検出できる */
  athletic.stepStartStandId = athletic.standId;
  /* 溜めジャンプの跳躍中は垂直初速が非常に大きい（倍率10で約250m/s）ため、
   * 1フレームの縦移動が足場の厚みを超えてすり抜けてしまう。跳躍中は
   * 縦移動が 0.25m 以下になるようサブステップに分割して積分する。
   * あわせて水平方向も、1ステップの水平移動量が 0.4m を超える場合は
   * 同じサブステップごとに加算し、各小ステップで支持判定を行う
   * （高速時の水平すり抜け対策。通常速度では分割数は従来どおり
   * 縦基準のみで決まり、挙動は変わらない） */
  if (athletic.chargeJumping) {
    /* 跳躍中の水平速度: 「その瞬間の移動キー入力」がそのまま効く。
     * 入力方向（カメラ相対）へ、水平速度＝通常の空中移動速度×倍率×
     * ルール係数 で進み、入力方向が変われば空中でも即座にその方向へ
     * 転換する。入力がない間は水平速度0（旧方式の「発動時点の方向へ
     * 速度維持」は廃止） */
    const hvx = vx * athletic.cjMult * athletic.cjHFactor, hvz = vz * athletic.cjMult * athletic.cjHFactor;
    const hDist = Math.hypot(hvx, hvz) * dt;
    const subN = Math.min(64, Math.max(1, Math.ceil(Math.abs(athletic.vy) * dt / 0.25), Math.ceil(hDist / 0.4)));
    for (let si = 0; si < subN; si++) {
      player.pos.x += hvx * (dt / subN); player.pos.z += hvz * (dt / subN);
      applyGravityCollide(dt / subN, t);
    }
  } else {
    applyGravityCollide(dt, t);
  }
  /* 生存プレイヤー同士の押し合い（項目15）: ゴーストとは衝突しない（観戦者も常時ゴースト・項目4） */
  if (!selfIsGhost()) {
    for (const snap of remoteSnap) {
      if (!snap || snap.id === myId || snap.ghost) continue;
      const dx = player.pos.x - snap.pos.x, dz = player.pos.z - snap.pos.z;
      const dist = Math.hypot(dx, dz), minDist = 0.8;
      if (dist < minDist && Math.abs(player.pos.y - snap.pos.y) < 1.5) {
        const ux = dist > 0.001 ? dx / dist : 1, uz = dist > 0.001 ? dz / dist : 0;
        /* 押し出し先へ1フレームでテレポートさせず、補正量に上限（12m/s）を設ける。
         * 相手の位置はサーバーから100ms周期で届くため階段状に動き、無制限の
         * 補正は自分の位置（＝カメラの注視中心）まで階段状に跳ばしてしまう */
        const step = Math.min(minDist - dist, 12 * dt);
        player.pos.x += ux * step; player.pos.z += uz * step;
      }
    }
  }
  /* 竹輪に「乗った瞬間」を検出してサーバーへ通知する。比較の基準は
   * prevStandId（直前の applyGravityCollide 呼び出し時点）ではなく
   * stepStartStandId（このステップ開始時点）: 溜めジャンプのサブステップ
   * 分割で着地が最終サブステップより前に起きても取りこぼさない。
   * platform:stand の用途はこの竹輪トリガー通知のみ（サーバー側は
   * triggerAt 基準で同一サイクル内の再通知を無視するため、万一の
   * 重複送信も無害） */
  if (athletic.standId && athletic.standId !== athletic.stepStartStandId) {
    const pl = S.placed.find(x => x.id === athletic.standId);
    if (pl && pl.type === 'chikuwa') socket.emit('platform:stand', { platformId: pl.id });
  }
  /* 溜めジャンプの状態遷移（衝突解決の後＝このフレームの接地が確定した状態で判定する）。
   * 開始できるのは「接地していて、その瞬間に新たに押した（押し直した）入力」だけ。
   * chargePrevHeld（前フレームの押下）と chargeSuppress（リセット時点で押されていた
   * 入力を離すまで無効化）の二重の仕組みで、押しっぱなしの持ち越しを一切許さない */
  {
    let chargeHeldNow = chargeInputHeld();
    if (athletic.chargeSuppress) {
      if (!chargeHeldNow) athletic.chargeSuppress = false; // 完全に離したら抑止を解除
      chargeHeldNow = false;
    }
    if (athletic.chargeJumping) {
      // 発動後〜着地まで: 他のアクションは一切受け付けない（上のジャンプ/パンチも遮断済み）
      if (athletic.grounded) { athletic.chargeJumping = false; athletic.cjMult = 1; athletic.cjG = 0; athletic.cjHFactor = 1; }
    } else if (athletic.charge) {
      if (!athletic.grounded) {
        cancelChargeLocal(); // 溜め中に足場を離れて空中に出たら、溜めはキャンセル（発動しない）
      } else {
        /* 溜めの経過時間は「フレーム dt の累積」ではなく、開始時刻からの
         * 実時間差で計測する（performance.now ベース）。以前は dt を
         * 累積していたため、loop の dt クランプ（最大33ms）により
         * 低fps端末では溜めが実時間より遅く進み、20fps では5秒の溜めが
         * 7.5秒かかっていた。物理は固定ステップで進むため、どの fps
         * でも自動発動までの実時間が一致する */
        athletic.charge.t = Math.max(0, (performance.now() - (athletic.charge.startedAt || performance.now())) / 1000);
        if (athletic.charge.t >= ChargeLib.MAX_CHARGE_SEC) {
          launchCharge(true); // 5秒経過で自動発動（倍率は通常ジャンプ程度＝1.0に戻る）
        } else if (!chargeHeldNow) {
          // ホールドを離した → 発動。ただしモーダル表示中などの解放は発動させずキャンセル
          if (!locked && !typingActive() && !modalOpen()) launchCharge(false);
          else cancelChargeLocal();
        }
      }
    } else if (!locked && athletic.started && chargeHeldNow && !athletic.chargePrevHeld && athletic.grounded && !typingActive() && !modalOpen() && !capture) {
      // パンチのモーション中（クールダウン中）は開始できない。その間に押し始めた
      // 入力は chargePrevHeld が立つため、モーションが終わっても持ち越されない
      if (performance.now() - (athletic.lastPunchAt || 0) >= PUNCH_COOLDOWN_MS) startChargeLocal();
    }
    athletic.chargePrevHeld = chargeHeldNow;
  }
  updateChargeGauge(); // 溜め中のみ・ルール「倍率ゲージ」ONのときだけ表示される
  /* 落下 */
  if (player.pos.y < -12 && Date.now() - athletic.fallSentAt > 300) {
    athletic.fallSentAt = Date.now();
    socket.emit('player:fall');
  }
  /* 送信 */
  if (Date.now() - athletic.lastSend > 80) {
    athletic.lastSend = Date.now();
    socket.emit('pos:update', { pos: { x: player.pos.x, y: player.pos.y, z: player.pos.z }, yaw: athletic.faceYaw, moving: Math.abs(vx) + Math.abs(vz) > 0.1, airborne: !athletic.grounded });
  }
  gamepadEdge.jump = false; gamepadEdge.punch = false;
}
function clearMovementOnly() { athletic.vel.set(0, 0, 0); }
function doPunch() {
  // モーション完了までは次のパンチを出せない（項目17: ローカル入力ロック。サーバー側でも検証）
  const nowMs = performance.now();
  if (nowMs - (athletic.lastPunchAt || 0) < PUNCH_COOLDOWN_MS) return;
  athletic.lastPunchAt = nowMs;
  const r0 = remotePlayers.get(myId); if (r0) r0.punchAt = nowMs; // 自分のパンチモーション
  // 対象は「前方の至近」だけ（項目16）。以前は半径2.4m内の最近接を無条件に対象にし、
  // 真横や背後の相手にも当たって見た目より判定が広かった
  let best = null, bestD = PUNCH_RANGE;
  const fx = Math.sin(athletic.faceYaw), fz = Math.cos(athletic.faceYaw);
  for (const [id, r] of remotePlayers.entries()) {
    if (id === myId) continue;
    /* 候補は「参加者である生存者」のみ。観戦者（spectator）は eliminated が
     * false のため以前は候補に入ってしまい、最も近い観戦者が選ばれると
     * サーバー側で対象外として黙って無視され、その背後にいる本物の相手に
     * 当たらなかった（観戦者は生存者の画面に表示されないため原因が見えない）。
     * サーバー側の対象外チェックは最終防衛として維持される */
    const p = S.players.find(x => x.id === id); if (!p || p.eliminated || p.spectator || !p.isParticipant) continue;
    const dx = r.group.position.x - player.pos.x, dz = r.group.position.z - player.pos.z;
    const dy = r.group.position.y - player.pos.y;
    const d = Math.hypot(dx, dz);
    if (d > PUNCH_RANGE || Math.abs(dy) > 1.4) continue;
    if (d > 0.01 && (dx * fx + dz * fz) / d < PUNCH_COS) continue;
    if (d < bestD) { bestD = d; best = id; }
  }
  socket.emit('punch', { targetId: best, yaw: athletic.faceYaw }); // 空振りでも送る（モーションとクールダウンをサーバーと揃える）
}
function showCountdown(txt) {
  const c = $('#countdown'); c.textContent = txt; c.classList.remove('hidden');
  c.classList.remove('slam'); void c.offsetWidth; c.classList.add('slam');
}

/* ============ ゲームパッド（PS4） ============ */
const gamepadEdge = { jump: false, punch: false };
const padState = { x: 0, y: 0 };
let padPrev = [];
/* ゲームパッドを毎フレーム読む。以前はこの処理が「キャラ操作アンロック中」しか
 * 呼ばれない gamepadMove() の中にあり、カメラ回転まで含んでいたため、カウントダウン中は
 * パッドで視点が一切動かなかった（項目12の原因）。
 * カメラはロック中でも常時有効にし、エッジ（ジャンプ/パンチ）だけを GO 後に有効化する */
/* パッド軸の静止位置（ニュートラル）校正の状態。
 * 校正そのものは PadMap.createCalibrator（padmap.js）の
 * 「値が安定してから確定する」方式が担う:
 *  - 初回観測ウィンドウ: 値が 150ms 安定したら静止値として採用する。
 *    最初は軸が未確定（全0）でも、遅れて現れる本来のオフセット
 *    （現実的な大きさのもの）は安定した時点で採用し直される。
 *    以前の「初回観測で即時固定」では全0で固定された後に現れた
 *    ドリフトが校正されず、アスレチック開始と同時にキャラやカメラが
 *    勝手に動き続け、パッドを再接続（＝たまたま良いタイミングで
 *    取り直し）するまで治らなかった。フォーカス復帰直後などの
 *    一過性の値も、安定しなければ採用しない。大きな値への差し替えは
 *    認めない（観測直後に倒したままにされた状態を静止値として
 *    記録しないため。初回観測時点で既に現れている大きなオフセットは
 *    初回採用で無効化される）。
 *  - ドリフト追従（試合中も常時）: 小さな一定値（|値|<=0.5）が
 *    2.5秒安定したら静止値として再校正し、自動で回復する。
 *    大きく倒した入力（全速前進など）は大きさの上限で絶対に採用
 *    されない。さらに「滑らかな移動の痕跡」がある保持エピソード中の
 *    候補は採用対象から外れる: 小さな一定倒しを保持し続ける操作
 *    （傾けた細長の頂点でバランスを取る等）は、人の手で倒した以上
 *    必ず滑らかに移動して到達しているためドリフトと区別でき、
 *    離した後に逆向きの入力が残って勝手に動き出す誤採用が起きない。
 *    本物の静止オフセットは一段のステップとして現れるため、
 *    従来どおり自動回復の対象になる。
 *  - 再接続時: padNeutralStore に保存した確定値を復元して開始し、
 *    初回ウィンドウの採用は行わない（倒したまま再接続しても、
 *    倒した値はドリフト追従の上限規則で採用されない）。
 * padNeutralStore は切断をまたいで padKey ごとに確定値を保持する */
let padCalib = { key: null, calib: null, layout: false, lastT: 0 };
const padNeutralStore = {};
function pollPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads && [...pads].find(p => p && p.connected);
  if (!pad) { padState.x = 0; padState.y = 0; padHeld.chargeJump = false; padCalib = { key: null, calib: null, layout: false, lastT: 0 }; return; }
  const padKey = pad.index + '|' + (pad.id || '');
  if (padCalib.key !== padKey) {
    // 初めて見るパッドは初回ウィンドウ付き、再接続は保存済みの確定値から復元
    padCalib = { key: padKey, calib: PadMap.createCalibrator(padNeutralStore[padKey] || null), layout: false, lastT: performance.now() };
  }
  /* 軸レイアウトの検出（ラッチ式）: DS4生並び環境では右スティックYが
   * index 5 にあり、index 3,4 はトリガー軸（静止時 -1）。署名が一度でも
   * 見えたら、そのパッドではトリガー割り込み型レイアウトとして固定する */
  if (!padCalib.layout && PadMap.isTriggerInterleaved(pad.axes, pad.mapping)) padCalib.layout = true;
  const tNow = performance.now();
  const dtMs = Math.min(250, Math.max(0, tNow - (padCalib.lastT || tNow)));
  padCalib.lastT = tNow;
  const neutral = padCalib.calib.push(pad.axes, dtMs); // 安定性ゲート付き校正（全軸）
  if (padCalib.calib.confirmed()) padNeutralStore[padKey] = neutral.slice(); // 確定値を保存（再接続時の復元用）
  const cax = PadMap.centerAxes(pad.axes, neutral); // 静止オフセットを差し引いた軸（生の並び）
  const sax = PadMap.standardAxes(cax, padCalib.layout); // 標準のスティック順 [LX, LY, RX, RY] に並べ替え
  const ax = settings.swapSticks ? [2, 3, 0, 1] : [0, 1, 2, 3];
  const dz = (v) => { v = Number(v); return Number.isFinite(v) && Math.abs(v) > 0.18 ? v : 0; };
  /* ボタンの押下状態は標準 index に正規化してから読む。
   * DualShock 4 が非標準マッピング（生並び 0=□,1=×,2=○）で届く環境では、
   * 生 index をそのまま使うと ×→○・○→□・□→× とずれてしまう（項目5の原因）。
   * キーコンフィグの割当値（Pad0=×, Pad1=○, ...）は標準 index 前提なので、
   * ここで揃えることで表示・割当・実入力がすべて一致する */
  const stdPressed = PadMap.standardPressed(pad);
  const pressed = (i) => !!stdPressed[i]; // i は標準 index
  padState.x = dz(sax[ax[0]]); padState.y = dz(sax[ax[1]]);
  // カメラ: 右スティック（L1押下中はズーム）。カウントダウン中も有効
  const rx = dz(sax[ax[2]]), ry = dz(sax[ax[3]]);
  if (S && S.phase === 'athletic' && !modalOpen() && !capture) {
    if (pressed(4)) athCam.dist = clamp(athCam.dist + ry * 0.12, 3, 14);
    else if (rx || ry) rotateAthCam(rx * 14, ry * 14);
  }
  // ジャンプ / パンチのエッジは GO 後のみ（カウントダウン中の入力を蓄積させない）
  const jumpIdx = Number(String(settings.padBinds.jump || 'Pad3').slice(3)) || 0;
  const punchIdx = Number(String(settings.padBinds.punch || 'Pad2').slice(3)) || 0;
  const chargeIdx = Number(String(settings.padBinds.chargeJump || 'Pad0').slice(3)) || 0;
  padHeld.chargeJump = pressed(chargeIdx); // 溜めジャンプはホールド判定（毎フレーム現在の押下を反映）
  if (athletic.started) {
    if (pressed(jumpIdx) && !padPrev[jumpIdx]) gamepadEdge.jump = true;
    if (pressed(punchIdx) && !padPrev[punchIdx]) gamepadEdge.punch = true;
  }
  padPrev = pad.buttons.map((_, i) => pressed(i));
  // キーコンフィグのパッド割当待ち中: 押された物理ボタンを標準 index の割当として記録する
  if (capture && capture.device === 'pad') {
    for (let i = 0; i < pad.buttons.length; i++) {
      const b = pad.buttons[i];
      if (b && (b.pressed || b.value > 0.5) && !capture.main) { capture.main = 'Pad' + PadMap.standardButtonIndex(i, pad.mapping); capture.mods = new Set(); finishCapture(); break; }
    }
  }
}
/* キーコンフィグのパッド割当待ちを常時ポーリングする（ロビー表示中でもボタンを拾えるように） */
let padCapturePrev = [];
setInterval(() => {
  if (!capture || capture.device !== 'pad') { padCapturePrev = []; return; }
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads && [...pads].find(p => p && p.connected);
  if (!pad) return;
  const rawPressed = (i) => { const b = pad.buttons[i]; return b && (b.pressed || b.value > 0.5); };
  for (let i = 0; i < pad.buttons.length; i++) {
    // 押された物理ボタン（生 index）を標準 index の割当に変換して記録する（項目5）
    if (rawPressed(i) && !padCapturePrev[i]) { capture.main = 'Pad' + PadMap.standardButtonIndex(i, pad.mapping); capture.mods = new Set(); finishCapture(); break; }
  }
  padCapturePrev = pad.buttons.map((_, i) => rawPressed(i));
}, 60);

/* ============ メインループ ============ */
let lastFrame = performance.now();
let lastCountShown = null;
function loop(t) {
  requestAnimationFrame(loop);
  if (!renderer || !S) return;
  /* rawDt はクランプしない実フレーム間隔。表示系（アニメーション・
   * カメラ平滑）は従来どおり dt（最大33msでクランプ）を使うが、
   * アスレチックのローカル物理は rawDt を蓄積して固定ステップで進める
   * ため、低fps端末でも移動・重力・溜めが実時間どおりに進む */
  const rawDt = Math.max(0, Math.min(0.25, (t - lastFrame) / 1000 || 0.016));
  const dt = Math.min(0.033, (t - lastFrame) / 1000 || 0.016); lastFrame = t;
  resize();
  pollPad(); // パッドのカメラ・移動軸は毎フレーム取得（カウントダウン中もカメラだけは効かせる・項目12）
  // 視点角の自己復旧ガード: 異常値が入っていたら既定へ戻す
  if (!Number.isFinite(athCam.pitch)) athCam.pitch = 0.32;
  if (!Number.isFinite(athCam.yaw)) athCam.yaw = 0;
  /* 注: ここにあったピッチのウォッチドッグ（入力が蓄積してもピッチが変化しない
   * 場合に 0.32 へ戻す処理）は廃止した。系統計測（項目4）で、視点を上下に
   * 往復させて開始ピッチ付近へ戻す正常な操作を「ピッチが変化していない」と
   * 誤判定し、操作の途中でピッチを 0.32 へ跳ばす誤発が実測されたため。
   * ガードは NaN チェックのみで十分（rotateAthCam 側の注記参照） */
  const nowMs = serverNow();
  updateShatters(dt);
  updateGuardHover(t);
  /* 足場メッシュの現在位置 */
  if (S) for (const pl of S.placed) {
    const m = platformMeshes.get(pl.id); if (!m) continue;
    const c = platformCurrent(pl, nowMs);
    m.position.set(c.x, c.y, c.z);
    if (pl.type === 'chikuwa') {
      const src = S.placed.find(x => x.id === pl.id);
      if (src && src.chikuwaTriggerAt) { const d = (nowMs - src.chikuwaTriggerAt) / 1000; if (d > 1.7 && d < 2) m.position.x += Math.sin(t * 0.09) * 0.05; }
    }
    if (pl.type === 'teleport' && pl.end) {
      const ph = ((nowMs - pl.placedAt) % 3000) / 1000;
      m.material.opacity = ph > 2 ? Math.max(0.1, 1 - (ph - 2)) : 1; m.material.transparent = true;
    }
    if (pl.type === 'wheel' && pl.rot) {}
  }
  updatePlacementMouse();
  if (placement.selected) updateGhostThrottled();
  /* プレイヤー表示 */
  ensurePlayerMeshes();
  const myGhost = selfIsGhost(); // 脱落者と観戦者（常時ゴースト）は他のゴーストが見える（項目4）
  for (const [id, r] of remotePlayers.entries()) {
    const pub = S.players.find(x => x.id === id); if (!pub) continue;
    const snap = id === myId ? null : remoteSnap.find(s => s.id === id);
    const ghost = !!pub.eliminated || !!(snap && snap.ghost) || !!pub.spectator; // 公開状態とスナップショットの両方から判定（項目14）。観戦者は常時ゴースト（項目4）
    // ゴーストの可視性ルールはネームプレートにも適用される（グループごと表示/非表示）
    r.group.visible = id === myId ? true : (myGhost ? true : !ghost);
    if (r.ghostApplied !== ghost) {
      r.ghostApplied = ghost;
      r.group.traverse(ch => { if (ch.material) { ch.material.transparent = true; ch.material.opacity = ghost ? 0.45 : 1; } });
    }
    if (id === myId) {
      r.group.position.copy(player.pos);
      r.group.rotation.y = athletic.faceYaw; // 自分の向きは入力方向で確定（項目21）
      // アスレチック中だけ歩行モーションを出す。結果画面などでは速度残量があっても再生しない（項目10）
      r.intentSpeed = (S.phase === 'athletic' && !athletic.chargeJumping) ? Math.hypot(athletic.moveVx || 0, athletic.moveVz || 0) : 0; // 溜めジャンプの跳躍中は歩行モーションを出さない。足場の運搬は含めない（項目22）
    } else {
      /* 他プレイヤーはスナップショット補間で描画する（remoteinterp.js）:
       * 「サーバー現在時刻 − 補間遅延(120ms)」の位置を前後スナップ
       * ショットから線形補間で求める。等速で直進する相手はフレーム間
       * 移動量が一定になり、以前の「最新位置へ lerp で寄せる」方式
       * （スナップショット到着直後に大きく進み、その後止まる脈動）が
       * 消える。履歴が枯渇した場合は直近2点の速度で最大250msまで外挿し、
       * それを超えたら上限位置に留まる。
       * バッファが無い/空の場合、または検証用の無効化フラグ
       * （__awInterpOff）が立っている場合は従来方式へフォールバックする */
      const buf = remoteInterpBuffers.get(id);
      const ipos = (!window.__awInterpOff && buf) ? buf.sample(serverNow() - RemoteInterp.INTERP_DELAY_MS) : null;
      if (ipos) {
        r.group.position.set(ipos.x, ipos.y, ipos.z);
        r.target.copy(r.group.position);
        r.serverMoving = ipos.moving;
      } else if (snap) {
        r.target.set(snap.pos.x, snap.pos.y, snap.pos.z); r.serverMoving = snap.moving;
        r.group.position.lerp(r.target, 0.35);
      }
      if (snap && Number.isFinite(snap.yaw)) { // 相手の向きはサーバー同期の yaw（本人の入力方向）を使う
        let diff = snap.yaw - r.group.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
        r.group.rotation.y += diff * 0.35;
      }
      r.intentSpeed = (S.phase === 'athletic' && r.serverMoving) ? 4.2 : 0; // 相手自身の移動入力があった場合だけ歩行扱い（結果画面では常に0・項目10）
    }
    if (r.group.visible) animatePlayer(r, dt, t);
    else r.prevPos.copy(r.group.position);
  }
  /* フェーズ別カメラ・物理 */
  if (S.phase === 'athletic' || S.phase === 'result') {
    if (S.phase === 'athletic' && !athletic.active && S.goAt) startAthleticClient();
    /* ローカル物理は固定ステップ（1/60秒）のサブステップで進める:
     * 実経過時間（rawDt）を蓄積し、1/60 刻みで必要な回数だけ
     * stepAthletic を呼ぶ。以前は1フレームに1回だけ dt（最大33msで
     * クランプ）で進めていたため、30fps 未満では物理が実時間より
     * 遅れていた（20fps では 0.66 倍速）。1フレームの最大ステップ数は
     * PHYS_MAX_STEPS（5）で、蓄積が上限を超えた分は切り捨てる
     * （約12fps 未満では緩やかにスローになるが、スパイラルには入らない）。
     * ロック判定・カウントダウンはサーバー時刻で進める */
    physAcc = Math.min(physAcc + rawDt, PHYS_STEP * PHYS_MAX_STEPS);
    while (physAcc >= PHYS_STEP) { selfPrevStepPos.copy(player.pos); stepAthletic(PHYS_STEP, serverNow()); physAcc -= PHYS_STEP; }
    selfCurrStepPos.copy(player.pos);
    /* 自キャラの描画位置: 物理境界の間を蓄積残り時間の割合で補間する
     * （render interpolation）。物理（player.pos の進行・入力応答）は
     * 従来どおり固定ステップのまま変えず、メッシュとカメラの基準点
     * だけを滑らかにする。これにより表示fps と 60Hz ステップの干渉で
     * 生じていた「止まる→跳ぶ」の震え（ジャダー）が消える */
    selfRenderPos.lerpVectors(selfPrevStepPos, selfCurrStepPos, physAcc / PHYS_STEP);
    { const selfR = remotePlayers.get(myId); if (selfR) selfR.group.position.copy(selfRenderPos); }
    // カウントダウン表示（発表が終わる残り3秒から数字を出す）
    if (athletic.active && !athletic.started) {
      const remain = Math.ceil((athletic.goAt - serverNow()) / 1000);
      if (remain >= 1 && remain <= 3 && lastCountShown !== remain) { lastCountShown = remain; showCountdown(String(remain)); }
    }
    /* カメラは「プレイヤー位置＋視点入力（yaw/pitch/dist）」だけで決める（項目2）。
     * 足場や島による干渉（障害物での距離・高さ変更、レイキャスト）は存在しない。
     * かつて視点が引っ掛かった原因は次の2点で、いずれも除去した:
     * (a) カメラ高さの下限 Math.max(cy, 0.5): 見上げ帯域（スタート島上では pitch < 約-0.25）で
     *     カメラ位置が凍結し、lookAt 側だけが動き続けて視線ピッチが逆行していた
     *     （実測: pitch -0.38→-0.9 の間で viewPitch が +0.148→+0.024 と戻った）。
     *     → 下限に当たる場合は高さを凍結せず「距離を縮める（プルイン）」ことで連続に応答させる
     * (b) 垂直スタビライザーが 0.08/frame 固定で、足場の上り下り後にカメラ高さが
     *     長く尾を引いた。→ dt 基準の指数平滑にし、接地中は速く・空中は緩やかに追従させる */
    const targetY = selfRenderPos.y + 1.0;
    if (settings.sickness) {
      const rate = athletic.grounded ? 14 : 5; // 1秒あたりの追従率（接地中は残留を短く）
      athCam.smoothY += (targetY - athCam.smoothY) * (1 - Math.exp(-rate * dt));
      if (!Number.isFinite(athCam.smoothY)) athCam.smoothY = targetY;
    } else {
      /* 酔い防止OFF時も、プレイヤーYの1フレーム段差（段差への乗り上げ・着地の
       * スナップ等）がそのままカメラに伝わらないよう、速い指数平滑だけは常時
       * かける（追従率30/s＝ほぼ直接だが、段差は数フレームに分散される） */
      athCam.smoothY += (targetY - athCam.smoothY) * (1 - Math.exp(-30 * dt));
      if (!Number.isFinite(athCam.smoothY)) athCam.smoothY = targetY;
    }
    const sinP = Math.sin(athCam.pitch), cosP = Math.cos(athCam.pitch);
    let dEff = athCam.dist;
    const CAM_FLOOR_Y = 0.4; // カメラが潜ってはいけない高さ（島上面 y=1 より下の虚空側）
    if (sinP < 0) { const maxD = (athCam.smoothY - CAM_FLOOR_Y) / -sinP; if (maxD < dEff) dEff = Math.max(1.2, maxD); }
    const cx = selfRenderPos.x + Math.sin(athCam.yaw) * cosP * dEff;
    const cz = selfRenderPos.z + Math.cos(athCam.yaw) * cosP * dEff;
    const cy = athCam.smoothY + sinP * dEff;
    cam.position.set(cx, cy, cz);
    // 注視点はカメラ軌道の中心（＝平滑化したプレイヤー高さ）に統一する。
    // 以前は注視点に sin(pitch)*dist*0.3 を加え、視線ピッチが入力ピッチの約0.7倍に
    // 非線形圧縮されていた（実測: pitch 0.82 に対し viewPitch -0.64）
    cam.lookAt(selfRenderPos.x, athCam.smoothY, selfRenderPos.z);
    const vig = $('#vignette'); if (vig && settings.sickness) vig.style.opacity = (Math.abs(athCam.yawVel || 0) > 0.01) ? 0.7 : 0.25;
  } else {
    athletic.active = false; lastCountShown = null;
    const cx = Math.sin(placeCam.yaw) * Math.cos(placeCam.pitch) * placeCam.dist;
    const cz = Math.cos(placeCam.yaw) * Math.cos(placeCam.pitch) * placeCam.dist;
    const cy = Math.sin(placeCam.pitch) * placeCam.dist;
    cam.position.set(cx, cy + 2, cz); cam.lookAt(0, 1, 0);
  }
  renderer.render(scene, cam);
}
let ghostThrottle = 0;
function updateGhostThrottled() { const n = performance.now(); if (n - ghostThrottle > 60) { ghostThrottle = n; updateGhostPositionOnly(); } }
function updateGhostPositionOnly() {
  if (!placement.ghost || !placement.mouseWorld) return;
  const base = placement.anchor || placement.mouseWorld;
  placement.ghost.position.set(base.x, base.y, base.z);
  if (placement.selected === 'wheel') { const wp = WheelPhase.wheelPosAt(base, serverNow(), placement.wheelPhase); placement.ghost.position.set(wp.x, wp.y, wp.z); }
  if (placement.ghostEnd && placement.anchor) {
    const end = placement.endPt || (placement.selected === 'slide' ? slideEnd(placement.anchor, placement.mouseWorld) : placement.mouseWorld);
    placement.ghostEnd.position.set(end.x, end.y, end.z);
  }
  if (placement.ghost && placement.selected === 'long' && placement.anchor) {
    if (placement.rotQ) placement.ghost.quaternion.copy(placement.rotQ);
    else placement.ghost.rotation.set(placement.rot.x || 0, placement.rot.y || 0, placement.rot.z || 0);
  }
  applyGhostValidity(); // 配置制限に触れる位置ではゴーストを赤くする
}
/* 配置ゴーストの生成（選択時のみ） */
const _origRenderHand = renderHand;
setInterval(() => { if (S && S.phase === 'place' && placement.selected && scene && !placement.ghost) updateGhost(); if (S && (!S.phase || S.phase !== 'place') && placement.ghost) { scene.remove(placement.ghost); disposeObject3D(placement.ghost); placement.ghost = null; } }, 300);
