// Import Express to create the HTTP server.
const express = require("express");
// Import CORS so our frontend can communicate with the backend.

const cors = require("cors");

// Import rate limiter to protect APIs from excessive requests.
const rateLimit = require("express-rate-limit");

// Import PostgreSQL connection pool.
const { Pool } = require("pg");

// Import Node's crypto module for secure short-code generation.
const crypto = require("crypto");

// Create the Express application.
const app = express();

// Use Render's assigned port in production, or 3000 locally.
const PORT = process.env.PORT || 3000;

// Use Render's public URL in production, or localhost locally.
const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;

// Allow Express to read JSON request bodies.
app.use(express.json());
// Allow our React frontend to call the API during R&D.
app.use(cors());

// Create a PostgreSQL connection pool using Render's DATABASE_URL.
const pool = new Pool({
  // Connect using the database URL stored in Render environment variables.
  connectionString: process.env.DATABASE_URL,

  // Render internal PostgreSQL connection works without custom SSL configuration.
  ssl: false,
});

// Protect admin APIs using an API key.
function requireApiKey(req, res, next) {
  // Read the API key sent in the request header.
  const apiKey = req.headers["x-api-key"];

  // Reject the request if the API key is missing or incorrect.
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  // Continue to the requested API when the key is correct.
  next();
}

// Limit how often one IP address can create short URLs.
const shortenLimiter = rateLimit({
  // Count requests inside a 1-minute window.
  windowMs: 60 * 1000,

  // Allow only 5 requests per IP during that minute.
  limit: 5,

  // Return modern RateLimit headers.
  standardHeaders: true,

  // Disable old X-RateLimit headers.
  legacyHeaders: false,

  // Return a custom response after exceeding the limit.
  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
  },
});

// Create/update the database table when the application starts.
async function initializeDatabase() {
  // Create the URLs table if it does not already exist.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id SERIAL PRIMARY KEY,
      short_code VARCHAR(20) UNIQUE NOT NULL,
      long_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add expiration support if the column does not already exist.
  await pool.query(`
    ALTER TABLE urls
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP
  `);

  // Add active/inactive status support.
  await pool.query(`
    ALTER TABLE urls
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
  `);

  // Add click tracking.
  await pool.query(`
    ALTER TABLE urls
    ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0
  `);

  // Show confirmation in Render logs.
  console.log("PostgreSQL database initialized");
}

// Generate a secure random short code.
function generateShortCode() {
  // Characters allowed in our short URL code.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  // Start with an empty code.
  let code = "";

  // Generate 6 secure random characters.
  for (let i = 0; i < 6; i++) {
    // Generate a secure random number between 0 and 61.
    const randomIndex = crypto.randomInt(chars.length);

    // Add the selected character to the short code.
    code += chars[randomIndex];
  }

  // Return the completed short code.
  return code;
}

