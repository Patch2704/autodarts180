// Zugriff auf Spieler und Matches
import { db } from './db.js';
import { uid } from '../core/rng.js';

export const players = {
  async list() {
    const all = await db.all('players');
    return all.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  },
  get: (id) => db.get('players', id),
  async create({ name, avatar = null }) {
    const p = { id: uid(), name: name.trim(), avatar, createdAt: Date.now() };
    await db.put('players', p);
    return p;
  },
  save: (p) => db.put('players', p),
  remove: (id) => db.del('players', id),
};

export const matches = {
  async list() {
    const all = await db.all('matches');
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
  get: (id) => db.get('matches', id),
  save: (m) => db.put('matches', m),
  remove: (id) => db.del('matches', id),
  async running() {
    return (await this.list()).filter((m) => m.status === 'running');
  },
  async finished() {
    return (await this.list()).filter((m) => m.status === 'finished');
  },
};

/** Bild-Datei → quadratisches 160px-JPEG als Data-URL */
export function resizeImage(file, size = 160) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
