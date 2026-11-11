'use strict';
/* アスレチック人狼 サーバー
 * 単一ルーム制。フェーズ遷移・役職・手札・投票・守護/破壊・勝敗判定はすべてサーバーが管理する。
 */
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WheelPhase = require('./public/js/wheelphase.js'); // 観覧車の回転位相（クライアントと共通の純粋関数）

/* 最終防衛: 予期しない例外でプロセス全体が落ちて全員切断になることを防ぐ。
 * 個別ハンドラ側の try/catch（接続処理の on ラッパー）が本線で、こちらは
 * タイマー等の非同期経路で漏れた例外をログに残して継続するためのもの */
process.on('uncaughtException', (e) => { console.error('[aw] uncaughtException (継続します):', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[aw] unhandledRejection (継続します):', e && e.stack || e); });

const app = express();
const server = http.createServer(app);
const io = new Server(server);
/* 静的ファイルは毎回再検証させる（no-cache）。ZIP を差し替えて更新する運用のため、
 * ブラウザに古い client.js がキャッシュから残ると、新しいサーバーと古い
 * クライアントが混ざって検証挙動などが食い違う事故になる（ルール設定モーダルで
 * 「サーバーは警告を返すのにクライアントは無検証で閉じてしまう」症状の原因）。
 * ETag による再検証だけなので、ローカル配信では実質コストはない */
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const PORT = process.env.PORT || 3000;

/* ============ 定数 ============ */
const PALETTE = [
  { name: 'ブルー', hex: '#3b82f6' }, { name: 'レッド', hex: '#ef4444' },
  { name: 'グリーン', hex: '#22c55e' }, { name: 'オレンジ', hex: '#f97316' },
  { name: 'パープル', hex: '#a855f7' }, { name: 'シアン', hex: '#06b6d4' },
  { name: 'イエロー', hex: '#eab308' }, { name: 'ピンク', hex: '#ec4899' },
  { name: 'ミント', hex: '#2dd4a7' }, { name: 'シルバー', hex: '#c0c6ce' },
];
// 仕様19.6 役職範囲 [knight, madman, wolf]
const ROLE_RANGES = {
  3: { knight: [0, 2], madman: [0, 0], wolf: [1, 1] },
  4: { knight: [0, 3], madman: [0, 0], wolf: [1, 1] },
  5: { knight: [0, 4], madman: [0, 1], wolf: [1, 2] },
  6: { knight: [0, 5], madman: [0, 1], wolf: [1, 2] },
  7: { knight: [0, 6], madman: [0, 2], wolf: [1, 3] },
  8: { knight: [0, 7], madman: [0, 2], wolf: [1, 3] },
  9: { knight: [0, 8], madman: [0, 3], wolf: [1, 4] },
  10: { knight: [0, 9], madman: [0, 3], wolf: [1, 4] },
};
// 仕様11 山札構成
const DECK_TABLE = {
  12: { stable: 2, island: 1, chikuwa: 3, slide: 2, wheel: 2, long: 1, teleport: 1 },
  14: { stable: 3, island: 1, chikuwa: 3, slide: 2, wheel: 2, long: 2, teleport: 1 },
  15: { stable: 3, island: 1, chikuwa: 3, slide: 2, wheel: 2, long: 2, teleport: 2 },
  16: { stable: 3, island: 1, chikuwa: 4, slide: 2, wheel: 2, long: 2, teleport: 2 },
  18: { stable: 4, island: 1, chikuwa: 4, slide: 3, wheel: 2, long: 2, teleport: 2 },
  20: { stable: 4, island: 1, chikuwa: 4, slide: 3, wheel: 3, long: 3, teleport: 2 },
  21: { stable: 4, island: 1, chikuwa: 4, slide: 3, wheel: 3, long: 3, teleport: 3 },
};
const START_POS = { x: -30, y: 1, z: 0 };
const GOAL_POS = { x: 30, y: 1, z: 0 };
const FALL_Y = -12;
const PLACE_TOTAL = 10;
const COUNTDOWN_LEAD_MS = 4700; // 脱落者発表(約1.7秒)＋カウントダウン3秒
const VOTE_RESULT_PANEL_MS = 8000; // 投票結果パネルの表示時間（通常ケース）
const VOTE_RESULT_PANEL_SHORT_MS = 4000; // 投票結果パネルの表示時間（投票結果直後にアスレチックへ入るケースのみ短縮）
const PUNCH_RANGE = 1.35; // 拳の届く中心間距離（見た目に合わせて狭め）
const PUNCH_COS = 0.5; // 前方±60度以内でのみ命中
const PUNCH_MAX_DY = 1.4;
const PUNCH_COOLDOWN_MS = 420; // パンチモーション全長と一致（クライアント側の連打間隔もこの値）
/* サーバー側のパンチ受理クールダウンは、クライアントの送信間隔（420ms）より
 * 意図的に短くする。両者が同じ 420ms だと、ネットワークの到着ジッタで
 * 間隔が 419ms 等に縮んだ正規の連打がサーバーで黙って捨てられてしまう
 * （モーションは出ているのに punch:fx も命中判定も発生しない）。
 * 370ms なら到着間隔 390ms 程度の連打は受理され、露骨な早連打
 * （370ms 未満）は従来どおり弾ける */
const PUNCH_SERVER_COOLDOWN_MS = 370;
const PUNCH_KB_SPEED = 18; // ノックバック初速（水平成分。従来9の2倍＝水平移動距離も約2倍）
const PUNCH_KB_DIST = 3.2; // ノックバックの水平移動距離（キャラ幅0.8の4体分。従来1.6mの2倍）
const PUNCH_LAG_MS = 240; // パンチ判定のラグ補償: 被弾側の直近240ms以内の位置履歴でも判定する
const POS_HISTORY_MS = 600; // 位置履歴の保持期間（ラグ補償用）
const DUMMY_DESTROY_MIN_MS = 3000, DUMMY_DESTROY_MAX_MS = 10000; // 人狼全員脱落時のダミー破壊選択時間（3〜10秒ランダム）
/* 配置制限: スタート/ゴール島の真上・低空には置けない（スポーン直後の
 * キャラクターと干渉して押し出し・ジッターの原因になるため）。
 * 足場の底面が島上面+2.2m（キャラクター身長+余裕）より低い位置にあり、
 * かつ XZ フットプリントが島の範囲と重なる配置を禁止する */
const ISLAND_HALF = 5, ISLAND_TOP = START_POS.y, PLACE_CLEARANCE = 2.2;
const PLAYER_RADIUS = 0.4;
const SLIDE_DIST = 8;

/* ============ 状態 ============ */
const players = new Map(); // sessionId -> player
let joinSeq = 0;
let hostId = null;
let ruleConfig = { knight: 0, madman: 0, wolf: 1, timeMin: 5, botCount: 0, gauge: false, chargePower: 1.0 }; // 初期値=各範囲の最低人数／制限時間は初期5分(1〜10分スライダー)／BOT人数は初期0／倍率ゲージは初期OFF／溜めジャンプ力は初期1.0倍
let phase = 'lobby'; // lobby | role | place | vote | guard | destroy | athletic | result
let participants = []; // sessionId[]
let placed = []; // {id, type, pos, end, rot, ownerId, ownerColor, placedAt}
let placedSeq = 0;
let turnOrder = [], turnIdx = 0;
let votes = new Map(); // voterId -> [targetIds]
let voteSession = null; // { kind: 'trigger'|'final', triggererId, seq } 投票イベント進行中（内部フェーズは place のまま）
let voteSeq = 0; // 投票セッションの識別子（セッションごとに増加。連続セッションでもクライアントが選択状態をリセットできるように）
let lastVoteEliminated = []; // 直近の投票セッションで脱落したプレイヤーID（アスレチック開始時の発表用）
let lastVoteResultAt = 0; // 直近の投票結果（vote:result）を送ったサーバー時刻。結果パネルが閉じるまで発表/カウントダウンを始めない判定に使う
let lastVoteDirect = false; // 直近の投票が「そのまま守護/破壊→アスレチックへ進む」最終投票だったか（解決時点で記録。ダミー破壊等で時間が空いてもパネル短縮の判定がぶれないように）
let votePanelCloseAt = 0; // 現在の投票結果パネルが閉じるサーバー時刻（通常は結果+8秒。結果直後にアスレチックへ入るケースでは結果+4秒に短縮される）。公開状態経由で全クライアントに伝える
let presentAt = 0; // アスレチックの発表・カウントダウン演出を開始するサーバー時刻（startAthletic で決定し全クライアント共通）
let guardQueue = [], guardedIds = new Set(), guardCurrent = null;
let destroyerId = null, destroyDone = false;
let result = null; // {winner:'villager'|'wolf'|null, reason, at}
let goAt = 0, athleticEndsAt = 0, athleticTimer = null;
let botSeq = 0;
const chikuwaState = new Map(); // platformId -> triggerAt(ms)
/* フェーズ遷移を伴う遅延タイマーのハンドル。endGame で必ず破棄し、
 * 「強制終了したのに遅れてアスレチックが始まる」ような復活を防ぐ */
let athleticStartTimer = null, dummyDestroyTimer = null, dummyGuardTimer = null, roleTimer = null;
let pubSeq = 0;

/* ============ 公開ID（F） ============
 * 内部ID（sessionId）は再接続のための本人確認情報であり秘匿する。
 * クライアントへ配信する識別子は、推測・再利用できないランダムな
 * 公開ID（pub）に分離する。sessionId を知っても他人の公開IDからは
 * 逆引きできず、公開IDで join しても他人の席には入れない */
function newPub() {
  let pub;
  do { pub = 'pub-' + Math.random().toString(36).slice(2, 10) + (pubSeq++).toString(36); } while ([...players.values()].some(p => p.pub === pub));
  return pub;
}
function playerByPub(pub) {
  if (!pub) return null;
  for (const p of players.values()) if (p.pub === pub) return p;
  return null;
}
const pubOf = (internalId) => { const p = internalId ? players.get(internalId) : null; return p ? p.pub : null; };

const now = () => Date.now();
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };
const enteredPlayers = () => [...players.values()].filter(p => p.entered && !p.inResult).sort((a, b) => a.joinOrder - b.joinOrder);
const connectedPlayers = () => [...players.values()].filter(p => p.connected).sort((a, b) => a.joinOrder - b.joinOrder);
const wolfCampCount = () => ruleConfig.wolf + ruleConfig.madman;
const campLimit = (n) => Math.ceil(n / 2) - 1; // 半数未満の最大値

/* ルール設定「溜めジャンプ力」の正規化（純粋関数）:
 * 0.5〜3.0 にクランプし、0.1刻みに丸める。数値として解釈できない場合は null */
function clampChargePower(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(3, Math.max(0.5, n)) * 10) / 10;
}

function validateRules(n, cfg) {
  const r = ROLE_RANGES[n];
  if (!r) return `参加人数 ${n} 人では開始できません（3〜10人）`;
  for (const k of ['knight', 'madman', 'wolf']) {
    if (cfg[k] < r[k][0] || cfg[k] > r[k][1]) return `${{ knight: '騎士', madman: '狂人', wolf: '人狼' }[k]}は ${r[k][0]}〜${r[k][1]} 人の範囲で設定してください`;
  }
  if (cfg.knight + cfg.madman + cfg.wolf > n) return `役職の合計（${cfg.knight + cfg.madman + cfg.wolf}人）が参加人数（${n}人）を超えています`;
  if (cfg.wolf + cfg.madman > campLimit(n)) return `人狼陣営（人狼+狂人）は参加人数の半数未満までです（${n}人の場合は最大${campLimit(n)}人）`;
  return null;
}
function handCount(n, wolfCamp) {
  if (n === 3) return 5;
  if (n === 4) return 4;
  if (n === 5) return wolfCamp >= 2 ? 4 : 3;
  if (n === 6) return wolfCamp >= 2 ? 3 : 2;
  if (n === 7) return wolfCamp >= 3 ? 3 : 2;
  return 2;
}
function toast(to, msg, type = 'warn') {
  if (to === 'all') io.emit('toast', { msg, type });
  else { const p = players.get(to); if (p && p.socketId) io.to(p.socketId).emit('toast', { msg, type }); }
}

/* ============ ホスト管理 ============ */
function reassignHost(excludeId) {
  // BOTにはホスト権を移譲しない（候補から完全に除外）。人間の候補がいなければホスト不在とする
  const cands = connectedPlayers().filter(p => p.id !== excludeId && !p.isBot);
  if (!cands.length) { hostId = null; return; }
  const entered = cands.filter(p => p.entered);
  hostId = (entered[0] || cands[0]).id; // エントリー中優先→接続順（仕様18.4.1）
}

/* ============ 公開状態 ============ */
function publicState() {
  return {
    phase: voteSession ? 'vote' : phase, // 投票イベント中はクライアントには vote フェーズとして見せる
    serverTime: now(),
    hostId: pubOf(hostId), // 公開IDで配信（内部ID=sessionId は配信しない）
    ruleConfig,
    entryCount: enteredPlayers().length,
    players: [...players.values()].sort((a, b) => a.joinOrder - b.joinOrder).map(p => ({
      id: p.pub, name: p.name, color: PALETTE[p.colorIdx], entered: p.entered, connected: p.connected,
      isHost: p.id === hostId, isBot: !!p.isBot, inResult: !!p.inResult, spectator: !!p.spectator,
      handCount: p.hand ? p.hand.length : 0,
      eliminated: !!p.eliminated,
      isParticipant: participants.includes(p.id),
    })),
    placed: placed.map(pl => ({ ...pl, ownerId: pubOf(pl.ownerId), chikuwaTriggerAt: chikuwaState.get(pl.id) || null })),
    turnId: (phase === 'place' && !voteSession && turnOrder.length) ? pubOf(turnOrder[turnIdx % turnOrder.length]) : null,
    placedCount: placed.length,
    voteSession: voteSession ? { kind: voteSession.kind, triggererId: pubOf(voteSession.triggererId), seq: voteSession.seq } : null,
    announceEliminated: phase === 'athletic' ? lastVoteEliminated.map(id => pubOf(id)).filter(Boolean) : [],
    goAt, presentAt, athleticEndsAt, votePanelCloseAt,
    result: result ? { winner: result.winner, reason: result.reason } : null,
    resultDetail: phase === 'result' ? participants.map(id => { const p = players.get(id); return p ? { id: p.pub, name: p.name, color: PALETTE[p.colorIdx], role: p.role, camp: p.camp, eliminated: !!p.eliminated } : null; }).filter(Boolean) : null,
    /* 守護/破壊の「現在の担当者」は本人にだけ player:private で伝える。
     * 以前は guardPhase.currentKnight / destroyPhase.destroyerId として
     * 全員に配信されており、担当の騎士・人狼が誰でも読めてしまった */
    guardPhase: null,
    destroyPhase: null,
  };
}
function sendPrivate(p) {
  if (!p || !p.socketId) return;
  const allies = (p.role === 'wolf') ? participants.filter(id => id !== p.id && players.get(id) && players.get(id).role === 'wolf').map(id => pubOf(id)).filter(Boolean) : [];
  io.to(p.socketId).emit('player:private', {
    id: p.pub, // 自分の公開ID（クライアント側の自他識別はすべて公開IDで統一する）
    role: p.role || null, camp: p.camp || null, hand: p.hand || [],
    wolfAllies: allies,
    voteNeed: 1, // 投票は1人1票制（人狼陣営の人数によらず常に1人だけ選ぶ）
    canPass: canPass(p),
    myTurn: phase === 'place' && turnOrder.length && turnOrder[turnIdx % turnOrder.length] === p.id,
    isGuardTurn: phase === 'guard' && guardCurrent === p.id,
    isDestroyer: phase === 'destroy' && destroyerId === p.id,
    hasVoted: votes.has(p.id),
    eliminated: !!p.eliminated,
    voteTriggerUsed: !!p.voteTriggerUsed, // 投票イベントは1ゲーム1人1回まで
    inVoteSession: !!voteSession,
    pos: p.pos,
  });
}
function syncAll() { io.emit('state:sync', publicState()); for (const p of players.values()) sendPrivate(p); }

/* ============ 配置フェーズ ============ */
function canPass(p) {
  if (!p) return false;
  return !p.passLocked; // 自分がパスした後に全員がパスして戻ってきた場合のみ true で保持される
}
function currentTurnPlayer() { return turnOrder.length ? players.get(turnOrder[turnIdx % turnOrder.length]) : null; }
function advanceTurn() {
  if (phase !== 'place' || voteSession) return;
  let guard = 0;
  while (guard++ < 50) {
    turnIdx++;
    const p = currentTurnPlayer();
    if (!p) break;
    if (p.eliminated) continue; // 脱落者の手番はスキップ
    if (!p.connected && !p.isBot) continue; // 切断者はスキップ
    if (!p.hand || p.hand.length === 0) { // 手札切れは自動パス
      if (allHandsEmpty()) { finishPlacement(); return; }
      continue;
    }
    break;
  }
  syncAll();
  maybeBotTurn();
}
function allHandsEmpty() { return participants.every(id => { const p = players.get(id); return !p || !p.hand || p.hand.length === 0; }); }
function finishPlacement() {
  // 設置数が合計10個に到達 → 従来どおり投票イベント（最終投票）を発生させる
  startVoteSession('final', null);
}

/* ============ 投票イベント（新ルール） ============ */
// 投票は「パンチ禁止対象の決定」ではなく「脱落者の決定」に変わった。
// 配置フェーズ中、自分の手番のプレイヤーが「投票」ボタンで1ゲーム1回まで発生させられる（trigger）。
// 設置数が10個に到達したときの最終投票（final）も同じ仕組みで処理する。
// 選ばれたプレイヤーは即脱落し、その足場は全て破壊（粉砕演出つき）→カードに戻して
// 手札と合算し、他の未脱落プレイヤーへ均等寄りに再配分する。設置数はその分減り、
// 10個未満なら配置フェーズが続く。
/* 配置フェーズ用: 村人陣営の参加者が全員「ゴースト状態」かどうか。
 * ゴースト状態 = 脱落（eliminated）している、または切断中で不在の人間プレイヤー。
 * 従来は投票の集計直後（resolveVoteSession）でしかこの条件を見ておらず、
 * 配置フェーズ中に切断で最後の村人が落ちても（切断は脱落扱いになるのに）
 * ゲームが続いてしまう穴があった。切断・再接続・配置開始などの
 * あらゆる状態変化点から、現在の状態で判定できるよう共通化する */
function villagerCampAllGhosts() {
  if (!participants.length) return false;
  const villagers = participants.map(id => players.get(id)).filter(p => p && p.camp === 'villager');
  if (!villagers.length) return false;
  return villagers.every(p => p.eliminated || (!p.connected && !p.isBot));
}
function endGameIfVillagerCampWipedOut(reason) {
  if (phase !== 'place') return false; // 対象は配置フェーズ（とその中の投票イベント）のみ
  if (!villagerCampAllGhosts()) return false;
  syncAll();
  endGame('wolf', reason, now());
  return true;
}
function activeParticipants() { return participants.map(id => players.get(id)).filter(p => p && !p.eliminated); }
/* カードの再配分: 受取順をシャッフルしてから round-robin する。
 * 以前は受取人が参加順（joinOrder）で固定だったため、プール枚数が
 * 割り切れないときの余りが常に先頭側のプレイヤーへ偏っていた */
function distributeCards(pool, recipients) {
  if (!pool || !pool.length || !recipients || !recipients.length) return;
  const cards = shuffle(pool);
  const order = shuffle(recipients);
  cards.forEach((card, i) => { const r = order[i % order.length]; r.hand = r.hand || []; r.hand.push(card); });
}
/* 脱落者の後処理（投票脱落と切断脱落で共通のパイプライン）:
 * 本人の足場をすべて破壊（粉砕演出イベントつき）→足場をカードに戻し、
 * 本人の手札と合算して、他の未脱落プレイヤーへ偏りなく配分する。
 * 設置総数はその分減り、配置フェーズは継続する */
function applyEliminationCleanup(p) {
  if (!p) return;
  const pool = [];
  const mine = placed.filter(pl => pl.ownerId === p.id);
  placed = placed.filter(pl => pl.ownerId !== p.id);
  for (const pl of mine) {
    io.emit('destroy:anim', { platformId: pl.id, destroyed: true, type: pl.type, pos: platformApproxPos(pl, now()), rot: pl.rot, ownerColor: pl.ownerColor });
    chikuwaState.delete(pl.id);
    pool.push(pl.type);
  }
  pool.push(...(p.hand || []));
  p.hand = [];
  distributeCards(pool, activeParticipants());
}
function startVoteSession(kind, triggererId) {
  if (voteSession || phase !== 'place') return;
  voteSeq++;
  voteSession = { kind, triggererId: triggererId || null, seq: voteSeq };
  votes = new Map();
  // 切断中の人間プレイヤーはパス扱いで即時補完する（セッションが止まらないように）
  for (const p of activeParticipants()) if (!p.connected && !p.isBot) votes.set(p.id, []);
  syncAll();
  // BOTは少し遅れて自動投票する
  for (const p of activeParticipants()) {
    if (p.isBot && !votes.has(p.id)) setTimeout(() => botVoteSubmit(p), 350 + Math.random() * 550);
  }
  checkVoteComplete();
}
function botVoteSubmit(p) {
  if (!voteSession || votes.has(p.id) || p.eliminated) return;
  if (Math.random() < 0.2) { votes.set(p.id, []); } // 2割はパス
  else {
    const others = activeParticipants().map(q => q.id).filter(id => id !== p.id);
    votes.set(p.id, shuffle(others).slice(0, 1)); // 1人1票制: 対象は1人のみ
  }
  checkVoteComplete();
  syncAll();
}
function checkVoteComplete() {
  if (!voteSession) return;
  if (activeParticipants().every(p => votes.has(p.id))) resolveVoteSession();
}
function resolveVoteSession() {
  const session = voteSession;
  voteSession = null;
  const actives = activeParticipants();
  const tally = new Map(actives.map(p => [p.id, 0]));
  for (const [voter, targets] of votes.entries()) {
    for (const t of targets || []) if (tally.has(t)) tally.set(t, tally.get(t) + 1);
  }
  // 脱落は最大1人（1人1票制）: 最多得票者が1人だけで、かつその得票数が
  // 生存（未脱落）プレイヤー数の過半数を超えている場合に、その1人だけが脱落する。
  // 最多票でも過半数以下なら脱落しない。同点トップ（1人1票制では過半数超の同点は
  // 起こりえないが念のため）も脱落者なしとする。
  let topId = null, topVotes = 0, topTie = false;
  for (const [id, n] of tally.entries()) {
    if (n > topVotes) { topVotes = n; topId = id; topTie = false; }
    else if (n === topVotes && n > 0) topTie = true;
  }
  const eliminatedIds = (topId && !topTie && topVotes * 2 > actives.length) ? [topId] : [];
  // 結果発表時の開示用に「誰が誰に投票したか（またはパス）」を集計する。
  // 投票中は非公開のままで、開示はこの集計（結果発表）のタイミングでのみ行う。
  // 並びは参加順で安定させる
  const ballots = [...votes.entries()]
    .map(([voter, targets]) => ({ voter, target: (targets && targets[0]) || null }))
    .sort((a, b) => participants.indexOf(a.voter) - participants.indexOf(b.voter));
  votes = new Map();
  lastVoteEliminated = eliminatedIds.slice();

  // 脱落処理: 足場の全破壊（粉砕演出イベント付き）＋手札合算→再配分プールへ（共通パイプライン）
  for (const id of eliminatedIds) {
    const p = players.get(id); if (!p) continue;
    p.eliminated = true;
    applyEliminationCleanup(p);
  }
  if (eliminatedIds.length) {
    io.emit('vote:eliminated', { playerIds: eliminatedIds.map(id => pubOf(id)), names: eliminatedIds.map(id => { const p = players.get(id); return p ? p.name : id; }) });
  } else {
    // 脱落者が発生しなかった場合も、投票結果として全員に分かるメッセージを出す（項目3）
    io.emit('vote:no-elimination', {});
  }
  // 投票結果の開示: 脱落の有無と合わせて、各投票者の投票先（またはパス）を全員へ送る。
  // クライアントはこれを受けて結果パネルに一覧表示する（開示は結果発表時のみ）。
  // 結果を送った時刻を記録しておき、アスレチック開始時に「結果パネルが閉じてから
  // 発表・カウントダウンを始める」ための presentAt/goAt の計算に使う
  lastVoteResultAt = now();
  votePanelCloseAt = lastVoteResultAt + VOTE_RESULT_PANEL_MS; // 標準の表示終了時刻（結果+8秒）。直後にアスレチックへ入る場合は startAthletic で結果+4秒へ短縮される
  io.emit('vote:result', { kind: session.kind, eliminatedIds: eliminatedIds.map(id => pubOf(id)), ballots: ballots.map(b => ({ voter: pubOf(b.voter), target: b.target ? pubOf(b.target) : null })), panelCloseAt: votePanelCloseAt });
  // 村人陣営が0人（全員ゴースト状態）になったら即座に人狼陣営の勝利で終了
  if (endGameIfVillagerCampWipedOut('配置フェーズで村人陣営が全滅しました')) return;

  lastVoteDirect = false; // この投票の結果、配置へ戻る場合は「直行」ではない
  if (session.kind === 'final') {
    if (placed.length >= PLACE_TOTAL || allHandsEmpty()) { lastVoteDirect = true; startGuardPhase(); return; }
    syncAll();
    advanceTurn(); // 設置数が10個未満なら配置を次の手番から再開
    return;
  }
  // trigger: 発生させた本人が脱落した場合は手番を進め、それ以外は同じ手番が続く
  const triggerer = session.triggererId ? players.get(session.triggererId) : null;
  if (!triggerer || triggerer.eliminated) { syncAll(); advanceTurn(); return; }
  if (allHandsEmpty() && placed.length < PLACE_TOTAL) { startVoteSession('final', null); return; }
  syncAll();
  maybeBotTurn();
}

/* ============ 守護・破壊 ============ */
function startGuardPhase() {
  phase = 'guard';
  guardedIds = new Set();
  guardQueue = shuffle(participants.filter(id => { const p = players.get(id); return p && p.role === 'knight' && !p.eliminated; }));
  guardCurrent = null;
  /* ルール設定で騎士が1人以上設定されているのに、生存している騎士が
   * 1人もいない場合は、即座に破壊フェーズへ進まず「ダミーの守護選択
   * 時間」を設ける。通常の守護フェーズと見分けがつかないよう、表示は
   * そのまま（騎士が守護対象を選んでいます…）で担当者は割り当てず、
   * 3〜10秒（サーバー側ランダム）経過させてから、守護を行わずに
   * 破壊フェーズへ進む（破壊フェーズの人狼全員脱落時のダミー選択時間
   * と同等の扱い。騎士が0人設定の場合は従来どおり即座に進む。
   * 生存しているが切断している騎士は従来どおり nextGuard で
   * スキップされるため、この条件には含めない） */
  if (ruleConfig.knight >= 1 && !guardQueue.length) {
    syncAll();
    const dummyMs = DUMMY_DESTROY_MIN_MS + Math.floor(Math.random() * (DUMMY_DESTROY_MAX_MS - DUMMY_DESTROY_MIN_MS + 1));
    clearTimeout(dummyGuardTimer);
    dummyGuardTimer = setTimeout(() => { dummyGuardTimer = null; if (phase === 'guard') startDestroyPhase(); }, dummyMs);
    return;
  }
  nextGuard();
}
function nextGuard() {
  while (guardQueue.length) {
    const id = guardQueue.shift();
    const p = players.get(id);
    if (p && p.connected) { guardCurrent = id; syncAll(); if (p.isBot) setTimeout(() => guardPick(id, randomPlacedId()), 400); return; }
    if (p && p.isBot) { guardCurrent = id; if (randomPlacedId()) guardedIds.add(randomPlacedId()); continue; }
    // 切断した騎士はスキップ
  }
  guardCurrent = null;
  startDestroyPhase();
}
function guardPick(playerId, platformId) {
  if (phase !== 'guard' || guardCurrent !== playerId) return;
  if (!placed.some(pl => pl.id === platformId)) return;
  guardedIds.add(platformId);
  guardCurrent = null;
  nextGuard();
  syncAll();
}
function randomPlacedId() { return placed.length ? placed[Math.floor(Math.random() * placed.length)].id : null; }
function startDestroyPhase() {
  phase = 'destroy';
  destroyDone = false;
  // 人狼（役職）が未脱落で1人もいなければ破壊イベント自体をスキップする
  const wolves = participants.filter(id => { const p = players.get(id); return p && p.role === 'wolf' && !p.eliminated && (p.connected || p.isBot); });
  if (!wolves.length) {
    destroyerId = null;
    /* 人狼陣営の役職プレイヤーが存在するのに全員脱落している場合は、
     * 即座にスキップせず「ダミーの破壊選択時間」を設ける。通常の破壊
     * フェーズと見分けがつかないよう、表示はそのまま（人狼が破壊対象を
     * 選んでいます…）で 3〜10秒（サーバー側ランダム）経過させてから、
     * 実際には何も破壊せずに resolveDestroy(null) へ進む。
     * （人狼役職そのものが居ない構成では従来どおり即スキップ） */
    const anyWolfRole = participants.some(id => { const p = players.get(id); return p && p.role === 'wolf'; });
    if (anyWolfRole) {
      syncAll();
      const dummyMs = DUMMY_DESTROY_MIN_MS + Math.floor(Math.random() * (DUMMY_DESTROY_MAX_MS - DUMMY_DESTROY_MIN_MS + 1));
      clearTimeout(dummyDestroyTimer);
      dummyDestroyTimer = setTimeout(() => { dummyDestroyTimer = null; if (phase === 'destroy') resolveDestroy(null); }, dummyMs);
      return;
    }
    resolveDestroy(null); return;
  }
  destroyerId = shuffle(wolves)[0];
  syncAll();
  const dp = players.get(destroyerId);
  if (dp && dp.isBot) setTimeout(() => destroyPick(destroyerId, randomPlacedId()), 500);
}
function destroyPick(playerId, platformId) {
  if (phase !== 'destroy' || destroyerId !== playerId || destroyDone) return;
  destroyDone = true;
  resolveDestroy(platformId);
}
function resolveDestroy(platformId) {
  if (phase !== 'destroy') return; // 終了済みフェーズでの遅延呼び出しを無効化
  let msg;
  if (platformId && !guardedIds.has(platformId)) {
    const pl = placed.find(x => x.id === platformId);
    placed = placed.filter(x => x.id !== platformId);
    chikuwaState.delete(platformId);
    msg = '足場が1つ破壊されました';
    // 粉砕アニメーション用に足場の種類・現在位置・色を一緒に送る（クライアント共通演出）
    io.emit('destroy:anim', { platformId, destroyed: true, type: pl ? pl.type : null, pos: pl ? platformApproxPos(pl, now()) : null, rot: pl ? pl.rot : null, ownerColor: pl ? pl.ownerColor : null });
  } else {
    msg = '足場は破壊されませんでした';
    /* 守護で無効化された場合は platformId を送らない: 送ると「人狼が
     * 狙った足場＝守護された足場」が全クライアントへ漏れ、騎士の
     * 秘密裏の守護が開発者ツール等で特定できてしまう。破壊が実際に
     * 起きた場合の platformId は、足場が消える公開イベントなので問題ない */
    io.emit('destroy:anim', { destroyed: false });
  }
  toast('all', msg, 'info');
  /* アスレチック開始は遅延タイマー経由。ハンドルを保持し、endGame で
   * 破棄する。発火側（startAthletic）でもフェーズを確認するため、
   * この間にホストが強制終了しても result から athletic へ復活しない */
  clearTimeout(athleticStartTimer);
  athleticStartTimer = setTimeout(() => { athleticStartTimer = null; startAthletic(); }, 1200);
}

/* ============ アスレチック ============ */
function spawnPos(idx) { // スタート島上に重ならない配置
  const col = idx % 4, row = Math.floor(idx / 4);
  // y はスタート島の上面（島は中心 y=0・高さ2 → 上面 y=1 = START_POS.y）に一致させる。
  // 以前は y=1.6 で、足裏が上面から 0.6m 浮いた状態でスポーンし、アスレチック開始直後に
  // 落下してから接地していた（項目1）。接地した状態で開始できるよう上面ちょうどにする
  return { x: START_POS.x - 3 + col * 2, y: START_POS.y, z: START_POS.z - 3 + row * 2 };
}
/* 観戦者（試合不参加）のプレイヤー一覧。観戦者は「常時ゴースト」のキャラクターとして扱う */
function spectatorPlayers() {
  return [...players.values()].filter(p => p.spectator && !participants.includes(p.id)).sort((a, b) => a.joinOrder - b.joinOrder);
}
/* 観戦者のスポーン位置を割り当てる（参加者の後ろのグリッド位置）。リスポーン時も同じ位置を使う */
function assignSpectatorSpawn(p) {
  const idx = Math.max(0, spectatorPlayers().findIndex(q => q.id === p.id));
  p.pos = spawnPos(participants.length + idx);
  p.vel = { x: 0, y: 0, z: 0 }; p.knockback = null;
  p.svx = 0; p.svz = 0; p.svy = 0; p.moving = false; p.airborne = false;
  p.lastSeenAt = now(); p.serverPosAt = p.lastSeenAt;
  return p.pos;
}
/* アスレチックの発表開始時刻（presentAt）と GO 時刻（goAt）、および結果パネルが
 * 閉じる時刻（panelCloseAt）を決める純粋関数。
 * 順序は「投票結果パネル表示 → パネルが閉じる → 脱落者発表 → カウントダウン → GO」。
 * 投票結果直後（結果から VOTE_RESULT_PANEL_MS 以内）にアスレチック開始処理が来た
 * ケースでは、結果パネルの表示を VOTE_RESULT_PANEL_SHORT_MS（4秒）に短縮し、
 * 発表開始はその短縮後のパネル終了時刻になる。パネルが十分前に閉じている
 * 通常ケースでは表示は8秒のままで、遅延は入らない（presentAt = 開始時刻） */
function athleticStartTimes(nowMs, lastVoteAtMs, directHint) {
  let panelCloseAt = 0;
  if (lastVoteAtMs) {
    /* 「直後にアスレチックへ入る」かどうかは、投票解決の時点で
     * （守護/破壊へ進んだか）で決まる。経過時間だけでは、人狼全員脱落時の
     * ダミー破壊選択時間（3〜10秒）が間に入ると8秒を超えて誤判定し、
     * 短縮されるはずのパネル終了時刻が8秒に戻ってしまうため、
     * 呼び出し側が解決時点の判定（directHint）を渡す。未指定の場合は
     * 従来の経過時間ヒューリスティクスで判定する */
    const directToAthletic = directHint !== undefined ? !!directHint : (nowMs - lastVoteAtMs < VOTE_RESULT_PANEL_MS);
    panelCloseAt = lastVoteAtMs + (directToAthletic ? VOTE_RESULT_PANEL_SHORT_MS : VOTE_RESULT_PANEL_MS);
  }
  const present = Math.max(nowMs, panelCloseAt);
  return { presentAt: present, goAt: present + COUNTDOWN_LEAD_MS, panelCloseAt };
}

function startAthletic() {
  /* フェーズガード: 破壊フェーズからの正規の遷移でのみ開始する。
   * 遅延タイマーが強制終了（result）後に発火しても、アスレチックへ
   * 復活させない（endGame 側でもタイマーは破棄している） */
  if (phase !== 'destroy') return;
  phase = 'athletic';
  result = null;
  participants.forEach((id, i) => {
    const p = players.get(id); if (!p) return;
    p.pos = spawnPos(i); p.vel = { x: 0, y: 0, z: 0 }; p.knockback = null;
    // スポーンは島上面に接地した高さ（y=1）なので、接地済みとして開始する。
    // 以前は _grounded=false で始まり、開始直後に 0.6m 落下する動きが入っていた（項目1）
    p._vy = 0; p._grounded = true; p._bvx = 0; p._bvz = 0; p._standId = 'start'; p._standCenter = { cx: START_POS.x, top: START_POS.y, cz: START_POS.z }; p.moving = false;
    p.svx = 0; p.svz = 0; p.svy = 0; p.yaw = 0; p.lastPunchAt = 0;
    p.respawnLatchUntil = 0; p.lastSeenAt = now(); p.serverPosAt = p.lastSeenAt; p.airborne = false;
    if (!p.connected) p.eliminated = true;
  });
  /* 守護/破壊フェーズ中に切断で村人陣営が全滅していた場合の取りこぼし防止:
   * 切断者を脱落扱いにした直後のこの時点で全滅を判定し、人狼勝利で
   * 終了する（アスレチックを開始して制限時間満了まで待たせない） */
  if (checkVillagerAllOut()) return;
  // 観戦者にもゴーストキャラクターのスポーンを割り当てる（項目4）。
  // 観戦者は勝敗・ゴール判定には一切関与しない
  for (const p of spectatorPlayers()) { if (p.connected) assignSpectatorSpawn(p); }
  const limitMs = (ruleConfig.timeMin || 5) * 60 * 1000; // ルール設定「アスレチック制限時間」に従う
  // 発表・カウントダウンは、直近の投票結果パネルが閉じてから始める（全クライアント共通・サーバー時刻ベース）
  const times = athleticStartTimes(now(), lastVoteResultAt, lastVoteDirect);
  votePanelCloseAt = times.panelCloseAt; // 直行ケースでは結果+4秒に短縮された終了時刻を、syncAll 経由で全クライアントへ伝える
  presentAt = times.presentAt;
  goAt = times.goAt; // presentAt から 脱落者発表→3,2,1,GO
  athleticEndsAt = goAt + limitMs;
  syncAll();
  io.emit('athletic:start', { goAt, presentAt, eliminated: lastVoteEliminated.map(id => pubOf(id)).filter(Boolean) });
  clearTimeout(athleticTimer);
  athleticTimer = setTimeout(() => {
    if (phase === 'athletic') endGame('wolf', `制限時間（${ruleConfig.timeMin || 5}分）経過`, now());
  }, (goAt - now()) + limitMs);
}
function endGame(winner, reason, at) {
  if (phase === 'result') return;
  phase = 'result';
  voteSession = null;
  result = { winner, reason, at };
  clearTimeout(athleticTimer);
  /* 進行中の遅延タイマーを全て破棄する（強制終了後にアスレチック開始や
   * ダミー破壊が遅れて発火して result を上書きするのを防ぐ） */
  clearTimeout(athleticStartTimer); athleticStartTimer = null;
  clearTimeout(dummyDestroyTimer); dummyDestroyTimer = null;
  clearTimeout(dummyGuardTimer); dummyGuardTimer = null;
  clearTimeout(roleTimer); roleTimer = null;
  for (const id of participants) {
    const p = players.get(id); if (!p) continue;
    // BOTはロビーへ戻る際に自動で再エントリーする（放置状態にしない）。
    // 人間は従来どおり「再戦」/「退出」の本人操作でのみエントリー状態が決まる。
    if (p.isBot) { p.inResult = false; p.entered = true; p.spectator = false; }
    else { p.inResult = true; p.entered = false; }
  }
  io.emit('game:result', { winner, reason, detail: publicState().resultDetail });
  syncAll();
}
function checkVillagerAllOut() {
  const villagers = participants.map(id => players.get(id)).filter(p => p && p.camp === 'villager');
  if (villagers.length && villagers.every(p => p.eliminated)) { endGame('wolf', '村人陣営が全員脱落', now()); return true; }
  return false;
}
function eliminate(p, reason) {
  if (!p) return;
  const wasAlive = !p.eliminated;
  p.eliminated = true;
  p.pos = spawnPos(participants.indexOf(p.id));
  p.vel = { x: 0, y: 0, z: 0 }; p.knockback = null;
  p.svx = 0; p.svz = 0; p.svy = 0;
  p._vy = 0; p._grounded = true; p._standId = 'start'; p._standCenter = { cx: START_POS.x, top: START_POS.y, cz: START_POS.z };
  p.serverPosAt = now(); // リスポーンで位置が不連続に変わる（補間キーも進める）
  p.respawnLatchUntil = now() + 1000; // ラッチ1秒（仕様15.4）
  io.emit('player:eliminated', { id: p.pub, respawn: p.pos, wasAlive });
  // 脱落した事実を公開状態にも即時反映する。これが無いとBOTが落下しても
  // state:sync が送られず、生存者の画面でBOTゴーストが表示され続けた（項目14の原因）
  if (wasAlive) syncAll();
  if (wasAlive && phase === 'athletic') checkVillagerAllOut();
}

/* ============ BOT ============ */
function addBot() {
  botSeq++;
  const used = new Set([...players.values()].map(p => p.colorIdx));
  let colorIdx = PALETTE.findIndex((_, i) => !used.has(i)); if (colorIdx < 0) colorIdx = 0;
  const id = 'bot-' + botSeq + '-' + Math.random().toString(36).slice(2, 7);
  const p = {
    id, pub: newPub(), socketId: null, name: 'BOT-' + botSeq, colorIdx, entered: true, connected: true, isBot: true,
    joinOrder: ++joinSeq, hand: [], role: null, camp: null, eliminated: false, inResult: false, spectator: false,
    pos: { ...START_POS }, passLocked: false, posHistory: [],
  };
  players.set(id, p);
  return p;
}
// ルール設定「BOT人数」に合わせてルーム内のBOT数を増減させる（ロビー/リザルト時のみ）。
// BOTはホストにならず、参加BOTは試合終了後に自動再エントリーする既存仕様は維持する。
// 頭打ち判定で数える対象は「エントリー済みの人数（＝次試合の参加枠）」のみ。
// 以前は players.size（全レコード数）も条件に入っていたため、リザルトに
// 残った切断者や観戦者のレコードに枠を潰され、指定したBOT数まで黙って
// 増えないことがあった。戻り値は同期後の実BOT数（頭打ち検出用）
function syncBotsToRule() {
  if (phase !== 'lobby' && phase !== 'result') return [...players.values()].filter(p => p.isBot).length;
  const want = Math.max(0, Math.min(9, ruleConfig.botCount | 0));
  let bots = [...players.values()].filter(p => p.isBot).sort((a, b) => a.joinOrder - b.joinOrder);
  while (bots.length > want) { const t = bots.pop(); players.delete(t.id); }
  while (bots.length < want) {
    if (enteredPlayers().length >= 10) break; // 参加枠（エントリー10人）の上限でのみ頭打ち
    bots.push(addBot());
  }
  return bots.length;
}
function maybeBotTurn() {
  if (phase !== 'place' || voteSession) return;
  const p = currentTurnPlayer();
  if (!p || !p.isBot) return;
  setTimeout(() => {
    if (phase !== 'place' || voteSession || currentTurnPlayer() !== p) return;
    // BOTも低確率で投票イベントを発生させる（テスト可能性のため手番で使える状態にしておく）
    if (!p.voteTriggerUsed && placed.length >= 2 && Math.random() < 0.12) {
      p.voteTriggerUsed = true;
      startVoteSession('trigger', p.id);
      return;
    }
    botPlace(p);
  }, 600);
}
function botPlace(p) {
  const idx = placed.length;
  const type = p.hand[0];
  const x = -21 + idx * 4.6, y = 1.6, z = (idx % 2 === 0 ? -1 : 1);
  /* 配置制限（始点・終点・通過範囲）に触れない候補を選ぶ: 従来の向き
   * （+x・低空）を第一候補とし、島に掛かる場合は向き反転→高所の順に試す。
   * 終点や通過範囲も制限対象になったため、ゴール寄りの slide/teleport は
   * そのままでは島の低空へ終点が掛かって拒否され、手番が止まってしまう */
  const rot0 = { x: 0, y: 0, z: 0 };
  for (const yy of [y, 4.2]) for (const dir of [1, -1]) {
    const pos = { x, y: yy, z };
    let end = null;
    if (type === 'slide') end = { x: x + SLIDE_DIST * dir, y: yy, z };
    if (type === 'teleport') end = { x: Math.max(-24, Math.min(24, x + 7 * dir)), y: yy + 1, z };
    if (!placementForbiddenFull(type, pos, end, rot0)) { doPlace(p, type, pos, end, rot0); return; }
  }
  /* 最後の手段（現行の定数では到達しない: 全 type × 全 idx で候補の
   * いずれかが通ることを検証済み）。それでも置けない場合は高所候補を
   * 試し、最終的に手番を進めることで、BOT の手番で永久に詰まる
   * 構造にしないための保証とする */
  if (!doPlace(p, type, { x, y, z }, null, rot0) && !doPlace(p, type, { x, y: 4.2, z }, null, rot0)) advanceTurn();
}
/* 配置制限（スタート/ゴール島）: 島の XZ 範囲と足場フットプリントが重なり、
 * かつ足場の底面が島上面+PLACE_CLEARANCE（2.2m）より低い配置を禁止する。
 * 島の上空を通る高所の配置は妨げない。観覧車はゴンドラの最下点
 * （中心−半径）で判定する */
function placementForbidden(type, pos, rot) {
  const dims = BOT_DIMS[type];
  if (!dims || !pos) return true;
  let [ex, ey, ez] = rotAABBHalf(dims[0], dims[1], dims[2], type === 'long' ? rot : null);
  /* 観覧車はゴンドラが中心の周りを半径 RADIUS で公転する（回転面は XY 平面:
   * wheelPosAt で x が ±RADIUS 振れ、z は不変）。中心フットプリント
   * （±1m）だけで判定すると、軌道の張り出しが島に掛かる配置を通して
   * しまうため、回転面方向（x）は「半径＋ゴンドラ半幅」、回転軸方向（z）は
   * ゴンドラ半幅で、軌道全体の外接範囲を判定に使う。上下は現行どおり
   * ゴンドラ最下点（中心−半径−半高さ）が島上面+クリアランス未満なら禁止 */
  if (type === 'wheel') { ex = WheelPhase.RADIUS + dims[0] / 2; ez = dims[2] / 2; }
  const bottom = pos.y - ey - (type === 'wheel' ? WheelPhase.RADIUS : 0);
  if (bottom >= ISLAND_TOP + PLACE_CLEARANCE) return false;
  for (const isl of BOT_ISLANDS) {
    if (Math.abs(pos.x - isl.cx) < ex + ISLAND_HALF && Math.abs(pos.z - isl.cz) < ez + ISLAND_HALF) return true;
  }
  return false;
}
/* 配置制限の全体判定: 始点だけでなく終点（水平移動・テレポ）も同じ規則で
 * 判定し、水平移動については始点〜終点の通過範囲（移動する足場が低空で
 * 島と重なる区間）も判定する。以前は始点しか検証しておらず、始点を島の
 * 外に置けば終点・通過範囲がスタート/ゴール島の低空へ侵入できてしまった。
 * 通過範囲は 0.5m 刻みのサンプリングで判定する
 * （クライアントの placementForbiddenFullClient と同じ刻み・同じ規則） */
const PLACE_SWEEP_STEP = 0.5;
function placementForbiddenFull(type, pos, end, rot) {
  if (!pos) return true;
  if (placementForbidden(type, pos, rot)) return true;
  if (end) {
    if (placementForbidden(type, end, rot)) return true;
    if (type === 'slide') {
      const dist = Math.hypot(end.x - pos.x, end.y - pos.y, end.z - pos.z);
      const n = Math.max(1, Math.ceil(dist / PLACE_SWEEP_STEP));
      for (let i = 1; i < n; i++) {
        const f = i / n;
        const p = { x: pos.x + (end.x - pos.x) * f, y: pos.y + (end.y - pos.y) * f, z: pos.z + (end.z - pos.z) * f };
        if (placementForbidden(type, p, rot)) return true;
      }
    }
  }
  return false;
}
/* ============ 配置実行 ============ */
function doPlace(p, type, pos, end, rot, phaseOffset) {
  if (phase !== 'place' || voteSession) return false; // 投票イベント中は配置できない
  if (p.eliminated) return false;
  if (currentTurnPlayer() !== p) return false;
  const hi = p.hand.indexOf(type);
  if (hi < 0) return false;
  pos = { x: clamp(pos.x, -30, 30), y: clamp(pos.y, 0.5, 16), z: clamp(pos.z, -18, 18) };
  if (end) end = { x: clamp(end.x, -30, 30), y: clamp(end.y, 0.5, 16), z: clamp(end.z, -18, 18) }; // 終点にも始点と同じ範囲制限をかける（以前は無制限だった）
  if (placementForbiddenFull(type, pos, end, rot)) return false; // スタート/ゴール島の真上・低空は禁止（始点・終点・水平移動の通過範囲）
  p.hand.splice(hi, 1);
  const rec = { id: 'pl' + (++placedSeq), type, pos, end: end || null, rot: rot || { x: 0, y: 0, z: 0 }, ownerId: p.id, ownerColor: PALETTE[p.colorIdx].hex, placedAt: now() };
  // 観覧車: プレビュー中にホイールで調整した回転位相オフセットを保存し、全クライアントへ同期する。
  // 配置後の角度は placedAt ではなく「絶対時刻＋このオフセット」で決まるため、
  // プレビューで見えていた位相のまま配置され、確定前後でズレない（wheelphase.js 参照）。
  // 未指定（BOT配置・旧クライアント）は 0 として従来どおり回転する
  if (type === 'wheel') rec.phaseOffset = WheelPhase.normalizePhase(phaseOffset);
  placed.push(rec);
  for (const q of players.values()) q.passLocked = false; // 誰かが配置したらパス制限リセット
  if (placed.length >= PLACE_TOTAL) { finishPlacement(); return true; }
  advanceTurn();
  return true;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));