// Create a new short URL.
// Rate limiting and API-key authentication are required.
app.post(
  "/shorten",
  shortenLimiter,
  requireApiKey,
  async (req, res) => {
    try {
      // Read the long URL and optional expiration date from the request body.
      const { longUrl, expiresAt } = req.body;

      // Reject the request if longUrl is missing.
      if (!longUrl) {
        return res.status(400).json({
          success: false,
          message: "longUrl is required",
        });
      }

      // Validate the supplied URL.
      try {
        // Convert the supplied string into a URL object.
        const parsedUrl = new URL(longUrl);

        // Only allow HTTP and HTTPS URLs.
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return res.status(400).json({
            success: false,
            message: "Only http and https URLs are allowed",
          });
        }
      } catch (error) {
        // Reject invalid URL strings.
        return res.status(400).json({
          success: false,
          message: "Invalid URL",
        });
      }

      // Validate the expiration date if one was provided.
      if (expiresAt) {
        // Convert the provided expiration value into a Date.
        const expirationDate = new Date(expiresAt);

        // Reject an invalid date.
        if (Number.isNaN(expirationDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid expiresAt date",
          });
        }

        // Reject an expiration date that is already in the past.
        if (expirationDate <= new Date()) {
          return res.status(400).json({
            success: false,
            message: "expiresAt must be a future date",
          });
        }
      }

      // Generate the first candidate short code.
      let shortCode = generateShortCode();

      // Check whether that short code already exists.
      let existingCode = await pool.query(
        "SELECT id FROM urls WHERE short_code = $1",
        [shortCode]
      );

      // Keep generating until a unique code is found.
      while (existingCode.rows.length > 0) {
        // Generate another short code.
        shortCode = generateShortCode();

        // Check the new code again.
        existingCode = await pool.query(
          "SELECT id FROM urls WHERE short_code = $1",
          [shortCode]
        );
      }

      // Store the short-code mapping in PostgreSQL.
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

      // Build the complete public short URL.
      const shortUrl = `${BASE_URL}/${shortCode}`;

      // Return the newly created short URL.
      return res.status(201).json({
        success: true,
        longUrl,
        shortCode,
        shortUrl,
        expiresAt: expiresAt || null,
      });
    } catch (error) {
      // Log unexpected shortening errors.
      console.error("Shorten error:", error);

      // Return a generic server error.
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get information about a short URL.
// API key is required because this is an admin endpoint.
app.get("/info/:shortCode", requireApiKey, async (req, res) => {
  try {
    // Read the short code from the request path.
    const { shortCode } = req.params;

    // Find the matching URL record.
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

    // Return 404 if the code does not exist.
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Short URL not found",
      });
    }

    // Return the URL information.
    return res.json({
      success: true,
      url: result.rows[0],
    });
  } catch (error) {
    // Log unexpected errors.
    console.error("Info error:", error);

    // Return a generic error.
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Disable an existing short URL.
// API key is required because this is an admin operation.
app.patch("/disable/:shortCode", requireApiKey, async (req, res) => {
  try {
    // Read the short code from the URL.
    const { shortCode } = req.params;

    // Set the matching URL to inactive.
    const result = await pool.query(
      `
      UPDATE urls
      SET is_active = FALSE
      WHERE short_code = $1
      RETURNING short_code, is_active
      `,
      [shortCode]
    );

    // Return 404 if the URL does not exist.
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Short URL not found",
      });
    }

    // Return confirmation.
    return res.json({
      success: true,
      message: "Short URL disabled",
      url: result.rows[0],
    });
  } catch (error) {
    // Log unexpected errors.
    console.error("Disable error:", error);

    // Return a generic error.
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Enable an existing short URL.
// API key is required because this is an admin operation.
app.patch("/enable/:shortCode", requireApiKey, async (req, res) => {
  try {
    // Read the short code from the URL.
    const { shortCode } = req.params;

    // Set the matching URL back to active.
    const result = await pool.query(
      `
      UPDATE urls
      SET is_active = TRUE
      WHERE short_code = $1
      RETURNING short_code, is_active
      `,
      [shortCode]
    );

    // Return 404 if the URL does not exist.
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Short URL not found",
      });
    }

    // Return confirmation.
    return res.json({
      success: true,
      message: "Short URL enabled",
      url: result.rows[0],
    });
  } catch (error) {
    // Log unexpected errors.
    console.error("Enable error:", error);

    // Return a generic error.
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Public redirect endpoint.
// No API key is required because users must be able to open short links.
app.get("/:shortCode", async (req, res) => {
  try {
    // Read the short code from the URL.
    const { shortCode } = req.params;

    // Find the original URL and its status.
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

    // Return 404 if no matching code exists.
    if (result.rows.length === 0) {
      return res.status(404).send("Short URL not found");
    }

    // Read the database record.
    const record = result.rows[0];

    // Stop redirecting if the URL was manually disabled.
    if (!record.is_active) {
      return res.status(410).send(
        "This short URL has been disabled"
      );
    }

    // Stop redirecting if the URL has expired.
    if (
      record.expires_at &&
      new Date(record.expires_at) < new Date()
    ) {
      return res.status(410).send(
        "This short URL has expired"
      );
    }

    // Increase the click count by one.
    await pool.query(
      `
      UPDATE urls
      SET click_count = click_count + 1
      WHERE short_code = $1
      `,
      [shortCode]
    );

    // Redirect the user to the original URL.
    return res.redirect(302, record.long_url);
  } catch (error) {
    // Log unexpected redirect errors.
    console.error("Redirect error:", error);

    // Return a generic server error.
    return res.status(500).send("Internal server error");
  }
});

// Initialize the database before starting the server.
initializeDatabase()
  .then(() => {
    // Start the Express server after PostgreSQL is ready.
    app.listen(PORT, "0.0.0.0", () => {
      // Show the active port in Render logs.
      console.log(
        `URL Shortener running on port ${PORT}`
      );
    });
  })
  .catch((error) => {
    // Log startup errors if PostgreSQL initialization fails.
    console.error(
      "Database initialization failed:",
      error
    );
  });



  //Added this 