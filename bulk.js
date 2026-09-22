      // ==UserScript==
      // @name         OLX & publi24 → Google Sheets (Bulk)
      // @match        *://*.olx.ro/*
      // @match        *://*.publi24.ro/*
      // @grant        GM_xmlhttpRequest
      // @grant        GM_notification
      // @grant        GM_setValue
      // @grant        GM_getValue
      // @connect      script.google.com
      // @connect      script.googleusercontent.com
      // @version      1.1
      // @author       Security Researcher
      // @description  Bulk export listings from search pages + single listing save
      // ==/UserScript==
      /* CONFIG - REPLACE THESE */
      const WEB_APP_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
      const BULK_DELAY_MS = 1500;      // delay between listings (avoid rate limit)
      const MAX_BULK_ITEMS = 50;       // safety cap
      /* ---------- UTILITIES ---------- */
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const clean = (s) => s?.replace(/\s+/g, ' ').trim() || '';
      const notify = (title, text, type = 'info') => GM_notification({
        title, text, timeout: type === 'error' ? 5000 : 3000, silent: true
      });
      /* ---------- SEND TO SHEETS ---------- */
      async function sendToSheets(payload) {
        return new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'POST',
            url: WEB_APP_URL,
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify(payload),
            onload: (r) => {
              try { resolve(JSON.parse(r.responseText)); } catch { resolve({ok: false, error: 'parse'}); }
            },
            onerror: reject,
            ontimeout: () => reject(new Error('timeout'))
          });
        });
      }
      /* ---------- OLX SELECTORS ---------- */
      const OLX = {
        // Search page listing cards
        cards: '[data-cy="l-card"], [data-testid="l-card"], .css-1sw7q4x',
        // Within card
        cardTitle: '[data-cy="ad-title"], [data-testid="ad-title"], h6',
        cardPrice: '[data-testid="ad-price"], [data-cy="ad-price"], .css-10b0gli',
        cardUrl: 'a[data-cy="ad-link"], a[href*="/d/anunt/"]',
        cardSeller: '[data-cy="seller-name"], [data-testid="seller-name"]',
        cardSellerUrl: 'a[href*="/user/"]',
        // Detail page
        detailTitle: '[data-cy="ad-title"], h1[data-testid="ad-title"]',
        detailPrice: '[data-testid="ad-price"], [data-cy="ad-price"]',
        detailSellerName: '[data-cy="seller-name"], [data-testid="seller-name"]',
        detailSellerUrl: 'a[href*="/user/"]',
        detailPhoneBtn: '[data-cy="phone-button"], [data-testid="show-phone"]',
        detailPhone: '[data-cy="phone-number"], [data-testid="phone-number"]',
      };
      /* ---------- publi24 SELECTORS ---------- */
      const P24 = {
        cards: '.ad-item, .listing-item, .item-ad, article.ad',
        cardTitle: '.ad-title, h3 a, h2 a, [itemprop="name"]',
        cardPrice: '.ad-price, .price, [itemprop="price"]',
        cardUrl: 'a[href*="/anunt/"], .ad-title a',
        cardSeller: '.seller-name, .user-name, [itemprop="seller"] [itemprop="name"]',
        cardSellerUrl: 'a[href*="/user/"], a[href*="/profil/"]',
        detailTitle: 'h1.ad-title, h1[itemprop="name"]',
        detailPrice: '.ad-price, [itemprop="price"]',
        detailSellerName: '.seller-name, .user-name, [itemprop="seller"] [itemprop="name"]',
        detailSellerUrl: 'a[href*="/user/"], a[href*="/profil/"]',
        detailPhoneBtn: '.show-phone, .phone-btn, [data-action="show-phone"]',
        detailPhone: '.phone-number, [itemprop="telephone"]',
      };
      /* ---------- DETECT SITE ---------- */
      function getSite() {
        if (location.hostname.includes('olx.ro')) return {site: 'OLX', sel: OLX};
        if (location.hostname.includes('publi24.ro')) return {site: 'publi24', sel: P24};
        return null;
      }
      /* ---------- EXTRACT FROM CARD (search page) ---------- */
      function extractFromCard(card, sel) {
        const titleEl = card.querySelector(sel.cardTitle);
        const priceEl = card.querySelector(sel.cardPrice);
        const urlEl = card.querySelector(sel.cardUrl);
        const sellerEl = card.querySelector(sel.cardSeller);
        const sellerUrlEl = card.querySelector(sel.cardSellerUrl);

        return {
          title: clean(titleEl?.innerText),
          price: clean(priceEl?.innerText || priceEl?.getAttribute('content')),
          url: urlEl?.href || '',
          sellerName: clean(sellerEl?.innerText),
          sellerUrl: sellerUrlEl?.href || '',
          phone: '', // phones not on search cards
        };
      }
      /* ---------- EXTRACT FROM DETAIL PAGE ---------- */
      async function extractDetailPage(sel) {
        await sleep(800);

        const title = clean(document.querySelector(sel.detailTitle)?.innerText);
        const priceEl = document.querySelector(sel.detailPrice);
        const price = clean(priceEl?.innerText || priceEl?.getAttribute('content'));
        const negotiable = /negociabil/i.test(price);

        const sellerNameEl = document.querySelector(sel.detailSellerName);
        const sellerName = clean(sellerNameEl?.innerText);
        const sellerUrl = sellerNameEl?.closest('a')?.href ||
                          document.querySelector(sel.detailSellerUrl)?.href || '';

        // Phone
        let phone = '';
        const phoneBtn = document.querySelector(sel.detailPhoneBtn);
        if (phoneBtn) {
          phoneBtn.click();
          await sleep(1000);
          const phoneEl = document.querySelector(sel.detailPhone);
          phone = clean(phoneEl?.innerText);
        }

        return {title, price, negotiable, sellerName, sellerUrl, phone};
      }
      /* ---------- BULK EXPORT LOGIC ---------- */
      async function bulkExport() {
        const {site, sel} = getSite();
        if (!site) return;

        const cards = Array.from(document.querySelectorAll(sel.cards));
        if (!cards.length) {
          notify('Bulk Export', `No listings found on this ${site} page`);
          return;
        }

        const total = Math.min(cards.length, MAX_BULK_ITEMS);
        notify('Bulk Export', `Found ${cards.length} listings, processing first ${total}...`);

        const btn = document.getElementById('gm-bulk-btn');
        const orig = btn.innerText;

        let success = 0, failed = 0;

        for (let i = 0; i < total; i++) {
          btn.innerText = `⏳ ${i+1}/${total}`;
          btn.disabled = true;

          try {
            const cardData = extractFromCard(cards[i], sel);
            if (!cardData.url) { failed++; continue; }

            // Option A: Use card data only (fast, no phone)
            // Option B: Navigate to detail page for phone (slow, complete)
            // We'll do Option A by default, user can enable deep scrape
            const payload = {
              source: site,
              url: cardData.url,
              title: cardData.title,
              price: cardData.price,
              negotiable: /negociabil/i.test(cardData.price) ? true : false,
              sellerName: cardData.sellerName,
              sellerUrl: cardData.sellerUrl,
              phone: cardData.phone,
            };

            const res = await sendToSheets(payload);
            if (res.ok) success++; else failed++;

          } catch (e) {
            failed++;
            console.error('Bulk item error:', e);
          }

          if (i < total - 1) await sleep(BULK_DELAY_MS);
        }

        btn.innerText = orig;
        btn.disabled = false;
        notify('Bulk Export Done', `${site}: ${success} saved, ${failed} failed`, failed ? 'error' : 'info');
      }
      /* ---------- DEEP BULK (visit each listing for phone) ---------- */
      async function deepBulkExport() {
        const {site, sel} = getSite();
        if (!site) return;

        const cards = Array.from(document.querySelectorAll(sel.cards));
        const urls = cards.map(c => c.querySelector(sel.cardUrl)?.href).filter(Boolean);
        const total = Math.min(urls.length, MAX_BULK_ITEMS);

        if (!total) { notify('Deep Bulk', 'No valid listing URLs'); return; }

        const confirmDeep = confirm(
          `DEEP BULK: Will open ${total} tabs sequentially to get phone numbers.\n` +
          `Estimated time: ~${Math.round(total * (BULK_DELAY_MS + 2000) / 1000)}s.\n\nContinue?`
        );
        if (!confirmDeep) return;

        notify('Deep Bulk', `Starting deep scrape of ${total} listings...`);

        const btn = document.getElementById('gm-deep-btn');
        const orig = btn.innerText;
        let success = 0, failed = 0;

        for (let i = 0; i < total; i++) {
          btn.innerText = `🔍 ${i+1}/${total}`;
          btn.disabled = true;

          try {
            // Open in new tab
            const tab = window.open(urls[i], '_blank');
            if (!tab) throw new Error('Popup blocked');

            // Wait for tab to load
            await new Promise(r => {
              const check = setInterval(() => {
                if (tab.document.readyState === 'complete') {
                  clearInterval(check);
                  r();
                }
              }, 200);
            });

            // Extract from detail page
            await sleep(1000);
            const detail = await extractDetailPage(sel);

            const payload = {
              source: site,
              url: urls[i],
              title: detail.title,
              price: detail.price,
              negotiable: detail.negotiable,
              sellerName: detail.sellerName,
              sellerUrl: detail.sellerUrl,
              phone: detail.phone,
            };

            const res = await sendToSheets(payload);
            if (res.ok) success++; else failed++;

            tab.close();

          } catch (e) {
            failed++;
            console.error('Deep bulk error:', e);
          }

          if (i < total - 1) await sleep(BULK_DELAY_MS);
        }

        btn.innerText = orig;
        btn.disabled = false;
        notify('Deep Bulk Done', `${site}: ${success} saved, ${failed} failed`, failed ? 'error' : 'info');
      }
      /* ---------- SINGLE LISTING SAVE (from detail page) ---------- */
      async function handleSingleSave() {
        const {site, sel} = getSite();
        if (!site) return;

        const btn = document.getElementById('gm-single-btn');
        const orig = btn.innerText;
        btn.innerText = '⏳ Saving...';
        btn.disabled = true;

        try {
          const detail = await extractDetailPage(sel);
          const payload = {
            source: site,
            url: location.href,
            title: detail.title,
            price: detail.price,
            negotiable: detail.negotiable,
            sellerName: detail.sellerName,
            sellerUrl: detail.sellerUrl,
            phone: detail.phone,
          };

          const res = await sendToSheets(payload);
          if (res.ok) {
            notify('Saved', `${site}: "${detail.title.substring(0,40)}..."`);
            btn.innerText = '✅ Saved!';
          } else throw new Error(res.error || 'Failed');
        } catch (e) {
          notify('Error', e.message, 'error');
          btn.innerText = '❌ Failed';
        }

        await sleep(2000);
        btn.innerText = orig;
        btn.disabled = false;
      }
      /* ---------- UI BUTTONS ---------- */
      function createButton(id, text, click, styleOverrides = {}) {
        if (document.getElementById(id)) return;
        const btn = document.createElement('button');
        btn.id = id;
        btn.innerText = text;
        Object.assign(btn.style, {
          position: 'fixed', zIndex: 999999,
          padding: '10px 14px', border: 'none', borderRadius: '6px',
          cursor: 'pointer', fontSize: '13px', fontWeight: '600',
          boxShadow: '0 4px 12px rgba(0,0,0,.3)',
          ...styleOverrides
        });
        btn.onclick = click;
        document.body.appendChild(btn);
        return btn;
      }
      function addButtons() {
        const {site} = getSite();
        if (!site) return;

        const isDetail = /\/anunt\/|\/d\/anunt\//.test(location.pathname);
        const baseRight = 20;
        const baseBottom = 20;
        const gap = 50;

        if (isDetail) {
          // Detail page: single save
          createButton('gm-single-btn', '📊 Save to Sheets', handleSingleSave, {
            bottom: `${baseBottom}px`, right: `${baseRight}px`,
            background: '#1a73e8', color: '#fff'
          });
        } else {
          // Search/category page: bulk buttons
          createButton('gm-bulk-btn', `📦 Bulk Export (${site})`, bulkExport, {
            bottom: `${baseBottom}px`, right: `${baseRight}px`,
            background: '#34a853', color: '#fff'
          });
          createButton('gm-deep-btn', `🔍 Deep Bulk (phones)`, deepBulkExport, {
            bottom: `${baseBottom + gap}px`, right: `${baseRight}px`,
            background: '#ea4335', color: '#fff'
          });
        }
      }
      /* ---------- INIT ---------- */
      function init() {
        addButtons();

        // Handle SPA navigation
        let lastUrl = location.href;
        new MutationObserver(() => {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            // Remove old buttons
            ['gm-single-btn', 'gm-bulk-btn', 'gm-deep-btn'].forEach(id => {
              const el = document.getElementById(id);
              if (el) el.remove();
            });
            setTimeout(addButtons, 800);
          }
        }).observe(document.body, {subtree: true, childList: true});
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