/* ============ ゲーム開始 ============ */
// 開始時に参加者間でプレイヤーカラーが重複していたら解消する:
// 重複グループごとにランダムに1人だけ元の色を残し、残りの参加者（シャッフル順）に
// 参加者全員と被っていない未使用色（10色パレット）からランダムに割り当て直す。
function dedupeParticipantColors(entries) {
  const byColor = new Map();
  for (const p of entries) {
    if (!byColor.has(p.colorIdx)) byColor.set(p.colorIdx, []);
    byColor.get(p.colorIdx).push(p);
  }
  const dupGroups = [...byColor.values()].filter(g => g.length > 1);
  if (!dupGroups.length) return;
  const targets = [];
  for (const g of dupGroups) {
    const keep = g[Math.floor(Math.random() * g.length)]; // 被っている参加者の中でランダムに残す1人
    for (const p of g) if (p !== keep) targets.push(p);
  }
  const usedIdx = new Set(entries.map(p => p.colorIdx));
  const freeIdx = shuffle(PALETTE.map((_, i) => i).filter(i => !usedIdx.has(i)));
  for (const p of shuffle(targets)) {
    if (!freeIdx.length) break; // 参加者10人以下なので通常は枯渇しない
    p.colorIdx = freeIdx.pop();
  }
}
function startGame() {
  const entries = enteredPlayers();
  dedupeParticipantColors(entries);
  const roles = [];
  for (let i = 0; i < ruleConfig.wolf; i++) roles.push('wolf');
  for (let i = 0; i < ruleConfig.madman; i++) roles.push('madman');
  for (let i = 0; i < ruleConfig.knight; i++) roles.push('knight');
  while (roles.length < entries.length) roles.push('villager');
  const shuffledRoles = shuffle(roles);
  participants = entries.map(p => p.id);
  /* 切断済みの残留記録を削除する。結果画面で切断した参加者は inResult=true の
   * ため切断時には削除されず（本人の再接続・再戦操作の余地を残すため）、
   * 次の試合開始時に観戦者化されて残り続けていた。観戦者のスポーン割り当て
   * （spectatorPlayers の並び順）にも数えられるため、サーバーを再起動せずに
   * 試合を重ねると記録が累積し、やがてスポーン位置が島の外に出ていた。
   * ここ（次試合の開始時点）で、「切断済み・BOTでない・新試合の参加者でない・
   * 前試合の残留（inResult または観戦者）」の記録を削除する。再接続の余地を
   * 残すべき現行試合の参加者・観戦者は、このタイミングでは新試合の参加者
   * 判定の対象外＝削除条件に当てはまらないため消えない */
  for (const p of [...players.values()]) {
    if (!p.connected && !p.isBot && !participants.includes(p.id) && (p.inResult || p.spectator)) players.delete(p.id);
  }
  /* リザルト画面に残ったまま次の試合が始まった人（未エントリーで、
   * 参加者でも観戦者でもない）は自動で観戦者にする。そのままだと
   * ゲーム画面が出ず、かつ試合中に「再戦」を押すとエントリー扱いに
   * なって人数表示が増減する不整合な状態になっていた */
  for (const p of players.values()) {
    if (!participants.includes(p.id) && p.inResult) { p.inResult = false; p.entered = false; p.spectator = true; }
  }
  entries.forEach((p, i) => {
    p.role = shuffledRoles[i];
    p.camp = (p.role === 'wolf' || p.role === 'madman') ? 'wolf' : 'villager';
    p.eliminated = false; p.inResult = false; p.passLocked = false;
    p.voteTriggerUsed = false; // 投票イベントの発生権は1ゲーム1回
    // 試合開始時にキャラクター状態をスタート地点へ完全リセットする。
    // 以前は pos・速度・落下状態が前試合の最終状態（落下し終えた空中位置など）の
    // まま残っており、2試合目の配置画面でも前試合の位置にキャラが見えていた（項目11の原因）
    p.pos = spawnPos(i); p.vel = { x: 0, y: 0, z: 0 }; p.knockback = null;
    p.svx = 0; p.svz = 0; p.svy = 0; p.yaw = 0; p.moving = false; p.airborne = false;
    p._vy = 0; p._grounded = true; p._bvx = 0; p._bvz = 0; p._standId = 'start'; p._standCenter = { cx: START_POS.x, top: START_POS.y, cz: START_POS.z };
    p.lastPunchAt = 0; p.respawnLatchUntil = 0; p.lastSeenAt = now(); p.serverPosAt = p.lastSeenAt;
  });
  // 山札（仕様5.1/11）
  const per = handCount(entries.length, wolfCampCount());
  const total = per * entries.length;
  const comp = DECK_TABLE[total];
  let deck = [];
  for (const [t, c] of Object.entries(comp)) for (let i = 0; i < c; i++) deck.push(t);
  deck = shuffle(deck);
  entries.forEach((p, i) => { p.hand = deck.slice(i * per, (i + 1) * per); });
  placed = []; placedSeq = 0; votes = new Map(); voteSession = null; lastVoteEliminated = []; lastVoteResultAt = 0; lastVoteDirect = false; votePanelCloseAt = 0; presentAt = 0; chikuwaState.clear(); result = null;
  goAt = 0; athleticEndsAt = 0; // 前試合の開始時刻を残さない（バナー誤表示の一因・項目19）
  // 手番: ランダムな先手から座席順（参加順）に時計回り
  turnOrder = participants.slice();
  turnIdx = Math.floor(Math.random() * turnOrder.length);
  phase = 'role';
  syncAll();
  io.emit('role:reveal', {});
  clearTimeout(roleTimer);
  roleTimer = setTimeout(() => {
    roleTimer = null;
    if (phase !== 'role') return;
    phase = 'place';
    // 役職フェーズ中の切断などで、配置開始時点で既に村人陣営が全員ゴースト状態なら
    // そのまま人狼陣営の勝利で終了する（状態変化の取りこぼし防止）
    if (endGameIfVillagerCampWipedOut('配置フェーズで村人陣営が全員ゴースト状態になりました')) return;
    /* 先手が役職確認中に切断/脱落していたら手番を進める。以前は
     * 「手札が空なら進める」だけだったため、手札を持ったまま切断した
     * 先手に手番が留まり、誰も配置・パスできず膠着した */
    const p = currentTurnPlayer();
    if (p && (p.eliminated || (!p.connected && !p.isBot) || !p.hand || !p.hand.length)) advanceTurn(); else { syncAll(); maybeBotTurn(); }
  }, 3000);
}

