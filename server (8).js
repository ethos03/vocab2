const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const INDEX = path.join(__dirname, 'index.html');
const sessions = new Set();
const reportCooldown = new Map();
const visitCooldown = new Map();
const adminLoginFailures = new Map();
const errorAlertCooldown = new Map();
const VISIT_COOLDOWN_MS = 60_000;
const ERROR_ALERT_COOLDOWN_MS = 60_000;

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
    CREATE TABLE IF NOT EXISTS ignored_suggestions (
      word_id TEXT NOT NULL,
      field TEXT NOT NULL,
      original TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      suggestion_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (word_id, suggestion_key)
    );
    -- Preserve existing ignored IDs if an older installation stored them as UUID.
    ALTER TABLE ignored_suggestions
      ALTER COLUMN word_id TYPE TEXT USING word_id::text;
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

function parisTime() {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date());
}

// Envoi asynchrone sans effet sur la réponse HTTP ni sur la disponibilité du serveur.
function fireDiscordWebhook(webhookUrl, payload, label) {
  if (!webhookUrl || typeof fetch !== 'function') return;
  Promise.resolve().then(async () => {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) console.error(`${label} Discord a répondu ${response.status}.`);
    } catch (e) {
      console.error(`Échec de ${label} Discord : ${String(e && e.message || e).slice(0, 300)}`);
    }
  }).catch(e => console.error(`Échec de ${label} Discord : ${String(e && e.message || e).slice(0, 300)}`));
}

function notifyAdminEvent(title, fields, { mention = false } = {}) {
  const webhookUrl = process.env.DISCORD_ADMIN_WEBHOOK_URL;
  if (!webhookUrl) return;
  const discordUserId = process.env.DISCORD_USER_ID;
  const payload = {
    ...(mention && discordUserId ? {
      content: `<@${discordUserId}>`, allowed_mentions: { users: [discordUserId] }
    } : {}),
    embeds: [{ title, color: 0x5865f2, fields, timestamp: new Date().toISOString() }]
  };
  fireDiscordWebhook(webhookUrl, payload, 'Webhook admin');
}

function notifyAdminLogin(req) {
  notifyAdminEvent('✅ Connexion admin réussie', [
    { name: 'IP', value: getClientIp(req).slice(0, 100), inline: true },
    { name: 'Appareil', value: getDeviceType(req.headers['user-agent'] || ''), inline: true },
    { name: 'Heure (Europe/Paris)', value: parisTime(), inline: true }
  ]);
}

function notifyWordChange(action, word, chapter) {
  const fields = [
    { name: 'Action', value: action.slice(0, 100), inline: true },
    { name: 'Mot', value: String(word || '—').slice(0, 1000) }
  ];
  if (chapter) fields.push({ name: 'Chapitre', value: String(chapter).slice(0, 100), inline: true });
  fields.push({ name: 'Heure (Europe/Paris)', value: parisTime(), inline: true });
  notifyAdminEvent(`📝 ${action} de mot`, fields);
}

function notifyDeletedWord(word) {
  const webhookUrl = process.env.DISCORD_DELETED_WEBHOOK_URL;
  if (!webhookUrl || !word) return;
  const clip = value => String(value || '—').slice(0, 1024);
  fireDiscordWebhook(webhookUrl, {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '🗑️ Mot supprimé',
      color: 0xed4245,
      fields: [
        { name: 'Mot', value: clip(word.english) },
        { name: 'Traduction', value: clip(word.translation) },
        { name: 'Synonyme(s) / réponse(s)', value: clip(word.synonym) },
        { name: 'Contraire(s) / réponse(s)', value: clip(word.antonym) },
        { name: 'Chapitre', value: clip(word.chapter), inline: true },
        { name: 'ID', value: clip(word.id), inline: true },
        { name: 'Heure (Europe/Paris)', value: clip(parisTime()) }
      ],
      timestamp: new Date().toISOString()
    }]
  }, 'Webhook suppression de mot');
}

