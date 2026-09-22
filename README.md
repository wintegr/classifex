bility
      ───────────────────────  ────────────────────────────────────────────────────────────────
      URL, title, price        ✅ Easy (in DOM)
      Negotiable               ✅ Text check
      Seller name/profile URL  ✅ In DOM
      Phone number             ⚠️  Hard — requires click + AJAX, often login-gated, rate-limited
      Anti-bot                 Both use Cloudflare + behavioral detection

    Phone numbers are the blocker. olx.ro shows them only after "Arată numărul" click (AJAX, requires session). public24.ro similar.

    ────────────────────────────────────

## Deploy

Create a Google Sheet "Listings" and copy write2sheet.gs
    1. Open script.google.com → New Project
    2. Paste this code, save, deploy as Web App (Execute as: Me, Who has access: Anyone)
    3. Deploy → New deployment → Type: Web App → Execute as: Me → Who has access: Anyone → Copy the Web App URL (ends with /exec)

For Tampermonkey, choose userscript.js for individual results or bulk.js for bulk results; copy the code, and create new script in Tampermonkey.

## Summary

      Step  Action
      ────  ─────────────────────────────────────────────────────────────────
      1     Create Google Sheet → copy Sheet ID from URL (/d/{SHEET_ID}/edit)
      2     Paste Sheet ID into SHEET_ID in Apps Script
      3     Deploy Apps Script as Web App → copy Web App URL
      4     Paste Web App URL into WEB_APP_URL in userscript
      5     Save userscript in Tampermonkey
      6     Open any OLX/Public24 listing → click 📊 Save to Sheets button

    ────────────────────────────────────

    Selectors Note

    These selectors are current as of 2024-2025. Both sites change markup occasionally. If a field comes back empty:

    1. Open DevTools (F12) on a listing page
    2. Inspect the element you need
    3. Update the selector in the userscript (document.querySelector('...'))

    ────────────────────────────────────

    Phone Number Limitation

    Both sites require a click + AJAX to reveal the phone. The script clicks the button and waits. If it fails:

    • You may need to be logged in
    • Rate limiting may block rapid requests
    • Some listings hide phones entirely

## Comparison

    ────────────────────────────────────

    What's New

      Button             Page             Behavior
      ─────────────────  ───────────────  ────────────────────────────────────────────────────────────────────────────────────────
      📦 Bulk Export     Search/category  Extracts visible cards (title, price, URL, seller) — no phones (fast, ~50 items)
      🔍 Deep Bulk       Search/category  Opens each listing in new tab, clicks "Show phone", extracts everything — slow, complete
      📊 Save to Sheets  Listing detail   Original single-save with phone

    ────────────────────────────────────

    Key Differences

      Mode         Speed       Phone Numbers              Use Case
      ───────────  ──────────  ─────────────────────────  ───────────────────────────────
      Bulk Export  ~2s/page    ❌ Not available on cards  Quick inventory, price tracking
      Deep Bulk    ~3-5s/item  ✅ Full phone extraction   When you need contact info
      Single Save  ~2s         ✅                         One-off listings

    ────────────────────────────────────

    Configuration Constants (top of script)

      ─ javascript
      const BULK_DELAY_MS = 1500;      // Delay between requests (avoid 429)
      const MAX_BULK_ITEMS = 50;       // Hard cap per run

    Adjust based on your tolerance. OLX/Public24 will rate-limit aggressive scraping.

    ────────────────────────────────────

    Install

    1. Replace WEB_APP_URL with your deployed Apps Script URL
    2. Save in Tampermonkey
    3. Go to any OLX/Public24 search page (e.g., olx.ro/auto/masini/) → see 📦 Bulk Export + 🔍 Deep Bulk buttons
    4. On a listing page → see 📊 Save to Sheets

    ────────────────────────────────────

    Pro Tips

    • Filter first on the site (price range, location, etc.) → then bulk export
    • Deep Bulk opens/closes tabs — allow popups for the domain
    • Check browser console (F12) if something fails — selectors log there
    • Run bulk exports in batches of 20-30 to stay under radar

    Want me to add pagination support (auto-click "Next page" and continue)?

 ───

