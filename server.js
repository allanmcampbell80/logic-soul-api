// server.js
import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { findBestMatchesForMealItems } from "./services/mealSearch.js";
import { buildUserEnrichedDoc, ensureSimpleIngredientsFromParsedList} from "./services/enrich.js";
import { ensureUser, updateUserProfile, patchUserDailyTotals, addRecoveryEmail, verifyRecoveryEmail, recoverAccount} from "./services/users.js";
import { logUserMeal, recomputeDailyNutritionTotals, getUserMealsForDate, deleteUserMeal,} from "./services/userMeals.js";
import { getFoodDetails } from "./services/foodDetails.js";
import { getUserFavoritesByUserId, addUserFavoriteByUserId, deleteUserFavoriteByUserId,} from "./services/favorites.js";
import { storeUserCorrelationPack } from "./services/userAnalysis.js";
import { getAwardsForUser, applyAwardEvent } from "./services/awards.js";

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

let db;
let collection;

async function initMongo() {
  await client.connect();
  db = client.db(dbName);
  collection = db.collection(collectionName);
  console.log("Connected to MongoDB, collection:", collectionName);
}



// --- Express middleware ---

app.use(cors());
app.use(express.json());

// --- Moderation / reporting ---
const REPORT_REASONS = new Set([
  "brand_wrong",
  "wrong_food",
  "duplicate",
  "restaurant_misclassified",
  "preparation_context_wrong",
  "nutrition_data_wrong",
  "other",
]);


function notIgnoredQuery() {
  return { "moderation.is_ignored": { $ne: true } };
}

function safeTrimString(v) {
  if (v == null) return "";
  return String(v).trim();
}

function hasNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

function isLikelyDvBoilerplate(text) {
  const t = safeTrimString(text).toLowerCase();
  if (!t) return false;
  // Common Canadian %DV boilerplate in EN/FR
  if (t.includes("5% or less is a little")) return true;
  if (t.includes("15% or more is a lot")) return true;
  if (t.includes("5% ou moins")) return true;
  if (t.includes("15% ou plus")) return true;
  return false;
}

function scoreCanadianDoc(doc) {
  // Higher is better
  let score = 0;

  const userSubmitted = !!doc?.source?.user_submitted;
  const sourceType = safeTrimString(doc?.source?.type);
  const hasIngredientsParsed = hasNonEmptyArray(doc?.ingredients_parsed);
  const ingredientsText = safeTrimString(doc?.ingredients_text);

  // Strong preference: user-submitted label/OCR docs
  if (userSubmitted) score += 100;
  if (sourceType === "gpt_ocr_label") score += 50;

  // Prefer richer ingredient coverage
  if (hasIngredientsParsed) score += 30;
  if (ingredientsText.length > 0) score += 10;

  // Penalize DV boilerplate if it leaked into ingredients_text
  if (ingredientsText.length > 0 && isLikelyDvBoilerplate(ingredientsText)) score -= 20;

  // If it looks like an OFF/import doc, keep it as a fallback choice
  if (doc?.is_canadian_product) score += 5;

  // Prefer newest updates slightly
  const updatedAt = doc?.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
  const createdAt = doc?.createdAt ? new Date(doc.createdAt).getTime() : 0;
  const ts = Math.max(updatedAt || 0, createdAt || 0);
  if (ts > 0) {
    // Add a small, bounded bonus for recency (0..10)
    const daysAgo = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
    const recencyBonus = Math.max(0, 10 - Math.min(10, Math.floor(daysAgo / 7)));
    score += recencyBonus;
  }

  return score;
}

async function chooseBestCanadianDocForUPC(normalizedUPC16) {
  if (!collection) return null;

  // Pull all candidate docs for this UPC (excluding USDA branded)
  const docs = await collection
    .find({
      ...notIgnoredQuery(),
      normalized_upc_16: normalizedUPC16,
      $or: [
        { "source.usda_data_type": { $exists: false } },
        { "source.usda_data_type": { $ne: "Branded" } },
      ],
    })
    .limit(25)
    .toArray();

  if (!docs || docs.length === 0) return null;

  // Rank using score; tie-break by newest timestamp
  docs.sort((a, b) => {
    const sa = scoreCanadianDoc(a);
    const sb = scoreCanadianDoc(b);
    if (sb !== sa) return sb - sa;

    const ta = Math.max(
      a?.updatedAt ? new Date(a.updatedAt).getTime() : 0,
      a?.createdAt ? new Date(a.createdAt).getTime() : 0
    );
    const tb = Math.max(
      b?.updatedAt ? new Date(b.updatedAt).getTime() : 0,
      b?.createdAt ? new Date(b.createdAt).getTime() : 0
    );
    return (tb || 0) - (ta || 0);
  });

  return docs[0];
}


//-----------------------------------------------------------------------------------------------------

// Helper: Apply an award event by deviceId (best-effort, async)
async function applyAwardEventByDeviceId(db, deviceId, eventKey, amount = 1) {
  try {
    const cleaned = String(deviceId || "").trim();
    if (!db || !cleaned) return;

    const usersCol = db.collection("users");
    const user = await usersCol.findOne({ deviceId: cleaned }, { projection: { _id: 1 } });
    if (!user?._id) return;

    const userId = String(user._id);
    await applyAwardEvent(db, { userId }, { eventKey, amount });
  } catch (err) {
    console.error(`[Awards] Failed applyAwardEventByDeviceId (${eventKey}):`, err);
  }
}

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "LogicSoul API" });
});


//----------------------------------------------------------------------------------------------------------------


