
// index.js — Zonaprop (tu versión 20SEP) + microScore OSM (A..Z)
// (NO CAMBIÉ el método de scrapeo: se mantienen tus selectores y flujo)
//
// A..S (igual que tu script que andaba):
// price, expenses, address, neighborhood, description, link,
// totalArea, coveredArea, rooms, bathrooms, bedrooms, toilets,
// age, backFacing, propertyType, daysFromPublish, views,
// lastSeenAt, Active
//
// + T..Z nuevas:
// lat, lon, distSubte, distParque, distViaRapida, distFerrocarril, microScore

"use strict";

const { chromium } = require("playwright");
const { google } = require("googleapis");
const fs = require("fs");
const { scoreAddress } = require("./scorer");

/* ==============================
   ▶ EDITÁ SOLO ESTAS 2 LÍNEAS
   ============================== */
const BASE_URL  = "https://www.zonaprop.com.ar/ph-venta-saavedra-50000-200000-dolar"; // << pegá tu URL (sin .html)
const SHEET_TAB = "PH-SAAVEDRA"; // << nombre de la pestaña

/* ==============================
   Config fija (tu Sheet)
   ============================== */
const SPREADSHEET_ID = "1izKR1lLezYmH7_ZJTgQEcqHrpgdwxMqO5H4hG81zifg"; // tu ID

/* ==============================
   Helpers
   ============================== */
function nowISO() { return new Date().toISOString(); }

async function ensureSheetExists(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(s => s.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
  }
}

// ➜ Header extendido a A..Z (mantengo "Active" como nombre de tu col. S)
async function ensureHeader(sheets, spreadsheetId, sheetTitle) {
  await ensureSheetExists(sheets, spreadsheetId, sheetTitle);
  const header = [[
    "price","expenses","address","neighborhood","description","link",
    "totalArea","coveredArea","rooms","bathrooms","bedrooms","toilets",
    "age","backFacing","propertyType","daysFromPublish","views",
    "lastSeenAt","Active",
    "lat","lon","distSubte","distParque","distViaRapida","distFerrocarril","microScore"
  ]];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetTitle}'!A1:Z1`,
  });
  const hasHeader = res.data.values && res.data.values[0] && res.data.values[0].length >= 6;
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetTitle}'!A1:Z1`,
      valueInputOption: "RAW",
      requestBody: { values: header },
    });
  }
}

// padding a 26 columnas (A..Z)
function rowTo26(row) {
  const out = new Array(26).fill("");
  for (let i = 0; i < Math.min(row.length, 26); i++) out[i] = row[i];
  return out;
}

// fila completa (A..Z)
function buildRowFromPost(post, status) {
  return [
    post.price ?? "",                     // A
    post.expenses ?? "",                  // B
    post.address ?? "",                   // C
    post.neighborhood ?? "",              // D
    post.description ?? "",               // E
    post.link ?? "",                      // F
    post.totalArea ?? "",                 // G
    post.coveredArea ?? "",               // H
    post.rooms ?? "",                     // I
    post.bathrooms ?? "",                 // J
    post.bedrooms ?? "",                  // K
    post.toilets ?? "",                   // L
    post.age ?? "",                       // M
    post.backFacing ? "Si" : "No",        // N
    post.propertyType ?? "",              // O
    post.daysFromPublish ?? "",           // P
    post.views ?? "",                     // Q
    nowISO(),                             // R lastSeenAt
    status,                               // S Active
    post.lat ?? "",                       // T
    post.lon ?? "",                       // U
    post.distSubte ?? "",                 // V
    post.distParque ?? "",                // W
    post.distViaRapida ?? "",             // X
    post.distFerrocarril ?? "",           // Y
    post.microScore ?? ""                 // Z
  ];
}

