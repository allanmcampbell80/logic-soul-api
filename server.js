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
    // Turn off apiStrict so we can safely use $meta: "textScore" in queries
    strict: false,
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

// Helper function to build user enriched doc
function buildUserEnrichedDoc(payload, headers) {
  const { rawGPTData, userSubmission } = payload || {};

  if (!rawGPTData || typeof rawGPTData !== "object") {
    throw new Error("Missing or invalid 'rawGPTData' in request body");
  }

  const rawBarcode =
    (typeof rawGPTData.barcode === "string" && rawGPTData.barcode) ||
    headers["x-barcode"] ||
    headers["X-Barcode"] ||
    "";

  const cleanedBarcode = rawBarcode.replace(/\D/g, "");
  const normalizedUPC16 = cleanedBarcode ? cleanedBarcode.padStart(16, "0") : null;

  const incomingSource =
    rawGPTData.source && typeof rawGPTData.source === "object" ? rawGPTData.source : {};

  const originHeader = headers["x-origin"] || headers["X-Origin"];

  const source = {
    ...incomingSource,
    type: incomingSource.type || "gpt_ocr_label",
    created_via: incomingSource.created_via || "barcode_ocr_ios_user_photo",
    user_submitted: true,
    origin:
      (userSubmission && userSubmission.sourceType) ||
      originHeader ||
      "ios_user_barcode_ocr",
    submitted_at:
      userSubmission && userSubmission.submittedAt
        ? new Date(userSubmission.submittedAt)
        : new Date(),
    submitted_by_device:
      userSubmission && userSubmission.submittedByDevice
        ? userSubmission.submittedByDevice
        : undefined,
    note: userSubmission && userSubmission.note ? userSubmission.note : undefined,
  };

  const now = new Date();

  const docToInsert = {
    ...rawGPTData,
    type: rawGPTData.type || "product",
    source,
    normalized_upc: normalizedUPC16 || rawGPTData.normalized_upc || null,
    normalized_upc_16: normalizedUPC16 || rawGPTData.normalized_upc_16 || null,
    original_barcode_raw: rawBarcode || rawGPTData.original_barcode_raw || null,
    createdAt: now,
    updatedAt: now,
  };

  return docToInsert;
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

// POST /foods/user-enriched  → insert a GPT-enriched user product from barcode+photos
app.post("/foods/user-enriched", async (req, res) => {
  try {
    if (!collection) {
      return res.status(500).json({ error: "DB not ready" });
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    let docToInsert;
    try {
      docToInsert = buildUserEnrichedDoc(body, req.headers);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("Missing or invalid 'rawGPTData'")
      ) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const result = await collection.insertOne(docToInsert);

    res.status(201).json({
      ok: true,
      insertedId: result.insertedId,
      normalized_upc: docToInsert.normalized_upc,
      normalized_upc_16: docToInsert.normalized_upc_16,
    });
  } catch (err) {
    console.error("[User-Enriched] Error inserting GPT-enriched product:", err);
    res.status(500).json({ error: "Internal server error inserting user-enriched product." });
  }
});

// POST /user-enriched-food-item  → alias for iOS client endpoint
app.post("/user-enriched-food-item", async (req, res) => {
  try {
    if (!collection) {
      return res.status(500).json({ error: "DB not ready" });
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    let docToInsert;
    try {
      docToInsert = buildUserEnrichedDoc(body, req.headers);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("Missing or invalid 'rawGPTData'")
      ) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const result = await collection.insertOne(docToInsert);

    res.status(201).json({
      ok: true,
      insertedId: result.insertedId,
      normalized_upc: docToInsert.normalized_upc,
      normalized_upc_16: docToInsert.normalized_upc_16,
    });
  } catch (err) {
    console.error("[User-Enriched Alias] Error inserting GPT-enriched product:", err);
    res
      .status(500)
      .json({ error: "Internal server error inserting user-enriched product (alias)." });
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
    // Search both normalized_upc (USDA) and normalized_upc_16 (Canada OFF)
    const doc = await collection.findOne({
    $or: [
    { normalized_upc: normalized },
    { normalized_upc_16: normalized }
        ]
    });

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

// POST /foods/usda-candidates
// Given a product name + brandName, return top USDA-branded candidates.
app.post("/foods/usda-candidates", async (req, res) => {
  try {
    if (!collection) {
      return res.status(500).json({ error: "DB not ready" });
    }

    const { name, brandName, limit } = req.body || {};

    console.log("[USDA Candidates] Incoming body:", req.body);

    // Build a text search string from whatever we have
    const searchParts = [];
    if (typeof brandName === "string" && brandName.trim().length > 0) {
      searchParts.push(`"${brandName.trim()}"`);
    }
    if (typeof name === "string" && name.trim().length > 0) {
      searchParts.push(name.trim());
    }
    const searchString = searchParts.join(" ");

    console.log("[USDA Candidates] searchString:", JSON.stringify(searchString));

    // If we ended up with nothing meaningful to search, bail with 400
    if (!searchString || searchString.trim().length === 0) {
      return res.status(400).json({
        error:
          "Please provide a non-empty product name or brandName to search USDA candidates.",
      });
    }

    // Base query: USDA branded products only
    const query = {
      "source.usda_data_type": "Branded",
      $text: { $search: searchString },
    };

    // Projection: include a textScore so we can sort by relevance
    const projection = {
      name: 1,
      normalized_name: 1,
      normalized_upc: 1,
      brand: 1,
      food_type: 1,
      "source.usda_fdc_id": 1,
      score: { $meta: "textScore" },
    };

    const maxResults =
      typeof limit === "number" && limit > 0 && limit <= 25 ? limit : 10;

    const cursor = collection
      .find(query, { projection })
      .sort({ score: { $meta: "textScore" } })
      .limit(maxResults);

    const results = await cursor.toArray();

    console.log(
      "[USDA Candidates] Found",
      results.length,
      "docs for searchString:",
      searchString
    );

    const simplified = results.map((doc) => ({
      id: doc._id,
      name: doc.name,
      normalizedName: doc.normalized_name,
      normalizedUPC: doc.normalized_upc,
      normalizedUPC16: doc.normalized_upc, // same for now
      brandName: doc.brand?.name ?? null,
      brandOwner: doc.brand?.owner ?? null,
      marketCountry: doc.brand?.market_country ?? null,
      foodType: doc.food_type,
      usdaFdcId: doc.source?.usda_fdc_id ?? null,
      nutrients: doc.nutrients ?? [],
    }));

    res.json({
      ok: true,
      count: simplified.length,
      candidates: simplified,
      searchString,
    });
  } catch (err) {
    console.error("[USDA Candidates] Error:", err);
    res.status(500).json({
      error: "Internal server error finding USDA candidates.",
      details: String(err && err.message ? err.message : err),
    });
  }
});

// POST /foods/link-canadian-to-usda
// Link a Canadian OFF product to a USDA-branded equivalent for future lookups.
app.post("/foods/link-canadian-to-usda", async (req, res) => {
  try {
    if (!collection) {
      return res.status(500).json({ error: "DB not ready" });
    }

    const {
      canadianNormalizedUPC16,
      usdaNormalizedUPC,
      userVerified,
    } = req.body || {};

    if (!canadianNormalizedUPC16 || !usdaNormalizedUPC) {
      return res.status(400).json({
        error:
          "Missing required fields: 'canadianNormalizedUPC16' and 'usdaNormalizedUPC'.",
      });
    }

    const normalizedCanadian = String(canadianNormalizedUPC16)
      .replace(/\D/g, "")
      .padStart(16, "0");
    const normalizedUSDA = String(usdaNormalizedUPC)
      .replace(/\D/g, "")
      .padStart(16, "0");

    // Find the Canadian doc
    const canadianDoc = await collection.findOne({
      is_canadian_product: true,
      normalized_upc_16: normalizedCanadian,
    });

    if (!canadianDoc) {
      return res.status(404).json({
        error: "Canadian product not found for given normalized UPC.",
        normalizedCanadian,
      });
    }

    // Find the USDA branded doc
    const usdaDoc = await collection.findOne({
      "source.usda_data_type": "Branded",
      normalized_upc: normalizedUSDA,
    });

    if (!usdaDoc) {
      return res.status(404).json({
        error: "USDA product not found for given normalized UPC.",
        normalizedUSDA,
      });
    }

    const now = new Date();
    const usdaFdcId = usdaDoc.source?.usda_fdc_id ?? null;

    const updateResult = await collection.updateOne(
      { _id: canadianDoc._id },
      {
        $set: {
          usda_equivalent: {
            normalized_upc: normalizedUSDA,
            usda_fdc_id: usdaFdcId,
            user_verified: !!userVerified,
            link_source: "user",
            linked_at: now,
          },
        },
      }
    );

    res.json({
      ok: true,
      matchedCount: updateResult.matchedCount,
      modifiedCount: updateResult.modifiedCount,
      canadianId: canadianDoc._id,
      usdaId: usdaDoc._id,
      normalizedCanadian,
      normalizedUSDA,
    });
  } catch (err) {
    console.error("[Link Canadian→USDA] Error:", err);
    res.status(500).json({
      error: "Internal server error linking Canadian product to USDA.",
    });
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
