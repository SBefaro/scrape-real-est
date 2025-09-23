const { chromium } = require("playwright");
const { google } = require("googleapis");

// TO DO MEJORAS:
// Como remover links viejos?
// Como ver actualizaciones de precios?
// A veces no lee tipologia, dias de publicacion y visualizaciones

async function main() {
  let baseUrl = `https://www.zonaprop.com.ar/ph-alquiler-saavedra-nunez-belgrano-vicente-lopez-villa-urquiza-florida-menos-800000-pesos`;

  baseUrl =
    "https://www.zonaprop.com.ar/ph-alquiler-florida-menos-800000-pesos";

  const postsData = [];
  let hasNextPage = true;
  let pageNumber = 1;

  try {
    while (hasNextPage) {
      const { browser, context, page } = await setupBrowser();

      const url = `${baseUrl}${
        pageNumber > 1 ? `-pagina-${pageNumber}` : ""
      }.html`;

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

      // Wait for the main container
      await page.waitForSelector(
        "div.postingsList-module__postings-container",
        {
          timeout: 30000,
        }
      );

      // Extract data from all postings
      const postings = await page.evaluate(() => {
        const postingElements = document.querySelectorAll(
          "div.postingsList-module__postings-container > div"
        );

        return Array.from(postingElements).map((posting) => ({
          price: posting
            .querySelector('[data-qa="POSTING_CARD_PRICE"]')
            ?.textContent?.trim()
            .replace(/\./g, "")
            .replace(/[^\d]/g, ""),
          expenses: posting
            .querySelector('[data-qa="expensas"]')
            ?.textContent?.trim()
            .replace(/\./g, "")
            .replace(/[^\d]/g, ""),
          address: posting
            .querySelector('[data-qa="POSTING_CARD_LOCATION"]')
            .previousElementSibling?.textContent?.trim(),
          neighborhood: posting
            .querySelector('[data-qa="POSTING_CARD_LOCATION"]')
            ?.textContent?.trim(),
          description: posting
            .querySelector('[data-qa="POSTING_CARD_DESCRIPTION"]')
            ?.textContent?.trim(),
          link: posting.querySelector("a")?.href,
          // imageUrl: posting.querySelector("img")?.src,
        }));
      });

      postsData.push(...postings);

      hasNextPage = await page
        .$('[data-qa="PAGING_NEXT"]')
        .then((element) => !!element)
        .catch(() => false);

      pageNumber++;

      await context.close();
      await browser.close();
    }

    // Get existing links from Google Sheets
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

    let iteration = 0;
    const newPosts = [];
    while (postsData.length > iteration) {
      const post = postsData[iteration];
      const currentLink = post.link;

      console.log(
        `File: ${iteration + 1}/${postsData.length} - Completed: ${(
          (iteration / postsData.length) *
          100
        ).toFixed(2)}%`
      );
      // Skip if link already exists in sheet
      if (existingLinks.has(currentLink)) {
        console.log(`Skipping existing link: ${currentLink}`);
        iteration++;
        continue;
      }

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

      // Check if not found container exists
      const notFoundElement = await page.$(".nf-container");
      if (notFoundElement) {
        console.log("Property under construction, skipping to next...");
        await context.close();
        await browser.close();
        iteration++;
        continue;
      }

      // Wait for main features section
      try {
        await page.waitForSelector("div.section-main-features", {
          timeout: 30000,
        });
      } catch (error) {
        console.log("Main features section not found, skipping to next...");
        await context.close();
        await browser.close();
        iteration++;
        continue;
      }

      try {
        await page.waitForSelector("#user-views", {
          timeout: 5000,
          state: "attached",
        });
      } catch (error) {
        console.log("Views element not found, continuing without it");
      }

      const {
        totalArea,
        coveredArea,
        rooms,
        bathrooms,
        bedrooms,
        toilets,
        age,
        backFacing,
        propertyType,
        daysFromPublish,
        views,
      } = await page.evaluate(() => {
        const featuresSection = document.querySelector(
          ".section-main-features"
        );

        // Get description text
        const descriptionEl = document.querySelector("#longDescription");
        const description = descriptionEl
          ? descriptionEl.textContent.trim()
          : null;

        // Analyze description to determine property type
        const getPropertyType = (text) => {
          if (!text) return null;
          const lowerText = text.toLowerCase();

          if (lowerText.includes("ph")) return "PH";
          if (lowerText.includes("loft")) return "Loft";
          if (lowerText.includes("depto") || lowerText.includes("departamento"))
            return "Depto";
          return null;
        };

        const propertyType = getPropertyType(description);

        // Get views and publication date
        const viewsEl = document.querySelector("#user-views");
        let daysFromPublish = null;
        let views = null;

        if (viewsEl) {
          const text = viewsEl.textContent.trim();
          const viewsMatch = text.match(/(\d+) visualizaciones/);
          daysFromPublish = viewsEl
            .querySelector("p")
            ?.textContent.trim()
            .replace("Publicado ", "");

          views = viewsMatch ? parseInt(viewsMatch[1]) : null;
        }

        if (!featuresSection)
          return {
            totalArea: null,
            coveredArea: null,
            rooms: null,
            bathrooms: null,
            bedrooms: null,
            toilets: null,
            age: null,
            backFacing: false,
            propertyType,
            daysFromPublish,
            views,
          };

        // Find all feature elements
        const totalAreaEl = featuresSection.querySelector("i.icon-stotal");
        const coveredAreaEl = featuresSection.querySelector("i.icon-scubierta");
        const roomsEl = featuresSection.querySelector("i.icon-ambiente");
        const bathroomsEl = featuresSection.querySelector("i.icon-bano");
        const bedroomsEl = featuresSection.querySelector("i.icon-dormitorio");
        const toiletsEl = featuresSection.querySelector("i.icon-toilete");
        const ageEl = featuresSection.querySelector("i.icon-antiguedad");
        const dispositionEl =
          featuresSection.querySelector("i.icon-disposicion");

        // Helper function to get numeric value from element's parent text
        const getNumericValue = (el) => {
          if (!el) return null;
          const text = el.parentElement.textContent.trim();
          const match = text.match(/\d+/);
          return match ? parseInt(match[0]) : null;
        };

        return {
          totalArea: getNumericValue(totalAreaEl),
          coveredArea: getNumericValue(coveredAreaEl),
          rooms: getNumericValue(roomsEl),
          bathrooms: getNumericValue(bathroomsEl),
          bedrooms: getNumericValue(bedroomsEl),
          toilets: getNumericValue(toiletsEl),
          age: getNumericValue(ageEl),
          backFacing: dispositionEl
            ? dispositionEl.parentElement.textContent
                .trim()
                .includes("Contrafrente")
            : false,
          propertyType,
          daysFromPublish,
          views,
        };
      });

      post.totalArea = totalArea;
      post.coveredArea = coveredArea;
      post.rooms = rooms;
      post.bathrooms = bathrooms;
      post.bedrooms = bedrooms;
      post.toilets = toilets;
      post.age = age;
      post.backFacing = backFacing;
      post.propertyType = propertyType;
      post.daysFromPublish = daysFromPublish;
      post.views = views;

      newPosts.push(post);

      iteration++;

      await context.close();
      await browser.close();
    }

    // Format data for sheets

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
