const { chromium } = require("playwright");
const { google } = require("googleapis");

async function main() {
  let hasNextPage = true;
  let pageNumber = 1;
  let offset = 0;
  const links = [];

  try {
    //  *** ----- Get all the links from the listing for all pages ----- ***
    while (hasNextPage) {
      const { browser, context, page } = await setupBrowser();

      const url = `https://inmuebles.mercadolibre.com.ar/ph/venta/capital-federal/almagro-o-belgrano-o-belgrano-r-o-belgrano-c-o-botanico-o-belgrano-chico-o-barrio-norte-o-colegiales-o-las-canitas-o-nunez-o-palermo-o-palermo-chico-o-palermo-hollywood-o-palermo-soho-o-palermo-viejo-o-recoleta-o-saavedra-o-villa-crespo-o-villa-urquiza/_Desde_${offset}_PriceRange_40000USD-500000USD_NoIndex_True`;

      console.log(`Navigating to page ${pageNumber}...`);

      // Navigate to the target URL
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      // Add random mouse movement
      await page.mouse.move(
        Math.floor(Math.random() * 1920),
        Math.floor(Math.random() * 1080)
      );

      // Wait for the main container and get all listings
      await page.waitForSelector("ol.ui-search-layout", {
        timeout: 30000,
      });
      const listing = await page.$$("ol.ui-search-layout > li");

      for (const item of listing) {
        const titleLink = await item.$("a.poly-component__title");
        if (titleLink) {
          const href = await titleLink.getAttribute("href");
          links.push(href);
        }
      }

      // Find the "Siguiente" button. In the last page it will be disabled but present in the DOM
      hasNextPage = await page
        .$(
          "ul.andes-pagination li.andes-pagination__button--next:not(.andes-pagination__button--disabled)"
        )
        .then((element) => !!element)
        .catch(() => false);

      pageNumber++;
      // Mercadolibre shows 48 items per page, and the index is 0-based
      offset += offset === 0 ? 49 : 48;

      await context.close();
      await browser.close();
    }

    //  *** ----- Get all the links that are in the Google Sheet, then skip them later to not scrape them again ----- ***
    const auth = new google.auth.GoogleAuth({
      keyFile: "./credentials.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const spreadsheetId = "1izKR1lLezYmH7_ZJTgQEcqHrpgdwxMqO5H4hG81zifg";

    // Fetch existing links from column F
    const existingLinksResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Listado!F:F",
    });

    const existingLinks = new Set(
      (existingLinksResponse.data.values || []).flat().filter((link) => link)
    );

    //  *** ----- Start scraping all the data from the links ----- ***
    let iteration = 0;
    const newPosts = [];

    while (links.length > iteration) {
      const currentLink = links[iteration];

      // Log progress
      console.log(
        `File: ${iteration + 1}/${links.length} - Completed: ${(
          (iteration / links.length) *
          100
        ).toFixed(2)}%`
      );
      // Skip if link already exists in sheet
      //   if (existingLinks.has(currentLink)) {
      //     console.log(`Skipping existing link: ${currentLink}`);
      //     iteration++;
      //     continue;
      //   }

      const { browser, context, page } = await setupBrowser();

      console.log(`Navigating to link ${currentLink}...`);

      // Navigate to the target URL
      await page.goto(currentLink, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      // Add random mouse movement
      await page.mouse.move(
        Math.floor(Math.random() * 1920),
        Math.floor(Math.random() * 1080)
      );

      //   // Wait for features sections that contain the data we need
      //   try {
      //     await Promise.all([
      //       page.waitForSelector("div.ui-pdp-component-list", {
      //         timeout: 30000,
      //       }),
      //       page.waitForSelector("div.ui-pdp-specs", {
      //         timeout: 30000,
      //       }),
      //     ]);
      //   } catch (error) {
      //     console.log("Main features section not found, skipping to next...");
      //     await context.close();
      //     await browser.close();
      //     iteration++;
      //     continue;
      //   }

      const post = {};

      // Get all the data from the page
      const pageData = await page.evaluate(() => {
        // Get price
        const priceElement = document.querySelector(
          "div#price span.andes-money-amount__fraction"
        );
        const price = priceElement
          ? parseInt(priceElement.textContent.replace(/\./g, ""))
          : null;

        // Get title which contains address info
        const titleElement = document.querySelector("h1.ui-pdp-title");
        const title = titleElement ? titleElement.textContent.trim() : null;

        // Get expenses from the specs table
        const expensesRow = Array.from(
          document.querySelectorAll(".andes-table__row")
        ).find((row) => row.textContent.includes("Expensas"));
        const expenses = expensesRow
          ? parseInt(
              expensesRow
                .querySelector(".andes-table__column--value")
                .textContent.replace(/[^\d]/g, "")
            ) || 0
          : 0;

        // Get specifications from the table
        const getSpecValue = (specName) => {
          const row = Array.from(
            document.querySelectorAll(".andes-table__row")
          ).find((row) => row.textContent.includes(specName));
          if (!row) return null;
          const value = row
            .querySelector(".andes-table__column--value")
            .textContent.trim();
          if (
            specName === "Superficie total" ||
            specName === "Superficie cubierta"
          ) {
            return parseInt(value.replace(/[^\d]/g, ""));
          }
          if (specName === "Antigüedad") {
            return parseInt(value.replace(/[^\d]/g, ""));
          }
          if (specName === "Disposición") {
            return value.toLowerCase().includes("contrafrente");
          }
          return parseInt(value) || value;
        };

        // Get property type from the subtitle
        const subtitleElement = document.querySelector(".ui-pdp-subtitle");
        const propertyType = subtitleElement
          ? subtitleElement.textContent.trim().split(" ")[0]
          : null;

        // Get publication date
        const publishDateElement = document.querySelector(
          ".ui-pdp-header__bottom-subtitle"
        );
        const publishDate = publishDateElement
          ? publishDateElement.textContent.trim().replace("Publicado hace ", "")
          : null;

        // Get views (if available)
        const viewsElement = document.querySelector("#user-views");
        const views = viewsElement
          ? parseInt(
              viewsElement.textContent.match(/(\d+) visualizaciones/)?.[1]
            )
          : null;

        // Get description
        const descriptionEl = document.querySelector(
          ".ui-pdp-description p[data-testid='content']"
        );
        const description = descriptionEl
          ? descriptionEl.textContent.trim()
          : null;

        // Get neighborhood from breadcrumb
        const breadcrumbItems = document.querySelectorAll(
          "ol.andes-breadcrumb li"
        );
        const lastBreadcrumb = breadcrumbItems[breadcrumbItems.length - 1];
        const neighborhood = lastBreadcrumb
          ? lastBreadcrumb.querySelector("a")?.textContent.trim()
          : null;

        // Get address from location div
        const locationDiv = document.querySelector("div.ui-vip-location");
        const address = locationDiv
          ? locationDiv
              .querySelector("div.ui-pdp-media__body p")
              ?.textContent.trim()
          : null;

        return {
          price,
          title,
          address,
          neighborhood,
          description,
          expenses,
          totalArea: getSpecValue("Superficie total"),
          coveredArea: getSpecValue("Superficie cubierta"),
          rooms: getSpecValue("Ambientes"),
          bathrooms: getSpecValue("Baños"),
          bedrooms: getSpecValue("Dormitorios"),
          age: getSpecValue("Antigüedad"),
          backFacing: getSpecValue("Disposición"),
          propertyType,
          daysFromPublish: publishDate,
          views,
        };
      });

      // Assign all the extracted data to the post object
      Object.assign(post, pageData, { link: currentLink });

      newPosts.push(post);

      iteration++;

      await context.close();
      await browser.close();
    }
    //  *** ----- End scraping all the data from the links ----- ***

    //  *** ----- Format data for sheets, the order of the map represents the order of the columns in the sheet ----- ***

    const values = newPosts.map((post) => [
      post.price,
      post.expenses,
      post.address,
      post.neighborhood,
      post.description,
      post.link,
      post.totalArea,
      post.coveredArea,
      post.rooms,
      post.bathrooms,
      post.bedrooms,
      post.toilets,
      post.age,
      post.backFacing ? "Si" : "No",
      post.propertyType,
      post.daysFromPublish,
      post.views,
    ]);

    try {
      // const response = await sheets.spreadsheets.values.get({
      //   spreadsheetId,
      //   range: "Listado!A:G",
      // });

      // const lastRow = response.data.values
      //   ? response.data.values.length + 1
      //   : 2;

      // const range = `Listado!A${lastRow}:N`;

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Listado!A:N",
        // range,
        // valueInputOption: "RAW" - Tells Sheets to not parse/format the input values (e.g. dates, formulas)
        valueInputOption: "RAW",
        // insertDataOption: "INSERT_ROWS" - Inserts new rows for the data rather than overwriting existing cells
        insertDataOption: "INSERT_ROWS",
        resource: {
          values: values,
        },
      });

      console.log("Data successfully uploaded to Google Sheets");
    } catch (error) {
      console.error("Error uploading to Google Sheets:", error);
    }
  } catch (error) {
    console.error("An error occurred:", error);
    process.exit(1);
  }
}

const setupBrowser = async () => {
  // Launch browser with stealth settings, common anti-detection measures:
  // Adding a common plugin that real Chrome browsers typically have
  // Modifying the user agent
  // Setting specific viewport dimensions
  // Adding language preferences
  // Removing the webdriver property
  // Setting geolocation permissions
  // Adding random mouse movements

  const browser = await chromium.launch({
    headless: true,
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

  // Create new context with specific device and locale settings
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    permissions: ["geolocation"],
    // Emulate real browser behavior
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    // Additional headers
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

  // Create new page
  const page = await context.newPage();

  // Add script to modify navigator properties
  await page.addInitScript(() => {
    const newProto = navigator.__proto__;
    delete newProto.webdriver;
    navigator.__proto__ = newProto;

    // Add language preference
    Object.defineProperty(navigator, "languages", {
      get: () => ["es-AR", "es"],
    });

    // Add plugins
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        {
          name: "Chrome PDF Plugin",
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
        },
      ],
    });
  });

  return { browser, context, page };
};

main();
