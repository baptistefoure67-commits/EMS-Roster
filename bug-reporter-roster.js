(() => {
  'use strict';

  const APP_NAME = 'Roster EMS';
  const APP_KIND = 'roster';
  const REPORTER_VERSION = '1.0.0';
  const MAX_EVENTS = 120;
  const events = [];
  let panel = null;
  let reportArea = null;
  let statusNode = null;
  let noteInput = null;

  const nowIso = () => new Date().toISOString();

  function sanitize(value) {
    let text;
    try {
      if (value instanceof Error) text = `${value.name}: ${value.message}\n${value.stack || ''}`;
      else if (typeof value === 'string') text = value;
      else text = JSON.stringify(value, (key, val) => {
        if (/token|secret|password|authorization|cookie|session|credential|api.?key/i.test(key)) return '[REDACTED]';
        return val;
      });
    } catch (_) {
      try { text = String(value); } catch (_) { text = '[unserializable]'; }
    }

    return String(text || '')
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:token|access_token|id_token|refresh_token|code|key|api_key|apikey)=)[^&#\s]+/gi, '$1[REDACTED]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL_REDACTED]')
      .replace(/\b\d{15,22}\b/g, '[ID_REDACTED]')
      .slice(0, 6000);
  }

  function safeUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      return `${u.origin}${u.pathname}`;
    } catch (_) {
      return sanitize(raw).split('?')[0];
    }
  }

  function addEvent(type, detail) {
    events.push({ at: nowIso(), type, detail: sanitize(detail) });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  // Capture erreurs JS / console sans modifier le comportement de l'application.
  ['error', 'warn'].forEach((method) => {
    const original = console[method];
    if (typeof original !== 'function') return;
    console[method] = function (...args) {
      try { addEvent(`console.${method}`, args); } catch (_) {}
      return original.apply(this, args);
    };
  });

  window.addEventListener('error', (event) => {
    addEvent('window.error', {
      message: event.message,
      source: safeUrl(event.filename || ''),
      line: event.lineno,
      column: event.colno,
      error: event.error || null
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    addEvent('promise.unhandled', event.reason || 'Unhandled promise rejection');
  });

  // Capture les échecs fetch (401/403/404/5xx...) sans enregistrer les corps ni les paramètres sensibles.
  if (typeof window.fetch === 'function') {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (args[1] && args[1].method) || (input && input.method) || 'GET';
      try {
        const response = await nativeFetch(...args);
        if (!response.ok) addEvent('network.http', { method, status: response.status, url: safeUrl(url) });
        return response;
      } catch (error) {
        addEvent('network.fetch', { method, url: safeUrl(url), error });
        throw error;
      }
    };
  }

  function cssVar(name) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '—'; }
    catch (_) { return '—'; }
  }

  function visible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.getClientRects().length > 0;
  }

  function duplicateIds() {
    const counts = new Map();
    document.querySelectorAll('[id]').forEach((el) => counts.set(el.id, (counts.get(el.id) || 0) + 1));
    return [...counts.entries()].filter(([, count]) => count > 1).map(([id, count]) => `${id} x${count}`);
  }

  function safeStorageSummary() {
    const result = { keys: [], theme: {} };
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        result.keys.push(key);
        if (/theme|palette|color|colour|holo/i.test(key) && !/token|auth|session|user|discord/i.test(key)) {
          const value = localStorage.getItem(key);
          if (value && value.length < 800) result.theme[key] = sanitize(value);
        }
      }
    } catch (error) {
      result.error = sanitize(error);
    }
    result.keys = result.keys.filter((k) => !/token|auth|session|cookie|credential/i.test(k)).slice(0, 80);
    return result;
  }

  function appChecks() {
    const allButtons = [...document.querySelectorAll('button')];
    const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const result = {
      buttons: allButtons.length,
      disabledButtons: allButtons.filter((b) => b.disabled).length,
      visibleDialogs: [...document.querySelectorAll('[role="dialog"], .modal, dialog')].filter(visible).length,
      duplicateIds: duplicateIds(),
      bodyClasses: document.body ? [...document.body.classList] : [],
      htmlClasses: [...document.documentElement.classList],
      theme: {
        primary: cssVar('--theme-primary'),
        secondary: cssVar('--theme-secondary'),
        accentEnd: cssVar('--theme-accent-end'),
        logoGradient: cssVar('--theme-logo-gradient')
      }
    };

    if (APP_KIND === 'roster') {
      const modify = allButtons.filter((b) => /^Modifier$/i.test(textOf(b)));
      result.roster = {
        modifierButtons: modify.length,
        modifierDisabled: modify.filter((b) => b.disabled).length,
        modifierVisible: modify.filter(visible).length,
        firebaseStatusTexts: [...document.querySelectorAll('body *')]
          .filter((el) => el.children.length === 0 && /firebase|vérification|verification|lecture seule|readonly/i.test(textOf(el)))
          .map(textOf).filter(Boolean).slice(0, 12)
      };
    } else {
      const names = ['Analyser', 'Sauvegarder', 'Synchroniser', 'Terminer'];
      result.pillbox = {};
      names.forEach((name) => {
        const hits = allButtons.filter((b) => textOf(b).toLowerCase().includes(name.toLowerCase()));
        result.pillbox[name.toLowerCase()] = { count: hits.length, disabled: hits.filter((b) => b.disabled).length };
      });
      const metaVersion = document.querySelector('meta[name="application-version"]');
      result.pillbox.applicationVersion = metaVersion ? metaVersion.content : '—';
    }
    return result;
  }

  function buildReport() {
    const storage = safeStorageSummary();
    const checks = appChecks();
    const lines = [];
    lines.push(`=== RAPPORT BUG ${APP_NAME.toUpperCase()} ===`);
    lines.push(`Reporter: v${REPORTER_VERSION}`);
    lines.push(`Date: ${nowIso()}`);
    lines.push(`Page: ${location.origin}${location.pathname}`);
    lines.push(`Navigateur: ${navigator.userAgent}`);
    lines.push(`En ligne: ${navigator.onLine ? 'oui' : 'non'}`);
    lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio || 1}x`);
    lines.push(`Document: ${document.readyState}`);
    lines.push('');
    lines.push('--- BUG OBSERVE / ACTION EFFECTUEE ---');
    lines.push(noteInput && noteInput.value.trim() ? sanitize(noteInput.value.trim()) : 'Non renseigné.');
    lines.push('');
    lines.push('--- ETAT INTERFACE ---');
    lines.push(JSON.stringify(checks, null, 2));
    lines.push('');
    lines.push('--- STOCKAGE LOCAL (SANS SECRETS) ---');
    lines.push(JSON.stringify(storage, null, 2));
    lines.push('');
    lines.push(`--- EVENEMENTS CAPTURES (${events.length}) ---`);
    if (!events.length) lines.push('Aucune erreur/alerte capturée depuis le chargement de la page.');
    else events.forEach((entry, index) => {
      lines.push(`#${index + 1} [${entry.at}] ${entry.type}`);
      lines.push(entry.detail);
    });
    lines.push('');
    lines.push('--- CONSEIL POUR CHATGPT / CLAUDE ---');
    lines.push('Analyse ce rapport comme un diagnostic. Identifie la cause probable, les fichiers/fonctions à vérifier et propose un correctif minimal sans casser les autres fonctionnalités.');
    return lines.join('\n');
  }

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'emsBugReporterPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', `Diagnostic ${APP_NAME}`);
    panel.style.cssText = [
      'position:fixed','inset:20px','z-index:2147483647','display:none','flex-direction:column','gap:10px',
      'background:#0b1220','color:#e6edf7','border:1px solid #31435f','border-radius:14px','padding:14px',
      'box-shadow:0 22px 70px rgba(0,0,0,.55)','font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif'
    ].join(';');

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap';
    const title = document.createElement('strong');
    title.textContent = `🐞 Diagnostic — ${APP_NAME}`;
    title.style.fontSize = '16px';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';

    function mkButton(label) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'min-height:38px;padding:7px 12px;border-radius:9px;border:1px solid #385273;background:#13223a;color:#e6edf7;cursor:pointer';
      return b;
    }

    const refresh = mkButton('↻ Actualiser');
    const copy = mkButton('📋 Copier le rapport');
    const clear = mkButton('🧹 Effacer les événements');
    const close = mkButton('✕ Fermer');
    actions.append(refresh, copy, clear, close);
    top.append(title, actions);

    const hint = document.createElement('div');
    hint.textContent = 'Reproduis le bug, puis clique sur « Actualiser » et « Copier le rapport ». Colle ensuite le texte dans ChatGPT ou Claude.';
    hint.style.cssText = 'color:#9fb0c7';

    noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.placeholder = 'Ex. Je clique sur Modifier et rien ne se passe';
    noteInput.setAttribute('aria-label', 'Décris le bug observé');
    noteInput.style.cssText = 'width:100%;min-height:40px;border-radius:9px;border:1px solid #243957;background:#07101e;color:#dbeafe;padding:8px 10px;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';

    statusNode = document.createElement('div');
    statusNode.setAttribute('aria-live', 'polite');
    statusNode.style.cssText = 'min-height:20px;color:#7dd3fc';

    reportArea = document.createElement('textarea');
    reportArea.readOnly = true;
    reportArea.spellcheck = false;
    reportArea.style.cssText = 'width:100%;flex:1;min-height:280px;resize:none;border-radius:10px;border:1px solid #243957;background:#07101e;color:#dbeafe;padding:12px;font:12px/1.45 Consolas,monospace';

    refresh.addEventListener('click', () => { reportArea.value = buildReport(); statusNode.textContent = 'Rapport actualisé.'; });
    clear.addEventListener('click', () => { events.length = 0; reportArea.value = buildReport(); statusNode.textContent = 'Événements effacés.'; });
    close.addEventListener('click', () => { panel.style.display = 'none'; });
    copy.addEventListener('click', async () => {
      reportArea.value = buildReport();
      let ok = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(reportArea.value);
          ok = true;
        }
      } catch (_) {}
      if (!ok) {
        try {
          reportArea.focus(); reportArea.select();
          ok = document.execCommand('copy');
        } catch (_) {}
      }
      statusNode.textContent = ok ? '✅ Rapport copié. Tu peux le coller dans ChatGPT ou Claude.' : '⚠️ Copie automatique impossible : sélectionne le texte et copie-le manuellement.';
    });

    panel.append(top, hint, noteInput, statusNode, reportArea);
    document.body.appendChild(panel);
  }

  function openPanel() {
    ensurePanel();
    reportArea.value = buildReport();
    statusNode.textContent = `${events.length} événement(s) capturé(s) depuis le chargement.`;
    panel.style.display = 'flex';
    reportArea.focus();
  }

  window.EMSBugReport = Object.freeze({
    open: openPanel,
    build: buildReport,
    clear() { events.length = 0; },
    version: REPORTER_VERSION,
    app: APP_NAME
  });

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      openPanel();
    }
  });

  try {
    const params = new URLSearchParams(location.search);
    if (params.get('bugreport') === '1') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openPanel, { once: true });
      else setTimeout(openPanel, 0);
    }
  } catch (_) {}

  addEvent('reporter.ready', { app: APP_NAME, version: REPORTER_VERSION });
})();