// POST /api/food-items/:id/report
// Flags a food item to be ignored until a human review.
// Body: { reason: string, message?: string, platform?: string }
app.post("/api/food-items/:id/report", async (req, res) => {
  try {
    if (!collection) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, error: "Invalid food item id" });
    }

    const reason = String(req.body?.reason || "").trim();
    const message = String(req.body?.message || "").trim();
    const platform = String(req.body?.platform || "unknown").trim();

    if (!REPORT_REASONS.has(reason)) {
      return res.status(400).json({ ok: false, error: "Invalid report reason" });
    }

    if (message.length > 280) {
      return res
        .status(400)
        .json({ ok: false, error: "Message too long (280 max)" });
    }

    const now = new Date();

    const update = {
      $set: {
        "moderation.is_ignored": true,
        "moderation.status": "reported",
        "moderation.reason": reason,
        "moderation.user_message": message || null,
        "moderation.reported_at": now,
        "moderation.reported_by": {
          // Auth may not be wired yet; keep null-safe.
          user_id: req.user?.id ?? null,
          platform,
        },
        updatedAt: now,
      },
    };

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      update
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ ok: false, error: "Food item not found" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[FoodItems/Report] Error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to report food item" });
  }
});

//-------------------------------------------------------------------------------------------------------
// Favorites


// GET /users/:id/favorites  → returns the user's favorites list (by userId)
app.get("/users/:id/favorites", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = String(req.params?.id || "").trim();
    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid ':id' (userId).",
      });
    }

    const favorites = await getUserFavoritesByUserId(db, userId);
    return res.json({ ok: true, userId, favorites: favorites || [] });
  } catch (err) {
    console.error("[Favorites/ListByUserId] Error:", err);
    const status = err?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || "Failed to fetch favorites",
    });
  }
});


//-------------------------------------------------------------------------------------------------------------------

// POST /users/:id/favorites  → adds a favorite to the user's profile (by userId)
// Body: { foodId, commonName?, brandName? }
app.post("/users/:id/favorites", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = String(req.params?.id || "").trim();
    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid ':id' (userId).",
      });
    }

    const foodId = String(req.body?.foodId || "").trim();
    const commonName =
      req.body?.commonName != null ? String(req.body.commonName).trim() : null;
    const brandName =
      req.body?.brandName != null ? String(req.body.brandName).trim() : null;

    if (!foodId || !ObjectId.isValid(foodId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid 'foodId' (expected Mongo ObjectId).",
      });
    }

    const result = await addUserFavoriteByUserId(db, {
      userId,
      foodId,
      commonName,
      brandName,
    });

    return res.json({ ok: true, userId, favorites: result || [] });
  } catch (err) {
    console.error("[Favorites/AddByUserId] Error:", err);
    const status = err?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || "Failed to add favorite",
    });
  }
});

//------------------------------------------------------------------------------------------------------------------

// DELETE /users/:id/favorites/:foodId  → removes a favorite from the user's profile (by userId)
app.delete("/users/:id/favorites/:foodId", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = String(req.params?.id || "").trim();
    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid ':id' (userId).",
      });
    }

    const foodId = String(req.params?.foodId || "").trim();

    if (!foodId || !ObjectId.isValid(foodId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid ':foodId' (expected Mongo ObjectId).",
      });
    }

    const result = await deleteUserFavoriteByUserId(db, {
      userId,
      foodId,
    });

    return res.json({ ok: true, userId, favorites: result || [] });
  } catch (err) {
    console.error("[Favorites/DeleteByUserId] Error:", err);
    const status = err?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || "Failed to delete favorite",
    });
  }
});


//-------------------------------------------------------------------------------------------------------
// Awards (stored on the user document)

// GET /users/:id/awards  → returns the user's awards list (by userId)
// Returns: { ok: true, userId, awards: [...] }
app.get("/users/:id/awards", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = String(req.params?.id || "").trim();
    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid ':id' (userId).",
      });
    }

    const result = await getAwardsForUser(db, { userId });
    if (!result) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    return res.json({ ok: true, userId: result.userId, awards: result.awards || [] });
  } catch (err) {
    console.error("[Awards/ListByUserId] Error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to fetch awards" });
  }
});


//-------------------------------------------------------------------------------------------------------------------------

// POST /users/:id/awards/event  → increments a tally and auto-awards if thresholds are crossed.
// Body: { eventKey: string, amount?: number }
// Returns: { ok: true, userId, awards: [...] }
app.post("/users/:id/awards/event", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = String(req.params?.id || "").trim();
    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid ':id' (userId).",
      });
    }

    const eventKey = String(req.body?.eventKey || "").trim();
    const amountRaw = req.body?.amount;
    const amount =
      typeof amountRaw === "number" && Number.isFinite(amountRaw)
        ? Math.trunc(amountRaw)
        : 1;

    if (!eventKey) {
      return res.status(400).json({ ok: false, error: "Missing required field 'eventKey'." });
    }

    if (amount === 0) {
      return res.status(400).json({ ok: false, error: "'amount' must be non-zero." });
    }

    const result = await applyAwardEvent(db, { userId }, { eventKey, amount });
    if (!result) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    return res.json({ ok: true, userId: result.userId, awards: result.awards || [] });
  } catch (err) {
    console.error("[Awards/EventByUserId] Error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to apply award event" });
  }
});

//---------------------------------------------------------------------------------------------------------------------

// POST /users/ensure → create or update a user by deviceId
app.post("/users/ensure", async (req, res) => {
  try {
    const user = await ensureUser(db, req.body || {});
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("[Users/Ensure] Error:", err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || "Failed to ensure user",
    });
  }
});

//--------------------------------------------------------------------------------------------------------

// PATCH /users/:id/profile → update basic profile info
app.patch("/users/:id/profile", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await updateUserProfile(db, id, req.body || {});
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("[Users/Profile] Error:", err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || "Failed to update user profile",
    });
  }
});


//--------------------------------------------------------------------------------------------------------
// Account Recovery (placeholders)
// These routes are scaffolding only. Server-side implementation will be added in services/users.js.

// POST /users/:id/recovery-email
// Body: { email: string }
// Intended: store only a server-side hash (HMAC) + send verification code/link.
app.post("/users/:id/recovery-email", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }
    const userId = String(req.params?.id || "").trim();
    const email = String(req.body?.email || "").trim();

    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({ ok: false, error: "Missing or invalid ':id' (userId)." });
    }

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing required field 'email'." });
    }

    const user = await addRecoveryEmail(db, userId, email);
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("[Users/RecoveryEmail/Add] Error:", err);
    return res.status(500).json({ ok: false, error: "Failed to add recovery email" });
  }
});

