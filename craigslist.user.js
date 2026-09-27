// ==UserScript==
// @name         Classifex — Craigslist → Google Sheets
// @namespace    classifex
// @version      1.0
// @description  Extract Craigslist listing data (single save + bulk export from search) and send to the same Google Sheet used by the other classifex scripts. Works on any city subdomain, including all Canadian cities (toronto, vancouver, montreal, calgary, ottawa, edmonton, winnipeg, halifax, ...).
// @match        *://*.craigslist.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * CONFIG — same Web App URL as the other classifex scripts.
   * Rows land with source: "CRAIGSLIST".
   * ==========================================================*/
  const WEB_APP_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

  const BULK_DELAY_MS = 500;    // search results are already fully rendered on the page —
                                 // this only paces calls to your Sheet, not requests to Craigslist
  const MAX_BULK_ITEMS = 120;   // roughly one search results page
  const DEBUG = true;

  /* ============================================================
   * Craigslist has used the same class names across every city
   * subdomain for years (one shared template, unlike OLX/Kijiji/FB
   * which each have their own markup), so this one config covers
   * every Canadian city automatically. Both the current and the
   * slightly older result-list class names are included below in
   * case a given city/category is still serving the older skin.
   * ==========================================================*/

  const log = (...a) => DEBUG && console.log('[classifex-craigslist]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
  const notify = (title, text, type = 'info') => {
    try { GM_notification({ title, text, timeout: type === 'error' ? 6000 : 3000, silent: true }); } catch (e) {}
    log(title, '-', text);
  };
  function q(root, selectors) {
    for (const sel of selectors.split(',').map((s) => s.trim())) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  const SEL = {
    cards: 'li.cl-static-search-result, li.result-row, li.cl-search-result[data-pid]',
    cardTitle: 'a.posting-title span.label, a.result-title, .title',
    cardUrl: 'a.posting-title, a.result-title, a.cl-app-anchor',
    cardPrice: 'span.priceinfo, span.result-price, .price',
    cardLocation: 'span.result-hood, span.result-location',
    cardDate: 'span.result-posted-date, time',

    detailTitle: '#titletextonly',
    detailPrice: '.postingtitletext .price, span.price',
    detailLocation: '.postingtitletext small, .mapaddress',
    detailDescription: '#postingbody',
    detailDate: '.postinginfos time, time[datetime]',
  };

  /* ============================================================
   * SEARCH PAGE — cards are fully rendered on the page already
   * ==========================================================*/
  function extractFromCard(card) {
    const urlEl = q(card, SEL.cardUrl);
    const url = urlEl?.href?.split('?')[0] || '';
    const title = clean(q(card, SEL.cardTitle)?.innerText);
    const price = clean(q(card, SEL.cardPrice)?.innerText);
    const location_ = clean(q(card, SEL.cardLocation)?.innerText).replace(/^\(|\)$/g, '');
    const dateEl = q(card, SEL.cardDate);
    const datePosted = dateEl?.getAttribute?.('datetime') ? '' : clean(dateEl?.innerText); // relative label only on cards
    const adId = card.getAttribute('data-pid') || (url.match(/(\d+)\.html$/) || [])[1] || '';

    return {
      source: 'CRAIGSLIST',
      url, title, price,
      negotiable: /obo|or best offer/i.test(title),
      description: '',
      datePosted, timePosted: '',
      adId,
      views: '',
      location: location_,
      sellerName: '', sellerUrl: '', // Craigslist postings are anonymous — no seller profile
      phone: '', // no phone reveal — contact is via the anonymized "reply" email relay, not automated here
    };
  }

  async function bulkExport() {
    const cards = [...document.querySelectorAll(SEL.cards)].slice(0, MAX_BULK_ITEMS);
    if (!cards.length) { notify('Nothing found', 'No listing cards detected — Craigslist may be serving a different template', 'error'); return; }

    notify('Bulk export started', `${cards.length} listings queued`);
    let ok = 0, fail = 0;
    for (const card of cards) {
      try {
        const data = extractFromCard(card);
        if (!data.url || !data.title) { fail++; continue; }
        const res = await sendToSheets(data);
        res.ok ? ok++ : fail++;
      } catch (e) { fail++; log('card failed', e); }
      await sleep(BULK_DELAY_MS);
    }
    notify('Bulk export finished', `${ok} saved, ${fail} skipped/failed`);
  }

  /* ============================================================
   * DETAIL PAGE
   * ==========================================================*/
  function extractAdId() {
    const m = location.pathname.match(/(\d+)\.html$/);
    return m ? m[1] : '';
  }

  function cleanDescription(text) {
    // Strips the boilerplate Craigslist appends to every posting body.
    return clean(text).replace(/QR Code Link to This Post/i, '').trim();
  }

  async function extractDetailPage() {
    await sleep(500); // Craigslist detail pages are server-rendered, minimal JS settling needed

    const url = location.href.split('?')[0];
    const title = clean(q(document, SEL.detailTitle)?.innerText);
    const price = clean(q(document, SEL.detailPrice)?.innerText);
    const location_ = clean(q(document, SEL.detailLocation)?.innerText).replace(/^\(|\)$/g, '');
    const description = cleanDescription(q(document, SEL.detailDescription)?.innerText);
    const dateEl = q(document, SEL.detailDate);
    const iso = dateEl?.getAttribute?.('datetime') || '';
    const d = iso ? new Date(iso) : null;
    const datePosted = d && !isNaN(d) ? d.toLocaleDateString() : '';
    const timePosted = d && !isNaN(d) ? d.toLocaleTimeString() : '';

    return {
      source: 'CRAIGSLIST',
      url, title, price,
      negotiable: /obo|or best offer/i.test(description || title),
      description,
      datePosted, timePosted,
      adId: extractAdId(),
      views: '', // not shown on Craigslist postings
      location: location_,
      sellerName: '', sellerUrl: '',
      phone: '',
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
    const btn = document.getElementById('classifex-cl-save');
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

  function isDetailPath(path) { return /\/d\/[^/]+\/\d+\.html$/.test(path); }
  function isSearchPath(path) { return /\/search\//.test(path); }

  function addButtons() {
    document.getElementById('classifex-cl-save')?.remove();
    document.getElementById('classifex-cl-bulk')?.remove();
    const path = location.pathname;
    if (isDetailPath(path)) createButton('classifex-cl-save', '📊 Save to Sheets', handleSingleSave);
    else if (isSearchPath(path)) createButton('classifex-cl-bulk', '📦 Bulk Export', bulkExport);
  }

  /* ============================================================
   * INIT — Craigslist is mostly classic full page loads, but cover
   * client-side nav (e.g. "next 120 postings") just in case.
   * ==========================================================*/
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addButtons);
  } else {
    addButtons();
  }
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(addButtons, 500);
    }
  }).observe(document.body, { subtree: true, childList: true });
})();
