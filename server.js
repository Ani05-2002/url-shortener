// Import Express to create our HTTP server.
const express = require("express");

// Import PostgreSQL connection pool.
const { Pool } = require("pg");

// Import Node's crypto module for secure random values.
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
  ssl: false,
});

// Create the URLs table if it does not already exist.
async function initializeDatabase() {
  // Create our main URL mapping table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id SERIAL PRIMARY KEY,
      short_code VARCHAR(20) UNIQUE NOT NULL,
      long_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Confirm database initialization in Render logs.
  console.log("PostgreSQL database initialized");
}

// Import Node's crypto module for stronger random code generation.
const crypto = require("crypto");

// Generate a secure random 6-character short code.
function generateShortCode() {
  // Characters allowed inside short codes.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  // Generate six secure random bytes.
  const randomBytes = crypto.randomBytes(6);

  // Start with an empty code.
  let code = "";

  // Convert each random byte into one allowed character.
  for (let i = 0; i < 6; i++) {
    code += chars[randomBytes[i] % chars.length];
  }

  // Return the generated short code.
  return code;
}

// API endpoint used to convert a long URL into a short URL.
app.post("/shorten", async (req, res) => {
  try {
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

    // Insert the short-code-to-long-URL mapping into PostgreSQL.
    await pool.query(
      `
      INSERT INTO urls (short_code, long_url)
      VALUES ($1, $2)
      `,
      [shortCode, longUrl]
    );

    // Build the short URL using Render's public BASE_URL.
    const shortUrl = `${BASE_URL}/${shortCode}`;

    // Return information about the newly generated short URL.
    res.status(201).json({
      success: true,
      longUrl,
      shortCode,
      shortUrl,
    });
  } catch (error) {
    // Show unexpected errors in Render/server logs.
    console.error("Shorten error:", error);

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

    // Search PostgreSQL for the corresponding long URL.
    const result = await pool.query(
      "SELECT long_url FROM urls WHERE short_code = $1",
      [shortCode]
    );

    // Return 404 if that short code does not exist.
    if (result.rows.length === 0) {
      return res.status(404).send("Short URL not found");
    }

    // Read the original URL from the PostgreSQL result.
    const longUrl = result.rows[0].long_url;

    // Redirect the browser to the stored original URL.
    res.redirect(302, longUrl);
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
      // Show the running port in Render/server logs.
      console.log(`URL Shortener running on port ${PORT}`);
    });
  })
  .catch((error) => {
    // Show the database startup error if connection fails.
    console.error("Database initialization failed:", error);
  });