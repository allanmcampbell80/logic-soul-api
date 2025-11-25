// server.js
import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion } from "mongodb";

const app = express();
const port = process.env.PORT || 3000;

// Env vars from Render
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;
const collectionName = process.env.MONGODB_COLLECTION_FOODS;

if (!uri || !dbName || !collectionName) {
  console.error("Missing MongoDB env vars");
  process.exit(1);
}

// --- Mongo client setup (connect once, then reuse) ---
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let collection;

async function initMongo() {
  await client.connect();
  const db = client.db(dbName);
  collection = db.collection(collectionName);
  console.log("Connected to MongoDB, collection:", collectionName);
}

// --- Express middleware ---
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "LogicSoul API" });
});

// POST /foods  → insert a product or ingredient
// Body should be your FoodItem object, including type: "product" | "ingredient"
app.post("/foods", async (req, res) => {
  try {
    if (!collection) return res.status(500).json({ error: "DB not ready" });

    const doc = req.body;

    if (!doc || typeof doc !== "object") {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    // Minimal sanity check
    if (!doc.type || !["product", "ingredient"].includes(doc.type)) {
      return res.status(400).json({ error: "Missing or invalid 'type'" });
    }

    const result = await collection.insertOne(doc);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    console.error("Error inserting food:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /foods/barcode/:barcode  → fetch branded product by UPC/EAN
app.get("/foods/barcode/:barcode", async (req, res) => {
  try {
    if (!collection) return res.status(500).json({ error: "DB not ready" });

    const raw = req.params.barcode;
    const cleaned = raw.replace(/\D/g, ""); // strip spaces, hyphens, etc.

    if (!cleaned) {
      return res.status(400).json({ error: "Invalid barcode" });
    }

    // Normalize to a 16-digit numeric string to match normalized_upc in Mongo
    const normalized = cleaned.padStart(16, "0");

    console.log("[API] Raw:", raw, "Clean:", cleaned, "Normalized16:", normalized);

    // Search ONLY the normalized_upc
    const doc = await collection.findOne({ normalized_upc: normalized });

    console.log("[API] Lookup result:", doc ? "FOUND" : "NOT FOUND");

    if (!doc) {
      return res.status(404).json({ 
        error: "Not found", 
        normalized_upc: normalized 
      });
    }

    res.json(doc);

  } catch (err) {
    console.error("Error fetching by barcode:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start server only after Mongo is ready
initMongo()
  .then(() => {
    app.listen(port, () => {
      console.log(`LogicSoul API listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to init MongoDB:", err);
    process.exit(1);
  });

// Handle clean shutdown (Render will send SIGTERM)
process.on("SIGTERM", async () => {
  try {
    await client.close();
  } finally {
    process.exit(0);
  }
});
