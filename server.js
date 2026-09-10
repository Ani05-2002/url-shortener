// Import Express to create our HTTP server.
const express = require("express");

// Import PostgreSQL connection pool.
const { Pool } = require("pg");

// Import Node's crypto module for stronger random short-code generation.
const crypto = require("crypto");

// Create the Express application.
const app = express();

// Use Render's assigned port in production, or 3000 locally.
const PORT = process.env.PORT || 3000;

// Use Render's public URL in production, or localhost during local development.
const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;

// Allow Express to read JSON request bodies.
app.use(express.json());

// Create PostgreSQL connection pool using Render's DATABASE_URL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Internal Render PostgreSQL connection does not require custom SSL handling.
  ssl: false,
});

// Create/update the URLs table when the application starts.
async function initializeDatabase() {
  // Create the basic table if this is the first deployment.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id SERIAL PRIMARY KEY,
      short_code VARCHAR(20) UNIQUE NOT NULL,
      long_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add expiration support to existing databases.
  await pool.query(`
    ALTER TABLE urls
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP
  `);

  // Add active/inactive status support.
  await pool.query(`
    ALTER TABLE urls
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
  `);

  // Add click-count tracking.
  await pool.query(`
    ALTER TABLE urls
    ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0
  `);

  // Confirm database initialization in server logs.
  console.log("PostgreSQL database initialized");
}

// Generate a secure random 6-character short code.
function generateShortCode() {
  // Characters allowed inside our short codes.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  // Generate secure random bytes.
  const randomBytes = crypto.randomBytes(6);

  // Start with an empty short code.
  let code = "";

  // Convert each random byte into an allowed character.
  for (let i = 0; i < 6; i++) {
    code += chars[randomBytes[i] % chars.length];
  }

  // Return the generated short code.
  return code;
}

// API endpoint used to convert a long URL into a short URL.
app.post("/shorten", async (req, res) => {
  try {
    // Read the long URL and optional expiration date from the request body.
    const { longUrl, expiresAt } = req.body;

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

      // Allow only HTTP and HTTPS URLs.
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

    // Validate expiresAt if the user supplied one.
    if (expiresAt) {
      // Convert supplied expiration value into a JavaScript Date.
      const expirationDate = new Date(expiresAt);

      // Reject invalid date values.
      if (Number.isNaN(expirationDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid expiresAt date",
        });
      }

      // Reject expiration dates that are already in the past.
      if (expirationDate <= new Date()) {
        return res.status(400).json({
          success: false,
          message: "expiresAt must be a future date",
        });
      }
    }

    // Generate the first candidate short code.
    let shortCode = generateShortCode();

    // Check whether the generated short code already exists in PostgreSQL.
    let existingCode = await pool.query(
      "SELECT id FROM urls WHERE short_code = $1",
      [shortCode]
    );

    // Generate another code if a collision occurs.
    while (existingCode.rows.length > 0) {
      // Generate a new candidate code.
      shortCode = generateShortCode();

      // Check whether the new candidate already exists.
      existingCode = await pool.query(
        "SELECT id FROM urls WHERE short_code = $1",
        [shortCode]
      );
    }

    // Store the URL mapping and optional expiration date in PostgreSQL.
    await pool.query(
      `
      INSERT INTO urls (
        short_code,
        long_url,
        expires_at
      )
      VALUES ($1, $2, $3)
      `,
      [shortCode, longUrl, expiresAt || null]
    );

    // Build the public short URL.
    const shortUrl = `${BASE_URL}/${shortCode}`;

    // Return information about the newly generated short URL.
    res.status(201).json({
      success: true,
      longUrl,
      shortCode,
      shortUrl,
      expiresAt: expiresAt || null,
    });
  } catch (error) {
    // Show unexpected errors in server logs.
    console.error("Shorten error:", error);

    // Return a generic server error.
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Return information about one short URL.
app.get("/info/:shortCode", async (req, res) => {
  try {
    // Read the requested short code.
    const { shortCode } = req.params;

    // Get URL information from PostgreSQL.
    const result = await pool.query(
      `
      SELECT
        short_code,
        long_url,
        created_at,
        expires_at,
        is_active,
        click_count
      FROM urls
      WHERE short_code = $1
      `,
      [shortCode]
    );

    // Return 404 if the short code does not exist.
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Short URL not found",
      });
    }

    // Return stored URL information.
    res.json({
      success: true,
      url: result.rows[0],
    });
  } catch (error) {
    // Show unexpected errors in server logs.
    console.error("Info error:", error);

    // Return a generic server error.
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Endpoint called when someone opens one of our short links.
app.get("/:shortCode", async (req, res) => {
  try {
    // Read the short code from the URL path.
    const { shortCode } = req.params;

    // Get the original URL and its current status from PostgreSQL.
    const result = await pool.query(
      `
      SELECT
        long_url,
        is_active,
        expires_at,
        click_count
      FROM urls
      WHERE short_code = $1
      `,
      [shortCode]
    );

    // Return 404 if that short code does not exist.
    if (result.rows.length === 0) {
      return res.status(404).send("Short URL not found");
    }

    // Get the database record.
    const record = result.rows[0];

    // Block links that have been manually disabled.
    if (!record.is_active) {
      return res.status(410).send("This short URL has been disabled");
    }

    // Block links that have passed their expiration date.
    if (
      record.expires_at &&
      new Date(record.expires_at) < new Date()
    ) {
      return res.status(410).send("This short URL has expired");
    }

    // Increase the click counter whenever the link is successfully opened.
    await pool.query(
      `
      UPDATE urls
      SET click_count = click_count + 1
      WHERE short_code = $1
      `,
      [shortCode]
    );

    // Redirect the browser to the stored original URL.
    res.redirect(302, record.long_url);
  } catch (error) {
    // Show unexpected redirect errors in server logs.
    console.error("Redirect error:", error);

    // Return a generic server error.
    res.status(500).send("Internal server error");
  }
});

// Initialize PostgreSQL before starting the Express server.
initializeDatabase()
  .then(() => {
    // Start the server only after the database connection is successful.
    app.listen(PORT, "0.0.0.0", () => {
      // Show the running port in Render logs.
      console.log(`URL Shortener running on port ${PORT}`);
    });
  })
  .catch((error) => {
    // Show the database startup error if the connection fails.
    console.error("Database initialization failed:", error);
  });