/* ============ BOTのアスレチックAI（足場をたどる） ============ */
// BOTは配置された足場の上面を順にたどる。到達可能な次の足場だけを目標にし、
// 足場のない方向へは進まない。たどれない場合は落下して脱落する。
const BOT_DIMS = { stable: [2, 1, 2], island: [4, 1, 4], chikuwa: [2, 1, 2], slide: [2, 1, 2], wheel: [2, 1, 2], long: [5, 0.6, 1], teleport: [2, 1, 2] };
const BOT_ISLANDS = [
  { cx: START_POS.x, cy: 0, cz: START_POS.z, w: 10, h: 2, d: 10, id: 'start' },
  { cx: GOAL_POS.x, cy: 0, cz: GOAL_POS.z, w: 10, h: 2, d: 10, id: 'goal' },
];
function rotAABBHalf(w, h, d, rot) {
  // 回転したボックスのAABB半寸法（|R| * half）を返す。
  // 回転行列はクライアント（Three.js Euler 'XYZ' = Rx·Ry·Rz）と同一の
  // rotMatrixXYZ を使う。以前は Ry·Rx·Rz の順で合成していたため、ヨー（Y）と
  // 傾け（Z）だけの回転では一致するが、ホイールねじり（X回転）が加わると
  // クライアントの見た目の AABB と食い違っていた
  // （例: rot=(0.61,0.73,0.24)・細長で サーバー 2.37/1.02/1.84 ≠ クライアント 2.20/1.84/1.50）
  const hx = w / 2, hy = h / 2, hz = d / 2;
  if (!rot) return [hx, hy, hz];
  const m = rotMatrixXYZ(rot);
  return [
    Math.abs(m[0][0]) * hx + Math.abs(m[0][1]) * hy + Math.abs(m[0][2]) * hz,
    Math.abs(m[1][0]) * hx + Math.abs(m[1][1]) * hy + Math.abs(m[1][2]) * hz,
    Math.abs(m[2][0]) * hx + Math.abs(m[2][1]) * hy + Math.abs(m[2][2]) * hz,
  ];
}
/* 細長（OBB）判定: Three.js の Euler 'XYZ'（R = Rx·Ry·Rz）と同一の回転行列。
 * 以前は回転行列ベースのAABB近似で、傾けた細長では「見た目より広い/ずれた」判定になっていた。
 * プレイヤー座標を足場ローカル空間へ変換し、上面・側面をローカル軸で判定する */
