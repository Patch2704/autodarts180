// Soundeffekte (synthetisch per Web Audio, keine Dateien) und Sprachausgabe (lokale Systemstimmen).
import { settings } from '../state.js';

let ac = null;
function ctx() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

function tone(freq, start, dur, { type = 'sine', gain = 0.25 } = {}) {
  const c = ctx();
  if (!c) return;
  const vol = (settings.get('volume') ?? 70) / 100;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t0 = c.currentTime + start;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain * vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

const EFFECTS = {
  hit: () => tone(880, 0, 0.08, { type: 'triangle', gain: 0.2 }),
  miss: () => tone(220, 0, 0.12, { type: 'sine', gain: 0.15 }),
  bust: () => { tone(300, 0, 0.18, { type: 'sawtooth', gain: 0.12 }); tone(200, 0.15, 0.25, { type: 'sawtooth', gain: 0.12 }); },
  oneEighty: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.35, { type: 'square', gain: 0.12 })),
  checkout: () => [659, 784, 988].forEach((f, i) => tone(f, i * 0.1, 0.3, { type: 'triangle', gain: 0.2 })),
  highFinish: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.35, { type: 'square', gain: 0.12 })),
  leg: () => [392, 523, 659].forEach((f, i) => tone(f, i * 0.12, 0.4, { type: 'triangle', gain: 0.22 })),
  set: () => [392, 523, 659, 784].forEach((f, i) => tone(f, i * 0.12, 0.45, { type: 'triangle', gain: 0.22 })),
  match: () => [523, 523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.15, 0.55, { type: 'square', gain: 0.12 })),
  record: () => [784, 988, 1175].forEach((f, i) => tone(f, i * 0.08, 0.3, { type: 'sine', gain: 0.22 })),
};

export function sfx(name) {
  if (!settings.get('sounds')) return;
  const enabled = settings.get('soundEvents') || {};
  if (enabled[name] === false) return;
  try { EFFECTS[name]?.(); } catch { /* Audio nicht verfügbar */ }
}

export function speechAvailable() {
  return 'speechSynthesis' in window;
}

export function say(text) {
  if (!settings.get('speech') || !speechAvailable()) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = settings.get('speechLang') || 'de-DE';
    const voice = speechSynthesis.getVoices().find((v) => v.lang?.startsWith(u.lang.slice(0, 2)) && v.localService);
    if (voice) u.voice = voice;
    u.volume = (settings.get('volume') ?? 70) / 100;
    u.rate = 1.05;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}
