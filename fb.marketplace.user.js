// ==UserScript==
// @name         Classifex — Facebook Marketplace → Google Sheets
// @namespace    classifex
// @version      1.0
// @description  Extract Facebook Marketplace listing data (single save + bulk export from search) and send to the same Google Sheet used by the OLX/Publi24 classifex scripts
// @match        *://www.facebook.com/marketplace/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * CONFIG — same Web App URL as the OLX/Publi24 scripts. The
   * backend (write2sheet.gas) is unchanged: it just gets
   * source: "FB_MARKETPLACE" rows appended alongside the others.
   * ==========================================================*/
  const WEB_APP_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

  const BULK_DELAY_MS = 2500;   // FB rate-limits/checkpoints harder than OLX — keep this generous
  const MAX_BULK_ITEMS = 25;    // safety cap per run
  const DEBUG = true;

  /* ============================================================
   * UTILITIES
   * ==========================================================*/
  const log = (...a) => DEBUG && console.log('[classifex-fb]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
  const notify = (title, text, type = 'info') => {
    try {
      GM_notification({ title, text, timeout: type === 'error' ? 6000 : 3000, silent: true });
    } catch (e) { /* not available in this context */ }
    log(title, '-', text);
  };

  // Try selectors in order, first match wins.
  function q(root, selectors) {
    for (const sel of selectors.split(',').map((s) => s.trim())) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /* ============================================================
   * SELECTORS — Facebook's class names are auto-generated and
   * churn constantly. These lean on structure (roles, hrefs,
   * dialog wrappers) and text patterns rather than class names,
   * but this section is exactly where you'll need to adjust if
   * a field comes back empty. Open DevTools on a listing, inspect
   * the field, and update here.
   * ==========================================================*/
  const SEL = {
    // Detail page (facebook.com/marketplace/item/<id>/)
    detailRoot: '[role="main"]',
    title: 'h1',
    price: 'span[dir="auto"]', // first $-looking span near the title, see extractPrice()
    description: '[data-testid="marketplace_pdp_description"], [class*="description"] span',
    location: 'a[href*="/marketplace/"][href*="location"], span[dir="auto"]', // fallback: text-scan, see extractLocation()
    sellerLink: 'a[href*="/marketplace/profile/"], a[href^="https://www.facebook.com/profile.php"], a[href*="facebook.com/people/"]',
    photo: 'img[src*="scontent"]',

    // Search / category grid cards
    cards: 'a[href*="/marketplace/item/"]',
  };

  /* ============================================================
   * DETAIL PAGE EXTRACTION
   * ==========================================================*/
  function extractPrice() {
    // Price is usually the first short "$123" / "€123" text node near the
    // title, not inside the description. Scan spans, take the first
    // currency-shaped match.
    const spans = document.querySelectorAll('span[dir="auto"]');
    for (const el of spans) {
      const t = clean(el.innerText);
      if (/^(\$|€|lei)\s?\d[\d.,]*$/i.test(t) || /^\d[\d.,]*\s?(lei|€|\$)$/i.test(t)) {
        return t;
      }
    }
    return '';
  }

  function extractLocation() {
    // Location usually appears as a short "City, State/County" string
    // below the price, often inside an <a> pointing at a location filter.
    const candidates = document.querySelectorAll('a[href*="/marketplace/"] span, span[dir="auto"]');
    for (const el of candidates) {
      const t = clean(el.innerText);
      if (/^[A-Za-zĂÂÎȘȚăâîșț\-\s]+,\s?[A-Za-zĂÂÎȘȚăâîșț\-\s]+$/.test(t) && t.length < 60) {
        return t;
      }
    }
    return '';
  }

  function extractSeller() {
    const el = q(document, SEL.sellerLink);
    return {
      sellerName: clean(el?.innerText),
      sellerUrl: el?.href || '',
    };
  }

  function extractAdId() {
    const m = location.pathname.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : '';
  }

  async function extractDetailPage() {
    await sleep(1200); // let the SPA finish rendering

    const url = location.href.split('?')[0];
    const title = clean(q(document, SEL.title)?.innerText);
    const price = extractPrice();
    const negotiable = /obo|negociabil|or best offer/i.test(document.body.innerText);
    const description = clean(q(document, SEL.description)?.innerText);
    const location_ = extractLocation();
    const { sellerName, sellerUrl } = extractSeller();
    const adId = extractAdId();

    return {
      source: 'FB_MARKETPLACE',
      url,
      title,
      price,
      negotiable,
      description,
      datePosted: '',   // Marketplace listing pages don't reliably expose a posted date/time in the DOM
      timePosted: '',
      adId,
      views: '',        // not shown on Marketplace listings
      location: location_,
      sellerName,
      sellerUrl,
      phone: '',        // Marketplace has no phone-reveal — contact is via Messenger only, deliberately not automated here
    };
  }

  /* ============================================================
   * SEARCH-PAGE CARD EXTRACTION (bulk export)
   * ==========================================================*/
  function extractFromCard(card) {
    const url = card.href ? card.href.split('?')[0] : '';
    const texts = [...card.querySelectorAll('span[dir="auto"]')]
      .map((el) => clean(el.innerText))
      .filter(Boolean);

    // Heuristic: first currency-shaped text is price, the longest
    // remaining text is the title, a short trailing "City, ST" text is location.
    const priceIdx = texts.findIndex((t) => /^(\$|€|lei)\s?\d[\d.,]*$/i.test(t) || /^\d[\d.,]*\s?(lei|€|\$)$/i.test(t));
    const price = priceIdx >= 0 ? texts[priceIdx] : '';
    const rest = texts.filter((_, i) => i !== priceIdx);
    const title = rest.sort((a, b) => b.length - a.length)[0] || '';
    const location_ = rest.find((t) => /,/.test(t) && t.length < 40) || '';

    return {
      source: 'FB_MARKETPLACE',
      url,
      title,
      price,
      negotiable: false,
      description: '',
      datePosted: '', timePosted: '',
      adId: (url.match(/\/marketplace\/item\/(\d+)/) || [])[1] || '',
      views: '',
      location: location_,
      sellerName: '', sellerUrl: '', // not shown on search cards
      phone: '',
    };
  }

  async function bulkExport() {
    const cards = [...document.querySelectorAll(SEL.cards)].slice(0, MAX_BULK_ITEMS);
    if (!cards.length) { notify('Nothing found', 'No listing cards detected on this page', 'error'); return; }

    notify('Bulk export started', `${cards.length} listings queued`);
    let ok = 0, fail = 0;

    for (const card of cards) {
      try {
        const data = extractFromCard(card);
        if (!data.url || !data.title) { fail++; continue; }
        const res = await sendToSheets(data);
        res.ok ? ok++ : fail++;
      } catch (e) {
        fail++;
        log('card failed', e);
      }
      await sleep(BULK_DELAY_MS);
    }

    notify('Bulk export finished', `${ok} saved, ${fail} skipped/failed`);
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
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); } catch { resolve({ ok: false, error: 'parse' }); }
        },
        onerror: reject,
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  /* ============================================================
   * UI
   * ==========================================================*/
  function createButton(id, text, bottom, onClick) {
    if (document.getElementById(id)) return;
    const btn = document.createElement('button');
    btn.id = id;
    btn.innerText = text;
    Object.assign(btn.style, {
      position: 'fixed', bottom, right: '20px', zIndex: 999999,
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
    const btn = document.getElementById('classifex-fb-save');
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

  function addButtons() {
    const path = location.pathname;
    if (/\/marketplace\/item\/\d+/.test(path)) {
      createButton('classifex-fb-save', '📊 Save to Sheets', '20px', handleSingleSave);
    } else if (/\/marketplace\/(category|search)/.test(path) || path === '/marketplace/') {
      createButton('classifex-fb-bulk', '📦 Bulk Export', '20px', bulkExport);
    }
  }

  function removeButtons() {
    document.getElementById('classifex-fb-save')?.remove();
    document.getElementById('classifex-fb-bulk')?.remove();
  }

  /* ============================================================
   * INIT — Marketplace is a client-side-routed SPA, so watch for
   * URL changes instead of relying on page loads.
   * ==========================================================*/
  function init() {
    removeButtons();
    setTimeout(addButtons, 1200);
  }

  init();
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      init();
    }
  }).observe(document.body, { subtree: true, childList: true });
})();