function rotMatrixXYZ(rot) {
  const x = (rot && rot.x) || 0, y = (rot && rot.y) || 0, z = (rot && rot.z) || 0;
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * cz * sy, cx * cz - sx * sz * sy, -sx * cy],
    [sx * sz - cx * cz * sy, sx * cz + cx * sz * sy, cx * cy],
  ];
}
// OBBの支持面（乗れる面）のワールドYを返す（フットプリント外なら null）。(x,z) はワールド座標
function obbTopAt(col, x, z) {
  const dx = x - col.cx, dz = z - col.cz, R = col.R;
  const h = [col.hx, col.hy, col.hz];
  /* 支持面は「元の上面（ローカル+Y面）」とは限らない。細長はホイール回転で
   * 任意の向きに配置でき、側面（±Z面）や端面（±X面）が上を向くことがある。
   * 以前はローカル+Y面の平面との交点しか返さなかったため、側面を上にして
   * 配置すると +Y面がほぼ垂直（法線Y≈0）になって支持が一切なく（乗れない）、
   * 裏返し（180°）では下面の平面を返して見た目より 0.6m 低い位置に立つなど、
   * 「上を向いた面」が支持面になっていなかった。
   *
   * ここでは上向きの全ての面（法線のY成分 >= 0.5、つまり傾斜60度以下）を
   * 候補とし、(x,z) の鉛直線と各面の平面の交点を求める。交点がその面の
   * 矩形内にあるものを優先（第1段）し、無ければ +0.4 のマージン内にある
   * もの（第2段・従来の「端の少し外でも乗れる」許容）から最も高いものを
   * 返す。第1段を優先するのは、マージンで広げた別面の平面の延長が、
   * 実際に線が突き抜ける面より高い値を返して浮いて見えるのを防ぐため。
   * ボックスの最も上を向いた面の法線Yは常に 1/√3 ≈ 0.577 以上になるため、
   * どの向きでも支持面は必ず1つ存在する。逆に傾斜60度を超える急な面は
   * 候補に入らない（側面の押し出し側が担当する）。
   * 交点Yの計算自体は従来の厳密式（上面平面との交点）と同じ考え方で、
   * 対象面を一般化したもの（クライアントの longTopAtCollider と同じ式） */
  let bestExact = null, bestMargin = null;
  for (let a = 0; a < 3; a++) {
    for (let s = 1; s >= -1; s -= 2) {
      const ny = s * R[1][a];
      if (ny < 0.5) continue; // 下向き・急な面は支持面にしない
      const t = (s * h[a] - R[0][a] * dx - R[2][a] * dz) / R[1][a];
      const o1 = (a + 1) % 3, o2 = (a + 2) % 3;
      const l1 = R[0][o1] * dx + R[1][o1] * t + R[2][o1] * dz;
      const l2 = R[0][o2] * dx + R[1][o2] * t + R[2][o2] * dz;
      const y = col.cy + t;
      if (Math.abs(l1) <= h[o1] && Math.abs(l2) <= h[o2]) { if (bestExact === null || y > bestExact) bestExact = y; }
      else if (Math.abs(l1) <= h[o1] + 0.4 && Math.abs(l2) <= h[o2] + 0.4) { if (bestMargin === null || y > bestMargin) bestMargin = y; }
    }
  }
  return bestExact !== null ? bestExact : bestMargin;
}
function longTopAt(pl, x, z) { // ロジックテスト用: 配置データから直接上面Yを引く
  const col = { cx: pl.pos.x, cy: pl.pos.y, cz: pl.pos.z, R: rotMatrixXYZ(pl.rot), hx: 2.5, hy: 0.3, hz: 0.5 };
  return obbTopAt(col, x, z);
}
function botColliders(t) {
  const list = BOT_ISLANDS.map(i => ({ ...i, top: i.cy + i.h / 2 }));
  for (const pl of placed) {
    const c = platformApproxPos(pl, t);
    if (pl.type === 'long') {
      // 細長はOBBとして扱う（w/d はBOTの進路計算用の概算フットプリント）
      list.push({ kind: 'obb', id: pl.id, cx: c.x, cy: c.y, cz: c.z, R: rotMatrixXYZ(pl.rot), hx: 2.5, hy: 0.3, hz: 0.5, w: 5.8, h: 0.6, d: 1.8 });
      continue;
    }
    const [w, h, d] = BOT_DIMS[pl.type];
    const [ex, ey, ez] = rotAABBHalf(w, h, d, null);
    list.push({ id: pl.id, cx: c.x, cy: c.y, cz: c.z, w: ex * 2, h: ey * 2, d: ez * 2, top: c.y + ey });
  }
  return list;
}
function botSupportAt(cols, pos) {
  let best = null;
  for (const c of cols) {
    if (c.kind === 'obb') {
      const top = obbTopAt(c, pos.x, pos.z);
      if (top !== null && Math.abs(pos.y - top) <= 0.35 && (!best || top > best.top)) best = { ...c, top };
      continue;
    }
    if (Math.abs(pos.x - c.cx) <= c.w / 2 + 0.4 && Math.abs(pos.z - c.cz) <= c.d / 2 + 0.4) {
      if (Math.abs(pos.y - c.top) <= 0.35 && (!best || c.top > best.top)) best = c;
    }
  }
  return best;
}
// 落下中の着地判定（AABB/OBB共通）。着地できる足場があれば {…, top} を返す
function landCheck(cols, prevY, pos) {
  for (const c of cols) {
    if (c.kind === 'obb') {
      const top = obbTopAt(c, pos.x, pos.z);
      if (top !== null && prevY >= top - 0.05 && pos.y <= top) return { ...c, top };
      continue;
    }
    if (Math.abs(pos.x - c.cx) <= c.w / 2 + 0.4 && Math.abs(pos.z - c.cz) <= c.d / 2 + 0.4 && prevY >= c.top - 0.05 && pos.y <= c.top) return c;
  }
  return null;
}
function botStep(p, t, dt) {
  const cols = botColliders(t);
  // 乗っている移動足場の動きに追従
  if (p._grounded && p._standId) {
    const cur = cols.find(c => c.id === p._standId);
    if (cur && cur.kind === 'obb') { /* 細長は静止足場なので追従不要 */ }
    else if (cur && p._standCenter) {
      const standPl = placed.find(x => x.id === p._standId);
      // 瞬間移動の検出は3次元距離（高さの差も含む）。水平距離のみだと
      // 高さだけ違う垂直テレポで乗員が運ばれてしまう（クライアント側と同式）
      const jumpDist = Math.hypot(cur.cx - p._standCenter.cx, cur.top - p._standCenter.top, cur.cz - p._standCenter.cz);
      if (standPl && standPl.type === 'teleport' && jumpDist > 1) {
        // テレポの瞬間移動では乗員を運ばない（取り残されて落下する・項目23）
        p._grounded = false; p._vy = 0; p._standId = null; p._standCenter = null;
      } else {
        p.pos.x += cur.cx - p._standCenter.cx; p.pos.y += cur.top - p._standCenter.top; p.pos.z += cur.cz - p._standCenter.cz;
      }
    }
  }
  let support = p._grounded ? botSupportAt(cols, p.pos) : null;
  if (support) { p._standId = support.id; p._standCenter = { cx: support.cx, top: support.top, cz: support.cz }; p.pos.y = support.top; p._vy = 0; }
  else p._grounded = false;
  // 次の目標: 現在の足場よりゴール寄り（+x）で最も近い足場。なければゴール島も候補になる
  let target = null;
  if (support) {
    const ahead = cols.filter(c => c.id !== support.id && c.cx > support.cx + 0.6);
    ahead.sort((a, b) => (a.cx - support.cx) - (b.cx - support.cx));
    target = ahead[0] || null;
  }
  // 水平移動（地上: 目標へ歩行 / 空中: 慣性で継続）
  let mvx = 0, mvz = 0;
  if (p._grounded && target) {
    const dx = target.cx - p.pos.x, dz = target.cz - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.05) {
      const sp = 3.6;
      mvx = dx / dist * sp; mvz = dz / dist * sp;
      p._bvx = mvx; p._bvz = mvz;
      // 足場の端から出る瞬間: 目標がジャンプ到達可能なら跳ぶ
      const nextX = p.pos.x + mvx * dt, nextZ = p.pos.z + mvz * dt;
      const stillOn = Math.abs(nextX - support.cx) <= support.w / 2 + 0.4 && Math.abs(nextZ - support.cz) <= support.d / 2 + 0.4;
      const overTarget = Math.abs(nextX - target.cx) <= target.w / 2 + 0.4 && Math.abs(nextZ - target.cz) <= target.d / 2 + 0.4;
      if (!stillOn && !overTarget) {
        const gapX = (target.cx - target.w / 2) - (support.cx + support.w / 2);
        const heightDiff = target.top - support.top;
        // ジャンプ到達可能性は速度3.4・跳躍初速9.5・重力20の実測レンジ（同一高さで約3.2m）に基づく
        if (gapX <= 3.4 && heightDiff <= 1.9 && heightDiff >= -0.5) { p._vy = 10.2; p._grounded = false; }
        // 到達不能な場合はそのまま歩き出て落下する（自然な脱落）
      }
    }
  } else if (!p._grounded) { mvx = p._bvx || 0; mvz = p._bvz || 0; }
  p.pos.x += mvx * dt; p.pos.z += mvz * dt;
  p.moving = Math.hypot(mvx, mvz) > 0.1;
  if (p.moving) p.yaw = Math.atan2(mvx, mvz); // 進行方向を向く（項目21）
  // 重力と着地
  if (!p._grounded) {
    const prevY = p.pos.y;
    p._vy = (p._vy || 0) - 20 * dt;
    p.pos.y += p._vy * dt;
    if (p._vy <= 0) {
      const landed = landCheck(cols, prevY, p.pos);
      if (landed) { p.pos.y = landed.top; p._vy = 0; p._grounded = true; p._standId = landed.id; p._standCenter = { cx: landed.cx, top: landed.top, cz: landed.cz }; }
    }
    if (p.pos.y < FALL_Y) { eliminate(p, 'fall'); return; }
  } else {
    // 歩いて足場を外れたら落下に移行
    const s2 = botSupportAt(cols, p.pos);
    if (!s2) { p._grounded = false; p._vy = 0; }
  }
  p.lastSeenAt = t; p.serverPosAt = t;
  checkGoal(p);
}

