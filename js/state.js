// Globale Einstellungen und Kalibrierung (persistiert in IndexedDB)
import { db } from './data/db.js';

const DEFAULTS = {
  sounds: true,
  soundEvents: {},
  speech: false,
  speechLang: 'de-DE',
  announceScores: true,
  volume: 70,
  theme: 'dark',
  accent: 'green',
  keepAwake: true,
  cameraHigh: true,
  confThreshold: 0.6,
  revealLater: true,
  collectSamples: false,
  mainPlayer: null,
  botDelay: 750,
  defaultBot: { avg: 60, personality: 'constant' },
  lastSetup: null,
};

const listeners = new Set();

export const settings = {
  values: { ...DEFAULTS },
  async load() {
    const stored = await db.getKV('settings', {});
    this.values = { ...DEFAULTS, ...stored };
  },
  get(key) {
    return this.values[key];
  },
  async set(key, value) {
    this.values[key] = value;
    await db.setKV('settings', this.values);
    listeners.forEach((fn) => fn(key, value));
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export const calibration = {
  current: null,
  async load() {
    this.current = await db.getKV('calibration', null);
    return this.current;
  },
  async save(c) {
    this.current = c;
    await db.setKV('calibration', c);
  },
  async clear() {
    this.current = null;
    await db.setKV('calibration', null);
  },
};

export function applyTheme() {
  document.documentElement.dataset.theme = settings.get('theme');
  document.documentElement.dataset.accent = settings.get('accent');
}
