// ==UserScript==
// @name         Classifex — Kijiji.ca → Google Sheets
// @namespace    classifex
// @version      1.0
// @description  Extract Kijiji listing data (single save + bulk export from search) and send to the same Google Sheet used by the other classifex scripts
// @match        *://www.kijiji.ca/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * CONFIG — same Web App URL as the other classifex scripts.
   * Rows land with source: "KIJIJI".
   * ==========================================================*/
  const WEB_APP_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

  const BULK_DELAY_MS = 300;    // Kijiji's search JSON is already on the page — no per-item
                                 // network hit needed, so this only paces calls to your Sheet.
  const MAX_BULK_ITEMS = 40;    // matches Kijiji's page size (40 listings/page)
  const DEBUG = true;

  /* ============================================================
   * WHY THIS SCRIPT DOESN'T RELY ON CSS SELECTORS FOR SEARCH PAGES
   * Kijiji is a Next.js app that server-renders the full result set
   * into a <script id="__NEXT_DATA__"> JSON blob (an Apollo GraphQL
   * cache) — every listing on the page is already fully decoded in
   * that blob, no DOM-scraping/pagination-clicking needed. Reading
   * it directly is both more reliable and far cheaper than driving
   * the page. The detail (single listing) page doesn't have this
   * documented as thoroughly, so that path falls back to DOM
   * selectors, which — like OLX/Publi24/FB — may need adjusting if
   * Kijiji changes markup.
   * ==========================================================*/

  const log = (...a) => DEBUG && console.log('[classifex-kijiji]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
  const notify = (title, text, type = 'info') => {
    try { GM_notification({ title, text, timeout: type === 'error' ? 6000 : 3000, silent: true }); } catch (e) {}
    log(title, '-', text);
  };

  function getApolloState() {
    const tag = document.getElementById('__NEXT_DATA__');
    if (!tag) return null;
    try {
      const data = JSON.parse(tag.textContent);
      return data?.props?.pageProps?.__APOLLO_STATE__ || null;
    } catch (e) {
      log('failed to parse __NEXT_DATA__', e);
      return null;
    }
  }

  function formatPrice(price) {
    if (!price) return '';
    if (price.amount != null) return `$${(price.amount / 100).toFixed(2)}`;
    return price.type || '';
  }

  function splitDate(iso) {
    if (!iso) return { date: '', time: '' };
    const d = new Date(iso);
    if (isNaN(d)) return { date: '', time: '' };
    return { date: d.toLocaleDateString(), time: d.toLocaleTimeString() };
  }

  /* ============================================================
   * SEARCH PAGE — read every listing straight out of the Apollo cache
   * ==========================================================*/
  function findSrp(apollo) {
    const key = Object.keys(apollo.ROOT_QUERY || {}).find((k) => k.startsWith('searchResultsPageByUrl'));
    return key ? apollo.ROOT_QUERY[key] : null;
  }

  function extractSearchListings() {
    const apollo = getApolloState();
    if (!apollo) return [];
    const srp = findSrp(apollo);
    if (!srp) return [];

    const mainKey = Object.keys(srp.results || {}).find((k) => k.startsWith('mainListings'));
    const refs = mainKey ? srp.results[mainKey] : [];

    return refs
      .map((r) => apollo[r.__ref])
      .filter(Boolean)
      .map((listing) => {
        const { date, time } = splitDate(listing.sortingDate || listing.activationDate);
        return {
          source: 'KIJIJI',
          url: listing.url || '',
          title: clean(listing.title),
          price: formatPrice(listing.price),
          negotiable: /obo|negotiable|swap/i.test(listing.title || ''),
          description: '', // not included at search-card level
          datePosted: date,
          timePosted: time,
          adId: listing.id || '',
          views: '',
          location: clean(listing.location?.name),
          sellerName: '', sellerUrl: '', // not exposed on search cards
          phone: '',
        };
      });
  }

  async function bulkExport() {
    const rows = extractSearchListings();
    if (!rows.length) {
      notify('Nothing found', 'Could not read __NEXT_DATA__ on this page — Kijiji may have changed its markup', 'error');
      return;
    }
    const batch = rows.slice(0, MAX_BULK_ITEMS);
    notify('Bulk export started', `${batch.length} listings queued`);
    let ok = 0, fail = 0;
    for (const row of batch) {
      try {
        const res = await sendToSheets(row);
        res.ok ? ok++ : fail++;
      } catch (e) { fail++; log('row failed', e); }
      await sleep(BULK_DELAY_MS);
    }
    notify('Bulk export finished', `${ok} saved, ${fail} failed`);
  }

  /* ============================================================
   * DETAIL PAGE — try Apollo cache first, fall back to DOM
   * ==========================================================*/
  function getAdIdFromUrl() {
    const m = location.pathname.match(/\/(\d{6,})(?:$|\/)/);
    return m ? m[1] : '';
  }

  function findDetailFromApollo(adId) {
    const apollo = getApolloState();
    if (!apollo || !adId) return null;
    const key = Object.keys(apollo).find((k) => k.endsWith(`:${adId}`) && apollo[k]?.title);
    return key ? apollo[key] : null;
  }

  function q(root, selectors) {
    for (const sel of selectors.split(',').map((s) => s.trim())) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  const DOM = {
    title: 'h1[data-testid="vip-title"], h1',
    price: '[data-testid="vip-price"], span[itemprop="price"]',
    description: '[data-testid="vip-description"], [itemprop="description"]',
    location: '[data-testid="vip-location"], a[href*="maps"]',
    sellerName: '[data-testid="vip-seller-name"], a[href*="/o/"]',
    phoneBtn: '[data-testid="vip-call-btn"], button[aria-label*="phone" i]',
    phoneRevealed: 'a[href^="tel:"]',
    views: '[data-testid="vip-view-count"]',
  };

  async function extractDetailPage() {
    await sleep(1000);
    const adId = getAdIdFromUrl();
    const fromJson = findDetailFromApollo(adId);
    const url = location.href.split('?')[0];

    if (fromJson) {
      const { date, time } = splitDate(fromJson.sortingDate || fromJson.activationDate);
      return {
        source: 'KIJIJI',
        url,
        title: clean(fromJson.title),
        price: formatPrice(fromJson.price),
        negotiable: /obo|negotiable|swap/i.test(fromJson.description || fromJson.title || ''),
        description: clean(fromJson.description),
        datePosted: date, timePosted: time,
        adId,
        views: fromJson.views ?? '',
        location: clean(fromJson.location?.name),
        sellerName: clean(fromJson.sellerName) || '',
        sellerUrl: '',
        phone: '', // see note below on phone reveal
      };
    }

    // Fallback: plain DOM read (selectors unverified — inspect and adjust if empty)
    const title = clean(q(document, DOM.title)?.innerText);
    const price = clean(q(document, DOM.price)?.innerText);
    const description = clean(q(document, DOM.description)?.innerText);
    const loc = clean(q(document, DOM.location)?.innerText);
    const sellerNameEl = q(document, DOM.sellerName);
    const sellerName = clean(sellerNameEl?.innerText);
    const sellerUrl = sellerNameEl?.closest('a')?.href || sellerNameEl?.href || '';
    const views = clean(q(document, DOM.views)?.innerText);

    // Phone reveal — Kijiji shows this on some (not all) listings. Click and
    // wait; if nothing appears, leave blank rather than guess.
    let phone = '';
    const phoneBtn = q(document, DOM.phoneBtn);
    if (phoneBtn) {
      phoneBtn.click();
      await sleep(1000);
      phone = clean(q(document, DOM.phoneRevealed)?.innerText || q(document, DOM.phoneRevealed)?.href?.replace('tel:', ''));
    }

    return {
      source: 'KIJIJI', url, title, price,
      negotiable: /obo|negotiable|swap/i.test(description || title),
      description, datePosted: '', timePosted: '', adId, views,
      location: loc, sellerName, sellerUrl, phone,
    };
  }

  /* ============================================================
   * SEND TO SHEETS
   * ==========================================================*/
  function sendToSheets(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: WEB_APP_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { resolve({ ok: false, error: 'parse' }); } },
        onerror: reject,
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  /* ============================================================
   * UI
   * ==========================================================*/
  function createButton(id, text, onClick) {
    if (document.getElementById(id)) return;
    const btn = document.createElement('button');
    btn.id = id;
    btn.innerText = text;
    Object.assign(btn.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: 999999,
      padding: '10px 16px', background: '#1a73e8', color: '#fff',
      border: 'none', borderRadius: '6px', cursor: 'pointer',
      fontSize: '14px', fontWeight: '600', boxShadow: '0 4px 12px rgba(0,0,0,.3)',
    });
    btn.onmouseenter = () => (btn.style.background = '#1557b0');
    btn.onmouseleave = () => (btn.style.background = '#1a73e8');
    btn.onclick = onClick;
    document.body.appendChild(btn);
  }

  async function handleSingleSave() {
    const btn = document.getElementById('classifex-kijiji-save');
    const original = btn.innerText;
    btn.innerText = '⏳ Saving...'; btn.disabled = true;
    try {
      const data = await extractDetailPage();
      if (!data.title) throw new Error('Could not read title — selectors likely need updating');
      const res = await sendToSheets(data);
      if (!res.ok) throw new Error(res.error || 'Unknown error');
      notify('Saved', `"${data.title.slice(0, 40)}..." saved`);
      btn.innerText = '✅ Saved!';
    } catch (e) {
      notify('Error', e.message, 'error');
      btn.innerText = '❌ Failed';
    }
    await sleep(2000);
    btn.innerText = original; btn.disabled = false;
  }

  function isDetailPath(path) { return /\/v-[^/]+\/.+\/\d{6,}/.test(path); }
  function isSearchPath(path) { return /\/b-/.test(path) || path === '/'; }

  function removeButtons() {
    document.getElementById('classifex-kijiji-save')?.remove();
    document.getElementById('classifex-kijiji-bulk')?.remove();
  }

  function addButtons() {
    removeButtons();
    const path = location.pathname;
    if (isDetailPath(path)) createButton('classifex-kijiji-save', '📊 Save to Sheets', handleSingleSave);
    else if (isSearchPath(path)) createButton('classifex-kijiji-bulk', '📦 Bulk Export', bulkExport);
  }

  /* ============================================================
   * INIT — SPA navigation between search/detail pages
   * ==========================================================*/
  setTimeout(addButtons, 1000);
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(addButtons, 1000);
    }
  }).observe(document.body, { subtree: true, childList: true });
})();