/* ============ 非アクティブ人間プレイヤーのサーバー物理代行 ============ */
// クライアントからの位置申告が途絶えたプレイヤーについて、サーバー保持位置に対して
// ノックバック速度の減衰・足場（島含む）の上面判定・重力・着地・落下を進める。
// 移動足場（水平移動・観覧車・テレポ）の上に立っている場合は、クライアント側・
// BOT と同じく「支持足場の現在位置の差分」を位置へ加えて追従する。以前は
// その場に固定するだけだったため、水平移動（約2m/s）に乗っていると
// 0.7秒ほどで足場が滑り去って支持が外れ、落下→ゴースト化していた。
// テレポの周期切替ではクライアント側と同じく乗員を運ばない（置いていかれる）
function serverPhysicsStep(p, t, dt) {
  if (p.eliminated) return;
  const beforeX = p.pos.x, beforeY = p.pos.y, beforeZ = p.pos.z;
  const cols = botColliders(t);
  // 乗っている移動足場の動きに追従（前ステップで接地が確定していた場合のみ）
  if (p._groundedSrv && p._standId) {
    const cur = cols.find(c => c.id === p._standId);
    if (cur && cur.kind !== 'obb' && p._standCenter) { // 細長は静止足場なので追従不要（BOTと同じ）
      const standPl = placed.find(x => x.id === p._standId);
      const jumpDist = Math.hypot(cur.cx - p._standCenter.cx, cur.top - p._standCenter.top, cur.cz - p._standCenter.cz); // 3次元距離（垂直テレポでも検出する）
      if (standPl && standPl.type === 'teleport' && jumpDist > 1) {
        p._groundedSrv = false; p._standId = null; p._standCenter = null; // テレポの瞬間移動では乗員を運ばない
      } else {
        p.pos.x += cur.cx - p._standCenter.cx; p.pos.y += cur.top - p._standCenter.top; p.pos.z += cur.cz - p._standCenter.cz;
      }
    }
  }
  const support = botSupportAt(cols, p.pos);
  const hasKb = Math.hypot(p.svx || 0, p.svz || 0) > 0.05;
  if (support && !hasKb && (p.svy || 0) <= 0) {
    // 足場の上に安定して立っている: 足場と一緒に動き、それ以外はその場に留まる
    p.pos.y = support.top; p.svy = 0;
    p._groundedSrv = true; p._standId = support.id; p._standCenter = { cx: support.cx, top: support.top, cz: support.cz };
    markServerPos(p, t, beforeX, beforeY, beforeZ);
    return;
  }
  p._groundedSrv = false;
  // 水平速度（主にノックバック）を適用しつつ減衰させる
  p.pos.x += (p.svx || 0) * dt; p.pos.z += (p.svz || 0) * dt;
  const decay = Math.max(0, 1 - 6 * dt);
  p.svx = (p.svx || 0) * decay; p.svz = (p.svz || 0) * decay;
  const sup2 = botSupportAt(cols, p.pos);
  if (sup2 && (p.svy || 0) <= 0 && Math.abs(p.pos.y - sup2.top) <= 0.35) {
    p.pos.y = sup2.top; p.svy = 0; // ノックバックで滑って別の足場に乗った等
    p._groundedSrv = true; p._standId = sup2.id; p._standCenter = { cx: sup2.cx, top: sup2.top, cz: sup2.cz };
    markServerPos(p, t, beforeX, beforeY, beforeZ);
    return;
  }
  // 重力落下と着地
  const prevY = p.pos.y;
  p.svy = (p.svy || 0) - 20 * dt;
  p.pos.y += p.svy * dt;
  if (p.svy <= 0) {
    const landed = landCheck(cols, prevY, p.pos);
    if (landed) {
      p.pos.y = landed.top; p.svy = 0; p.svx = 0; p.svz = 0; p._groundedSrv = true;
      p._standId = landed.id; p._standCenter = { cx: landed.cx, top: landed.top, cz: landed.cz };
      markServerPos(p, t, beforeX, beforeY, beforeZ);
      checkGoal(p); return;
    }
  }
  markServerPos(p, t, beforeX, beforeY, beforeZ);
  if (p.pos.y < FALL_Y) eliminate(p, 'fall');
}
/* サーバー側でプレイヤー位置が変化した時刻（serverPosAt）を進める。
 * pos:batch の補間キーとして使う。lastSeenAt は「クライアント申告の受信
 * 時刻」で、代行中は止まったままになるため、補間キーに使うと代行中の
 * 動き（足場追従・ノックバック・落下）が他クライアントに一切反映されず、
 * 凍結表示のあと突然ゴースト化して見えていた。serverPosAt は
 * pos:update 受信時とサーバー代行で位置が動いた時に更新し、batch では
 * こちらをキーとして載せる（remoteinterp はキーが進まないサンプルを捨てる） */