function notifySpellcheckWordChange(previous, updated, wordId, field) {
  const webhookUrl = process.env.DISCORD_MODIF_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('Modification issue de la vérification orthographique non publiée : DISCORD_MODIF_WEBHOOK_URL n’est pas défini.');
    return;
  }
  const fieldNames = { english: 'Anglais', translation: 'Français', synonym: 'Synonyme', antonym: 'Contraire' };
  const clip = value => String(value || '—').slice(0, 1000);
  fireDiscordWebhook(webhookUrl, {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '✏️ Modification d’un mot (vérification orthographique)',
      color: 0xe7833f,
      fields: [
        { name: `${fieldNames[field] || field} · avant`, value: clip(previous[field]) },
        { name: `${fieldNames[field] || field} · après`, value: clip(updated[field]) },
        { name: 'Chapitre', value: clip(updated.chapter), inline: true },
        { name: 'ID du mot', value: clip(wordId), inline: true }
      ],
      timestamp: new Date().toISOString()
    }]
  }, 'Webhook modification de mot');
}

function notifyFailedAdminLogin(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const previous = adminLoginFailures.get(ip);
  const count = previous && now - previous.startedAt < 60 * 60_000 ? previous.count + 1 : 1;
  adminLoginFailures.set(ip, { count, startedAt: previous && now - previous.startedAt < 60 * 60_000 ? previous.startedAt : now });
  if (adminLoginFailures.size > 5000) {
    for (const [key, value] of adminLoginFailures) {
      if (now - value.startedAt >= 60 * 60_000) adminLoginFailures.delete(key);
    }
  }
  notifyAdminEvent('⚠️ Échec de connexion admin', [
    { name: 'IP', value: ip.slice(0, 100), inline: true },
    { name: 'Nombre d’essais (dernière heure)', value: String(count), inline: true },
    { name: 'Heure (Europe/Paris)', value: parisTime(), inline: true }
  ], { mention: true });
}

function notifyServerError(error, source = 'Erreur serveur') {
  const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL;
  if (!webhookUrl) return;
  const err = error instanceof Error ? error : new Error(String(error));
  const text = `${source}: ${err.name}: ${err.message}`.slice(0, 1700);
  const key = text;
  const now = Date.now();
  const last = errorAlertCooldown.get(key);
  if (last && now - last < ERROR_ALERT_COOLDOWN_MS) return;
  errorAlertCooldown.set(key, now);
  if (errorAlertCooldown.size > 5000) {
    for (const [message, time] of errorAlertCooldown) {
      if (now - time >= ERROR_ALERT_COOLDOWN_MS) errorAlertCooldown.delete(message);
    }
  }
  const discordUserId = process.env.DISCORD_USER_ID;
  const payload = {
    ...(discordUserId ? {
      content: `<@${discordUserId}>`, allowed_mentions: { users: [discordUserId] }
    } : {}),
    embeds: [{
      title: '🚨 Erreur serveur', color: 0xed4245,
      description: text.slice(0, 1800),
      fields: [{ name: 'Heure (Europe/Paris)', value: parisTime() }],
      timestamp: new Date().toISOString()
    }]
  };
  fireDiscordWebhook(webhookUrl, payload, 'Webhook erreur');
}

// Les IP sont obtenues depuis l'en-tête défini par le proxy Render, sans exposer
// l'URL du webhook au navigateur. L'API IP geolocation est facultative.
function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  return (typeof forwardedFor === 'string' && forwardedFor.split(',')[0].trim())
    || req.socket.remoteAddress
    || 'inconnue';
}

function getDeviceType(userAgent = '') {
  const ua = String(userAgent).toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua) || (/android/.test(ua) && !/mobile/.test(ua))) {
    return 'Tablette';
  }
  if (/mobile|iphone|ipod|android|windows phone|iemobile|opera mini/.test(ua)) {
    return 'Téléphone';
  }
  return 'PC';
}

async function getLocation(ip) {
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) return { city: 'inconnue', country: 'inconnue' };
    const data = await response.json();
    if (data.success === false) return { city: 'inconnue', country: 'inconnue' };
    return {
      city: typeof data.city === 'string' && data.city.trim() ? data.city.trim() : 'inconnue',
      country: typeof data.country === 'string' && data.country.trim() ? data.country.trim() : 'inconnue'
    };
  } catch {
    return { city: 'inconnue', country: 'inconnue' };
  }
}