## Troubleshooting 

    1. Check Tampermonkey Dashboard

    • Click Tampermonkey extension icon → Dashboard
    • Verify your script shows Enabled (toggle on)
    • Check @match patterns: should include *://*.olx.ro/* and *://*.public24.ro/*

    2. Open Browser Console (F12)

    Go to an OLX listing page (e.g., https://www.olx.ro/d/anunt/...) and check Console for:

    • Red errors — script failed to load
    • [GM] logs — GM_xmlhttpRequest not granted (check @grant)
    • No output — script not injecting (match pattern issue)

    3. Verify @match Patterns

    The first script uses:

      ─ javascript
      @match        *://*.olx.ro/d/anunt/*
      @match        *://*.public24.ro/anunt/*

    Problem: These only match detail pages, not search pages. If you're on a search page (olx.ro/auto/masini/), no button appears.

    Fix: Change to broader matches (like the bulk script):

      ─ javascript
      @match        *://*.olx.ro/*
      @match        *://*.public24.ro/*

    4. Check GAS Web App Deployment

    In Apps Script:

    • Deploy → Manage deployments → Web App
    • Execute as: Me
    • Who has access: Anyone (critical!)
    • Copy Web App URL (ends with /exec) → paste in userscript WEB_APP_URL

    5. Test GAS Endpoint Directly

    In browser console on any page:

      ─ javascript
      fetch('YOUR_WEB_APP_URL', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source: 'TEST', url: 'test', title: 'test', price: '100', negotiable: false, sellerName: 'test', sellerUrl: '', phone:
       ''})
      }).then(r => r.json()).then(console.log)

    Should return {ok: true}. If CORS error → Web App not deployed as "Anyone".

    6. Iron Browser Specifics

    • chrome://extensions/ → Tampermonkey → Details → Allow access to file URLs (if testing local files)
    • Iron may block GM_xmlhttpRequest to external domains → check @connect includes your script.google.com domain

    ────────────────────────────────────

    Multiple Userscripts: Yes, They Can Coexist

      Scenario                                         Works?
      ───────────────────────────────────────────────  ───────────────────────────
      Two scripts with different @match                ✅ Yes
      Two scripts on same domain, different functions  ✅ Yes (both inject)
      Both try to add button at #gm-sheets-btn         ⚠️  Conflict (duplicate IDs)
      Both use GM_xmlhttpRequest to same endpoint      ✅ Fine

    To run both safely:

    1. Give each script unique button IDs (gm-sheets-btn-v1, gm-bulk-btn)
    2. Or disable the first script (toggle off in Dashboard) while testing the bulk one
    3. Tampermonkey runs all enabled scripts matching the URL — no limit

    ────────────────────────────────────

    Quick Test: Minimal Debug Script

    Create a new userscript to verify injection works:

      ─ javascript
      // ==UserScript==
      // @name         Debug Injection Test
      // @match        *://*.olx.ro/*
      // @match        *://*.public24.ro/*
      // @grant        none
      // ==/UserScript==
      console.log('[DEBUG] Userscript running on', location.hostname);
      const btn = document.createElement('button');
      btn.innerText = '🧪 TEST BUTTON';
      btn.style.cssText =
      'position:fixed;top:20px;right:20px;z-index:999999;padding:10px;background:red;color:white;border:none;border-radius:4px;';
      btn.onclick = () => alert('Injection works!');
      document.body.appendChild(btn);

    If this button appears → injection works, problem is in your main script logic.
    If this doesn't appear → @match / Tampermonkey / Iron issue.

    ────────────────────────────────────

    Most Likely Fix for Your Case

    Change the first script's @match from:

      ─ javascript
      @match        *://*.olx.ro/d/anunt/*
      @match        *://*.public24.ro/anunt/*

    to:

      ─ javascript
      @match        *://*.olx.ro/*
      @match        *://*.public24.ro/*

    Then refresh the page. The detail-page button should appear on listing URLs.