function markServerPos(p, t, bx, by, bz) {
  if (p.pos.x !== bx || p.pos.y !== by || p.pos.z !== bz) p.serverPosAt = t;
}

/* パンチのラグ補償用に、プレイヤーの直近位置履歴を記録する。
 * 保持は POS_HISTORY_MS（600ms）分まで（判定に使うのは直近 PUNCH_LAG_MS） */
function pushPosHistory(p, t) {
  if (!p || !p.pos) return;
  const h = p.posHistory || (p.posHistory = []);
  h.push({ t, x: p.pos.x, y: p.pos.y, z: p.pos.z });
  while (h.length && t - h[0].t > POS_HISTORY_MS) h.shift();
}
/* パンチの命中判定（単一地点）: 中心間1.35m以内・|Δy|<=1.4・前方±60° */
function punchHitAt(mePos, yaw, tp) {
  const dx = tp.x - mePos.x, dy = tp.y - mePos.y, dz = tp.z - mePos.z;
  const dist2d = Math.hypot(dx, dz);
  if (dist2d > PUNCH_RANGE || Math.abs(dy) > PUNCH_MAX_DY) return null;
  if (dist2d > 0.01) {
    const cosAng = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / dist2d;
    if (cosAng < PUNCH_COS) return null;
  }
  return { dx, dz, dist2d };
}
/* ラグ補償つき命中判定: 現在位置で判定し、外れた場合は被弾側の直近
 * PUNCH_LAG_MS（240ms）以内の位置履歴でも判定する。クライアント側は
 * 補間された表示位置で対象を決めるのに対し、サーバーは80ms周期で
 * 受け取った保持位置で判定していたため、動いている相手では
 * 「当たったように見えて当たらない」が起きていた。補償は時間方向
 * だけに留め、判定範囲そのもの（1.35m・±60°・±1.4m）は広げない。
 * 攻撃者の yaw は従来どおりクライアント送信値を使う */
function resolvePunchHit(me, target, yaw, atMs) {
  const t = atMs || now();
  const cur = punchHitAt(me.pos, yaw, target.pos);
  if (cur) return cur;
  const hist = target.posHistory || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (t - h.t > PUNCH_LAG_MS) break;
    const hit = punchHitAt(me.pos, yaw, h);
    if (hit) return hit;
  }
  return null;
}
/* ============ サーバーティック（BOT移動・非アクティブ物理・竹輪リセット・位置配信） ============ */
setInterval(() => {
  const t = now();
  if (phase === 'athletic' && t >= goAt) {
    for (const id of participants) {
      const p = players.get(id); if (!p || !p.isBot || p.eliminated) continue;
      botStep(p, t, 0.1);
      pushPosHistory(p, t);
    }
    // 非アクティブ者の物理代行（仕様15.3）: 通信途絶0.25秒超の人間プレイヤーは
    // サーバー権威位置でノックバック・足場判定・重力・落下まで進める。
    // 以前は「airborne のときだけ y を引く」処理しかなく、パンチで足場外へ
    // 突き出されても airborne フラグが立たず落下しなかった（項目20の原因）
    for (const id of participants) {
      const p = players.get(id); if (!p || p.isBot || !p.connected) continue;
      if (t - (p.lastSeenAt || t) > 250) { serverPhysicsStep(p, t, 0.1); pushPosHistory(p, t); }
    }
  }
  // 竹輪: 状態（発動時刻）は削除せず保持し続ける。発動・復活の判定は
  // クライアント/サーバー双方が「発動時刻からの純粋関数」
  // （chikuwaFallDy）で行うため、サーバーが 5.2秒で状態を消すと
  // 同期の到着タイミングによって最大100msの食い違いが出ていた。
  // 保持し続ければ、乗ったかの判定も復活の判定も triggerAt だけで
  // 両側が完全一致する（足場が破壊された時点で掃除される）
  // 位置配信
  if (phase === 'athletic') {
    const snap = participants.map(id => { const p = players.get(id); return p ? { id: p.pub, pos: p.pos, yaw: p.yaw || 0, ghost: !!p.eliminated, moving: p.isBot ? !!p.moving : (t - (p.lastSeenAt || 0) < 250 ? p.moving : false), lastSeenAt: (typeof p.serverPosAt === 'number' ? p.serverPosAt : p.lastSeenAt), t } : null; }).filter(Boolean);
    // 観戦者のゴーストキャラクターも配信する（項目4）。ghost=true で既存のゴースト可視ルールに乗せる
    const specSnap = spectatorPlayers().filter(p => p.connected).map(p => ({ id: p.pub, pos: p.pos, yaw: p.yaw || 0, ghost: true, spectator: true, moving: !!p.moving, lastSeenAt: (typeof p.serverPosAt === 'number' ? p.serverPosAt : p.lastSeenAt), t }));
    io.emit('pos:batch', [...snap, ...specSnap]);
  }
}, 100);

// 水平移動のサイクル: 4秒移動→2秒停止→4秒移動(復路)→2秒停止 = 12秒（往復どちらも停止する）
function slideFactorAt(tSec) {
  const ph = ((tSec % 12) + 12) % 12;
  if (ph < 4) return ph / 4;
  if (ph < 6) return 1;
  if (ph < 10) return 1 - (ph - 6) / 4;
  return 0;
}
/* 竹輪の落下サイクル: 乗って2秒はその場（微振動）→落下→トリガーから5.2秒で復活。
 * 各竹輪は自分のトリガー時刻だけから状態が決まる（他の足場のイベントに依存しない）。
 * クライアントの platformCurrent と同じ計算式を使う */
function chikuwaFallDy(triggerAt, t) {
  if (!triggerAt) return 0;
  const dt = (t - triggerAt) / 1000;
  if (dt < 2) return 0;              // 乗ってから2秒は落下しない
  if (dt >= 5.2) return 0;           // 復活済み
  return -4.9 * (dt - 2) * (dt - 2); // 落下中
}
function platformApproxPos(pl, t) {
  // BOT用に現在位置の近似を返す
  if (pl.type === 'chikuwa') {
    const dy = chikuwaFallDy(chikuwaState.get(pl.id) || null, t);
    return { x: pl.pos.x, y: pl.pos.y + dy, z: pl.pos.z };
  }
  if (pl.type === 'slide' && pl.end) {
    const f = slideFactorAt((t - pl.placedAt) / 1000);
    return { x: pl.pos.x + (pl.end.x - pl.pos.x) * f, y: pl.pos.y + (pl.end.y - pl.pos.y) * f, z: pl.pos.z + (pl.end.z - pl.pos.z) * f };
  }
  // 観覧車: クライアントの platformCurrent と同一の共通関数＋保存済み位相オフセットで計算する
  if (pl.type === 'wheel') return WheelPhase.wheelPosAt(pl.pos, t, pl.phaseOffset);
  if (pl.type === 'teleport' && pl.end) { const side = Math.floor((t - pl.placedAt) / 3000) % 2; return side ? { ...pl.end } : { ...pl.pos }; }
  return { ...pl.pos };
}
function checkGoal(p) {
  if (phase !== 'athletic' || now() < goAt) return;
  if (p.camp !== 'villager' || p.eliminated) return;
  if (Math.abs(p.pos.x - GOAL_POS.x) > 5 || Math.abs(p.pos.z - GOAL_POS.z) > 5) return;
  if (p.pos.y < 0.6 || p.pos.y > 3.0) return;
  /* 着地を要求する: ゴール島の上空をジャンプで横切っただけでは勝利にしない。
   * 接地の判定は経路ごとに持っている情報を使う:
   *  - BOT: サーバー物理の _grounded（支持判定で確定）
   *  - サーバー物理代行で着地した人間: _groundedSrv フラグ
   *  - クライアント申告の人間: airborne=false（接地中）の申告があり、
   *    かつ高さが島上面（y=1）付近で安定していること */
  let grounded;
  if (p.isBot) grounded = !!p._grounded;
  else if (p._groundedSrv) grounded = true;
  else grounded = !p.airborne && p.pos.y >= ISLAND_TOP - 0.1 && p.pos.y <= ISLAND_TOP + 0.7;
  if (!grounded) return;
  endGame('villager', '村人陣営がゴールに到達', now());
}

/* プレイヤー名の一意化: 既存プレイヤーと同名なら「名前 2」「名前 3」…。
 * excludeId は本人（再接続時の自分自身）で、競合として扱わない */
function uniquePlayerName(base, excludeId) {
  const taken = new Set([...players.values()].filter(p => p.id !== excludeId).map(p => p.name));
  let nm = base;
  for (let n = 2; taken.has(nm); n++) nm = `${base.slice(0, 13)} ${n}`;
  return nm;
}

/* ============ 接続処理 ============ */
/* 試合中参加者が「脱落扱い」になったときの後処理（切断・再接続join先行で共通）。
 * 以前は disconnect ハンドラの中にだけあり、再接続の join が旧ソケットの
 * 切断検出より先に届いた場合は、join 側が eliminated=true だけを立てて
 * 後処理が一切走らなかった（手札が再配分されず、手番がゴーストに留まり、
 * 本人が place:pass を送るまで配置が止まる不具合が実測再現された）。
 * 後処理はこの関数に集約し、切断経路と join 経路の両方から必ず呼ぶ */