//--------------------------------------------------------------------------------------------------

// POST /users/:id/recovery-email/verify
// Body: { code: string }
// Intended: verify code and mark recovery email as verified.
app.post("/users/:id/recovery-email/verify", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }
    const userId = String(req.params?.id || "").trim();
    const code = String(req.body?.code || "").trim();

    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(400).json({ ok: false, error: "Missing or invalid ':id' (userId)." });
    }

    if (!code) {
      return res.status(400).json({ ok: false, error: "Missing required field 'code'." });
    }

    const user = await verifyRecoveryEmail(db, userId, code);
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("[Users/RecoveryEmail/Verify] Error:", err);
    return res.status(500).json({ ok: false, error: "Failed to verify recovery email" });
  }
});

//----------------------------------------------------------------------------------------------------

// POST /users/recover
// Body: { email: string, code: string }
// Intended: find user by email hash + code, then attach/replace deviceId (or return a session).
app.post("/users/recover", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }
    const email = String(req.body?.email || "").trim();
    const code = String(req.body?.code || "").trim();

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing required field 'email'." });
    }

    if (!code) {
      return res.status(400).json({ ok: false, error: "Missing required field 'code'." });
    }

    const newDeviceId = String(
      req.body?.deviceId ||
      req.headers["x-device-id"] ||
      req.headers["X-Device-Id"] ||
      ""
    ).trim();

    if (!newDeviceId) {
      return res.status(400).json({ ok: false, error: "Missing required field 'deviceId' (or X-Device-Id header)." });
    }

    const user = await recoverAccount(db, email, code, newDeviceId);
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("[Users/Recover] Error:", err);
    return res.status(500).json({ ok: false, error: "Failed to recover account" });
  }
});


//-------------------------------------------------------------------------------------------------------------

app.post("/users/:id/meals", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = String(req.params?.id || "").trim();
    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "Missing required path parameter ':id' (userId).",
      });
    }

    // Expecting payload shaped roughly like:
    // {
    //   loggedAt: "2025-12-10T15:30:00.000Z",   // optional
    //   timezone: "America/Toronto",            // optional
    //   description: "Steak, cauliflower mash",
    //   dateKey: "2025-12-10",                  // optional override
    //   items: [
    //     {
    //       name: "Steak",
    //       foodId: "69248aba5f482c9b7d709939",
    //       quantity: 150,
    //       quantityUnit: "g",
    //       confidence: 0.92
    //     },
    //     // ...
    //   ]
    // }
    const payload = req.body;

    // 1) Log the meal itself
    const result = await logUserMeal(userId, payload);

    // 1b) Increment awards tally for meals logged (best-effort; never block response)
    applyAwardEvent(db, { userId }, { eventKey: "mealsLogged", amount: 1 }).catch(
      (err) => {
        console.error("[Users/Meals] Failed to apply mealsLogged award event:", err);
      }
    );

    // 2) Kick off daily nutrition total recompute in the background.
    //    We don't block the response on this — it's best-effort.
    if (db && result && result.dateKey) {
      recomputeDailyNutritionTotals(db, userId, result.dateKey).catch((err) => {
        console.error(
          "[Users/Meals] Failed to recompute daily nutrition totals:",
          err
        );
      });
    } else {
      console.warn(
        "[Users/Meals] Skipping recomputeDailyNutritionTotals — missing db or dateKey",
        { hasDb: !!db, hasDateKey: !!(result && result.dateKey) }
      );
    }

    res.json({
      ok: true,
      meal: result,
    });
  } catch (err) {
    console.error("[Users/Meals] Error:", err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message || "Failed to log meal",
    });
  }
});

//---------------------------------------------------------------------------------------------

// GET /users/:id/meals?dateKey=YYYY-MM-DD
// Returns the user's meals for a given day (sorted by time).
app.get("/users/:id/meals", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = req.params.id;
    const { dateKey } = req.query;

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "Missing required path parameter ':id' (userId).",
      });
    }

    if (!dateKey || typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid required query parameter 'dateKey' (expected YYYY-MM-DD).",
      });
    }

    // IMPORTANT:
    // In Mongo, userId may be stored as an ObjectId (newer docs) OR a string (older docs).
    // Query both so the API returns meals regardless of storage type.
    const userIdFilters = [{ userId: userId }];
    if (typeof userId === "string" && /^[a-fA-F0-9]{24}$/.test(userId)) {
      try {
        userIdFilters.push({ userId: new ObjectId(userId) });
      } catch {
        // ignore
      }
    }

    const mealsCol = db.collection("user_meals");

    const items = await mealsCol
      .find({
        $and: [
          { $or: userIdFilters },
          { dateKey },
        ],
      })
      .sort({ loggedAt: -1 })
      .toArray();

    // Return a stable shape, plus a `meals` alias for client compatibility.
    return res.json({
      ok: true,
      dateKey,
      count: Array.isArray(items) ? items.length : 0,
      items: items || [],
      meals: items || [],
    });
  } catch (err) {
    console.error("[Users/Meals/List] Error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to fetch meals for date",
      details: err && err.message ? err.message : String(err),
    });
  }
});

//----------------------------------------------------------------------------------------------------------------

// DELETE /users/:id/meals/:mealId
// Deletes a single logged meal and recomputes that day's totals.
app.delete("/users/:id/meals/:mealId", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = req.params.id;
    const { mealId } = req.params;

    if (!userId) {
      return res.status(400).json({ ok: false, error: "Missing required path parameter ':id' (userId)." });
    }

    if (!mealId || typeof mealId !== "string" || !ObjectId.isValid(mealId)) {
      return res.status(400).json({ ok: false, error: "Missing or invalid ':mealId' (expected Mongo ObjectId)." });
    }

    // NOTE:
    // user_meals.userId may be stored as ObjectId or string. The service layer
    // may query by exact type, so we pass an ObjectId when possible.
    let userIdForDelete = userId;
    if (typeof userId === "string" && /^[a-fA-F0-9]{24}$/.test(userId)) {
      try {
        userIdForDelete = new ObjectId(userId);
      } catch {
        userIdForDelete = userId;
      }
    }

    const result = await deleteUserMeal(db, userIdForDelete, mealId);

    if (!result || result.ok === false) {
      const msg = result && result.error ? result.error : "Failed to delete meal";
      const status = result && typeof result.statusCode === "number" ? result.statusCode : 500;
      return res.status(status).json({ ok: false, error: msg });
    }

    // Service should return dateKey so the client can refresh that day's list/totals.
    return res.json({
      ok: true,
      mealId,
      dateKey: result.dateKey || null,
      deletedCount: result.deletedCount ?? 1,
    });
  } catch (err) {
    console.error("[Users/Meals/Delete] Error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to delete meal",
      details: err && err.message ? err.message : String(err),
    });
  }
});

