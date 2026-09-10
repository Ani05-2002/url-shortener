// Import Express to create our HTTP server.
const express = require("express");

// Import SQLite so URL mappings can be stored permanently.
const Database = require("better-sqlite3");

// Create the Express application.
const app = express();

// Use Render's assigned port in production, or 3000 locally.
const PORT = process.env.PORT || 3000;
// Allow Express to read JSON request bodies.
app.use(express.json());

// Create or open the local SQLite database file.
const db = new Database("urls.db");

// Create the URLs table if it does not already exist.
db.prepare(`
  CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_code TEXT UNIQUE NOT NULL,
    long_url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// Generate a random 6-character short code.
function generateShortCode() {
  // Characters allowed inside our generated short codes.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  // Start with an empty short code.
  let code = "";

  // Generate exactly six random characters.
  for (let i = 0; i < 6; i++) {
    // Select one random character and append it to the code.
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  // Return the generated short code.
  return code;
}

// API endpoint used to convert a long URL into a short URL.
app.post("/shorten", (req, res) => {
  // Read the long URL from the JSON request body.
  const { longUrl } = req.body;

  // Check whether the user supplied a URL.
  if (!longUrl) {
    return res.status(400).json({
      success: false,
      message: "longUrl is required",
    });
  }

  // Validate the supplied URL.
  try {
    // Parse the supplied URL.
    const parsedUrl = new URL(longUrl);

    // Allow only normal HTTP and HTTPS URLs.
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        success: false,
        message: "Only http and https URLs are allowed",
      });
    }
  } catch (error) {
    // Return an error when the supplied value is not a valid URL.
    return res.status(400).json({
      success: false,
      message: "Invalid URL",
    });
  }

  // Generate the first candidate short code.
  let shortCode = generateShortCode();

  // Look for an existing database record using this code.
  let existingCode = db
    .prepare("SELECT id FROM urls WHERE short_code = ?")
    .get(shortCode);

  // Generate another code if a collision occurs.
  while (existingCode) {
    // Generate a new candidate code.
    shortCode = generateShortCode();

    // Check whether the new candidate already exists.
    existingCode = db
      .prepare("SELECT id FROM urls WHERE short_code = ?")
      .get(shortCode);
  }

  // Insert the short-code-to-long-URL mapping into SQLite.
  db.prepare(
    `
    INSERT INTO urls (short_code, long_url)
    VALUES (?, ?)
    `
  ).run(shortCode, longUrl);

  // Build the localhost version of our short URL.
  const shortUrl = `http://localhost:${PORT}/${shortCode}`;

  // Return information about the newly generated short URL.
  res.status(201).json({
    success: true,
    longUrl,
    shortCode,
    shortUrl,
  });
});

// Endpoint called when someone opens one of our short links.
app.get("/:shortCode", (req, res) => {
  // Read the short code from the URL path.
  const { shortCode } = req.params;

  // Search SQLite for the corresponding long URL.
  const record = db
    .prepare(
      `
      SELECT long_url
      FROM urls
      WHERE short_code = ?
      `
    )
    .get(shortCode);

  // Return 404 if that short code does not exist.
  if (!record) {
    return res.status(404).send("Short URL not found");
  }

  // Redirect the browser to the stored original URL.
  res.redirect(302, record.long_url);
});

// Listen on all network interfaces so the app works on public hosting.
app.listen(PORT, "0.0.0.0", () => {
  // Show the running port in the server logs.
  console.log(`URL Shortener running on port ${PORT}`);
});