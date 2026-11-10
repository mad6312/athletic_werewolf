'use strict';
/* PS4コントローラーのボタン対応（純粋関数モジュール: ブラウザ/Node共通）
 *
 * Gamepad API の standard mapping では index は
 *   0=×(下), 1=○(右), 2=□(左), 3=△(上), 4=L1, 5=R1, 6=L2, 7=R2,
 *   8=SHARE, 9=OPTIONS, 10=L3, 11=R3, 12=↑, 13=↓, 14=←, 15=→, 16=PS
 * が正しい対応。
 *
 * しかし DualShock 4 は接続方法・ブラウザによって pad.mapping が 'standard' に
 * ならず、生の並び（0=□, 1=×, 2=○, 3=△, 4=L1, ...）のまま届くことがある。
 * その生 index を標準のつもりで読むと、ボタン0〜2が循環的にずれて
 * 「×が○に、○が□に、□が×になる」現象が起きる（項目5の不具合の原因）。
 *
 * そのためパッド入力は必ず raw index → standard index へ正規化してから使い、
 * ボタン名テーブル・割当表示・ゲーム入力のすべてが標準 index で一致するようにする。
 */
(function (global) {
  var STANDARD_NAMES = ['×', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'SHARE', 'OPTIONS', 'L3', 'R3', '↑', '↓', '←', '→', 'PS'];
  /* DualShock 4 の生並び index → standard index（ずれるのはボタン0〜2のみ） */
  var DS4_RAW_TO_STANDARD = [2, 0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  function standardButtonIndex(rawIndex, mapping) {
    if (mapping === 'standard') return rawIndex;
    var m = DS4_RAW_TO_STANDARD[rawIndex];
    return m === undefined ? rawIndex : m;
  }
  function padButtonName(stdIndex) { return STANDARD_NAMES[stdIndex] || ('ボタン' + stdIndex); }
  /* スティック軸の「静止位置（ニュートラル）」を記録する。
   * Gamepad API の軸は、スティックの個体差（ドリフト）や非標準マッピングの
   * 軸割当によって、触っていないのに 0 でない値を返し続けることがある。
   * その生値をそのまま入力として使うと、毎フレーム一定方向へ入力が入り続け、
   * カメラが端まで寄って固定される（アスレチック開始直後の足元固定の原因）。
   * 静止時の値をニュートラルとして差し引くことで、静止オフセットを無効化する */
  function captureNeutral(axes) {
    var out = [];
    var a = axes || [];
    for (var i = 0; i < a.length; i++) {
      var v = Number(a[i]);
      out.push(Number.isFinite(v) ? v : 0);
    }
    return out;
  }
  /* 生の軸配列からニュートラルを差し引いた配列を返す（各値は [-1, 1] にクランプ）。
   * neutral が無い軸は 0 として扱う。ドリフトした軸は静止時 0 になり、
   * 実際に倒した分だけが入力として残る */
  function centerAxes(axes, neutral) {
    var out = [];
    var a = axes || [];
    for (var i = 0; i < a.length; i++) {
      var raw = Number(a[i]);
      if (!Number.isFinite(raw)) raw = 0;
      var n = neutral ? Number(neutral[i]) : 0;
      if (!Number.isFinite(n)) n = 0;
      var v = raw - n;
      out.push(v > 1 ? 1 : (v < -1 ? -1 : v));
    }
    return out;
  }
  /* DS4生並び（非標準マッピング）環境の軸レイアウト検出。
   * 一部のドライバ経由（Linux系など）では、DualShock 4 の軸が
   *   [LX, LY, RX, L2, R2, RY, ...]
   * の順で届き、右スティックYが index 5、トリガー軸（静止時 -1）が
   * index 3, 4 を占める。この並びのまま index 3 を右スティックYとして
   * 読むと、静止したトリガー軸を読み続けることになる。校正が無い時代は
   * 静止値 -1 が毎フレーム回転入力になり視点が端に固定され、校正導入後は
   * 静止値 -1 が差し引かれて実効値が常時 0 になり、ピッチだけが完全に
   * 反応しなくなった（水平＝index 2 はどちらの並びでも右スティックXで
   * あるため正常に効く）。
   * トリガー2軸がそろって静止端（<=-0.9）にあることを、この並びの
   * 署名として検出する。standard mapping では常に false */
  function isTriggerInterleaved(axes, mapping) {
    if (mapping === 'standard' || !axes || axes.length < 6) return false;
    return Number(axes[3]) <= -0.9 && Number(axes[4]) <= -0.9;
  }
  var AXIS_ORDER_STANDARD = [0, 1, 2, 3];
  var AXIS_ORDER_INTERLEAVED = [0, 1, 2, 5]; /* 右スティックYはトリガー軸の後ろ */
  /* 軸配列を「標準のスティック順 [LX, LY, RX, RY]」に並べ替えた配列を返す。
   * interleaved は isTriggerInterleaved の検出結果（一度検出したらその
   * パッドではラッチして使うこと。トリガー押下中は署名が消えるため、
   * フレームごとに判定すると並びが往復してしまう） */
  function standardAxes(axes, interleaved) {
    var order = interleaved ? AXIS_ORDER_INTERLEAVED : AXIS_ORDER_STANDARD;
    var out = [];
    for (var k = 0; k < 4; k++) {
      var v = axes ? Number(axes[order[k]]) : 0;
      out.push(Number.isFinite(v) ? v : 0);
    }
    return out;
  }
  /* スティック静止位置（ニュートラル）の「安定性ゲート付き」キャリブレータ。
   *
   * 旧方式（初回観測で即時記録／フェーズ入場・再接続で保留付き再記録）には
   * 次の穴が残っていた:
   *  - 初回観測の瞬間に軸がまだ未確定（全0）だと、その後現れる本来の
   *    静止オフセット（ドリフト）が校正されないまま残り、アスレチック
   *    開始と同時にキャラやカメラが勝手に動き続けた。再接続すると
   *    「たまたま良いタイミング」で取り直せるため治って見えた。
   *  - フォーカス復帰直後などの一過性の値で固定される可能性もあった。
   *
   * 本方式は「値が安定してから確定する」ことを全経路の原則にする:
   *  - 候補値: 軸ごとに、±0.02 以内の変動が続く時間を「安定時間」として
   *    数える。値が動けば候補は作り直し（平均もリセット）。
   *  - 初回キャプチャ（このパッドを初めて見た直後のウィンドウ）:
   *    安定 150ms で採用する。大きさを問わない（大きなドリフトの無効化の
   *    ため。ただし飽和 |値|>0.98 は静止値として採用しない）。ただし
   *    この無条件採用は「初めて見たときから一貫してその値だった」軸に
   *    限る。一度でも違う値が観測された軸は、未確定のうちにスティックを
   *    倒された可能性を排除できないため、小さな値（<=0.45）だけを
   *    慎重に採用する（倒した状態の混入防止）。確定後の差し替えも
   *    小さな値のみで、「全0 → 遅れて現れる現実的な大きさのオフセット」
   *    はウィンドウ内に拾い直す。
   *  - 通常時のドリフト追従（試合中も常時）: 確定済みの静止値と異なる
   *    候補が「|候補|<=0.5 の小さな値」のまま 2.5秒安定したら、その値を
   *    新しい静止値として採用する。これにより試合中でも自動回復する。
   *    大きく倒した入力（全速前進=±1 等）は |候補| の上限で絶対に採用
   *    されない。
   *  - 再接続時は保存済みの確定値を初期値として復元し（initial には
   *    しない）、以降はドリフト追従の規則だけで更新する。「倒したまま
   *    再接続」しても、倒した値は上限規則で採用されない。
   *  - 保持入力の誤採用ガード（held）: ドリフト追従だけでは「小さな
   *    一定の倒しを2.5秒以上保持する操作」とドリフトを区別できない。
   *    実際に、傾けた細長の頂点でバランスを取るような小さな一定倒し
   *    （0.25〜0.45）を数秒保持すると、その値が静止値として採用され、
   *    スティックを離した後に逆向きの入力が残り続けてキャラが勝手に
   *    動き出す事故が起きた（保持 0.40 で約4秒後に neutral=0.400 まで
   *    中毒し、離した後の実効入力が -0.400 になることを実測）。
   *    人の手でスティックを倒すと、値は必ず「滑らかに移動」して目標値に
   *    到達する（フレーム間の変化が BAND 以下のまま、合計 0.06 以上
   *    移動する）。一方、本物の静止オフセットは触れていないスティック
   *    から現れるため、一段のステップとして現れるか、最初からその値で
   *    ある。そのため、直近ウィンドウ内に「滑らかな移動の痕跡」が
   *    ある軸は held（保持エピソード中）とみなし、そのエピソード中の
   *    候補はドリフト追従・ウィンドウ内差し替えの対象から外す。
   *    held はスティックが静止ゾーン（確定値の近く）に戻って 300ms
   *    経つと解除される（＝手を離せば次のドリフトは再び拾える）。
   *    一段で跳ぶ変化（デバイス側の都合で現れるオフセット）は移動の
   *    痕跡にならないため、従来どおり自動回復の対象になる。
   *
   * 使い方: createCalibrator(savedNeutral|null) → { push(axes, dtMs), neutral(), confirmed() }
   * push は毎フレーム呼び、戻り値（実効ニュートラル配列）を centerAxes に渡す */
  var CAL = {
    BAND: 0.02,            // 安定とみなす変動幅
    INITIAL_WINDOW_MS: 1500, // 初回キャプチャウィンドウ
    INITIAL_STABLE_MS: 150,  // 初回採用に必要な安定時間
    DRIFT_STABLE_MS: 2500,   // ドリフト追従の採用に必要な安定時間
    DRIFT_MAX: 0.5,          // ドリフト追従で採用する候補の大きさ上限
    FRESH_MAX: 0.45,         // 未確定軸を通常時に確定させる候補の大きさ上限
    SATURATION: 0.98,        // これを超える値は静止値として採用しない
    MIN_SHIFT: 0.04,         // ドリフトとみなす最小のずれ
    REST_EPS: 0.06,          // 確定値からこの範囲内なら「静止ゾーン」にいるとみなす
    TRAVEL_WINDOW_MS: 700,   // 移動の痕跡を探す直近ウィンドウ
    TRAVEL_SPAN_MS: 80,      // 移動とみなす2点間の最小時間
    TRAVEL_DIST: 0.06,       // 滑らかな移動とみなす変位の大きさ
    REST_CLEAR_MS: 300,      // 静止ゾーンに留まり続けたら held を解除する時間
  };
  function createCalibrator(savedNeutral) {
    var hasSaved = !!(savedNeutral && savedNeutral.length);
    var neutral = hasSaved ? savedNeutral.slice() : []; // 確定値（未確定の要素は undefined）
    var tainted = []; // その軸で「最初の候補と異なる値」が観測されたか
    var cand = [];   // {val, stableMs, sum, n, clean}
    var hist = [];   // 軸ごとの直近サンプル [{t, v}]（移動の痕跡の検出用）
    var held = [];   // 保持エピソード中（人の手による移動の痕跡あり）とみなす軸か
    var restMs = []; // 静止ゾーンに連続して留まっている時間
    var firstAnchor = []; // その軸で最初に形成された候補の値（未確定軸の held 解除の目安）
    var elapsed = 0;
    var initial = !hasSaved; // 保存値がある（再接続）場合は初回ウィンドウを使わない
    function effective() {
      var out = [];
      var n = Math.max(neutral.length, cand.length);
      for (var i = 0; i < n; i++) out.push(Number.isFinite(neutral[i]) ? neutral[i] : 0);
      return out;
    }
    /* 直近ウィンドウ内に「人の手による移動の痕跡」があったかを返す。
     * 手でスティックを倒すと、値は複数フレームに分かれて段階的に移動する
     * （速い倒しでも1フレームの変化は小さい）。そのため「0.15以下の小さな
     * 変化が2回以上連なって、TRAVEL_SPAN_MS 以上の時間をかけ、合計
     * TRAVEL_DIST 以上移動した区間」があれば保持操作とみなす。
     * 一段で跳ぶデバイス側の変化（1回の大きな変化で完了する）は痕跡に
     * ならず、微小なセンサーノイズ（変位が TRAVEL_DIST 未満）もならない */
    function hasSmoothTravel(hp) {
      for (var s = 0; s < hp.length; s++) {
        var mn = hp[s].v, mx = hp[s].v, steps = 0;
        for (var k = s + 1; k < hp.length; k++) {
          var d = Math.abs(hp[k].v - hp[k - 1].v);
          if (d > 0.15) break; // 一段の大きな跳びを含む区間は「段階的な移動」ではない
          if (d > 0.004) steps++;
          if (hp[k].v < mn) mn = hp[k].v;
          if (hp[k].v > mx) mx = hp[k].v;
          if (steps >= 2 && hp[k].t - hp[s].t >= CAL.TRAVEL_SPAN_MS && mx - mn > CAL.TRAVEL_DIST) return true;
        }
      }
      return false;
    }
    function push(axes, dtMs) {
      var a = axes || [];
      var dt = Number(dtMs);
      if (!Number.isFinite(dt) || dt < 0) dt = 0;
      if (dt > 250) dt = 250; // フレーム間隔の異常値は安定時間へ算入しすぎない
      elapsed += dt;
      if (elapsed > CAL.INITIAL_WINDOW_MS) initial = false;
      for (var i = 0; i < a.length; i++) {
        var raw = Number(a[i]);
        if (!Number.isFinite(raw)) raw = 0;
        /* --- 保持エピソード（held）の更新: 候補の更新より先に行い、
         * 保持が落ち着いたフレームで形成される候補にも効かせる --- */
        var hp = hist[i] || (hist[i] = []);
        hp.push({ t: elapsed, v: raw });
        while (hp.length && elapsed - hp[0].t > CAL.TRAVEL_WINDOW_MS) hp.shift();
        if (hasSmoothTravel(hp)) held[i] = true;
        var restRef = Number.isFinite(neutral[i]) ? neutral[i] : (firstAnchor[i] !== undefined ? firstAnchor[i] : null);
        if (restRef !== null && Math.abs(raw - restRef) <= CAL.REST_EPS) {
          restMs[i] = (restMs[i] || 0) + dt;
          if (restMs[i] >= CAL.REST_CLEAR_MS) held[i] = false; // 手を離して静止に戻ればエピソード終了
        } else restMs[i] = 0;
        /* --- 候補の更新 ---
         * 保持エピソード中は候補を毎フレーム作り直し、安定時間を一切
         * 蓄積させない。エピソード中のサンプルの平均は「保持の途中経過」
         * でしかなく、エピソード終了（手を離して held が解除された）直後に
         * その古い候補が採用されてしまうと、保持値寄りの値が静止値に
         * なるため（実測: 0.30保持→離した後に neutral=0.167 を採用） */
        var c = cand[i];
        if (held[i]) {
          if (c) tainted[i] = true;
          cand[i] = { val: raw, stableMs: 0, sum: raw, n: 1, clean: false }; c = cand[i];
          if (firstAnchor[i] === undefined) firstAnchor[i] = raw;
        }
        else if (!c || Math.abs(raw - c.val) > CAL.BAND) {
          if (c) tainted[i] = true; // 最初の候補と異なる値が来た（＝値が途中で変わった）軸は「汚染」扱い
          cand[i] = { val: raw, stableMs: 0, sum: raw, n: 1, clean: !held[i] }; c = cand[i];
          if (firstAnchor[i] === undefined) firstAnchor[i] = raw;
        }
        else { c.stableMs += dt; c.sum += raw; c.n += 1; c.val = raw; }
        var mean = c.sum / c.n;
        /* 保持エピソード中の候補は、大きさ・安定時間の条件を満たしても
         * 静止値として採用しない（バランス保持などの小さな一定倒しを
         * ドリフトと誤認しないため）。ステップ状に現れた本物のオフセット
         * は held にならないため、従来どおり採用される */
        var adoptable = c.clean && !held[i];
        if (!Number.isFinite(neutral[i])) {
          /* 未確定軸の初回採用。大きさを問わない採用（飽和のみ除外）は
           * 「パッドを初めて見たときから一貫してその値だった」軸に限る。
           * 一度でも違う値が観測された軸（例: 最初は未確定で全0、途中で
           * スティックを倒された）では、倒した状態を静止値として記録
           * しないよう、小さな値（<=0.45）だけを慎重に採用する */
          var permissive = initial && !tainted[i];
          if (adoptable && c.stableMs >= (permissive ? CAL.INITIAL_STABLE_MS : 300) && Math.abs(mean) <= (permissive ? CAL.SATURATION : CAL.FRESH_MAX)) neutral[i] = mean;
        } else if (initial) {
          if (adoptable && Math.abs(mean - neutral[i]) > CAL.MIN_SHIFT && c.stableMs >= CAL.INITIAL_STABLE_MS && Math.abs(mean) <= CAL.FRESH_MAX) {
            /* ウィンドウ内の差し替えは小さな値（<=0.45）のみ: 「最初は
             * 未確定（全0）→ 遅れて本来のオフセットが現れる」ケースの
             * うち現実的な大きさのものはここで拾う。大きな値への差し替えは
             * 認めない（パッド観測直後にスティックを倒したままにされると、
             * 倒した状態を静止値として記録してしまう＝中毒するため。
             * 初回観測の時点で既に現れている大きなオフセットは、上の
             * 初回採用で無効化される） */
            neutral[i] = mean;
          }
        } else if (adoptable && Math.abs(mean - neutral[i]) > CAL.MIN_SHIFT && Math.abs(mean) <= CAL.DRIFT_MAX && c.stableMs >= CAL.DRIFT_STABLE_MS) {
          /* ドリフト追従: 小さな一定値（|値|<=0.5）が2.5秒安定したら
           * 静止値として再校正する（試合中の自動回復）。これより大きな
           * 値は、どれだけ長く安定していても採用しない: 試合中に
           * スティックを倒したまま保持し続ける操作（カメラを向け続ける等）
           * を静止値と誤認しないため。保持エピソード中の候補は、上の
           * adoptable の条件でさらに除外される */
          neutral[i] = mean;
        }
      }
      return effective();
    }
    return {
      push: push,
      neutral: effective,
      confirmed: function () { return cand.every(function (_, i) { return Number.isFinite(neutral[i]); }) && cand.length > 0; },
      isInitial: function () { return initial; },
      _debug: function () { return { neutral: neutral.slice(), elapsed: elapsed, initial: initial }; },
    };
  }
  /* pad.buttons（生の並び）から「標準 index が押されているか」の真偽配列を作る */
  function standardPressed(pad) {
    var out = [];
    if (!pad || !pad.buttons) return out;
    for (var i = 0; i < pad.buttons.length; i++) {
      var b = pad.buttons[i];
      if (b && (b.pressed || b.value > 0.5)) out[standardButtonIndex(i, pad.mapping)] = true;
    }
    return out;
  }
  var api = {
    STANDARD_NAMES: STANDARD_NAMES,
    DS4_RAW_TO_STANDARD: DS4_RAW_TO_STANDARD,
    standardButtonIndex: standardButtonIndex,
    padButtonName: padButtonName,
    standardPressed: standardPressed,
    captureNeutral: captureNeutral,
    centerAxes: centerAxes,
    createCalibrator: createCalibrator,
    CAL: CAL,
    isTriggerInterleaved: isTriggerInterleaved,
    standardAxes: standardAxes,
  };
  global.PadMap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