//------------------------------------------------------------------------------------------------

// GET /users/:id/daily-totals?dateKey=YYYY-MM-DD
// Returns the user's daily nutrition totals from the user_daily_totals collection.
app.get("/users/:id/daily-totals", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        ok: false,
        error: "DB not ready",
      });
    }

    const userId = req.params.id;
    const { dateKey } = req.query;

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "Missing required path parameter ':id' (userId).",
      });
    }

    if (!dateKey || typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid required query parameter 'dateKey' (expected YYYY-MM-DD).",
      });
    }

    // Collection lives in the same DB as everything else
    const totalsCol = db.collection("user_daily_totals");

    // Attempt to coerce userId into an ObjectId if it looks like one
    let userIdValue = userId;
    if (typeof userId === "string" && /^[a-fA-F0-9]{24}$/.test(userId)) {
      try {
        userIdValue = new ObjectId(userId);
      } catch {
        userIdValue = userId;
      }
    }

    const doc = await totalsCol.findOne({
      userId: userIdValue,
      dateKey,
    });

    if (!doc) {
      return res.status(404).json({
        ok: false,
        error: "Not found",
        userId,
        dateKey,
      });
    }

    // Return a stable shape that the iOS app can consume easily
    return res.json({
      ok: true,
      dateKey: doc.dateKey,
      timezone: doc.timezone || null,
      totals: doc.totals || {},
      updatedAt: doc.updatedAt || null,
      createdAt: doc.createdAt || null,
    });
  } catch (err) {
    console.error("[Users/DailyTotals] Error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to fetch daily nutrition totals",
      details: err && err.message ? err.message : String(err),
    });
  }
});

//------------------------------------------------------------------------------------------------------------

// PATCH /users/:id/daily-totals/hydration
// Body: { dateKey: "YYYY-MM-DD", delta_ml?: number, water_from_drinks_ml?: number, timezone?: "America/Toronto" }
// Updates drink-water (mL) without triggering daily check-in logic.
// Keeps totals.water_total_ml in sync: water_from_food_ml + water_from_drinks_ml.
app.patch("/users/:id/daily-totals/hydration", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = req.params.id;
    const { dateKey, delta_ml, deltaMl, water_from_drinks_ml, waterFromDrinksMl, timezone } = req.body || {};

    if (!userId) {
      return res.status(400).json({ ok: false, error: "Missing required path parameter ':id' (userId)." });
    }

    const dk = String(dateKey || "").trim();
    if (!dk || !/^\d{4}-\d{2}-\d{2}$/.test(dk)) {
      return res.status(400).json({ ok: false, error: "Missing or invalid required field 'dateKey' (expected YYYY-MM-DD)." });
    }

    // Prefer delta updates for frequent interactions.
    const deltaRaw = (typeof delta_ml === "number" ? delta_ml : (typeof deltaMl === "number" ? deltaMl : null));
    const absRaw = (typeof water_from_drinks_ml === "number" ? water_from_drinks_ml : (typeof waterFromDrinksMl === "number" ? waterFromDrinksMl : null));

    const hasDelta = typeof deltaRaw === "number" && Number.isFinite(deltaRaw);
    const hasAbs = typeof absRaw === "number" && Number.isFinite(absRaw);

    if (!hasDelta && !hasAbs) {
      return res.status(400).json({ ok: false, error: "Provide either 'delta_ml' (number) or 'water_from_drinks_ml' (number)." });
    }

    // Sanity: hydration cannot be negative.
    if (hasDelta && deltaRaw < 0) {
      return res.status(400).json({ ok: false, error: "'delta_ml' must be >= 0." });
    }
    if (hasAbs && absRaw < 0) {
      return res.status(400).json({ ok: false, error: "'water_from_drinks_ml' must be >= 0." });
    }

    const totalsCol = db.collection("user_daily_totals");

    // Match the same userId type strategy used elsewhere (ObjectId when possible)
    let userIdValue = userId;
    if (typeof userId === "string" && /^[a-fA-F0-9]{24}$/.test(userId)) {
      try {
        userIdValue = new ObjectId(userId);
      } catch {
        userIdValue = userId;
      }
    }

    const now = new Date();
    const tz = timezone != null ? String(timezone).trim() : null;

    // Aggregation pipeline update so we can atomically update drinks + recompute total.
    // - If delta is provided: drinks = drinks + delta
    // - Else: drinks = abs
    // Then: total = food + drinks
    const drinksExpr = hasDelta
      ? { $add: [ { $ifNull: ["$totals.water_from_drinks_ml", 0] }, deltaRaw ] }
      : absRaw;

    const updatePipeline = [
      {
        $set: {
          userId: userIdValue,
          dateKey: dk,
          updatedAt: now,
          createdAt: { $ifNull: ["$createdAt", now] },
          ...(tz ? { timezone: tz } : {}),
          "totals.water_from_drinks_ml": drinksExpr,
        },
      },
      {
        $set: {
          "totals.water_total_ml": {
            $add: [
              { $ifNull: ["$totals.water_from_food_ml", 0] },
              { $ifNull: ["$totals.water_from_drinks_ml", 0] },
            ],
          },
        },
      },
    ];

    await totalsCol.updateOne(
      { userId: userIdValue, dateKey: dk },
      updatePipeline,
      { upsert: true }
    );

    const doc = await totalsCol.findOne({ userId: userIdValue, dateKey: dk });

    return res.json({
      ok: true,
      dateKey: dk,
      timezone: doc?.timezone || tz || null,
      totals: doc?.totals || {},
      updatedAt: doc?.updatedAt || now,
      createdAt: doc?.createdAt || null,
    });
  } catch (err) {
    console.error("[Users/DailyTotals/Hydration] Error:", err?.message || err);
    if (err?.stack) console.error(err.stack);
    return res.status(500).json({ ok: false, error: "Failed to update hydration" });
  }
});