function handleParticipantDrop(p) {
  if (!p || !participants.includes(p.id)) return;
  if (['lobby', 'result'].includes(phase)) return;
  const newlyEliminated = !p.eliminated;
  p.eliminated = true; // 完全切断は脱落扱い（仕様14.1）
  /* 守護・破壊フェーズ中も村人陣営の全滅を検出する。判定が投票集計・
   * 配置フェーズ・アスレチック中にしかないと、守護/破壊中に生存村人が
   * 全員いなくなってもアスレチックが始まってしまう。ここで終了した
   * 場合は、この後の担当引き継ぎ等はフェーズ条件で自然にスキップされる */
  if (phase === 'athletic' || phase === 'guard' || phase === 'destroy') checkVillagerAllOut();
  if (phase === 'destroy' && destroyerId === p.id && !destroyDone) {
    // 破壊担当の離脱→他の人狼へ引き継ぎ（仕様8.5）
    const others = participants.filter(id => { const q = players.get(id); return q && q.role === 'wolf' && !q.eliminated && id !== p.id && (q.connected || q.isBot); });
    if (others.length) { destroyerId = shuffle(others)[0]; const dp = players.get(destroyerId); if (dp && dp.isBot) setTimeout(() => destroyPick(destroyerId, randomPlacedId()), 400); }
    else { destroyDone = true; resolveDestroy(null); }
  }
  /* 切断脱落にも投票脱落と同じ後処理を行う（配置フェーズ＋役職確認
   * フェーズ）: 本人の足場をすべて破壊→カードに戻し→手札と合算→
   * 他の生存プレイヤーへ再配分し、設置総数が減った状態で配置を
   * 継続する。守護/破壊/アスレチックで脱落になる場合は行わない: 配置は
   * 終了済みでカード再配分に意味がなく、足場の破壊は破壊フェーズ
   * 自体の仕組み（人狼の選択）と競合するため（脱落扱いのみ）。
   * ★順序が重要: この回収は「投票の完了判定」より前に行う。以前は
   * 完了判定が先で、離脱者が最終投票の最後の未投票者だった場合、
   * checkVoteComplete 内の resolveVoteSession が守護フェーズへ進めて
   * しまい、その後の (phase === 'place') 条件を満たせず、離脱者の足場が
   * 回収されないまま残った（実測再現あり）。先に回収しておけば、投票
   * 解決側は「設置数が減った状態」を正として判定でき（最終投票でも
   * 設置数不足なら配置再開になる）、投票で別人が脱落した場合の回収は
   * resolveVoteSession 側が自分の対象にだけ行うため二重にもならない */
  if ((phase === 'place' || phase === 'role') && newlyEliminated) applyEliminationCleanup(p);
  if (phase === 'place' && voteSession && !votes.has(p.id)) { votes.set(p.id, []); checkVoteComplete(); } // 投票イベント中の離脱はパス扱いで補完
  // 手番保持者がゴースト化したら、手番は自動で次へ進む（塩漬けにしない）
  if (phase === 'place' && !voteSession && currentTurnPlayer() === p) advanceTurn();
  if (phase === 'guard' && guardCurrent === p.id) { guardCurrent = null; nextGuard(); }
  // 配置フェーズ中: 脱落で村人陣営が全員ゴースト状態になったら人狼勝利で即終了
  if (phase === 'place') endGameIfVillagerCampWipedOut('配置フェーズで村人陣営が全員ゴースト状態になりました');
}

