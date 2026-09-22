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
   * If a field comes back empty in your Sheet, open DevTools on
   * that page, find the right element, and update ONLY the
   * selector string below — nothing else needs to change.
   * ==========================================================*/
  const SITES = {
    olx: {
      name: 'OLX',
      test: (h) => h.includes('olx.ro'),
      // OLX moved from /d/anunt/ to /d/oferta/ — accept both.
      isDetailPath: (path) => /\/d\/(oferta|anunt)\//.test(path),
      cards: '[data-cy="l-card"], [data-testid="l-card"]',
      cardTitle: '[data-cy="ad-card-title"] h4, h6, [data-cy="ad-title"]',
      cardPrice: '[data-testid="ad-price"], [data-cy="ad-price"]',
      cardUrl: 'a[href*="/d/oferta/"], a[href*="/d/anunt/"]',
      cardSeller: '[data-cy="seller-name"], [data-testid="seller-name"]',
      cardSellerUrl: 'a[href*="/o/anunturi-de-la/"], a[href*="/user/"]',
      detailTitle: 'h4[data-cy="ad_title"], h1[data-testid="ad-title"], [data-cy="ad_title"]',
      detailPrice: '[data-testid="ad-price"], [data-cy="ad-price"]',
      detailSellerName: '[data-cy="seller_name"], [data-cy="seller-name"], [data-testid="seller-name"]',
      detailSellerUrl: 'a[href*="/o/anunturi-de-la/"], a[href*="/user/"]',
      detailPhoneBtn: '[data-testid="show-phone"], button[data-cy="show-phone"]',
      detailPhone: '[data-testid="phone-number"], a[href^="tel:"]',
    },
    publi24: {
      name: 'PUBLI24',
      test: (h) => h.includes('publi24.ro'),
      isDetailPath: (path) => /\/anunt\//.test(path) || /-\d+\.html?$/.test(path),
      cards: '.ad-item, .listing-item, article.ad, li.EntityList-item',
      cardTitle: '.ad-title, h3 a, h2 a, [itemprop="name"]',
      cardPrice: '.ad-price, .price, [itemprop="price"]',
      cardUrl: 'a[href*="/anunt"], .ad-title a',
      cardSeller: '.seller-name, .user-name, [itemprop="seller"] [itemprop="name"]',
      cardSellerUrl: 'a[href*="/user/"], a[href*="/profil/"]',
      detailTitle: 'h1.ad-title, h1[itemprop="name"], h1',
      detailPrice: '.ad-price, [itemprop="price"]',
      detailSellerName: '.seller-name, .user-name, [itemprop="seller"] [itemprop="name"]',
      detailSellerUrl: 'a[href*="/user/"], a[href*="/profil/"]',
      detailPhoneBtn: '.show-phone, .phone-btn, [data-action="show-phone"], button[class*="phone" i]',
      detailPhone: '.phone-number, [itemprop="telephone"], a[href^="tel:"]',
    },
  };

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
          catch { resolve({ ok: r.status >= 200 && r.status < 300, error: 'parse' }); }
        },
        onerror: (e) => reject(new Error('network error — check @connect and Web App deployment ("Anyone" access)')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  /* ============================================================
   * EXTRACTION
   * ==========================================================*/
  function extractFromCard(card, sel) {
    const titleEl = q(card, sel.cardTitle);
    const priceEl = q(card, sel.cardPrice);
    const urlEl = q(card, sel.cardUrl);
    const sellerEl = q(card, sel.cardSeller);
    const sellerUrlEl = q(card, sel.cardSellerUrl);
    return {
      title: clean(titleEl?.innerText),
      price: clean(priceEl?.innerText || priceEl?.getAttribute('content')),
      url: urlEl?.href || '',
      sellerName: clean(sellerEl?.innerText),
      sellerUrl: sellerUrlEl?.href || '',
      phone: '', // phones are never on listing cards, only on detail pages
    };
  }

  async function extractDetailPage(sel) {
    await sleep(800);

    const titleEl = q(document, sel.detailTitle);
    const priceEl = q(document, sel.detailPrice);
    const title = clean(titleEl?.innerText);
    const price = clean(priceEl?.innerText || priceEl?.getAttribute('content'));
    const negotiable = /negociabil/i.test(price);

    const sellerNameEl = q(document, sel.detailSellerName);
    const sellerName = clean(sellerNameEl?.innerText);
    const sellerUrl = sellerNameEl?.closest('a')?.href || q(document, sel.detailSellerUrl)?.href || '';

    if (!title) warn('detailTitle selector matched nothing — update sel.detailTitle');
    if (!price) warn('detailPrice selector matched nothing — update sel.detailPrice');

    let phone = '';
    const phoneBtn = q(document, sel.detailPhoneBtn);
    if (phoneBtn) {
      phoneBtn.click();
      await sleep(1200);
      const phoneEl = q(document, sel.detailPhone);
      phone = clean(phoneEl?.innerText || phoneEl?.getAttribute('href')?.replace('tel:', ''));
      if (!phone) warn('phone button clicked but no phone number found — update sel.detailPhone, or you may need to be logged in');
    } else {
      log('no phone-reveal button found on this page (may already be shown, or selector needs updating)');
    }

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
        notify('Saved', `${site.name}: "${detail.title.substring(0, 40)}"`);
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
