require("dotenv").config({ path: "./.env" });
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { google } = require("googleapis");

puppeteer.use(StealthPlugin());
console.log("Starting movie crawler and processor...");

async function authorize() {
  console.log("Authorizing Google Sheets access...");
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth.getClient();
}

function sanitizeMovieTitle(title) {
  if (!title) return null;

  console.log(`\nProcessing title: ${title}`);
  const yearMatch = title.match(/\b(20|19)\d{2}\b/);
  const qualityMatch = title.match(/\b(1080p|720p|2160p)\b/);
  const possibleKeywords = [
    "REMUX",
    "BluRay",
    "UNTOUCHED",
    "HDR10",
    "IMAX",
    "Hallowed",
    "REMASTERED",
  ];

  const keywords = possibleKeywords.filter((keyword) =>
    title.toUpperCase().includes(keyword.toUpperCase())
  );

  let sanitizedTitle = title
    .replace(/\.(mkv|mp4|mov|avi|wmv|flv|webm)$/i, "")
    .replace(/\./g, " ")
    .replace(/[\[\]\(\)\-\_\/]/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  const result = {
    "sanitized-title": sanitizedTitle.split(/\d{4}/)[0].trim(),
    year: yearMatch ? yearMatch[0] : "",
    quality: qualityMatch ? qualityMatch[0] : "",
    keywords: keywords.join(","),
  };

  console.log("Sanitized results:", result);
  return result;
}

async function processMovies(movies) {
  console.log(`\nProcessing ${movies.length} movies...`);
  const processedMovies = movies.map((movie) => {
    const sanitized = sanitizeMovieTitle(movie["original-title"]);
    return [
      movie["original-title"],
      movie.url,
      movie.size,
      sanitized["sanitized-title"],
      sanitized.year,
      sanitized.quality,
      sanitized.keywords,
    ];
  });
  return processedMovies;
}

async function updateSheet(auth, processedMovies) {
  console.log("\nUpdating Google Sheet...");
  const sheets = google.sheets({ version: "v4", auth });

  console.log("Fetching existing data...");
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Sheet1!A:C",
  });

  const existingMovies = new Set(
    current.data.values?.slice(1).map((row) => row[0]) || []
  );

  const newMovies = processedMovies.filter((m) => !existingMovies.has(m[0]));
  const oldMovies = processedMovies.filter((m) => existingMovies.has(m[0]));

  console.log(`Found ${newMovies.length} new movies`);
  console.log(`Existing movies: ${oldMovies.length}`);

  const orderedMovies = [...newMovies.slice(0, 10), ...oldMovies];
  console.log(`Total movies after ordering: ${orderedMovies.length}`);

  const headers = [
    [
      "original-title",
      "url",
      "size",
      "sanitized-title",
      "year",
      "quality",
      "keywords",
    ],
  ];

  console.log("Clearing existing sheet data...");
  await sheets.spreadsheets.values.clear({
    spreadsheetId: process.env.SHEET_ID,
    range: "Sheet1!A:G",
  });

  console.log("Writing new data to sheet...");
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    resource: { values: [...headers, ...orderedMovies] },
  });

  console.log("Sheet update complete");
}

async function crawlAndUpdate() {
  console.log("\nStarting browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  const movieData = [];

  try {
    console.log("Logging in...");
    await page.goto("https://leech.saulie077.workers.dev/", {
      waitUntil: "networkidle2",
    });
    await page.type("#email", "admin");
    await page.type("#password", "admin");
    await page.click("#btn-login");
    await page.waitForNavigation({ waitUntil: "networkidle2" });
    console.log("Login successful");

    console.log("\nNavigating to movie folder...");
    await page.goto("https://leech.saulie077.workers.dev/0:/", {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector(".list-group-item.list-group-item-action", {
      visible: true,
    });

    console.log("Starting infinite scroll...");
    let prevContentLength = 0;
    let noChangeCount = 0;

    while (noChangeCount < 5) {
      const currentContentLength = await page.evaluate(
        () =>
          document.querySelectorAll(".list-group-item.list-group-item-action")
            .length
      );

      console.log(`Content loaded: ${currentContentLength} items`);

      if (currentContentLength === prevContentLength) {
        noChangeCount++;
        console.log(`No new content found. Attempt ${noChangeCount}/5`);
      } else {
        noChangeCount = 0;
      }

      prevContentLength = currentContentLength;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

      await page
        .waitForFunction(
          (prevLength) =>
            document.querySelectorAll(".list-group-item.list-group-item-action")
              .length > prevLength,
          { timeout: 2000 },
          prevContentLength
        )
        .catch(() => {});

      if (noChangeCount >= 5) {
        console.log("Reached end of content");
        break;
      }
    }

    console.log("\nExtracting movie data...");
    const divs = await page.$$(".list-group-item.list-group-item-action");
    console.log(`Found ${divs.length} movie items`);

    for (let div of divs) {
      const originalTitle = await div
        .$eval(".countitems", (el) => el.textContent.trim())
        .catch(() => null);
      const dlurl = await div
        .$eval(".form-check-input", (el) => el.value)
        .catch(() => null);
      const size = await div
        .$eval(".badge", (el) => el.textContent.trim())
        .catch(() => null);

      if (originalTitle && dlurl && size) {
        movieData.push({ "original-title": originalTitle, url: dlurl, size });
      }
    }

    console.log(`\nSuccessfully gathered ${movieData.length} movies`);

    console.log("\nStarting sheet processing...");
    const auth = await authorize();
    const processedMovies = await processMovies(movieData);
    await updateSheet(auth, processedMovies);

    console.log("\nProcess completed successfully!");
  } catch (error) {
    console.error("\nError during process:", error);
  } finally {
    console.log("\nClosing browser...");
    await browser.close();
  }
}

crawlAndUpdate();
 