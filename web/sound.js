// Ambient sound for the tap field. Web Audio synthesis only: no files, no
// network, and nothing plays before a user gesture.
(function () {
  "use strict";

  var button = document.getElementById("field-sound");
  var AC = window.AudioContext || window.webkitAudioContext;

  // A slow progression in F: Fmaj9, Dm9, Bbmaj9(#11), Gm11 (MIDI note numbers).
  var CHORDS = [
    [41, 48, 52, 55, 57],
    [38, 45, 53, 57, 64],
    [46, 53, 57, 60, 64],
    [43, 50, 53, 58, 60],
  ];
  // Top of the field plays the highest note: G5 E5 C5 A4 G4 F4. The notes
  // are F, G, A, C, E. They match Fmaj9 fully and three to four tones of
  // each other chord.
  var SCALE = [79, 76, 72, 69, 67, 65];
  var CHORD_EVERY = 9600;
  var MAX_VOICES = 40;
  var MIN_GAP = 0.15;
  var KEY = "hedwig-sound";

  var ac = null;
  var padBus = null;
  var bellBus = null;
  var timer = 0;
  var enabled = false;
  var starting = false;
  var chord = 0;
  var lastNote = -1;
  var voices = 0;
  var restoreSession = null;
  var muted = false;
  try {
    muted = sessionStorage.getItem(KEY) === "muted";
  } catch (e) {}

  function setUI() {
    if (!button) return;
    button.textContent = enabled ? "Mute music" : "Play music";
    button.dataset.on = String(enabled);
  }

  function hz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function voice(type, midi, at, dur, vol, attack, bus) {
    if (!ac || voices >= MAX_VOICES) return;
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.type = type;
    osc.frequency.value = hz(midi);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(vol, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(bus);
    voices++;
    osc.onended = function () {
      osc.disconnect();
      gain.disconnect();
      voices = Math.max(0, voices - 1);
    };
    osc.start(at);
    osc.stop(at + dur + 0.1);
  }

  // A soft bell: a sine plus two quiet upper partials.
  function bell(midi, at, vol) {
    voice("sine", midi, at, 3.2, vol, 0.012, bellBus);
    voice("sine", midi + 12, at, 1.4, vol * 0.16, 0.008, bellBus);
    voice("sine", midi + 19, at, 0.7, vol * 0.05, 0.006, bellBus);
  }

  function playChord() {
    if (!ac || !enabled || document.hidden) return;
    var now = ac.currentTime;
    CHORDS[chord % CHORDS.length].forEach(function (midi, i) {
      voice("triangle", midi, now + i * 0.42, 9.0, 0.05, 1.6, padBus);
    });
    chord++;
    timer = setTimeout(playChord, CHORD_EVERY);
  }

  function playTap(p) {
    if (!ac || !enabled) return;
    var now = ac.currentTime;
    if (now - lastNote < MIN_GAP) return;
    lastNote = now;
    if (p.kind === "eye") {
      bell(72, now, 0.07);
      bell(69, now + 0.34, 0.06);
      return;
    }
    var y = Math.min(1, Math.max(0, p.y));
    var i = Math.min(SCALE.length - 1, Math.floor(y * SCALE.length));
    bell(SCALE[i], now, 0.075);
    if (p.kind === "owl") {
      voice("sine", SCALE[i] - 12, now, 2.4, 0.03, 0.02, bellBus);
    }
  }

  function build() {
    // Phones: ask for the playback session so the ring switch does not mute it.
    try {
      var s = navigator.audioSession;
      var touch = window.matchMedia("(hover: none) and (pointer: coarse)");
      if (s && touch.matches && s.type !== "playback") {
        var prev = s.type;
        s.type = "playback";
        restoreSession = function () {
          try {
            s.type = prev;
          } catch (e) {}
        };
      }
    } catch (e) {}

    ac = new AC();
    var master = ac.createGain();
    master.gain.value = 0.34;
    master.connect(ac.destination);

    var tone = ac.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 900;
    tone.Q.value = 0.3;
    padBus = ac.createGain();
    padBus.connect(tone);
    tone.connect(master);

    bellBus = ac.createGain();
    bellBus.connect(master);
    var delay = ac.createDelay(1.0);
    delay.delayTime.value = 0.375;
    var feedback = ac.createGain();
    feedback.gain.value = 0.3;
    var damp = ac.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 1800;
    var wet = ac.createGain();
    wet.gain.value = 0.32;
    bellBus.connect(delay);
    delay.connect(damp);
    damp.connect(feedback);
    feedback.connect(delay);
    damp.connect(wet);
    wet.connect(master);
  }

  function stop() {
    clearTimeout(timer);
    enabled = false;
    starting = false;
    if (ac) {
      var old = ac;
      ac = null;
      old.close().catch(function () {});
    }
    voices = 0;
    if (restoreSession) {
      restoreSession();
      restoreSession = null;
    }
    setUI();
  }

  function start(p) {
    if (!AC || document.hidden) return;
    if (enabled) {
      if (p) playTap(p);
      return;
    }
    if (starting) return;
    starting = true;
    if (!ac) build();
    var active = ac;
    // resume() runs inside the gesture call stack, which Safari needs.
    active
      .resume()
      .then(function () {
        if (ac !== active || active.state !== "running") return;
        starting = false;
        enabled = true;
        setUI();
        playChord();
        if (p) playTap(p);
      })
      .catch(stop);
  }

  function remember() {
    try {
      sessionStorage.setItem(KEY, muted ? "muted" : "on");
    } catch (e) {}
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
  });
  window.addEventListener("pagehide", stop);

  if (button) {
    if (AC) {
      button.addEventListener("click", function () {
        if (enabled || starting) {
          muted = true;
          stop();
        } else {
          muted = false;
          start();
        }
        remember();
      });
    } else {
      button.textContent = "Sound unavailable";
      button.disabled = true;
    }
  }

  window.hedwigSound = {
    // Called by the field on every tap. Silent while the visitor has muted.
    interact: function (p) {
      if (!muted) start(p);
    },
  };
})();
