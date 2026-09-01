/* ===== audio.js — Web Audio 即時合成的背景音樂與音效 =====
 * 不需要任何外部音檔，所有聲音都是用振盪器＋噪音即時合成，
 * 因此沒有授權問題，也不會有載入失敗的狀況。要換成正式音檔時，
 * 只要保留 Sound.play / startBgm / stopBgm 這幾個介面即可。
 *
 * 瀏覽器規定必須在使用者第一次手勢之後才能播放聲音，
 * 所以 unlock() 會綁在第一次 pointerdown / keydown 上。
 */
(function (w) {
  'use strict';

  var ctx = null, master = null, musicGain = null, sfxGain = null;
  var musicOn = true, sfxOn = true, musicVolume = 0.7, sfxVolume = 1, hapticOn = true, chatCueOn = true;
  var timer = null, step = 0, nextTime = 0, curTrack = 'menu';
  var TEMPO = 84;                        // BPM，慢一點比較適合動腦
  var STEP = 15 / TEMPO;                 // 十六分音符秒數

  var KEY = {
    music: 'sd_music', sfx: 'sd_sfx',
    musicVol: 'sd_music_volume', sfxVol: 'sd_sfx_volume',
    haptic: 'sd_haptic', chatCue: 'sd_chat_cue'
  };

  function loadFlag(k, d) {
    try { var v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch (e) { return d; }
  }
  function saveFlag(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} }
  function loadVolume(k, d) {
    try {
      var v = parseFloat(localStorage.getItem(k));
      return isFinite(v) ? Math.max(0, Math.min(1, v)) : d;
    } catch (e) { return d; }
  }
  function saveVolume(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }

  musicOn = loadFlag(KEY.music, true);
  sfxOn = loadFlag(KEY.sfx, true);
  musicVolume = loadVolume(KEY.musicVol, 0.7);
  sfxVolume = loadVolume(KEY.sfxVol, 1);
  hapticOn = loadFlag(KEY.haptic, true);
  chatCueOn = loadFlag(KEY.chatCue, true);

  function applyGain() {
    if (musicGain) musicGain.gain.value = musicOn ? 0.13 * musicVolume : 0;
    if (sfxGain) sfxGain.gain.value = sfxOn ? 0.5 * sfxVolume : 0;
  }

  function ensure() {
    if (ctx) return ctx;
    var AC = w.AudioContext || w.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    musicGain = ctx.createGain(); musicGain.connect(master);
    sfxGain = ctx.createGain(); sfxGain.connect(master);
    applyGain();
    return ctx;
  }
  function unlock() {
    ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  function isUnlocked() { return !!ctx && ctx.state === 'running'; }

  function hz(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  function tone(o) {
    if (!ctx) return;
    var t0 = o.t || ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = o.type || 'triangle';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + (o.dur || 0.2));
    var peak = o.v === undefined ? 0.5 : o.v;
    var atk = o.atk === undefined ? 0.008 : o.atk;
    var dur = o.dur || 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(o.bus || sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise(o) {
    if (!ctx) return;
    var t0 = o.t || ctx.currentTime, dur = o.dur || 0.12;
    var n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var bp = ctx.createBiquadFilter(); bp.type = o.type || 'bandpass';
    bp.frequency.value = o.f || 2200; bp.Q.value = o.q || 1.1;
    var g = ctx.createGain(); g.gain.value = o.v === undefined ? 0.28 : o.v;
    src.connect(bp); bp.connect(g); g.connect(o.bus || sfxGain);
    src.start(t0);
  }

  /* ---- 音效語彙：點擊、填入、筆記、錯誤、清除、復原、提示、完成一個宮、勝利、暫停 ---- */
  var SFX = {
    click: function (t) { tone({ t: t, f: 620, f2: 880, dur: 0.08, type: 'square', v: 0.24 }); },
    select: function (t) { tone({ t: t, f: 880, dur: 0.06, type: 'sine', v: 0.2 }); },
    place: function (t) {
      tone({ t: t, f: hz(76), dur: 0.16, type: 'triangle', v: 0.36 });
      tone({ t: t + 0.02, f: hz(83), dur: 0.2, type: 'sine', v: 0.16 });
    },
    note: function (t) { tone({ t: t, f: 1180, dur: 0.06, type: 'sine', v: 0.22 }); noise({ t: t, f: 4200, dur: 0.04, v: 0.06 }); },
    wrong: function (t) {
      tone({ t: t, f: 300, f2: 175, dur: 0.24, type: 'sawtooth', v: 0.2 });
      tone({ t: t + 0.02, f: 220, f2: 140, dur: 0.26, type: 'triangle', v: 0.2 });
    },
    blocked: function (t) { tone({ t: t, f: 240, f2: 210, dur: 0.14, type: 'square', v: 0.16 }); },
    clear: function (t) { tone({ t: t, f: 760, f2: 420, dur: 0.12, type: 'triangle', v: 0.24 }); },
    undo: function (t) { tone({ t: t, f: 520, f2: 380, dur: 0.13, type: 'sine', v: 0.26 }); },
    hint: function (t) {
      [0, 0.07, 0.14].forEach(function (d, i) {
        tone({ t: t + d, f: hz(81 + i * 4), dur: 0.22, type: 'sine', v: 0.26 });
      });
    },
    unit: function (t) {
      [0, 0.08].forEach(function (d, i) {
        tone({ t: t + d, f: hz(79 + i * 5), dur: 0.28, type: 'triangle', v: 0.32 });
      });
      noise({ t: t + 0.02, f: 5200, dur: 0.2, v: 0.07 });
    },
    pause: function (t) { tone({ t: t, f: hz(72), f2: hz(64), dur: 0.24, type: 'sine', v: 0.28 }); },
    resume: function (t) { tone({ t: t, f: hz(64), f2: hz(76), dur: 0.24, type: 'sine', v: 0.28 }); },
    win: function (t) {
      [72, 76, 79, 84, 88].forEach(function (n, i) {
        tone({ t: t + i * 0.12, f: hz(n), dur: 0.55, type: 'triangle', v: 0.4 });
        tone({ t: t + i * 0.12, f: hz(n + 12), dur: 0.4, type: 'sine', v: 0.13 });
      });
      noise({ t: t + 0.55, f: 4200, dur: 0.6, v: 0.09 });
    },
    start: function (t) {
      tone({ t: t, f: 320, f2: 1100, dur: 0.3, type: 'triangle', v: 0.28 });
      noise({ t: t, f: 1800, dur: 0.26, v: 0.08 });
    },
    /* 線上觀戰用：新訊息、有人加入房間、房間關閉 */
    chat: function (t) {
      tone({ t: t, f: hz(84), dur: 0.1, type: 'sine', v: 0.24 });
      tone({ t: t + 0.06, f: hz(88), dur: 0.12, type: 'sine', v: 0.2 });
    },
    join: function (t) {
      tone({ t: t, f: hz(72), dur: 0.14, type: 'triangle', v: 0.26 });
      tone({ t: t + 0.08, f: hz(79), dur: 0.18, type: 'triangle', v: 0.22 });
    },
    leave: function (t) {
      tone({ t: t, f: hz(79), f2: hz(67), dur: 0.26, type: 'sine', v: 0.24 });
    }
  };

  function play(name, delay) {
    if (!sfxOn) return;
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    var f = SFX[name];
    if (f) f(ctx.currentTime + (delay || 0));
  }

  /* ---- 背景音樂：溫和的五聲音階循環，避免干擾思考 ---- */
  var MEL = {
    menu: [76, null, null, 79, null, null, 81, null, 84, null, null, 81, null, 79, null, null,
           76, null, null, 74, null, null, 72, null, 74, null, null, 76, null, null, null, null],
    game: [72, null, null, null, 76, null, null, null, 79, null, null, 76, null, null, null, null,
           74, null, null, null, 77, null, null, null, 81, null, null, 79, null, null, null, null]
  };
  var BASS = [48, null, null, null, null, null, null, null, 55, null, null, null, null, null, null, null,
              50, null, null, null, null, null, null, null, 53, null, null, null, null, null, null, null];

  function schedule() {
    if (!ctx) return;
    while (nextTime < ctx.currentTime + 0.22) {
      var i = step % 32;
      var m = MEL[curTrack][i];
      if (m !== null && m !== undefined) {
        tone({ t: nextTime, f: hz(m), dur: STEP * 3.4, type: 'triangle', v: 0.42, bus: musicGain, atk: 0.04 });
        tone({ t: nextTime, f: hz(m + 12), dur: STEP * 2.2, type: 'sine', v: 0.09, bus: musicGain, atk: 0.05 });
      }
      var b = BASS[i];
      if (b !== null && b !== undefined) tone({ t: nextTime, f: hz(b), dur: STEP * 5, type: 'sine', v: 0.6, bus: musicGain, atk: 0.03 });
      if (i % 16 === 8) noise({ t: nextTime, f: 6200, dur: 0.05, v: 0.03, bus: musicGain });
      nextTime += STEP;
      step++;
    }
  }

  function startBgm(track) {
    if (track && MEL[track]) curTrack = track;
    if (!musicOn) return;
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (timer) return;
    nextTime = ctx.currentTime + 0.08;
    timer = setInterval(schedule, 40);
  }
  function stopBgm() { if (timer) { clearInterval(timer); timer = null; } }
  function setTrack(t) {
    if (!MEL[t] || curTrack === t) return;
    curTrack = t; step = 0;
  }

  function setMusic(on) {
    musicOn = !!on; saveFlag(KEY.music, musicOn);
    ensure(); applyGain();
    if (musicOn) startBgm(); else stopBgm();
    return musicOn;
  }
  function setSfx(on) {
    sfxOn = !!on; saveFlag(KEY.sfx, sfxOn);
    ensure(); applyGain();
    if (sfxOn) play('click');
    return sfxOn;
  }
  function setMusicVolume(value) {
    musicVolume = Math.max(0, Math.min(1, Number(value) || 0));
    saveVolume(KEY.musicVol, musicVolume);
    ensure(); applyGain();
    return musicVolume;
  }
  function setSfxVolume(value) {
    sfxVolume = Math.max(0, Math.min(1, Number(value) || 0));
    saveVolume(KEY.sfxVol, sfxVolume);
    ensure(); applyGain();
    return sfxVolume;
  }
  function setHaptic(on) {
    hapticOn = !!on; saveFlag(KEY.haptic, hapticOn);
    return hapticOn;
  }
  /* 聊天提示音是獨立開關，但仍然受「遊戲音效」總開關管：音效關掉就一律不出聲 */
  function setChatCue(on) {
    chatCueOn = !!on; saveFlag(KEY.chatCue, chatCueOn);
    if (chatCueOn) play('chat');
    return chatCueOn;
  }
  function playChat() { if (chatCueOn) play('chat'); }
  function vibrate(pattern) {
    if (!hapticOn || !w.navigator || typeof w.navigator.vibrate !== 'function') return;
    /* 使用者還沒真的碰過畫面時呼叫 vibrate，瀏覽器會擋下並在主控台留下警告，先跳過 */
    var ua = w.navigator.userActivation;
    if (ua && ua.hasBeenActive === false) return;
    try { w.navigator.vibrate(pattern || 10); } catch (e) {}
  }

  /* 切到背景分頁時停掉音樂，回來再依設定恢復，避免疊播 */
  if (w.document && w.document.addEventListener) {
    w.document.addEventListener('visibilitychange', function () {
      if (w.document.hidden) stopBgm();
      else if (musicOn && isUnlocked()) startBgm();
    });
  }

  w.Sound = {
    unlock: unlock, isUnlocked: isUnlocked, play: play,
    startBgm: startBgm, stopBgm: stopBgm, setTrack: setTrack,
    setMusic: setMusic, setSfx: setSfx,
    setMusicVolume: setMusicVolume, setSfxVolume: setSfxVolume,
    setHaptic: setHaptic, vibrate: vibrate,
    setChatCue: setChatCue, playChat: playChat,
    isMusicOn: function () { return musicOn; },
    isSfxOn: function () { return sfxOn; },
    getMusicVolume: function () { return musicVolume; },
    getSfxVolume: function () { return sfxVolume; },
    isHapticOn: function () { return hapticOn; },
    isChatCueOn: function () { return chatCueOn; },
    resetDefaults: function () {
      setMusic(true); setSfx(true); setMusicVolume(0.7); setSfxVolume(1); setHaptic(true);
      chatCueOn = true; saveFlag(KEY.chatCue, true);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