//------------------------------------------------------------------------------------------------------------

// PATCH /users/:id/daily-totals/checkin
// Body: { dateKey: "YYYY-MM-DD", patch: { "checkin_mood": 6, ... }, timezone?: "America/Toronto" }
// Merges patch keys into doc.totals.* and upserts the daily totals doc if missing.
app.patch("/users/:id/daily-totals/checkin", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = req.params.id;
    const { dateKey, patch, timezone, pain_regions, painRegions, pain_details, painDetails } = req.body || {};
    const painRegionsPayload = (pain_regions && typeof pain_regions === "object")
      ? pain_regions
      : (painRegions && typeof painRegions === "object")
        ? painRegions
        : null;

    const painDetailsPayload = (pain_details && typeof pain_details === "object")
      ? pain_details
      : (painDetails && typeof painDetails === "object")
        ? painDetails
        : null;

    const result = await patchUserDailyTotals(db, userId, dateKey, patch, timezone);

    // Persist detailed pain region/detailed intensities (optional)
    // Stored separately from totals so we don't mix numeric totals with object fields.
    try {
      if (db && result?.ok && (painRegionsPayload || painDetailsPayload) && dateKey) {
        const totalsCol = db.collection("user_daily_totals");

        // Match the same userId type strategy used elsewhere (ObjectId when possible)
        let userIdValue = userId;
        if (typeof userId === "string" && /^[a-fA-F0-9]{24}$/.test(userId)) {
          try {
            userIdValue = new ObjectId(userId);
          } catch {
            userIdValue = userId;
          }
        }

        const setPatch = { updatedAt: new Date() };
        if (painRegionsPayload) setPatch["checkin.pain_regions"] = painRegionsPayload;
        if (painDetailsPayload) setPatch["checkin.pain_details"] = painDetailsPayload;

        await totalsCol.updateOne(
          { userId: userIdValue, dateKey: String(dateKey) },
          {
            $set: setPatch,
          }
        );
      }
    } catch (painErr) {
      console.error("[Users/DailyTotals/CheckIn] Failed to store pain_regions/pain_details:", painErr);
      // Best-effort: do not fail the main check-in patch if this optional field fails.
    }

    // Awards: Daily check-in tally (best-effort, de-duped per dateKey)
    try {
      if (db && result?.ok && dateKey && ObjectId.isValid(String(userId))) {
        const usersCol = db.collection("users");

        // De-dupe per dateKey so edits don't double-count
        const dedupe = await usersCol.updateOne(
          { _id: new ObjectId(String(userId)), dailyCheckinDateKeys: { $ne: String(dateKey) } },
          { $addToSet: { dailyCheckinDateKeys: String(dateKey) } }
        );

        if (dedupe?.modifiedCount === 1) {
          applyAwardEvent(db, { userId: String(userId) }, { eventKey: "dailyCheckins", amount: 1 }).catch(
            (err) => {
              console.error("[Users/DailyTotals/CheckIn] Failed to apply dailyCheckins award event:", err);
            }
          );
        }
      }
    } catch (awardErr) {
      console.error("[Users/DailyTotals/CheckIn] Daily check-in award hook error:", awardErr);
    }

    return res.json(result);
  } catch (err) {
    console.error("[Users/DailyTotals/CheckIn] Error:", err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || "Failed to update daily check-in",
    });
  }
});


//-------------------------------------------------------------------------------------------------------
// User Analysis

// POST /user-analysis/correlation-pack
// Receives app-generated daily correlation candidates for later longitudinal analysis
app.post("/user-analysis/correlation-pack", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const payload = req.body;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }

    const result = await storeUserCorrelationPack(db, payload);

    return res.json({
      ok: true,
      userId: result.userId,
      dateKey: result.dateKey,
      storedCount: result.storedCount,
      message: "Correlation pack stored",
    });
  } catch (err) {
    console.error("[UserAnalysis/CorrelationPack] Error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Failed to store correlation pack",
    });
  }
});
//-------------------------------------------------------------------------------------------------------


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

//----------------------------------------------------------------------------------------------------------

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
      docToInsert = await buildUserEnrichedDoc(body, req.headers, db);
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

    // Awards: count a barcode added when a user-enriched barcode submission is received (best-effort)
    const submittedDeviceId =
      docToInsert?.source?.submitted_by_device ||
      body?.deviceId ||
      body?.user_submission?.submittedByDevice ||
      body?.user_submission?.submitted_by_device ||
      body?.userSubmission?.submittedByDevice ||
      body?.userSubmission?.submitted_by_device ||
      req.headers["x-device-id"] ||
      req.headers["X-Device-Id"];

    if (submittedDeviceId) {
      console.log("[Awards] barcodesAdded event; deviceId:", submittedDeviceId);
    } else {
      console.warn("[Awards] barcodesAdded NOT applied (missing deviceId)");
    }

    if (db && submittedDeviceId) {
      applyAwardEventByDeviceId(db, submittedDeviceId, "barcodesAdded", 1);
    }

    // Ensure all parsed ingredients have simple-ingredient stubs for later enrichment
    if (
      Array.isArray(docToInsert.ingredients_parsed) &&
      docToInsert.ingredients_parsed.length > 0
    ) {
      try {
        await ensureSimpleIngredientsFromParsedList(
          docToInsert.ingredients_parsed,
          docToInsert.normalized_upc_16 || docToInsert.normalized_upc || null,
          "user_enriched_canadian_product"
        );
      } catch (ingErr) {
        console.error("[User-Enriched] Error ensuring simple ingredients:", ingErr);
      }
    }

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

