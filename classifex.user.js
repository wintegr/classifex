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
   * SITE DEFINITIONS — selectors below are confirmed against real
   * saved pages from both sites (2026), not guessed. If a site
   * changes markup again, this is the one place to update.
   * ==========================================================*/
  const SITES = {
    olx: {
      name: 'OLX',
      test: (h) => h.includes('olx.ro'),
      isDetailPath: (path) => /\/d\/(oferta|anunt)\//.test(path),
      cards: '[data-cy="l-card"], [data-testid="l-card"]',
      cardUrl: 'a[href*="/d/oferta/"], a[href*="/d/anunt/"]',
      titleSel: '[data-testid="offer_title"] h4, h4, h1',
      priceSel: '[data-testid="ad-price-container"] h3, h3',
      descSel: '[data-cy="ad_description"]',
      descLabel: 'Descriere',
      dateSel: '[data-cy="ad-posted-at"], [data-testid="ad-posted-at"]',
      datePrefix: /^postat\s*/i,
      idRegex: /\bID:\s*(\d+)/i,
      viewsSel: null, // OLX doesn't show a public view count on ad pages
      sellerNameSel: '[data-testid="user-profile-user-name"]',
      sellerUrlSel: '[data-testid="user-profile-link"]',
      phoneRevealedSel: 'a[data-testid="contact-phone"], a[href^="tel:"]',
      phoneButtonSel: '[data-testid*="phone" i] button, button[data-testid*="phone" i]',
      phoneIsImage: false,
    },
    publi24: {
      name: 'PUBLI24',
      test: (h) => h.includes('publi24.ro'),
      isDetailPath: (path) => /\/anunt\//.test(path) || /-\d+\.html?$/.test(path),
      cards: '.ad-item, .listing-item, article.ad, li.EntityList-item',
      cardUrl: 'a[href*="/anunt/"]',
      titleSel: 'h1',
      priceSel: '.product-price',
      descSel: '.article-description',
      descLabel: 'Descriere',
      dateSel: null, // no stable selector — found by scanning for the "Valabil din" prefix instead
      datePrefix: /^valabil din\s*/i,
      idRegex: /\bID anun[țt]\s*:?\s*(\d+)/i,
      viewsSel: '.article-views-count',
      sellerNameSel: '.user-profile-name a',
      sellerUrlSel: '.user-profile-name a',
      phoneRevealedSel: 'a[href^="tel:"]', // Publi24 never renders a real tel: link — see phoneIsImage
      phoneButtonSel: '.btn-show-phone, .show-phone-number button',
      phoneIsImage: true, // phone number is delivered as a base64 PNG image, not text — see notes below
    },
  };

  /* ---------- SHARED HELPERS ---------------------------------- */
  const PRICE_RE = /(\d[\d.,]{1,9})\s?(RON|LEI|EUR|€|\$|USD)/i;
  const PHONE_LABEL_RE = /arat[ăa]\s*(telefon|num[ăa]rul)|vezi\s*(telefon|num[ăa]rul)|afi[șş]eaz[ăa]\s*(telefon|num[ăa]rul)|show\s*phone/i;
  const PHONE_RE = /(\+?4?0)[\s.-]?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4}/;

  // Parse the page's schema.org JSON-LD Product block, if present.
  // Both sites embed one — it's a more stable source than CSS classes.
  function getJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const candidates = Array.isArray(data) ? data : (data['@graph'] || [data]);
        const product = candidates.find((d) => d && d['@type'] === 'Product');
        if (product) return product;
      } catch { /* malformed JSON-LD, skip */ }
    }
    return null;
  }

  function extractTitle(site, jsonld) {
    if (jsonld?.name) return clean(jsonld.name);
    const el = q(document, site.titleSel);
    if (el && clean(el.innerText)) return clean(el.innerText);
    return clean(document.title).replace(/\s*[-|].*$/, '');
  }

  function extractPrice(site, jsonld) {
    if (jsonld?.offers?.price) {
      return clean(`${jsonld.offers.price} ${jsonld.offers.priceCurrency || ''}`);
    }
    const el = q(document, site.priceSel);
    const m = (el?.innerText || '').match(PRICE_RE);
    if (m) return clean(m[0]);
    const m2 = (document.body.innerText || '').match(PRICE_RE);
    return m2 ? clean(m2[0]) : '';
  }

  function extractDescription(site, jsonld) {
    if (jsonld?.description) return clean(jsonld.description);
    const el = site.descSel ? document.querySelector(site.descSel) : null;
    if (!el) return '';
    let text = clean(el.innerText);
    if (site.descLabel) text = text.replace(new RegExp('^' + site.descLabel + '\\s*'), '');
    return text;
  }

  function extractDatePosted(site) {
    if (site.dateSel) {
      const el = q(document, site.dateSel);
      if (el) return clean(el.innerText).replace(site.datePrefix, '');
    }
    // Fallback: scan short elements for the known prefix text (handles Publi24,
    // which has no stable selector for this field).
    for (const el of document.querySelectorAll('i, span, div')) {
      const t = clean(el.innerText || el.textContent);
      if (t.length < 80 && site.datePrefix.test(t)) return t.replace(site.datePrefix, '');
    }
    return '';
  }

  function extractAdId(site, jsonld) {
    if (jsonld?.sku) return clean(jsonld.sku);
    const m = (document.body.innerText || '').match(site.idRegex);
    return m ? m[1] : '';
  }

  function extractViews(site) {
    if (!site.viewsSel) return '';
    const el = document.querySelector(site.viewsSel);
    const m = (el?.innerText || '').match(/(\d+)/);
    return m ? m[1] : '';
  }

  function extractSeller(site) {
    const nameEl = document.querySelector(site.sellerNameSel);
    const urlEl = document.querySelector(site.sellerUrlSel) || nameEl;
    return {
      sellerName: clean(nameEl?.innerText),
      sellerUrl: urlEl?.href || '',
    };
  }

  function findPhoneButton(site) {
    if (site.phoneButtonSel) {
      const el = document.querySelector(site.phoneButtonSel);
      if (el) return el;
    }
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return candidates.find((el) => PHONE_LABEL_RE.test(clean(el.innerText)));
  }

  async function extractPhone(site) {
    // Check FIRST for an already-revealed number (e.g. if you clicked "show
    // phone" yourself before saving) — this was the bug last time: the old
    // code only checked after attempting its own click, so an
    // already-revealed number was never picked up.
    const already = document.querySelector(site.phoneRevealedSel);
    if (already) {
      const t = clean(already.getAttribute('href')?.replace('tel:', '') || already.innerText);
      const m = t.match(PHONE_RE);
      if (m) return clean(m[0]);
    }

    if (site.phoneIsImage) {
      warn(`${site.name}: phone number is rendered as an image (anti-scraping), not text — it cannot be read from the DOM. Leaving blank.`);
      return '';
    }

    const btn = findPhoneButton(site);
    if (!btn) {
      log('no phone-reveal button found (may require login, or the label/selector changed)');
      return '';
    }
    btn.click();
    await sleep(1200);

    const revealed = document.querySelector(site.phoneRevealedSel);
    if (revealed) {
      const t = clean(revealed.getAttribute('href')?.replace('tel:', '') || revealed.innerText);
      const m = t.match(PHONE_RE);
      if (m) return clean(m[0]);
    }

    const scope = btn.closest('div, section, article') || document.body;
    const m2 = (scope.innerText || '').match(PHONE_RE);
    if (m2) return clean(m2[0]);

    warn('phone button clicked but no number appeared — you may need to be logged in to reveal it');
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

  async function extractDetailPage(site) {
    await sleep(800);
    const jsonld = safe(() => getJsonLd(), null);

    const title = safe(() => extractTitle(site, jsonld), '');
    const price = safe(() => extractPrice(site, jsonld), '');
    const negotiable = /negociabil/i.test(price);
    const description = safe(() => extractDescription(site, jsonld), '');
    const datePosted = safe(() => extractDatePosted(site), '');
    const adId = safe(() => extractAdId(site, jsonld), '');
    const views = safe(() => extractViews(site), '');
    const { sellerName, sellerUrl } = safe(() => extractSeller(site), { sellerName: '', sellerUrl: '' });

    if (!title) warn('title extraction found nothing');
    if (!price) warn('price extraction found nothing');
    if (!sellerName) warn(`seller extraction found nothing — check site.sellerNameSel (${site.sellerNameSel})`);
    if (!datePosted) warn('date-posted extraction found nothing');
    if (!adId) warn('ad ID extraction found nothing');

    let phone = '';
    try { phone = await extractPhone(site); }
    catch (e) { warn('phone extraction threw:', e.message); }

    return { title, price, negotiable, description, datePosted, adId, views, sellerName, sellerUrl, phone };
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
        const detail = await extractDetailPage(site);
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
      const detail = await extractDetailPage(site);
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