io.on('connection', (socket) => {
  let me = null;
  /* 全ハンドラを try/catch で包む共通ラッパー: 不正・欠落したパケット
   * （引数なし、型違い）で例外が出ても、そのイベントを無効として
   * 処理を続け、プロセス全体が落ちて全員切断になることを防ぐ */
  const on = (ev, fn) => socket.on(ev, (...args) => {
    try { fn(...args); } catch (e) { console.error(`[aw] handler error (${ev}):`, e && e.message); }
  });
  on('join', (d) => {
    d = d || {};
    let sessionId = d.sessionId, name = d.name;
    if (!sessionId || typeof sessionId !== 'string') sessionId = 's' + Math.random().toString(36).slice(2, 10);
    me = players.get(sessionId);
    if (me) {
      /* 旧ソケットの後始末: 同じプレイヤーに別の有効な旧ソケットが残って
       * いる場合は、旧ソケットをサーバー側から切断する。クライアントは
       * サーバー起点の切断（io server disconnect）では自動再接続しない
       * ため、タブ複製による二重操作を防げる。旧ソケットの切断通知は
       * disconnect 側で「現在の socketId と一致しない」として無視される */
      /* 再接続 join が旧ソケットの切断検出より先に届いた場合の後処理:
       * 旧ソケットがまだ生きている（切断イベントが来ていない）状態で
       * 別のソケットから join されたら、その時点で「旧接続の切断が
       * 完了した」ものとして、切断経路と共通の後処理を先に走らせる。
       * これをしないと eliminated だけが立ち、手札の再配分・手番送り・
       * 全滅判定が走らず、手番がゴーストに塩漬けになる（実測再現あり）。
       * 旧ソケットの切断が既に処理済みなら eliminated が立っているため
       * ここには入らない（後処理の二重実行はない） */
      const oldSocketId = me.socketId;
      if (oldSocketId && oldSocketId !== socket.id && participants.includes(me.id)
        && phase !== 'lobby' && phase !== 'result' && !me.eliminated) {
        handleParticipantDrop(me);
      }
      me.socketId = socket.id; me.connected = true;
      if (oldSocketId && oldSocketId !== socket.id) {
        const oldSock = io.sockets.sockets.get(oldSocketId);
        if (oldSock) oldSock.disconnect(true);
      }
      /* リザルト閲覧中に誰かが再戦してロビーへ戻った後で再接続すると、
       * inResult が残ったままになり、結果画面（result フェーズでしか
       * 描画されない）も「参加する」ボタン（inResult で無効化）も
       * 使えない詰み状態になっていた。フェーズがロビーなら結果画面は
       * 存在しないので、再接続の時点で inResult を解除する */
      if (phase === 'lobby' && me.inResult) me.inResult = false;
      /* 再接続時も名前の重複を解消する: 以前は settings.name で無条件に
       * 上書きしていたため、同一ブラウザの複数タブ等で重複名が復活した。
       * 本人自身は競合として扱わない */
      if (name) me.name = uniquePlayerName(String(name).slice(0, 16), me.id);
      // 試合中の再接続はゴースト復帰（脱落は解除しない・仕様17.4）
      if (participants.includes(me.id) && phase !== 'lobby' && phase !== 'result') { me.eliminated = true; }
      if (!hostId) hostId = me.id;
    } else {
      const used = new Set([...players.values()].filter(p => p.connected || participants.includes(p.id)).map(p => p.colorIdx));
      let colorIdx = PALETTE.findIndex((_, i) => !used.has(i)); if (colorIdx < 0) colorIdx = Math.floor(Math.random() * 10);
      // 初期プレイヤー名はルーム内で被らないようにする（項目1）
      let baseName = String(name || 'プレイヤー').slice(0, 16) || 'プレイヤー';
      const uniqueName = uniquePlayerName(baseName, null);
      me = {
        id: sessionId, pub: newPub(), socketId: socket.id, name: uniqueName,
        colorIdx, entered: false, connected: true, isBot: false, joinOrder: ++joinSeq,
        hand: [], role: null, camp: null, eliminated: false, inResult: false, spectator: false,
        pos: { ...START_POS }, vel: { x: 0, y: 0, z: 0 }, passLocked: false, lastSeenAt: now(), serverPosAt: now(), moving: false, airborne: false, posHistory: [],
      };
      players.set(me.id, me);
      if (!hostId) hostId = me.id;
      if (phase !== 'lobby' && phase !== 'result') me.spectator = true; // 試合中の入室者は観戦者
    }
    // アスレチック中の観戦者にはゴーストキャラクターのスポーンを割り当てる（項目4）
    if (me.spectator && phase === 'athletic') assignSpectatorSpawn(me);
    // 再接続も状態変化点: 配置フェーズなら「現在の状態」で村人陣営の全滅を判定する。
    // 戻ってきた村人が生存している構成では当然終了しない
    if (phase === 'place') endGameIfVillagerCampWipedOut('配置フェーズで村人陣営が全員ゴースト状態になりました');
    socket.emit('joined', { id: me.pub, isHost: me.id === hostId, name: me.name });
    syncAll();
    // 配置フェーズで自分の番がBOT/切断で止まっていた場合の回復は advanceTurn の通常経路に任せる
    if (phase === 'guard' && guardCurrent === me.id) sendPrivate(me);
  });

  const guard_ = (fn) => (d) => { if (me) fn(d || {}); }; // 引数なしのパケットは空オブジェクトとして扱う

  on('name:change', guard_(({ name }) => { if (name) { me.name = String(name).slice(0, 16); syncAll(); } }));
  on('lobby:toggleEntry', guard_(() => {
    if (phase !== 'lobby' && phase !== 'result') { me.spectator = true; toast(me.id, '試合中は観戦者として参加しています'); syncAll(); return; }
    if (me.inResult) { toast(me.id, '結果画面からは「再戦」または「退出」でロビーへ戻ってください'); return; }
    if (!me.entered) {
      if (enteredPlayers().length >= 10) { toast(me.id, `エントリー上限（10人）に達しています（現在 ${enteredPlayers().length} 人）`); return; }
      me.entered = true; me.spectator = false;
    } else me.entered = false;
    syncAll();
  }));
  on('rule:set', guard_((cfg) => {
    if (me.id !== hostId) return;
    /* ルール設定はロビーと結果（再戦準備）フェーズでのみ受理する。
     * 以前はフェーズ制限がなく、試合中に timeMin 等を変えると
     * 終了時メッセージの分数が実際の制限時間とずれる等の不整合が出た */
    if (phase !== 'lobby' && phase !== 'result') { toast(me.id, 'ルール設定はロビーでのみ変更できます'); return; }
    /* 役職範囲の検証人数は「この rule:set で BOT 数変更を適用した後の
     * 人数」で行う。以前は BOT 変更前のエントリー数で検証していたため、
     * 人間3人の状態で「BOTを4人増やして人狼を2人にする」設定が
     * （7人分の範囲ではなく）3人分の範囲で弾かれ、モーダルを開き直して
     * 2回に分けないと設定できなかった */
    const enteredNow = enteredPlayers();
    const humansEntered = enteredNow.filter(p => !p.isBot).length;
    const n = enteredNow.length;
    const next = { knight: cfg.knight | 0, madman: cfg.madman | 0, wolf: cfg.wolf | 0, timeMin: ruleConfig.timeMin || 5, botCount: ruleConfig.botCount || 0, gauge: ruleConfig.gauge === true, chargePower: clampChargePower(ruleConfig.chargePower) ?? 1.0 };
    if (cfg.timeMin !== undefined) {
      const tm = Math.round(Number(cfg.timeMin));
      if (!Number.isFinite(tm) || tm < 1 || tm > 10) { toast(me.id, 'アスレチック制限時間は1〜10分で設定してください'); return; }
      next.timeMin = tm; // 1〜10分・1分刻みスライダー
    }
    if (cfg.botCount !== undefined) {
      const bc = Math.round(Number(cfg.botCount));
      if (!Number.isFinite(bc) || bc < 0 || bc > 9) { toast(me.id, 'BOT人数は0〜9人で設定してください'); return; }
      next.botCount = bc;
    }
    if (cfg.gauge !== undefined) next.gauge = !!cfg.gauge; // 倍率ゲージ表示（初期OFF）
    if (cfg.chargePower !== undefined) {
      const cp = clampChargePower(cfg.chargePower); // 0.5〜3.0・0.1刻みにクランプ/丸め
      if (cp === null) { toast(me.id, '溜めジャンプ力は0.5〜3.0倍で設定してください'); return; }
      next.chargePower = cp;
    }
    // BOT数変更後の人数（人間エントリー＋設定BOT数。参加枠の上限10で頭打ち）
    const nAfter = Math.min(10, humansEntered + next.botCount);
    /* 検証は表示範囲と一致させる: エントリーが2人以下でもモーダルには
     * 3人用の範囲が表示される（fillRuleRanges が Math.max(3, 人数) で表示）
     * ため、検証人数も最低3人として3人用の範囲・上限をそのまま適用する。
     * 以前は「人数が3未満のときはエラーを捨てて緩く保持し、開始時に
     * 再検証する」扱いで、2人以下のロビーでは範囲外の役職設定が警告なく
     * 決定できてしまっていた（開始時再検証は game:start に残っている） */
    const err = validateRules(Math.max(nAfter, 3), next);
    if (err) { toast(me.id, err); return; }
    ruleConfig = next;
    const actualBots = syncBotsToRule(); // ロビー/リザルト時: ルーム内のBOT数を設定値に合わせて増減
    if (actualBots < next.botCount) {
      // 参加枠の上限で頭打ちになり指定数まで増やせなかった場合は、黙らずホストへ知らせる
      toast(me.id, `BOTは参加人数の上限（10人）のため ${actualBots} 人までしか追加できませんでした`);
    }
    syncAll();
  }));
  on('game:start', guard_(() => {
    if (me.id !== hostId) return;
    if (phase !== 'lobby' && phase !== 'result') return;
    if (!me.entered || me.inResult) { toast(me.id, 'ホストがエントリーしていないため開始できません'); return; }
    const n = enteredPlayers().length;
    if (n < 3) { toast(me.id, 'エントリーが3人以上必要です'); return; }
    const err = validateRules(n, ruleConfig);
    if (err) { toast(me.id, err); return; } // 開始時再検証（仕様19.5）
    startGame();
  }));
  on('place:place', guard_((d) => {
    if (!d.pos || ![d.pos.x, d.pos.y, d.pos.z].every(Number.isFinite)) { toast(me.id, '配置できません（手番・手札・範囲を確認してください）'); return; }
    if (!doPlace(me, d.type, d.pos, d.end, d.rot, d.phaseOffset)) toast(me.id, '配置できません（手番・手札・範囲を確認してください）');
    else syncAll();
  }));
  on('place:pass', guard_(() => {
    if (phase !== 'place' || voteSession || currentTurnPlayer() !== me) return;
    if (!canPass(me)) { toast(me.id, '全員がパスした後のため、パスできません。足場を配置してください'); return; }
    me.passLocked = true; // 次に誰かが配置するまで保持される
    advanceTurn();
  }));
  on('vote:trigger', guard_(() => {
    // 配置フェーズ中、自分の手番に1ゲーム1回だけ投票イベントを発生させられる（手番は消費しない）
    if (phase !== 'place' || voteSession) return;
    if (!participants.includes(me.id) || me.eliminated) return;
    if (currentTurnPlayer() !== me) { toast(me.id, '投票イベントは自分の手番にだけ発生させられます'); return; }
    if (me.voteTriggerUsed) { toast(me.id, '投票イベントは1ゲームに1回までです'); return; }
    me.voteTriggerUsed = true;
    startVoteSession('trigger', me.id);
  }));
  on('vote:submit', guard_((d) => {
    if (!voteSession || !participants.includes(me.id) || me.eliminated) return;
    if (votes.has(me.id)) { toast(me.id, '投票は送信済みのため変更できません'); return; } // 投票後の選び直しをサーバーでも拒否
    const targets = [...new Set((Array.isArray(d.targets) ? d.targets : []).map(t => playerByPub(t)).filter(q => q && participants.includes(q.id) && !q.eliminated).map(q => q.id))]; // クライアントからは公開IDで届くため内部IDへ解決する
    // 1人だけ選ぶか、誰にも投票しない（パス）かのどちらか（1人1票制）
    if (targets.length !== 0 && targets.length !== 1) { toast(me.id, '投票は 1 人だけ選ぶか、パスしてください（重複不可）'); return; }
    votes.set(me.id, targets);
    syncAll();
    checkVoteComplete();
  }));
  on('guard:pick', guard_((d) => guardPick(me.id, d.platformId)));
  on('destroy:pick', guard_((d) => destroyPick(me.id, d.platformId)));
  on('platform:stand', guard_((d) => {
    if (phase !== 'athletic' || !participants.includes(me.id) || me.eliminated) return; // ゴースト（観戦者含む）はトリガーしない
    const pl = placed.find(x => x.id === d.platformId);
    if (!pl || pl.type !== 'chikuwa') return;
    /* 発動判定も triggerAt ベースで決める: 現在のサイクルが終わっている
     * （未発動、または発動から5.2秒以上経過）場合だけ新しい発動として
     * 記録する。サーバーが状態を消す方式だと、消去タイミングと同期の
     * 到着の差で「乗ったのに発動しない」窓ができていた */
    const prev = chikuwaState.get(pl.id);
    if (!prev || now() - prev >= 5200) { chikuwaState.set(pl.id, now()); syncAll(); }
  }));
  on('pos:update', guard_((d) => {
    if (phase !== 'athletic' || !d.pos || ![d.pos.x, d.pos.y, d.pos.z].every(Number.isFinite)) return;
    // 参加者に加え、観戦者（常時ゴースト）の位置申告も受け付ける（項目4）。
    // 観戦者は押し合い・ゴール判定の対象からは外す
    const isPart = participants.includes(me.id);
    if (!isPart && !me.spectator) return;
    me.pos = { x: clamp(d.pos.x, -60, 60), y: clamp(d.pos.y, -30, 260), z: clamp(d.pos.z, -40, 40) }; // y上限は溜めジャンプ（最大約10倍）の跳躍高度を他クライアントにも見せるため広げる
    me._groundedSrv = false; // 本人が申告してきた=サーバー代行の着地フラグは無効化
    pushPosHistory(me, now()); // パンチ判定のラグ補償用に履歴を残す
    if (Number.isFinite(d.yaw)) me.yaw = d.yaw;
    me.svx = 0; me.svz = 0; // クライアントが申告してきた=本人が制御中なのでサーバー代行速度は破棄
    // 生存プレイヤー同士の押し合い（項目15）: 他の生存参加者と重なっていたら申告者を外へ押し出す
    if (isPart && !me.eliminated) {
      for (const id of participants) {
        if (id === me.id) continue;
        const q = players.get(id); if (!q || q.eliminated) continue;
        const dx = me.pos.x - q.pos.x, dz = me.pos.z - q.pos.z;
        const dist = Math.hypot(dx, dz), minDist = PLAYER_RADIUS * 2;
        if (dist < minDist && Math.abs(me.pos.y - q.pos.y) < 1.6) {
          const ux = dist > 0.001 ? dx / dist : 1, uz = dist > 0.001 ? dz / dist : 0;
          me.pos.x = q.pos.x + ux * minDist; me.pos.z = q.pos.z + uz * minDist;
        }
      }
    }
    me.moving = !!d.moving; me.airborne = !!d.airborne; me.lastSeenAt = now(); me.serverPosAt = me.lastSeenAt; // 位置が申告された=サーバー保持位置が更新された（補間キー）
    if (isPart) checkGoal(me); // ゴール判定は参加者だけ（観戦者は勝敗に影響しない・項目4）
  }));
  on('player:fall', guard_(() => {
    if (phase !== 'athletic') return;
    if (!participants.includes(me.id)) {
      // 観戦者（常時ゴースト）の落下: 脱落にはせず、ゴーストのままスポーンへ戻す（項目4）。
      // 以前は参加者以外からの落下申告を無視していたため、観戦者は落下したまま戻れなかった
      if (!me.spectator) return;
      if (me.respawnLatchUntil && now() < me.respawnLatchUntil) {
        socket.emit('resync:pos', { pos: me.pos, clearAction: true });
        return;
      }
      assignSpectatorSpawn(me);
      me.respawnLatchUntil = now() + 1000;
      socket.emit('resync:pos', { pos: me.pos, clearAction: true });
      return;
    }
    if (me.respawnLatchUntil && now() < me.respawnLatchUntil) {
      // 重複申告: 確定座標を即通知（仕様15.4）
      socket.emit('resync:pos', { pos: me.pos, clearAction: true });
      return;
    }
    eliminate(me, 'fall');
    socket.emit('resync:pos', { pos: me.pos, clearAction: true });
    syncAll();
  }));
  on('punch', guard_((d) => {
    if (phase !== 'athletic') return;
    if (!participants.includes(me.id)) return; // 観戦者（ゴースト）はパンチできない（項目4）
    if (now() < goAt) return; // カウントダウン中はサーバーでも無効（仕様13.2）
    if (me.eliminated) return;
    // モーション完了（420ms）までは次のパンチを出せない（項目17: サーバー側クールダウン）。
    // ただしサーバー側の受理間隔はクライアントの送信間隔より短い
    // PUNCH_SERVER_COOLDOWN_MS（370ms）を使う。到着ジッタで 420ms を
    // わずかに切った正規の連打を取りこぼさないため（定数の定義箇所参照）
    if (now() - (me.lastPunchAt || 0) < PUNCH_SERVER_COOLDOWN_MS) return;
    me.lastPunchAt = now();
    io.emit('punch:fx', { from: me.pub }); // モーション同期（命中しなくても腕は振る）
    const target = playerByPub(d.targetId); // 対象は公開IDで届くため内部プレイヤーへ解決する
    if (!target || target.eliminated || !participants.includes(target.id)) return;
    const yaw = Number.isFinite(d.yaw) ? d.yaw : (me.yaw || 0);
    // 判定は拳の見た目に合わせて狭める（項目16）: 前方至近のみ。
    // ラグ補償として被弾側の直近240msの位置履歴でも判定する
    const hit = resolvePunchHit(me, target, yaw);
    if (!hit) return;
    const { dx, dz } = hit;
    const len = hit.dist2d || 1;
    const kb = { x: (dx / len) * PUNCH_KB_DIST, z: (dz / len) * PUNCH_KB_DIST }; // ノックバック量はキャラ幅(0.8)の4体分=3.2m（従来の2倍）
    // 即時テレポートではなく速度として与える。非アクティブな相手にはサーバー物理代行が
    // この速度を使って足場判定・重力・落下まで進める（項目20）。アクティブな相手は
    // knockback イベントを受けたクライアント自身が同じ量だけ移動して申告する
    target.svx = (dx / len) * PUNCH_KB_SPEED; target.svz = (dz / len) * PUNCH_KB_SPEED;
    target.knockback = kb;
    if (target.socketId) io.to(target.socketId).emit('knockback', { dir: kb, dist: PUNCH_KB_DIST });
  }));
  on('charge:fx', guard_((d) => {
    // 溜めジャンプの溜め開始/キャンセルの同期（他プレイヤーにも溜めポーズを見せる）。
    // 物理そのものは各クライアントが自キャラ分を処理し、サーバーの物理代行では再現しない
    if (phase !== 'athletic' || !participants.includes(me.id)) return;
    const state = d && (d.state === 'start' || d.state === 'cancel') ? d.state : null;
    if (!state) return;
    socket.broadcast.emit('charge:fx', { from: me.pub, state });
  }));
  on('chargejump:fx', guard_((d) => {
    // 溜めジャンプの発動同期（発動時刻は受信側の時計で打つため倍率だけを運ぶ）
    if (phase !== 'athletic' || !participants.includes(me.id)) return;
    const mult = Number(d && d.mult);
    socket.broadcast.emit('chargejump:fx', { from: me.pub, mult: Number.isFinite(mult) ? mult : 1 });
  }));
  on('time:ping', guard_((d) => {
    /* 時刻同期専用の ping/pong: クライアント送信時刻 c0 をそのまま返し、
     * クライアント側で RTT の半分を差し引いたオフセット推定
     * （TimeSync.pingOffset）に使う。state:sync の serverTime は
     * 片道遅延の全量だけずれるため、補正の主経路はこちらにする */
    socket.emit('time:pong', { c0: d ? d.c0 : undefined, serverTime: now() });
  }));
  on('resync', guard_(() => {
    // タブ復帰: サーバー保持位置を正とし、速度・ノックバック・未完了アクションをクリア（仕様15.1/15.2）
    me.vel = { x: 0, y: 0, z: 0 }; me.knockback = null;
    socket.emit('resync:pos', { pos: me.pos, clearAction: true });
  }));
  on('result:rematch', guard_(() => {
    if (!me.inResult) return;
    /* 試合中は受け付けない: リザルトに残っていた人が試合開始後に
     * 「再戦」を押すと、試合中なのにエントリー扱いになり entryCount が
     * 増減する不整合が起きていた（そのような人は game:start の時点で
     * 自動で観戦者へ移行する）。ロビーでは従来どおり受理する */
    if (phase !== 'result' && phase !== 'lobby') return;
    if (enteredPlayers().length >= 10) { toast(me.id, `エントリー上限（10人）に達しています（現在 ${enteredPlayers().length} 人）`); return; }
    me.inResult = false; me.entered = true; me.spectator = false;
    if (phase === 'result' && ![...players.values()].some(p => p.inResult)) phase = 'lobby';
    if (phase === 'result') phase = 'lobby'; // ロビーへ戻る人が出たら画面遷移先はロビーとして扱う
    syncAll();
  }));
  on('result:exit', guard_(() => {
    if (!me.inResult) return;
    if (phase !== 'result' && phase !== 'lobby') return; // 試合中は受け付けない（result:rematch と同じ）
    const wasHost = me.id === hostId;
    me.inResult = false; me.entered = false;
    if (phase === 'result') phase = 'lobby';
    if (wasHost) reassignHost(me.id); // 自発的退出時のみ委譲（仕様18.4.2）
    syncAll();
  }));
  on('host:forceEnd', guard_(() => {
    if (me.id !== hostId) return;
    if (['lobby', 'result'].includes(phase)) return;
    endGame(null, 'ホストによる強制終了', now());
  }));

  on('disconnect', () => {
    if (!me) return;
    /* 旧ソケットの遅延切断通知を無視する: 再接続で socketId が新しい
     * ソケットへ付け替わっている場合、この切断は現在の接続に対する
     * ものではない。無条件に処理すると、生きている本人が一覧から消え
     * （ロビー）、試合中なら切断脱落の後処理まで連鎖してしまう */
    if (me.socketId !== socket.id) return;
    me.connected = false; me.socketId = null;
    const wasHost = me.id === hostId;
    if (phase !== 'lobby' && phase !== 'result' && participants.includes(me.id)) {
      handleParticipantDrop(me); // 脱落化と後処理（再接続join先行時と共通の関数）
    }
    if (wasHost) reassignHost(me.id);
    if (phase === 'lobby' || phase === 'result') {
      if (!me.inResult) players.delete(me.id); // ロビーでの切断は記録を消す（カラー解放）
      if (![...players.values()].some(p => p.connected)) { hostId = null; }
    }
    syncAll();
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`アスレチック人狼サーバー: http://localhost:${PORT}`));
module.exports = { slideFactorAt, rotMatrixXYZ, rotAABBHalf, obbTopAt, longTopAt, chikuwaFallDy, spawnPos, START_POS, athleticStartTimes, VOTE_RESULT_PANEL_MS, VOTE_RESULT_PANEL_SHORT_MS, COUNTDOWN_LEAD_MS, PUNCH_KB_SPEED, PUNCH_KB_DIST, PUNCH_LAG_MS, PUNCH_COOLDOWN_MS, PUNCH_SERVER_COOLDOWN_MS, clampChargePower, platformApproxPos, placementForbidden, placementForbiddenFull, distributeCards, punchHitAt, resolvePunchHit };
