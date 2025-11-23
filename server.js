import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion } from "mongodb";

const app = express();
app.use(cors());
app.use(express.json());

// ----- Config from environment variables -----
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;
const collectionName = process.env.MONGODB_COLLECTION_FOODS;
const port = process.env.PORT || 3000;

if (!uri || !dbName || !collectionName) {
  console.error("Missing MongoDB env vars");
  process.exit(1);
}

// ----- Mongo client + helper -----
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true
  }
});

let collection;

async function getCollection() {
  if (collection) return collection;
  await client.connect();
  const db = client.db(dbName);
  collection = db.collection(collectionName);

  // helpful indexes
  await collection.createIndex({ type: 1, barcode: 1 });
  await collection.createIndex({ type: 1, name: 1 });
  return collection;
}

// ----- Routes -----

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "LogicSoul API" });
});

// Upsert a food item (product or ingredient)
app.post("/food-items", async (req, res) => {
  try {
    const doc = req.body;
    if (!doc || !doc.type) {
      return res.status(400).json({ error: "Missing 'type' in body" });
    }

    const col = await getCollection();

    let filter;

    if (doc.type === "product" && doc.barcode) {
      filter = { type: "product", barcode: doc.barcode };
    } else if (doc.type === "ingredient" && doc.name) {
      filter = { type: "ingredient", name: doc.name };
    } else {
      return res
        .status(400)
        .json({ error: "Need barcode for products or name for ingredients" });
    }

    const result = await col.findOneAndUpdate(
      filter,
      { $set: doc },
      { upsert: true, returnDocument: "after" }
    );

    const id = result.value?._id || result.lastErrorObject?.upserted || null;

    res.json({ ok: true, id });
  } catch (err) {
    console.error("POST /food-items error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Get product by barcode
app.get("/food-items/barcode/:barcode", async (req, res) => {
  try {
    const col = await getCollection();
    const item = await col.findOne({
      type: "product",
      barcode: req.params.barcode
    });

    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err) {
    console.error("GET /food-items/barcode error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Get ingredient by name
app.get("/food-items/ingredient/:name", async (req, res) => {
  try {
    const col = await getCollection();
    const item = await col.findOne({
      type: "ingredient",
      name: req.params.name
    });

    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err) {
    console.error("GET /food-items/ingredient error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ----- Start server -----
app.listen(port, () => {
  console.log(`LogicSoul API listening on port ${port}`);
});