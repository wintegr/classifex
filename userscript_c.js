// ==UserScript==
// @name         Classifex — OLX & Publi24 → Google Sheets
// @namespace    classifex
// @version      2.0
// @description  Extract classifieds listing data (single save + bulk export) and send to a Google Sheet via an Apps Script Web App
// @match        *://*.olx.ro/*
// @match        *://*.publi24.ro/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * CONFIG — you MUST replace this with your deployed Apps
   * Script Web App URL (ends in /exec). See write2sheet.gas.
   * ==========================================================*/
  const WEB_APP_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

  const BULK_DELAY_MS = 1500;   // delay between deep-bulk requests
  const MAX_BULK_ITEMS = 50;    // safety cap per run
  const DEBUG = true;           // leave true until buttons + saves work, then set false

  /* ============================================================
   * UTILITIES
   * ==========================================================*/
  const log = (...a) => DEBUG && console.log('[classifex]', ...a);
  const warn = (...a) => console.warn('[classifex]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
  const notify = (title, text, type = 'info') => {
    try {
      GM_notification({ title, text, timeout: type === 'error' ? 6000 : 3000, silent: true });
    } catch (e) { /* GM_notification not available in this context */ }
    log(title, '-', text);
  };

  // Try a list of selectors in order, return the first element found.
  function q(root, selectors) {
    for (const sel of selectors.split(',').map((s) => s.trim())) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /* ============================================================
   * SITE DEFINITIONS
   * Detail-page extraction (title/price/seller/phone) is handled
   * generically below via structure/text, not per-site class
   * names — both sites' exact markup is hard to pin down from
   * outside a real browser (OLX actively blocks bot fetches).
   * Only the BULK/search-page card selectors are still per-site
   * guesses; if bulk export comes back empty, that's the part to
   * fix (see cards/cardUrl below).
   * ==========================================================*/
  const SITES = {
    olx: {
      name: 'OLX',
      test: (h) => h.includes('olx.ro'),
      // OLX moved from /d/anunt/ to /d/oferta/ — accept both.
      isDetailPath: (path) => /\/d\/(oferta|anunt)\//.test(path),
      cards: '[data-cy="l-card"], [data-testid="l-card"]',
      cardUrl: 'a[href*="/d/oferta/"], a[href*="/d/anunt/"]',
    },
    publi24: {
      name: 'PUBLI24',
      test: (h) => h.includes('publi24.ro'),
      isDetailPath: (path) => /\/anunt\//.test(path) || /-\d+\.html?$/.test(path),
      cards: '.ad-item, .listing-item, article.ad, li.EntityList-item',
      cardUrl: 'a[href*="/anunt/"]',
    },
  };

  /* ---------- GENERIC DETAIL-PAGE EXTRACTORS (both sites) ---- */
  const PRICE_RE = /(\d[\d.,]{1,9})\s?(RON|LEI|EUR|€|\$|USD)/i;
  const PHONE_LABEL_RE = /arat[ăa]\s*(telefon|num[ăa]rul)|vezi\s*(telefon|num[ăa]rul)|afi[șş]eaz[ăa]\s*(telefon|num[ăa]rul)|show\s*phone/i;
  const PHONE_RE = /(\+?4?0)[\s.-]?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4}/;
  const SELLER_HREF_RE = /\/public-user-profile-|^\/o\/|\/o\/anunturi-de-la\/|\/profil\/|\/user\/|\/seller\//;

  function extractTitle() {
    const h1 = document.querySelector('h1');
    if (h1 && clean(h1.innerText)) return clean(h1.innerText);
    return clean(document.title).replace(/\s*[-|].*$/, '');
  }

  function extractPrice() {
    const h1 = document.querySelector('h1');
    let scope = h1?.parentElement;
    for (let i = 0; i < 5 && scope; i++) {
      const m = (scope.innerText || '').match(PRICE_RE);
      if (m) return clean(m[0]);
      scope = scope.parentElement;
    }
    const m2 = (document.body.innerText || '').match(PRICE_RE);
    return m2 ? clean(m2[0]) : '';
  }

  function extractSeller() {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const a = anchors.find((el) => SELLER_HREF_RE.test(el.getAttribute('href') || '') && clean(el.innerText));
    return a ? { sellerName: clean(a.innerText), sellerUrl: a.href } : { sellerName: '', sellerUrl: '' };
  }

  function findPhoneButton() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return candidates.find((el) => PHONE_LABEL_RE.test(clean(el.innerText)));
  }

  async function extractPhone() {
    const btn = findPhoneButton();
    if (!btn) {
      log('no phone-reveal button found by label text (may already be shown, or the label text changed)');
      return '';
    }
    const before = clean(btn.innerText);
    btn.click();
    await sleep(1200);

    const telLink = document.querySelector('a[href^="tel:"]');
    if (telLink) return clean(telLink.getAttribute('href').replace('tel:', ''));

    const after = clean(btn.innerText);
    if (after !== before) {
      const m = after.match(PHONE_RE);
      if (m) return clean(m[0]);
    }

    const scope = btn.closest('div, section, article') || document.body;
    const m2 = (scope.innerText || '').match(PHONE_RE);
    if (m2) return clean(m2[0]);

    warn('phone button clicked but no number appeared — the site likely requires you to be logged in to reveal it (see README)');
    return '';
  }

  function getSite() {
    const h = location.hostname;
    for (const key in SITES) {
      if (SITES[key].test(h)) return SITES[key];
    }
    return null;
  }

  /* ============================================================
   * SEND TO SHEETS
   * ==========================================================*/
  function sendToSheets(payload) {
    return new Promise((resolve, reject) => {
      if (WEB_APP_URL.includes('YOUR_DEPLOYMENT_ID')) {
        reject(new Error('WEB_APP_URL not configured — edit the script and paste your Apps Script /exec URL'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: WEB_APP_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        onload: (r) => {
          log('POST response', r.status, r.responseText);
          try { resolve(JSON.parse(r.responseText)); }
          catch {
            // Apps Script didn't return JSON — surface what it DID return so
            // this is diagnosable instead of a bare "parse" error. Common
            // causes: Web App not deployed with "Anyone" access, or it
            // returned an HTML error/login page instead of your script's output.
            const snippet = clean(r.responseText).slice(0, 160);
            resolve({ ok: false, error: `non-JSON response (status ${r.status}): ${snippet || '(empty body)'}` });
          }
        },
        onerror: (e) => reject(new Error('network error — check @connect and Web App deployment ("Anyone" access)')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  /* ============================================================
   * EXTRACTION
   * Each field is wrapped so one failing step (e.g. the phone
   * click) can't blank out fields already successfully read.
   * ==========================================================*/
  function safe(fn, fallback) {
    try { return fn(); } catch (e) { warn('extractor failed:', e.message); return fallback; }
  }

  function extractFromCard(card, site) {
    const urlEl = q(card, site.cardUrl);
    const h = card.querySelector('h2, h3, h4, a');
    const title = clean(h?.innerText);
    const priceMatch = (card.innerText || '').match(PRICE_RE);
    return {
      title,
      price: priceMatch ? clean(priceMatch[0]) : '',
      url: urlEl?.href || '',
      sellerName: '',
      sellerUrl: '',
      phone: '', // phones are never on listing cards, only on detail pages
    };
  }

  async function extractDetailPage() {
    await sleep(800);

    const title = safe(() => extractTitle(), '');
    const price = safe(() => extractPrice(), '');
    const negotiable = /negociabil/i.test(price);
    const { sellerName, sellerUrl } = safe(() => extractSeller(), { sellerName: '', sellerUrl: '' });

    if (!title) warn('title extraction found nothing — check that this page has an <h1>');
    if (!price) warn('price extraction found nothing near the title — currency pattern may not match (see PRICE_RE)');
    if (!sellerName) warn('seller extraction found nothing — no link matched known profile-URL patterns (see SELLER_HREF_RE)');

    let phone = '';
    try { phone = await extractPhone(); }
    catch (e) { warn('phone extraction threw:', e.message); }

    return { title, price, negotiable, sellerName, sellerUrl, phone };
  }

  /* ============================================================
   * BULK (SEARCH / CATEGORY PAGE) — quick, no phones
   * ==========================================================*/
  async function bulkExport() {
    const site = getSite();
    if (!site) return;

    const cards = Array.from(document.querySelectorAll(site.cards));
    if (!cards.length) {
      notify('Bulk Export', 'No listing cards found — selector may be outdated (see console)', 'error');
      warn('sel.cards matched nothing:', site.cards);
      return;
    }

    let success = 0, failed = 0;
    for (const card of cards.slice(0, MAX_BULK_ITEMS)) {
      const data = extractFromCard(card, site);
      if (!data.url) { failed++; continue; }
      try {
        const res = await sendToSheets({ source: site.name, ...data });
        res.ok ? success++ : failed++;
      } catch (e) {
        failed++;
        warn('bulk item failed:', e.message);
      }
    }
    notify('Bulk Export Done', `${site.name}: ${success} saved, ${failed} failed`, failed ? 'error' : 'info');
  }

  /* ============================================================
   * DEEP BULK (SEARCH / CATEGORY PAGE) — opens each listing, gets phones
   * ==========================================================*/
  async function deepBulkExport() {
    const site = getSite();
    if (!site) return;

    const cards = Array.from(document.querySelectorAll(site.cards));
    const urls = cards.map((c) => q(c, site.cardUrl)?.href).filter(Boolean);
    const total = Math.min(urls.length, MAX_BULK_ITEMS);

    if (!total) {
      notify('Deep Bulk', 'No valid listing URLs found — selector may be outdated (see console)', 'error');
      warn('sel.cards / sel.cardUrl matched nothing usable');
      return;
    }

    const ok = confirm(
      `Deep Bulk: will open ${total} tabs sequentially to read phone numbers.\n` +
      `Estimated time: ~${Math.round((total * (BULK_DELAY_MS + 2000)) / 1000)}s.\n\nContinue?`
    );
    if (!ok) return;

    notify('Deep Bulk', `Starting deep scrape of ${total} listings...`);
    const btn = document.getElementById('cfx-deep-btn');
    const orig = btn?.innerText;
    let success = 0, failed = 0;

    for (let i = 0; i < total; i++) {
      if (btn) { btn.innerText = `🔍 ${i + 1}/${total}`; btn.disabled = true; }
      try {
        const tab = window.open(urls[i], '_blank');
        if (!tab) throw new Error('popup blocked — allow popups for this site');

        await new Promise((resolve) => {
          const check = setInterval(() => {
            try {
              if (tab.document.readyState === 'complete') { clearInterval(check); resolve(); }
            } catch { /* cross-origin during initial navigation, keep waiting */ }
          }, 200);
          setTimeout(() => { clearInterval(check); resolve(); }, 8000); // don't hang forever
        });

        await sleep(1000);
        const detail = await extractDetailPage();
        const res = await sendToSheets({ source: site.name, url: urls[i], ...detail });
        res.ok ? success++ : failed++;
        tab.close();
      } catch (e) {
        failed++;
        warn('deep bulk item failed:', e.message);
      }
      if (i < total - 1) await sleep(BULK_DELAY_MS);
    }

    if (btn) { btn.innerText = orig; btn.disabled = false; }
    notify('Deep Bulk Done', `${site.name}: ${success} saved, ${failed} failed`, failed ? 'error' : 'info');
  }

  /* ============================================================
   * SINGLE SAVE (DETAIL PAGE)
   * ==========================================================*/
  async function handleSingleSave() {
    const site = getSite();
    if (!site) return;
    const btn = document.getElementById('cfx-single-btn');
    const orig = btn.innerText;
    btn.innerText = '⏳ Saving...';
    btn.disabled = true;

    try {
      const detail = await extractDetailPage();
      const res = await sendToSheets({ source: site.name, url: location.href, ...detail });
      if (res.ok) {
        notify('Saved', `${site.name}: "${(detail.title || '(no title)').substring(0, 40)}"`);
        btn.innerText = '✅ Saved!';
      } else {
        throw new Error(res.error || 'Web App returned an error');
      }
    } catch (e) {
      notify('Error', e.message, 'error');
      btn.innerText = '❌ Failed';
    }
    await sleep(2000);
    btn.innerText = orig;
    btn.disabled = false;
  }

  /* ============================================================
   * UI
   * ==========================================================*/
  function createButton(id, text, onClick, styleOverrides) {
    if (document.getElementById(id)) return document.getElementById(id);
    const btn = document.createElement('button');
    btn.id = id;
    btn.innerText = text;
    Object.assign(btn.style, {
      position: 'fixed', zIndex: 2147483647,
      padding: '10px 14px', border: 'none', borderRadius: '6px',
      cursor: 'pointer', fontSize: '13px', fontWeight: '600',
      boxShadow: '0 4px 12px rgba(0,0,0,.3)', fontFamily: 'sans-serif',
      ...styleOverrides,
    });
    btn.onclick = onClick;
    document.body.appendChild(btn);
    return btn;
  }

  function addButtons() {
    const site = getSite();
    if (!site) return;

    const isDetail = site.isDetailPath(location.pathname);
    log('addButtons on', location.href, '-> site:', site.name, 'isDetail:', isDetail);

    if (isDetail) {
      createButton('cfx-single-btn', '📊 Save to Sheets', handleSingleSave, {
        bottom: '20px', right: '20px', background: '#1a73e8', color: '#fff',
      });
    } else {
      createButton('cfx-bulk-btn', `📦 Bulk Export (${site.name})`, bulkExport, {
        bottom: '20px', right: '20px', background: '#34a853', color: '#fff',
      });
      createButton('cfx-deep-btn', '🔍 Deep Bulk (phones)', deepBulkExport, {
        bottom: '70px', right: '20px', background: '#ea4335', color: '#fff',
      });
    }
  }

  function removeButtons() {
    ['cfx-single-btn', 'cfx-bulk-btn', 'cfx-deep-btn'].forEach((id) => document.getElementById(id)?.remove());
  }

  /* ============================================================
   * INIT
   * ==========================================================*/
  function init() {
    const site = getSite();
    log('userscript loaded on', location.hostname, '- recognized site:', site ? site.name : 'NONE (check @match)');
    addButtons();

    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        removeButtons();
        setTimeout(addButtons, 800); // SPA navigation, let the new page render
      }
    }).observe(document.body, { subtree: true, childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
