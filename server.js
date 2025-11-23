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

// GET /foods/barcode/:barcode  → fetch a product by barcode
app.get("/foods/barcode/:barcode", async (req, res) => {
  try {
    if (!collection) return res.status(500).json({ error: "DB not ready" });

    const barcode = req.params.barcode;
    const doc = await collection.findOne({ type: "product", barcode });

    if (!doc) return res.status(404).json({ error: "Not found" });

    res.json(doc);
  } catch (err) {
    console.error("Error fetching by barcode:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /foods/ingredient/:name  → fetch ingredient definition by name
app.get("/foods/ingredient/:name", async (req, res) => {
  try {
    if (!collection) return res.status(500).json({ error: "DB not ready" });

    const name = req.params.name;
    const doc = await collection.findOne({
      type: "ingredient",
      name: new RegExp(`^${name}$`, "i"), // case-insensitive
    });

    if (!doc) return res.status(404).json({ error: "Not found" });

    res.json(doc);
  } catch (err) {
    console.error("Error fetching ingredient:", err);
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