async function notifyVisit(req) {
  const webhookUrl = process.env.DISCORD_VISIT_WEBHOOK_URL;
  if (!webhookUrl) return; // Le suivi est désactivé sans configuration.
  const ip = getClientIp(req);
  const location = await getLocation(ip);
  const userAgent = req.headers['user-agent'] || '';
  const device = getDeviceType(userAgent);
  const time = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date());
  const payload = {
    embeds: [{
      title: '👀 Nouvelle visite',
      color: 0x5865f2,
      fields: [
        { name: 'IP', value: ip.slice(0, 100), inline: true },
        { name: 'Ville', value: location.city.slice(0, 100), inline: true },
        { name: 'Pays', value: location.country.slice(0, 100), inline: true },
        { name: 'Appareil', value: device, inline: true },
        { name: 'Heure (Europe/Paris)', value: time, inline: true }
      ]
    }]
  };
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) console.error(`Webhook visite Discord a répondu ${response.status}.`);
  } catch (e) {
    console.error(`Échec du webhook de visite Discord : ${e.message}`);
  }
}

// Node.js fournit fetch nativement à partir de la version 18.
async function sendDiscordWebhook(payload) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    const error = 'Webhook manquant : DISCORD_WEBHOOK_URL n’est pas défini.';
    console.error(error);
    return { ok: false, status: null, error };
  }
  if (typeof fetch !== 'function') {
    const error = 'fetch indisponible : utilisez Node.js 18 ou ultérieur.';
    console.error(error);
    return { ok: false, status: null, error };
  }

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    const error = `Échec de la requête au webhook Discord : ${e.message}`;
    console.error(error);
    return { ok: false, status: null, error };
  }

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    const details = responseBody || response.statusText || 'aucun détail fourni';
    const error = `Discord a répondu ${response.status}: ${details}`;
    console.error(error);
    return { ok: false, status: response.status, error };
  }
  return { ok: true, status: response.status, error: null };
}

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
    // Une seule notification par IP par minute, même si le navigateur répète l'appel.
    if (p === '/api/visit' && req.method === 'POST') {
      if (isAdmin(req)) return send(res, 204, '');
      const ip = getClientIp(req);
      const now = Date.now();
      if (visitCooldown.has(ip) && now - visitCooldown.get(ip) < VISIT_COOLDOWN_MS) {
        return send(res, 204, '');
      }
      visitCooldown.set(ip, now);
      if (visitCooldown.size > 5000) {
        for (const [key, lastVisit] of visitCooldown) {
          if (now - lastVisit >= VISIT_COOLDOWN_MS) visitCooldown.delete(key);
        }
      }
      // Ne retarde pas la réponse HTTP et ne fait jamais échouer la page.
      notifyVisit(req).catch(e => console.error('Erreur suivi visite :', e));
      return send(res, 204, '');
    }

    // Login admin
    if (p === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      if (b.password !== ADMIN_PASSWORD) {
        notifyFailedAdminLogin(req);
        return send(res, 401, { error: 'Mot de passe incorrect.' });
      }
      notifyAdminLogin(req);
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
      notifyWordChange('Ajout', w.english, w.chapter);
      return send(res, 201, w);
    }
    // Supprimer un chapitre (admin) : /api/chapters/NomDuChapitre
    if (p.startsWith('/api/chapters/') && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Accès admin requis.' });
      const name = decodeURIComponent(p.split('/')[3] || '');
      if (!name) return send(res, 400, { error: 'Chapitre manquant' });
      const wordsToDelete = await pool.query('SELECT * FROM words WHERE chapter=$1', [name]);
      if (!wordsToDelete.rowCount) return send(res, 404, { error: 'Chapitre introuvable' });
      const r = await pool.query('DELETE FROM words WHERE chapter=$1', [name]);
      for (const word of wordsToDelete.rows) notifyDeletedWord(word);
      notifyWordChange('Suppression du chapitre', `${r.rowCount} mot(s) supprimé(s)`, name);
      return send(res, 200, { ok: true, deleted: r.rowCount });
    }
    // Modifier / supprimer un mot
    if (p.startsWith('/api/words/') && ['PUT', 'DELETE'].includes(req.method)) {
      if (!isAdmin(req)) return send(res, 403, { error: 'Accès admin requis.' });
      const ident = p.split('/')[3];
      if (req.method === 'DELETE') {
        const deletedWord = await pool.query('SELECT * FROM words WHERE id=$1', [ident]);
        if (!deletedWord.rowCount) return send(res, 404, { error: 'Mot introuvable' });
        const r = await pool.query('DELETE FROM words WHERE id=$1', [ident]);
        if (!r.rowCount) return send(res, 404, { error: 'Mot introuvable' });
        notifyDeletedWord(deletedWord.rows[0]);
        notifyWordChange('Suppression', deletedWord.rows[0].english, deletedWord.rows[0].chapter);
        return send(res, 200, { ok: true });
      }
      const b = await body(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'Données invalides.' });
      const cur = await pool.query('SELECT * FROM words WHERE id=$1', [ident]);
      if (!cur.rowCount) return send(res, 404, { error: 'Mot introuvable' });
      const previous = cur.rows[0];
      const textField = (key, fallback = '') => Object.prototype.hasOwnProperty.call(b, key)
        ? String(b[key] == null ? '' : b[key]).trim()
        : String(previous[key] == null ? fallback : previous[key]).trim();
      const w = {
        id: ident,
        english: textField('english'),
        translation: textField('translation'),
        synonym: textField('synonym'),
        antonym: textField('antonym'),
        chapter: textField('chapter', 'Sans chapitre') || 'Sans chapitre'
      };
      if (!w.english || !w.translation) return send(res, 400, { error: 'anglais et français requis' });
      await pool.query(
        'UPDATE words SET english=$1, translation=$2, synonym=$3, antonym=$4, chapter=$5 WHERE id=$6',
        [w.english, w.translation, w.synonym, w.antonym, w.chapter, ident]
      );
      notifyWordChange('Modification', w.english, w.chapter);
      if (b.source === 'spellcheck') {
        const changedField = ['english', 'translation', 'synonym', 'antonym'].find(key => previous[key] !== w[key]);
        if (changedField) notifySpellcheckWordChange(previous, w, ident, changedField);
      }
      return send(res, 200, w);
    }

    // Ignorer définitivement une suggestion LanguageTool (admin uniquement).
    if (p === '/api/ai/ignore' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Accès admin requis.' });
      const b = await body(req);
      const fields = ['english', 'translation', 'synonym', 'antonym'];
      if (!b || !String(b.id || '').trim() || !fields.includes(b.field)
        || typeof b.original !== 'string' || !b.original.trim()
        || typeof b.suggestion !== 'string' || !b.suggestion.trim()) {
        return send(res, 400, { error: 'Suggestion invalide.' });
      }
      const wordId = String(b.id).trim();
      const suggestionKey = crypto.createHash('sha256')
        .update(JSON.stringify([b.field, b.original, b.suggestion])).digest('hex');
      await pool.query(
        'INSERT INTO ignored_suggestions (word_id, field, original, suggestion, suggestion_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [wordId, b.field, b.original, b.suggestion, suggestionKey]
      );
      return send(res, 200, { ok: true });
    }

    // Consulter et rétablir les suggestions ignorées (admin uniquement).
    if (p === '/api/ai/ignored' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Accès admin requis.' });
      const r = await pool.query(`
        SELECT i.word_id AS id, i.field, i.original, i.suggestion, w.chapter
        FROM ignored_suggestions i LEFT JOIN words w ON w.id::text = i.word_id::text
        ORDER BY i.created_at DESC
      `);
      return send(res, 200, r.rows);
    }
    if (p === '/api/ai/ignore' && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Accès admin requis.' });
      const b = await body(req);
      const ignoredField = String(b.field || '');
      const ignoredOriginal = String(b.original || '');
      const ignoredSuggestion = String(b.suggestion || '');
      const suggestionKey = crypto.createHash('sha256')
        .update(JSON.stringify([ignoredField, ignoredOriginal, ignoredSuggestion])).digest('hex');
      const result = await pool.query(
        'DELETE FROM ignored_suggestions WHERE word_id::text=$1::text AND suggestion_key=$2',
        [String(b.id || ''), suggestionKey]
      );
      if (!result.rowCount) return send(res, 404, { error: 'Suggestion ignorée introuvable.' });
      return send(res, 200, { ok: true });
    }

    // Vérification orthographique LanguageTool (admin uniquement, déclenchée par le bouton)
    if (p === '/api/spellcheck' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Accès admin requis.' });
      if (typeof fetch !== 'function') return send(res, 500, { error: 'fetch indisponible : utilisez Node.js 18 ou ultérieur.' });

      const result = await pool.query('SELECT id, english, translation, synonym, antonym, chapter FROM words ORDER BY chapter, english');
      const rows = result.rows;
      const ignoredResult = await pool.query('SELECT word_id, field, original, suggestion FROM ignored_suggestions');
      const ignoredSuggestions = new Set(ignoredResult.rows.map(item =>
        JSON.stringify([String(item.word_id), item.field, item.original, item.suggestion])
      ));
      const fields = ['english', 'translation', 'synonym', 'antonym'];
      const found = [];
      const editsByField = new Map();
      const maxTextLength = 16000;
      const separator = '\n\n';
      let lastRequestAt = 0;

      // Découpe à une frontière de mot afin de rester sous la limite du service.
      function splitField(value) {
        const parts = [];
        let start = 0;
        while (start < value.length) {
          let end = Math.min(start + maxTextLength, value.length);
          if (end < value.length) {
            const boundary = value.lastIndexOf(' ', end);
            if (boundary > start + Math.floor(maxTextLength / 2)) end = boundary + 1;
          }
          parts.push({ text: value.slice(start, end), localStart: start, localEnd: end });
          start = end;
        }
        return parts;
      }

      for (const language of ['en-US', 'fr']) {
        const segments = [];
        for (const word of rows) {
          for (const field of fields) {
            if ((field === 'translation') !== (language === 'fr')) continue;
            const value = String(word[field] || '');
            if (!value.trim()) continue;
            for (const part of splitField(value)) segments.push({
              id: String(word.id), field, original: value,
              text: part.text, localStart: part.localStart, localEnd: part.localEnd
            });
          }
        }

        // Chaque POST regroupe plusieurs champs dans un seul texte; les limites
        // permettent de rattacher sans ambiguïté les résultats au champ source.
        for (let i = 0; i < segments.length;) {
          const batch = [];
          let text = '';
          while (i < segments.length) {
            const segment = segments[i];
            const extra = (batch.length ? separator.length : 0) + segment.text.length;
            if (batch.length && text.length + extra > maxTextLength) break;
            const start = text.length + (batch.length ? separator.length : 0);
            text += (batch.length ? separator : '') + segment.text;
            batch.push({ ...segment, start, end: start + segment.text.length });
            i++;
          }

          const waitMs = Math.max(0, 3100 - (Date.now() - lastRequestAt));
          if (lastRequestAt && waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
          let response;
          try {
            response = await fetch('https://api.languagetool.org/v2/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ text, language, format: 'x-www-form-urlencoded' }),
              signal: AbortSignal.timeout(20000)
            });
            lastRequestAt = Date.now();
          } catch (e) {
            console.error('Échec de l’appel LanguageTool :', e);
            return send(res, 502, { error: 'Impossible de joindre LanguageTool. Vérifiez la connexion du serveur puis réessayez.' });
          }
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            console.error('LanguageTool a répondu', response.status, detail || response.statusText);
            if (response.status === 429) return send(res, 503, { error: 'Limite gratuite de LanguageTool atteinte. Attendez une minute avant de réessayer.' });
            if (response.status === 413) return send(res, 502, { error: 'Le texte dépasse la limite acceptée par LanguageTool. Réessayez avec moins de contenu.' });
            return send(res, 502, { error: `LanguageTool a refusé la vérification (${response.status}). Réessayez plus tard.` });
          }

          let payload;
          try { payload = await response.json(); }
          catch { return send(res, 502, { error: 'Réponse invalide reçue de LanguageTool.' }); }
          for (const match of (Array.isArray(payload.matches) ? payload.matches : [])) {
            // On ne signale que les fautes d’orthographe, pas les suggestions de grammaire/style.
            if (match.rule?.issueType !== 'misspelling' && match.rule?.category?.id !== 'TYPOS') continue;
            const offset = Number(match.offset), length = Number(match.length);
            const segment = batch.find(item => offset >= item.start && offset + length <= item.end);
            const replacement = String(match.replacements?.[0]?.value || '');
            if (!segment || !replacement || !Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) continue;
            const localOffset = segment.localStart + offset - segment.start;
            const key = `${segment.id}:${segment.field}`;
            if (!editsByField.has(key)) editsByField.set(key, { ...segment, edits: [] });
            const entry = editsByField.get(key);
            if (!entry.edits.some(edit => edit.offset === localOffset && edit.length === length)) {
              entry.edits.push({ offset: localOffset, length, replacement });
            }
          }
        }
      }

      for (const entry of editsByField.values()) {
        let correction = entry.original;
        for (const edit of entry.edits.sort((a, b) => b.offset - a.offset)) {
          correction = correction.slice(0, edit.offset) + edit.replacement + correction.slice(edit.offset + edit.length);
        }
        if (correction === entry.original) continue;
        if (ignoredSuggestions.has(JSON.stringify([entry.id, entry.field, entry.original, correction]))) continue;
        const word = rows.find(item => String(item.id) === entry.id);
        if (!word) continue;
        found.push({
          id: entry.id, mot: entry.original, correction,
          raison: 'LanguageTool a détecté une faute d’orthographe et propose cette correction.',
          field: entry.field, english: word.english, translation: word.translation
        });
      }
      return send(res, 200, { errors: found });
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

    // Test manuel du webhook Discord. Les secrets ne sont jamais renvoyés.
    if (p === '/api/report-test' && req.method === 'GET') {
      const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
      const discordUserId = process.env.DISCORD_USER_ID;
      const env = {
        DISCORD_WEBHOOK_URL: Boolean(webhookUrl),
        DISCORD_USER_ID: Boolean(discordUserId)
      };

      if (!discordUserId) {
        const error = 'Configuration manquante : DISCORD_USER_ID n’est pas défini.';
        console.error(error);
        return send(res, 502, { ok: false, env, discordStatus: null, error });
      }
      const result = await sendDiscordWebhook({
        content: `<@${discordUserId}> Test du webhook de signalement.`,
        allowed_mentions: { users: [discordUserId] }
      });
      return send(res, result.ok ? 200 : 502, {
        ok: result.ok,
        env,
        discordStatus: result.status,
        ...(result.error ? { error: result.error } : {})
      });
    }

    // Signalement de mot (public, sans authentification admin)
    if (p === '/api/report' && req.method === 'POST') {
      let b;
      try {
        b = await body(req);
      } catch {
        return send(res, 400, { error: 'Requête invalide' });
      }
      const reasons = ['Erreur de frappe', 'Mot inexistant', 'Double mot', 'Erreur de mot', 'Autre'];
      if (!b || typeof b !== 'object' || Array.isArray(b) || !reasons.includes(b.reason)) {
        return send(res, 400, { error: 'Motif invalide' });
      }

      const forwardedFor = req.headers['x-forwarded-for'];
      const ip = (typeof forwardedFor === 'string' && forwardedFor.split(',')[0].trim())
        || req.socket.remoteAddress
        || 'unknown';
      const now = Date.now();
      if (reportCooldown.has(ip) && now - reportCooldown.get(ip) < 20_000) {
        return send(res, 429, { error: 'Réessaie dans quelques secondes' });
      }

      const cut = (value, max) => String(value == null ? '' : value).slice(0, max);
      const wordId = cut(b.wordId, 100);
      const english = cut(b.english, 100);
      const translation = cut(b.translation, 100);
      const chapter = cut(b.chapter, 100);
      const comment = cut(b.comment, 500) || '—';
      const discordUserId = process.env.DISCORD_USER_ID;
      if (!discordUserId) {
        const error = 'Configuration manquante : DISCORD_USER_ID n’est pas défini.';
        console.error(error);
        return send(res, 502, { error });
      }
      const payload = {
        content: `<@${discordUserId}> nouveau signalement`,
        allowed_mentions: { users: [discordUserId] },
        embeds: [{
          title: '🚩 Mot signalé',
          color: 0xe7833f,
          fields: [
            { name: 'Mot', value: `${english} → ${translation}` },
            { name: 'Chapitre', value: chapter || '—', inline: true },
            { name: 'ID', value: wordId || '—', inline: true },
            { name: 'Motif', value: b.reason },
            { name: 'Commentaire', value: comment }
          ],
          timestamp: new Date().toISOString()
        }]
      };
      const result = await sendDiscordWebhook(payload);
      if (!result.ok) {
        return send(res, 502, { error: result.error || 'Échec de l’envoi à Discord.' });
      }
      reportCooldown.set(ip, now);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/config' && req.method === 'GET') return send(res, 200, { adminPasswordConfigured: true });
    if (p === '/api/health') return send(res, 200, { ok: true });

    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(INDEX), { 'Content-Type': 'text/html; charset=utf-8' });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    notifyServerError(e, `${req.method} ${req.url}`);
    if (!res.headersSent) send(res, 500, { error: 'Erreur serveur' });
    else if (!res.writableEnded) res.end();
  }
});

process.on('uncaughtException', error => {
  console.error('Exception non interceptée :', error);
  notifyServerError(error, 'uncaughtException');
});
process.on('unhandledRejection', reason => {
  console.error('Promesse rejetée non gérée :', reason);
  notifyServerError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
});

initDb()
  .then(() => server.listen(PORT, () => console.log(`Vocabulaire lancé sur le port ${PORT}`)))
  .catch(e => { console.error('Erreur connexion base :', e); process.exit(1); });