// merge para updates (manteniendo tu lógica original) + extras T..Z
function mergeExistingRow(existingRow, post, detail) {
  const base = rowTo26(existingRow);

  // A..F desde la card
  base[0] = post.price ?? base[0];
  base[1] = post.expenses ?? base[1];
  base[2] = post.address ?? base[2];
  base[3] = post.neighborhood ?? base[3];
  base[4] = post.description ?? base[4];
  base[5] = post.link ?? base[5];

  // Completar G..Q si vino "detail"
  if (detail) {
    const setIf = (idx, val) => { if (val !== null && val !== undefined && val !== "") base[idx] = val; };
    setIf(6,  detail.totalArea);
    setIf(7,  detail.coveredArea);
    setIf(8,  detail.rooms);
    setIf(9,  detail.bathrooms);
    setIf(10, detail.bedrooms);
    setIf(11, detail.toilets);
    setIf(12, detail.age);
    if (detail.backFacing === true)  base[13] = "Si";
    if (detail.backFacing === false) base[13] = "No";
    setIf(14, detail.propertyType);
    setIf(15, detail.daysFromPublish);
    setIf(16, detail.views);
  }

  // lastSeen + status
  base[17] = nowISO();     // R
  base[18] = "active";     // S

  // T..Z microScore (si ya viene en 'post')
  const setIf = (idx, val) => { if (val !== null && val !== undefined && val !== "") base[idx] = val; };
  setIf(19, post.lat);
  setIf(20, post.lon);
  setIf(21, post.distSubte);
  setIf(22, post.distParque);
  setIf(23, post.distViaRapida);
  setIf(24, post.distFerrocarril);
  setIf(25, post.microScore);

  return base;
}

/* ==============================
   Playwright (igual a tu versión)
   ============================== */
const setupBrowser = async () => {
  const browser = await chromium.launch({
    headless: true, // poné false si querés ver el navegador
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--disable-site-isolation-trials",
      "--no-sandbox",
      "--ignore-certificate-errors",
      "--ignore-certificate-errors-spki-list",
      "--disable-extensions",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    permissions: ["geolocation"],
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    extraHTTPHeaders: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua":
        '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "upgrade-insecure-requests": "1",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
    },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    const newProto = navigator.__proto__;
    delete newProto.webdriver;
    navigator.__proto__ = newProto;
    Object.defineProperty(navigator, "languages", { get: () => ["es-AR", "es"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [{ name: "Chrome PDF Plugin", description: "Portable Document Format", filename: "internal-pdf-viewer", length: 1 }]
    });
  });

  return { browser, context, page };
};

/* ==============================
   Scrape de detalle (idéntico a tu base)
   ============================== */
async function scrapeDetail(page, currentLink) {
  await page.goto(currentLink, { waitUntil: "domcontentloaded", timeout: 30000 });

  try {
    const btn = await page
      .locator('#onetrust-accept-btn-handler, #didomi-notice-agree-button, button:has-text("Aceptar"), button:has-text("Aceptar todas")')
      .first();
    if (await btn.isVisible({ timeout: 1500 })) await btn.click();
  } catch {}

  try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch {}
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(300);

  const notFoundElement = await page.$(".nf-container");
  if (notFoundElement) return null;

  try {
    await page.waitForSelector(".section-main-features, #longDescription, [data-qa='POSTING_CARD_DESCRIPTION'], h1", { timeout: 15000 });
  } catch {}

  const detail = await page.evaluate(() => {
    const featuresSection = document.querySelector(".section-main-features");

    const text = (el) => (el?.textContent || "").trim();
    const getNumericFromIcon = (sel) => {
      const el = featuresSection?.querySelector(sel);
      if (!el || !el.parentElement) return null;
      const t = el.parentElement.textContent.trim();
      const m = t.match(/\d+/);
      return m ? parseInt(m[0], 10) : null;
    };

    const descEl = document.querySelector("#longDescription, [data-qa='POSTING_CARD_DESCRIPTION']");
    const titleEl = document.querySelector("h1");
    const crumb = Array.from(document.querySelectorAll("nav[aria-label='breadcrumb'], .breadcrumb"))
      .map((el) => el.innerText).join(" / ");

    const inferType = (str) => {
      const t = (" " + (str || "") + " ").toLowerCase();
      if (/\bph\b/.test(t)) return "PH";
      if (/\bloft\b/.test(t)) return "Loft";
      if (/\bdepto\b|\bdepartamento\b|\bdto\b/.test(t)) return "Depto";
      if (/\bcasa\b/.test(t)) return "Casa";
      if (/\bd[uú]plex\b/.test(t)) return "Duplex";
      return null;
    };
    const propertyType = inferType(text(descEl)) || inferType(text(titleEl)) || inferType(crumb) || null;

    const extractViewsAndDays = () => {
      const candidate = document.querySelector("#user-views");
      let blob = candidate ? candidate.textContent : "";
      if (!blob || blob.trim().length < 5) blob = document.body.innerText || "";

      let views = null, daysFromPublish = null;

      const mViews = blob.match(/(\d+)\s*(visualizaciones|vistas)/i);
      if (mViews) views = parseInt(mViews[1], 10);

      let raw = (blob.match(/Publicado\s*([^\n\r]+)/i) || [])[1] || "";
      if (!raw) {
        const mAny = blob.match(/(hoy|ayer|hace\s+m[aá]s de\s+1\s+a[ñn]o|hace\s+\d+\s+(?:d[ií]as|semanas?|mes(?:es)?|a[ñn]os?))/i);
        if (mAny) raw = mAny[1];
      }
      if (raw) raw = raw.replace(/\s*\d+\s*(visualizaciones|vistas).*/i, "").trim();
      raw = raw.replace(/\s+/g, " ").trim();

      return { views, daysFromPublish: raw || null };
    };
    const { views, daysFromPublish } = extractViewsAndDays();

    const totalArea   = getNumericFromIcon("i.icon-stotal");
    const coveredArea = getNumericFromIcon("i.icon-scubierta");
    const rooms       = getNumericFromIcon("i.icon-ambiente");
    const bathrooms   = getNumericFromIcon("i.icon-bano");
    const bedrooms    = getNumericFromIcon("i.icon-dormitorio");
    const toilets     = getNumericFromIcon("i.icon-toilete");
    const age         = getNumericFromIcon("i.icon-antiguedad");
    const dispEl      = featuresSection?.querySelector("i.icon-disposicion");
    const backFacing  = dispEl ? dispEl.parentElement.textContent.trim().includes("Contrafrente") : false;

    return { totalArea, coveredArea, rooms, bathrooms, bedrooms, toilets, age, backFacing, propertyType, daysFromPublish, views };
  });

  return detail;
}