//-----------------------------------------------------------------------------------------

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
      docToInsert = await buildUserEnrichedDoc(body, req.headers, db);
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

    // Awards: count a barcode added when a user-enriched barcode submission is received (best-effort)
    const submittedDeviceId =
      docToInsert?.source?.submitted_by_device ||
      body?.deviceId ||
      body?.user_submission?.submittedByDevice ||
      body?.user_submission?.submitted_by_device ||
      body?.userSubmission?.submittedByDevice ||
      body?.userSubmission?.submitted_by_device ||
      req.headers["x-device-id"] ||
      req.headers["X-Device-Id"];

    if (submittedDeviceId) {
      console.log("[Awards] barcodesAdded event; deviceId:", submittedDeviceId);
    } else {
      console.warn("[Awards] barcodesAdded NOT applied (missing deviceId)");
    }

    if (db && submittedDeviceId) {
      applyAwardEventByDeviceId(db, submittedDeviceId, "barcodesAdded", 1);
    }

    // Ensure all parsed ingredients have simple-ingredient stubs for later enrichment
    if (
      Array.isArray(docToInsert.ingredients_parsed) &&
      docToInsert.ingredients_parsed.length > 0
    ) {
      try {
        await ensureSimpleIngredientsFromParsedList(
          docToInsert.ingredients_parsed,
          docToInsert.normalized_upc_16 || docToInsert.normalized_upc || null,
          "user_enriched_canadian_product"
        );
      } catch (ingErr) {
        console.error(
          "[User-Enriched Alias] Error ensuring simple ingredients:",
          ingErr
        );
      }
    }

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

//---------------------------------------------------------------------------------------------------------

// GET /foods/barcode/:barcode  → fetch best product by UPC/EAN
app.get("/foods/barcode/:barcode", async (req, res) => {
  try {
    if (!collection) {
      return res.status(500).json({ error: "DB not ready" });
    }

    const raw = req.params.barcode;
    const cleaned = raw.replace(/\D/g, ""); // strip spaces, hyphens, etc.

    if (!cleaned) {
      return res.status(400).json({ error: "Invalid barcode" });
    }

    // Normalize to a 16-digit numeric string to match normalized_upc / normalized_upc_16 in Mongo
    const normalized = cleaned.padStart(16, "0");

    console.log("[API] Raw:", raw, "Clean:", cleaned, "Normalized16:", normalized);

    // 1) Direct USDA branded match for this exact barcode (gold standard for *US* products)
    let doc = await collection.findOne({
      ...notIgnoredQuery(),
      "source.usda_data_type": "Branded",
      $or: [
        { normalized_upc: normalized },
        { normalized_upc_16: normalized },
      ],
    });

    if (doc) {
      console.log("[API] Lookup result: DIRECT USDA branded match for barcode", normalized);
      return res.json(doc);
    }

    // 2) Prefer the *best* Canadian doc for this UPC:
    //    - user-submitted OCR/label docs first (richer + cleaned)
    //    - then OFF/import Canadian docs
    //    This ensures the client sees the best-available representation.
    doc = await chooseBestCanadianDocForUPC(normalized);

    if (doc) {
      const userSubmitted = !!doc?.source?.user_submitted;
      const sourceType = doc?.source?.type || "";
      const tag = userSubmitted
        ? `USER-SUBMITTED (${sourceType || "unknown"})`
        : doc?.is_canadian_product
          ? "OFF/Canadian"
          : "Canadian (other)";

      console.log("[API] Lookup result:", tag, "product for barcode", normalized, "_id:", doc._id);
      return res.json(doc);
    }

    // 4) Generic safety net: any product with matching normalized_upc or normalized_upc_16
    doc = await collection.findOne({
      ...notIgnoredQuery(),
      $or: [
        { normalized_upc: normalized },
        { normalized_upc_16: normalized },
      ],
    });

    console.log("[API] Lookup result (generic fallback):", doc ? "FOUND" : "NOT FOUND");

    if (!doc) {
      return res.status(404).json({
        error: "Not found",
        normalized_upc: normalized,
      });
    }

    // IMPORTANT: we no longer promote `usda_equivalent` here.
    // Canadian/OFF or user-submitted records remain the primary document,
    // and USDA equivalents are used only as supplemental data elsewhere.
    return res.json(doc);
  } catch (err) {
    console.error("Error fetching by barcode:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

//----------------------------------------------------------------------------------------------


// GET /food-items/:id → fetch a single food_item by ObjectId (raw, unchanged)
app.get("/food-items/:id", async (req, res) => {
  try {
    if (!collection) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const { id } = req.params;

    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, error: "Invalid ObjectId" });
    }

    const item = await collection.findOne({ _id: new ObjectId(id) });

    if (!item) {
      return res.status(404).json({ ok: false, error: "Food item not found" });
    }

    // IMPORTANT: return the document completely unchanged
    return res.json({
      ok: true,
      item,
    });
  } catch (err) {
    console.error("[FoodItems/GetById] Error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to fetch food item",
      details: err && err.message ? err.message : String(err),
    });
  }
});


//--------------------------------------------------------------------------------------------------

// GET /foods/details?ids=... → fetch nutrient/details for one or more food IDs
// Usage examples:
//   /foods/details?ids=69249d5d5f482c9b7d71626e
//   /foods/details?ids=69249d5d5f482c9b7d71626e,6924a05a5f482c9b7d71923f
//   /foods/details?ids=id1&ids=id2&ids=id3
app.get("/foods/details", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        ok: false,
        error: "DB not ready",
      });
    }

    let { ids } = req.query;

    if (!ids) {
      return res.status(400).json({
        ok: false,
        error: "Missing required query parameter 'ids'.",
      });
    }

    // Allow either a single comma-separated string or repeated ?ids=...&ids=...
    if (Array.isArray(ids)) {
      ids = ids
        .flatMap((v) =>
          String(v)
            .split(",")
            .map((s) => s.trim())
        )
        .filter(Boolean);
    } else {
      ids = String(ids)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (!ids.length) {
      return res.status(400).json({
        ok: false,
        error:
          "No valid IDs provided. Pass one or more MongoDB IDs via ?ids=id1,id2,…",
      });
    }

    console.log("[FoodDetails] Incoming ids:", ids);

    const items = await getFoodDetails(db, ids);

    return res.json({
      ok: true,
      count: Array.isArray(items) ? items.length : 0,
      items: items || [],
    });
  } catch (err) {
    console.error("[FoodDetails] Error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to fetch food details.",
      details: err && err.message ? err.message : String(err),
    });
  }
});


