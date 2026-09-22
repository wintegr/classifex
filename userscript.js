      // ==UserScript==
      // @name         OLX & Public24 → Google Sheets
      // @match        *://*.olx.ro/d/anunt/*
      // @match        *://*.public24.ro/anunt/*
      // @grant        GM_xmlhttpRequest
      // @grant        GM_notification
      // @connect      script.google.com
      // @connect      script.googleusercontent.com
      // @version      1.0
      // @author       Security Researcher
      // @description  Extract listing data and send to Google Sheets via Web App
      // ==/UserScript==
      /* CONFIG - REPLACE WITH YOUR WEB APP URL */
      const WEB_APP_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
      /* ---------- UTILITIES ---------- */
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const clean = (s) => s?.replace(/\s+/g, ' ').trim() || '';
      const notify = (title, text) => GM_notification({title, text, timeout: 3000, silent: true});
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
      /* ---------- OLX.RO EXTRACTOR ---------- */
      async function extractOlx() {
        // Wait for page to settle
        await sleep(1500);

        const url = location.href;
        const title = clean(document.querySelector('[data-cy="ad-title"], h1[data-testid="ad-title"]')?.innerText);
        const priceEl = document.querySelector('[data-testid="ad-price"], [data-cy="ad-price"]');
        const price = clean(priceEl?.innerText);
        const negotiable = /negociabil/i.test(price);

        // Seller
        const sellerNameEl = document.querySelector('[data-cy="seller-name"], [data-testid="seller-name"]');
        const sellerName = clean(sellerNameEl?.innerText);
        const sellerUrl = sellerNameEl?.closest('a')?.href || '';

        // Phone - click "Arată numărul" if present
        let phone = '';
        const phoneBtn = document.querySelector('[data-cy="phone-button"], [data-testid="show-phone"]');
        if (phoneBtn) {
          phoneBtn.click();
          await sleep(1200); // wait for AJAX
          const phoneEl = document.querySelector('[data-cy="phone-number"], [data-testid="phone-number"]');
          phone = clean(phoneEl?.innerText);
        }

        return {source: 'OLX', url, title, price, negotiable, sellerName, sellerUrl, phone};
      }
      /* ---------- PUBLIC24.RO EXTRACTOR ---------- */
      async function extractPublic24() {
        await sleep(1500);

        const url = location.href;
        const title = clean(document.querySelector('h1.ad-title, h1[itemprop="name"]')?.innerText);

        const priceEl = document.querySelector('.ad-price, [itemprop="price"]');
        const price = clean(priceEl?.innerText || priceEl?.getAttribute('content'));
        const negotiable = /negociabil/i.test(price);

        // Seller
        const sellerNameEl = document.querySelector('.seller-name, .user-name, [itemprop="seller"] [itemprop="name"]');
        const sellerName = clean(sellerNameEl?.innerText);
        const sellerUrl = sellerNameEl?.closest('a')?.href || '';

        // Phone - click "Arată telefonul"
        let phone = '';
        const phoneBtn = document.querySelector('.show-phone, .phone-btn, [data-action="show-phone"]');
        if (phoneBtn) {
          phoneBtn.click();
          await sleep(1200);
          const phoneEl = document.querySelector('.phone-number, [itemprop="telephone"]');
          phone = clean(phoneEl?.innerText);
        }

        return {source: 'PUBLIC24', url, title, price, negotiable, sellerName, sellerUrl, phone};
      }
      /* ---------- UI: FLOATING BUTTON ---------- */
      function addButton() {
        if (document.getElementById('gm-sheets-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'gm-sheets-btn';
        btn.innerText = '📊 Save to Sheets';
        Object.assign(btn.style, {
          position: 'fixed', bottom: '20px', right: '20px', zIndex: 999999,
          padding: '10px 16px', background: '#1a73e8', color: '#fff',
          border: 'none', borderRadius: '6px', cursor: 'pointer',
          fontSize: '14px', fontWeight: '600', boxShadow: '0 4px 12px rgba(0,0,0,.3)'
        });
        btn.onmouseenter = () => btn.style.background = '#1557b0';
        btn.onmouseleave = () => btn.style.background = '#1a73e8';
        btn.onclick = handleSave;
        document.body.appendChild(btn);
      }
      async function handleSave() {
        const btn = document.getElementById('gm-sheets-btn');
        const original = btn.innerText;
        btn.innerText = '⏳ Saving...';
        btn.disabled = true;

        try {
          let data;
          if (location.hostname.includes('olx.ro')) data = await extractOlx();
          else if (location.hostname.includes('public24.ro')) data = await extractPublic24();
          else throw new Error('Unsupported site');

          const res = await sendToSheets(data);
          if (res.ok) {
            notify('Success', `${data.source}: "${data.title.substring(0,40)}..." saved`);
            btn.innerText = '✅ Saved!';
          } else {
            throw new Error(res.error || 'Unknown error');
          }
        } catch (e) {
          notify('Error', e.message);
          btn.innerText = '❌ Failed';
        }

        await sleep(2000);
        btn.innerText = original;
        btn.disabled = false;
      }
      /* ---------- INIT ---------- */
      if (location.hostname.includes('olx.ro') || location.hostname.includes('public24.ro')) {
        // Wait for page load
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', addButton);
        } else {
          addButton();
        }

        // SPA navigation (OLX uses client-side routing)
        let lastUrl = location.href;
        new MutationObserver(() => {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(addButton, 1000);
          }
        }).observe(document.body, {subtree: true, childList: true});
      }
