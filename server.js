const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const INDEX = path.join(__dirname, 'index.html');
const sessions = new Set();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS words (
      id TEXT PRIMARY KEY,
      english TEXT NOT NULL,
      translation TEXT NOT NULL,
      synonym TEXT DEFAULT '',
      antonym TEXT DEFAULT '',
      chapter TEXT DEFAULT 'Sans chapitre'
    );
    ALTER TABLE words ADD COLUMN IF NOT EXISTS chapter TEXT DEFAULT 'Sans chapitre';
    UPDATE words SET chapter='Sans chapitre' WHERE chapter IS NULL OR chapter='';
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      words JSONB NOT NULL DEFAULT '[]'
    );
  `);
}

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  const type = typeof obj === 'string' || Buffer.isBuffer(obj)
    ? 'text/plain; charset=utf-8'
    : 'application/json; charset=utf-8';
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function isAdmin(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  return t && sessions.has(t);
}

const id = () => crypto.randomUUID();

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // Login admin
    if (p === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      if (b.password !== ADMIN_PASSWORD) return send(res, 401, { error: 'Mot de passe incorrect.' });
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      return send(res, 200, { token });
    }

    // Lire les mots
    if (p === '/api/words' && req.method === 'GET') {
      const r = await pool.query('SELECT * FROM words ORDER BY chapter, english');
      return send(res, 200, r.rows);
    }

    // Ajouter un mot
    if (p === '/api/words' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Accès admin requis.' });
      const b = await body(req);
      if (!b.english || !b.translation) return send(res, 400, { error: 'anglais et français requis' });
      const w = {
        id: id(),
        english: String(b.english).trim(),
        translation: String(b.translation).trim(),
        synonym: String(b.synonym || '').trim(),
        antonym: String(b.antonym || '').trim(),
        chapter: String(b.chapter || '').trim() || 'Sans chapitre'
      };
      await pool.query(
        'INSERT INTO words (id, english, translation, synonym, antonym, chapter) VALUES ($1,$2,$3,$4,$5,$6)',
        [w.id, w.english, w.translation, w.synonym, w.antonym, w.chapter]
      );
      return send(res, 201, w);
    }

    // Modifier / supprimer un mot
    if (p.startsWith('/api/words/') && ['PUT', 'DELETE'].includes(req.method)) {
      if (!isAdmin(req)) return send(res, 403, { error: 'Accès admin requis.' });
      const ident = p.split('/')[3];
      if (req.method === 'DELETE') {
        const r = await pool.query('DELETE FROM words WHERE id=$1', [ident]);
        if (!r.rowCount) return send(res, 404, { error: 'Mot introuvable' });
        return send(res, 200, { ok: true });
      }
      const b = await body(req);
      const cur = await pool.query('SELECT * FROM words WHERE id=$1', [ident]);
      if (!cur.rowCount) return send(res, 404, { error: 'Mot introuvable' });
      const w = { ...cur.rows[0], ...b, id: ident };
      await pool.query(
        'UPDATE words SET english=$1, translation=$2, synonym=$3, antonym=$4, chapter=$5 WHERE id=$6',
        [w.english, w.translation, w.synonym || '', w.antonym || '', w.chapter || 'Sans chapitre', ident]
      );
      return send(res, 200, w);
    }

    // Évaluations
    if (p === '/api/evaluations' && req.method === 'GET') {
      const r = await pool.query('SELECT * FROM evaluations ORDER BY date DESC');
      return send(res, 200, r.rows);
    }

    if (p === '/api/evaluations' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Ajout des évaluations réservé à l’admin.' });
      const b = await body(req);
      if (!b.name || !b.date || !b.words) return send(res, 400, { error: 'nom, date et mots requis' });
      const e = {
        id: id(),
        name: String(b.name).trim(),
        date: String(b.date),
        words: String(b.words).split(/[,;\n]/).map(x => x.trim()).filter(Boolean)
      };
      await pool.query(
        'INSERT INTO evaluations (id, name, date, words) VALUES ($1,$2,$3,$4)',
        [e.id, e.name, e.date, JSON.stringify(e.words)]
      );
      return send(res, 201, e);
    }

    if (p === '/api/config' && req.method === 'GET') return send(res, 200, { adminPasswordConfigured: true });
    if (p === '/api/health') return send(res, 200, { ok: true });

    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(INDEX), { 'Content-Type': 'text/html; charset=utf-8' });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Erreur serveur' });
  }
});

initDb()
  .then(() => server.listen(PORT, () => console.log(`Vocabulaire lancé sur le port ${PORT}`)))
  .catch(e => { console.error('Erreur connexion base :', e); process.exit(1); });