/* ==============================
   MAIN (igual + microScore donde corresponde)
   ============================== */
async function main() {
  const postsData = [];
  let hasNextPage = true;
  let pageNumber = 1;

  try {
    while (hasNextPage) {
      const { browser, context, page } = await setupBrowser();

      const url = `${BASE_URL}${pageNumber > 1 ? `-pagina-${pageNumber}` : ""}.html`;
      console.log(`Navigating to page ${pageNumber}...`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.mouse.move(Math.floor(Math.random() * 1920), Math.floor(Math.random() * 1080));
      await page.waitForSelector("div.postingsList-module__postings-container", { timeout: 30000 });

      const postings = await page.evaluate(() => {
        const postingElements = document.querySelectorAll("div.postingsList-module__postings-container > div");
        const toInt = (s) => {
          if (!s) return null;
          const t = s.replace(/\./g, "").replace(/[^\d]/g, "");
          return t ? parseInt(t, 10) : null;
        };
        return Array.from(postingElements).map((posting) => ({
          price: toInt(posting.querySelector('[data-qa="POSTING_CARD_PRICE"]')?.textContent?.trim() || ""),
          expenses: toInt(posting.querySelector('[data-qa="expensas"]')?.textContent?.trim() || ""),
          address: posting.querySelector('[data-qa="POSTING_CARD_LOCATION"]')?.previousElementSibling?.textContent?.trim() || null,
          neighborhood: posting.querySelector('[data-qa="POSTING_CARD_LOCATION"]')?.textContent?.trim() || null,
          description: posting.querySelector('[data-qa="POSTING_CARD_DESCRIPTION"]')?.textContent?.trim() || null,
          link: posting.querySelector("a")?.href || null,
        }));
      });

      postsData.push(...postings);

      hasNextPage = await page.$('[data-qa="PAGING_NEXT"]').then((el) => !!el).catch(() => false);
      pageNumber++;
      await context.close(); await browser.close();
    }

    // === Google Sheets ===
    const auth = new google.auth.GoogleAuth({
      keyFile: "./credentials.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    // Header / pestaña
    await ensureHeader(sheets, SPREADSHEET_ID, SHEET_TAB);

    // Leer hoja y mapear link -> fila (A..Z)
    const allRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_TAB}'!A:Z`,
    });
    const rows = allRes.data.values || [];
    const linkToRow = new Map();
    for (let i = 1; i < rows.length; i++) {
      const link = rows[i][5];
      if (link) linkToRow.set(link, i + 1);
    }

    const seenLinks = new Set();
    let iteration = 0;
    const updatesBatch = [];
    const newRows = [];

    while (postsData.length > iteration) {
      const post = postsData[iteration];
      const currentLink = post.link;
      if (!currentLink) { iteration++; continue; }

      seenLinks.add(currentLink);

      console.log(`File: ${iteration + 1}/${postsData.length} - Completed: ${(((iteration) / postsData.length) * 100).toFixed(2)}%`);

      // función común para enriquecer con microScore (sin romper scraping)
      async function enrichMicro(p) {
        const locString = p.address
          ? `${p.address}, Buenos Aires, Argentina`
          : (p.neighborhood ? `${p.neighborhood}, Buenos Aires, Argentina` : null);
        if (!locString) return p;
        try {
          const res = await scoreAddress(locString);
          return {
            ...p,
            lat: res.lat, lon: res.lon,
            distSubte: res.dSubte, distParque: res.dParque,
            distViaRapida: res.dViaRapida, distFerrocarril: res.dFerrocarril,
            microScore: res.microScore
          };
        } catch {
          return p;
        }
      }

      if (linkToRow.has(currentLink)) {
        const rowIdx = linkToRow.get(currentLink);
        const existingRow = rows[rowIdx - 1] || [];

        // ¿Faltan O (14), P (15) o Q (16)? → abrimos la ficha para completar (igual que tu versión)
        const needsDetails = !existingRow[14] || !existingRow[15] || !existingRow[16];
        if (!needsDetails) {
          const postWithMicro = await enrichMicro(post);
          const merged = mergeExistingRow(existingRow, postWithMicro);
          updatesBatch.push({ range: `'${SHEET_TAB}'!A${rowIdx}:Z${rowIdx}`, values: [merged] });
          iteration++; continue;
        }

        const { browser, context, page } = await setupBrowser();
        console.log(`(fill O/P/Q) ${currentLink}...`);
        const detail = await scrapeDetail(page, currentLink);
        const full = await enrichMicro({ ...post, ...(detail || {}) });
        const merged = mergeExistingRow(existingRow, full, detail || {});
        updatesBatch.push({ range: `'${SHEET_TAB}'!A${rowIdx}:Z${rowIdx}`, values: [merged] });
        await context.close(); await browser.close();
        iteration++; continue;
      }

      // Nuevo → abrir detalle y agregar (igual que tu versión)
      const { browser, context, page } = await setupBrowser();
      console.log(`Navigating to link ${currentLink}...`);
      const detail = await scrapeDetail(page, currentLink);
      const full = await enrichMicro({ ...post, ...(detail || {}) });
      newRows.push(buildRowFromPost(full, "new"));
      await context.close(); await browser.close();
      iteration++;
    }

    // Updates
    if (updatesBatch.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: "RAW", data: updatesBatch },
      });
      console.log(`Updated existing rows: ${updatesBatch.length}`);
    }

    // Inserts
    if (newRows.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_TAB}'!A1`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: newRows },
      });
      console.log(`Inserted new rows: ${newRows.length}`);
    }

    // Marcar INACTIVE lo no visto (col S se mantiene igual)
    const allRes2 = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_TAB}'!A:Z`,
    });
    const rows2 = allRes2.data.values || [];
    const inactiveUpdates = [];
    for (let i = 2; i <= rows2.length; i++) {
      const link = rows2[i - 1]?.[5];
      if (link && !seenLinks.has(link)) {
        inactiveUpdates.push({ range: `'${SHEET_TAB}'!S${i}:S${i}`, values: [["inactive"]] });
      }
    }
    if (inactiveUpdates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: "RAW", data: inactiveUpdates },
      });
      console.log(`Marked inactive: ${inactiveUpdates.length}`);
    }

    console.log("Data successfully uploaded to Google Sheets");
  } catch (error) {
    console.error("An error occurred:", error);
    process.exit(1);
  }
}

/* ==============================
   Run
   ============================== */
main();