//--------------------------------------------------------------------------------------------------------


// POST /api/meal-search
// Accepts a parsed meal JSON (from GPT meal parser) and returns best DB matches.
app.post("/api/meal-search", async (req, res) => {
  try {
    if (!db || !collection) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const parsedMeal = req.body;

    if (!parsedMeal || !Array.isArray(parsedMeal.items)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload: expected { rawText, mealType, items: [...] }",
      });
    }

    const result = await findBestMatchesForMealItems(db, parsedMeal, {
      maxPerItem: 5,
    });

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("[MealSearch] Error:", err);
    return res.status(500).json({
      ok: false,
      error: "Meal search failed",
      details: err.message || String(err),
    });
  }
});

// --- USDA candidate scoring helpers ---

function normalizeBrand(str) {
  if (!str || typeof str !== "string") return "";

  // Basic cleanup: lower-case, strip apostrophes and common company suffixes,
  // drop non-alphanumerics, normalize whitespace.
  const cleaned = str
    .toLowerCase()
    .replace(/[’']/g, "") // remove apostrophes
    .replace(/company|companies|co\.?|inc\.?|ltd\.?|llc\.?|corp\.?/gi, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  if (!cleaned) return "";

  // Extra normalization step: gently trim a trailing "s" from tokens that are
  // likely plural/possessive brand variants. This makes
  // "Campbells", "Campbell's" → "campbell", so fuzzyBrandMatches can link
  // "Campbells" to "Campbell Soup".
  const parts = cleaned.split(" ");
  const normalizedParts = parts.map((p) => {
    // Only touch reasonably long tokens so we don't break things like "ms" or "us".
    if (p.length > 3 && p.endsWith("s")) {
      return p.slice(0, -1);
    }
    return p;
  });

  return normalizedParts.join(" ");
}

function tokenizeName(str) {
  if (!str || typeof str !== "string") return [];
  return str
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !["the", "and", "of", "with", "in", "style", "brand"].includes(t));
}

function fuzzyBrandMatches(docBrand, queryBrand) {
  const docOwner = (docBrand && docBrand.owner) || "";
  const docName = (docBrand && docBrand.name) || "";
  const docNorm = normalizeBrand(docName || docOwner);
  const qNorm = normalizeBrand(queryBrand);
  if (!docNorm || !qNorm) return false;
  if (docNorm === qNorm) return true;
  return docNorm.includes(qNorm) || qNorm.includes(docNorm);
}

function computeUSDACombinedScore(doc, options) {
  const { name, brandName } = options || {};
  let score = typeof doc.score === "number" ? doc.score : 0;

  const docBrand = doc.brand || {};
  const docOwner = docBrand.owner || "";
  const docNameBrand = docBrand.name || "";
  const docBrandNorm = normalizeBrand(docNameBrand || docOwner);
  const qBrandNorm = normalizeBrand(brandName);

  // Brand match bonuses
  if (qBrandNorm && docBrandNorm) {
    if (docBrandNorm === qBrandNorm) {
      score += 20;
    } else if (docBrandNorm.includes(qBrandNorm) || qBrandNorm.includes(docBrandNorm)) {
      score += 10;
    }
  }

  const qTokens = tokenizeName(name);
  const docNameTokens = tokenizeName(doc.name || doc.normalized_name || "");
  const overlap = qTokens.filter((t) => docNameTokens.includes(t)).length;
  score += overlap * 2;

  doc._combinedScore = score;
  return score;
}

//----------------------------------------------------------------------------------------------------------------

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
      ...notIgnoredQuery(),
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

    const finalLimit =
      typeof limit === "number" && limit > 0 && limit <= 25 ? limit : 10;

    // Pull a larger candidate set from Mongo text search so we can re-rank
    // by brand + name tokens. Then we will trim back to finalLimit.
    const mongoFetchLimit = Math.min(Math.max(finalLimit * 3, finalLimit + 10), 50);

    const cursor = collection
      .find(query, { projection })
      .sort({ score: { $meta: "textScore" } })
      .limit(mongoFetchLimit);

    let results = await cursor.toArray();

    // Re-rank initial $text results using combined score
    if (results && results.length > 0) {
      results.forEach((doc) => {
        computeUSDACombinedScore(doc, { name, brandName });
      });
      results.sort((a, b) => (b._combinedScore || 0) - (a._combinedScore || 0));
    }

    // Decide whether we should run a fallback: either no results at all,
    // or nothing that even loosely matches the requested brand.
    const hasFuzzyBrandHit =
      results &&
      results.length > 0 &&
      typeof brandName === "string" &&
      results.some((doc) => fuzzyBrandMatches(doc.brand || {}, brandName));

    const shouldRunFallback =
      !results || results.length === 0 || (!hasFuzzyBrandHit && typeof brandName === "string");

    if (shouldRunFallback) {
      console.log("[USDA Candidates] Using intelligent fallback to help find brand/food match…");

      // Escape helper for building safe regex patterns
      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Keep brand and name tokens in their own "zones"
      const brandTokens =
        typeof brandName === "string" && brandName.trim().length > 0
          ? tokenizeName(brandName)
          : [];

      const nameTokens =
        typeof name === "string" && name.trim().length > 0
          ? tokenizeName(name)
          : [];

      const uniqueBrandTokens = Array.from(new Set(brandTokens));
      const uniqueNameTokens = Array.from(new Set(nameTokens));

      // Brand-zone clauses → brand.name / brand.owner
      const brandRegexClauses = [];
      for (const token of uniqueBrandTokens) {
        const r = new RegExp(escapeRegex(token), "i");
        brandRegexClauses.push({ "brand.name": r });
        brandRegexClauses.push({ "brand.owner": r });
      }

      // Name-zone clauses → name / normalized_name
      const nameRegexClauses = [];
      for (const token of uniqueNameTokens) {
        const r = new RegExp(escapeRegex(token), "i");
        nameRegexClauses.push({ name: r });
        nameRegexClauses.push({ normalized_name: r });
      }

      let fallbackQuery;

      if (brandRegexClauses.length > 0 && nameRegexClauses.length > 0) {
        // We know both a brand and a product name:
        //  - brand tokens must match brand fields
        //  - name tokens must match name fields
        fallbackQuery = {
          ...notIgnoredQuery(),
          "source.usda_data_type": "Branded",
          $and: [
            { $or: brandRegexClauses },
            { $or: nameRegexClauses },
          ],
        };
      } else if (brandRegexClauses.length > 0) {
        // Only brand is useful (e.g., "Campbells")
        fallbackQuery = {
          ...notIgnoredQuery(),
          "source.usda_data_type": "Branded",
          $or: brandRegexClauses,
        };
      } else if (nameRegexClauses.length > 0) {
        // Only name is useful (no brand provided)
        fallbackQuery = {
          ...notIgnoredQuery(),
          "source.usda_data_type": "Branded",
          $or: nameRegexClauses,
        };
      } else {
        // Nothing meaningful to search on; extremely rare, but be safe.
        fallbackQuery = {
          ...notIgnoredQuery(),
          "source.usda_data_type": "Branded",
        };
      }

      const fallbackCursor = collection
        .find(fallbackQuery, { projection: { ...projection, score: undefined } })
        .limit(mongoFetchLimit);

      const fallbackResults = await fallbackCursor.toArray();

      // Merge primary $text results with fallback, de-duplicate by _id,
      // then recompute combined scores and re-sort.
      const mergedById = new Map();

      (results || []).forEach((doc) => {
        mergedById.set(String(doc._id), doc);
      });

      fallbackResults.forEach((doc) => {
        const key = String(doc._id);
        if (!mergedById.has(key)) {
          mergedById.set(key, doc);
        }
      });

      const merged = Array.from(mergedById.values());
      merged.forEach((doc) => {
        computeUSDACombinedScore(doc, { name, brandName });
      });
      merged.sort((a, b) => (b._combinedScore || 0) - (a._combinedScore || 0));

      results = merged;
    }

    // Finally trim down to the requested limit
    if (results && results.length > finalLimit) {
      results = results.slice(0, finalLimit);
    }

    console.log(
      "[USDA Candidates] Found",
      results.length,
      "docs for searchString (after fallback if any):",
      searchString
    );

    const simplified = results.map((doc) => ({
      id: String(doc._id),
      name: doc.name,
      normalizedName: doc.normalized_name,
      normalizedUPC: doc.normalized_upc,
      normalizedUPC16: doc.normalized_upc_16 ?? doc.normalized_upc,
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


//--------------------------------------------------------------------------------------------------------------

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

    // Find the Canadian doc for this UPC.
    // Prefer a user-submitted product (from barcode+photos) if one exists,
    // otherwise fall back to the OFF-imported Canadian product.
    let canadianDoc = await collection.findOne({
      normalized_upc_16: normalizedCanadian,
      "source.user_submitted": true,
    });

    if (!canadianDoc) {
      canadianDoc = await collection.findOne({
        normalized_upc_16: normalizedCanadian,
        is_canadian_product: true,
      });
    }

    if (!canadianDoc) {
      return res.status(404).json({
        error: "Canadian product not found for given normalized UPC.",
        normalizedCanadian,
      });
    }

    console.log("[Link Canadian→USDA] Linking UPC", normalizedCanadian, "to USDA UPC", normalizedUSDA, "using doc _id:", canadianDoc._id);

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

    // After linking, merge aliases across the Canadian doc, the USDA doc,
    // and any existing OFF/Canadian example with the same UPC.
    try {
      // Look for a separate OFF/Canadian doc with the same normalized UPC,
      // excluding the current Canadian doc (which may be user-submitted).
      const offDoc = await collection.findOne({
        normalized_upc_16: normalizedCanadian,
        is_canadian_product: true,
        "source.user_submitted": { $ne: true },
        _id: { $ne: canadianDoc._id },
      });

      const canadianAlt = Array.isArray(canadianDoc.alt_names)
        ? canadianDoc.alt_names
        : [];
      const usdaAlt = Array.isArray(usdaDoc.alt_names)
        ? usdaDoc.alt_names
        : [];
      const offAlt =
        offDoc && Array.isArray(offDoc.alt_names) ? offDoc.alt_names : [];

      const mergedAltSet = new Set();

      const pushAliases = (list) => {
        for (const raw of list) {
          if (!raw) continue;
          const trimmed = String(raw).trim();
          if (!trimmed) continue;
          mergedAltSet.add(trimmed.toLowerCase());
        }
      };

      pushAliases(canadianAlt);
      pushAliases(usdaAlt);
      pushAliases(offAlt);

      const mergedAltNames = Array.from(mergedAltSet);

      const bulkOps = [];

      // Update the Canadian doc
      bulkOps.push({
        updateOne: {
          filter: { _id: canadianDoc._id },
          update: { $set: { alt_names: mergedAltNames } },
        },
      });

      // Update the USDA doc
      bulkOps.push({
        updateOne: {
          filter: { _id: usdaDoc._id },
          update: { $set: { alt_names: mergedAltNames } },
        },
      });

      // If we found a distinct OFF/Canadian doc, update it as well
      if (offDoc) {
        bulkOps.push({
          updateOne: {
            filter: { _id: offDoc._id },
            update: { $set: { alt_names: mergedAltNames } },
          },
        });
      }

      if (bulkOps.length > 0) {
        await collection.bulkWrite(bulkOps);
      }
    } catch (aliasErr) {
      console.error(
        "[Link Canadian→USDA] Error while merging alt_names across linked docs:",
        aliasErr
      );
      // Do not fail the main link operation if alias propagation fails.
    }

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
