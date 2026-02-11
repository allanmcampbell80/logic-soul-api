// server.js
import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { notIgnoredQuery, safeTrimString, hasNonEmptyArray, isLikelyDvBoilerplate, scoreCanadianDoc, normalizeNutrientsForClient, 
isBarcodeLockedParsedMealItem, normalizeBarcodeTo16, coerceUserIdValue } from "./services/utils.js";
import { findBestMatchesForMealItems, enrichMealSearchResultWithUSDAEquivalent } from "./services/mealSearch.js";
import { buildUserEnrichedDoc, ensureSimpleIngredientsFromParsedList} from "./services/enrich.js";
import { deleteUserAndAllData, ensureUser, updateUserProfile, patchUserDailyTotals, storeUserEnergySamples, 
upsertUserEnergySnapshotForDate, addRecoveryEmail, verifyRecoveryEmail, recoverAccount, findUserIdByDeviceId, isValidDateKey, dateFromDateKeyUTC, 
dateKeyFromDateUTC, addDaysDateKeyUTC, computeLogicalDateKeyFromLoggedAt, getFavoritesForRequest} from "./services/users.js";
import { logUserMeal, recomputeDailyNutritionTotals, getUserMealsForDate, deleteUserMeal} from "./services/userMeals.js";
import { getFoodDetails, attachUSDAEquivalentFoodIdToCandidates, attachUSDAEquivalentFoodIdToDoc, chooseBestCanadianDocForUPC, 
fetchBestDocForBarcode, makeBarcodeLockedCandidateFromDoc,  } from "./services/foodDetails.js";
import { getUserFavoritesByUserId, addUserFavoriteByUserId, deleteUserFavoriteByUserId,} from "./services/favorites.js";
import { storeUserCorrelationPack, runCorrelationEngineForUser, runCorrelationEngineAndPromoteForUser } from "./services/userAnalysis.js";
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

  // Best-effort indexes (do not block server startup)
  try {
    // 1) De-dupe meal inserts when clients retry (or the app re-sends) using an idempotency key.
    // Requirement: user_meals docs should include `idempotencyKey` (string).
    // This partial unique index only applies when idempotencyKey is a non-empty string.
    await db.collection("user_meals").createIndex(
      { userId: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: "uniq_user_meals_userId_idempotencyKey",
        partialFilterExpression: {
          idempotencyKey: { $type: "string", $ne: "" },
        },
      }
    );

    // 2) One totals doc per user per dateKey.
    await db.collection("user_daily_totals").createIndex(
      { userId: 1, dateKey: 1 },
      { unique: true, name: "uniq_user_daily_totals_userId_dateKey" }
    );

    // Helpful query indexes
    await db.collection("user_meals").createIndex(
      { userId: 1, dateKey: 1, loggedAt: -1 },
      { name: "idx_user_meals_userId_dateKey_loggedAt" }
    );

    console.log("Mongo indexes ensured (best-effort)");
  } catch (idxErr) {
    console.error("[Mongo] Failed to ensure indexes (best-effort):", idxErr);
  }
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


//------------------------------------------------------------------------------------------------

// DELETE /users/:id  → permanently delete user + all related data
app.delete("/users/:id", async (req, res) => {
  try {
    const userId = String(req.params?.id || "").trim();
    const result = await deleteUserAndAllData(db, userId);
    return res.json(result);
  } catch (err) {
    console.error("[Users/Delete] Error:", err);
    const status = err?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || "Failed to delete user",
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
    const userIdValue = coerceUserIdValue(userId);

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

    // --- Normalize meal items so we NEVER replace the Canadian/scanned foodId with the USDA equivalent.
    // The client may optionally provide a USDA equivalent id plus a toggle.
    // Goal:
    //  - Store the *primary* (Canadian/off/user-enriched) id in `foodId`.
    //  - Store the linked USDA id (if any) in `usdaEquivalentFoodId`.
    //  - Store the toggle in `useUSDAEquivalent`.
    // This allows recomputeDailyNutritionTotals to add confident totals from `foodId`,
    // and add only the *delta* (USDA - Canadian) to totals_estimated when toggled on.
    function normalizeMealItemsForUSDAEquivalent(payload) {
      if (!payload || typeof payload !== "object") return payload;
      const items = Array.isArray(payload.items) ? payload.items : [];

      payload.items = items.map((it) => {
        if (!it || typeof it !== "object") return it;

        // Accept a few possible client field names (older/newer clients).
        const canadianId = String(
          it.canadianFoodId ||
          it.originalFoodId ||
          it.primaryFoodId ||
          ""
        ).trim();

        const usdaEqId = String(
          it.usdaEquivalentFoodId ||
          it.usda_equivalent_food_id ||
          it.usdaEquivalentId ||
          ""
        ).trim();

        const wantsUSDA =
          it.useUSDAEquivalent === true ||
          it.useUsdaEquivalent === true ||
          it.use_usda_equivalent === true;

        // If the client provided a Canadian id, it must be the stored foodId.
        // This fixes the bug where meals were being recorded as the USDA doc.
        const storedFoodId = canadianId || (it.foodId != null ? String(it.foodId).trim() : "");

        // If the client accidentally put the USDA id into foodId while also sending canadianFoodId,
        // we correct it by forcing foodId=canadian and retaining the USDA id separately.
        const correctedFoodId = canadianId ? canadianId : storedFoodId;

        // Build a normalized item object, preserving all original fields.
        const out = {
          ...it,
          foodId: correctedFoodId || it.foodId,
        };

        // Persist linkage fields when present
        if (usdaEqId) {
          out.usdaEquivalentFoodId = usdaEqId;
          out.usda_equivalent_food_id = usdaEqId;
        }

        // Persist the toggle explicitly (default false)
        out.useUSDAEquivalent = !!wantsUSDA;
        out.useUsdaEquivalent = !!wantsUSDA;
        out.use_usda_equivalent = !!wantsUSDA;

        return out;
      });

      return payload;
    }

    normalizeMealItemsForUSDAEquivalent(payload);

    // --- Normalize quantities so calculations use canonical units (g/ml/serving) when provided.
    // The client may send BOTH:
    //  - UI quantity: quantity + quantityUnit (e.g. 3 slice)
    //  - Normalized quantity: normalizedQuantity + normalizedQuantityUnit (e.g. 36 g)
    // Rule:
    //  - If normalizedQuantity/unit is present and valid, we store the UI quantity in uiQuantity/uiQuantityUnit
    //    and replace quantity/quantityUnit with the normalized values for downstream calculations.
    //  - We also keep the normalizedQuantity* fields intact for auditing/debug.
    function normalizeMealItemsForNormalizedQuantity(payload) {
      if (!payload || typeof payload !== "object") return payload;
      const items = Array.isArray(payload.items) ? payload.items : [];

      const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

      const normalizeUnit = (u) => {
        const raw = String(u || "").trim().toLowerCase();
        if (!raw) return "";
        if (raw === "grams") return "g";
        if (raw === "milliliters" || raw === "millilitres") return "ml";
        if (raw === "servings") return "serving";
        return raw;
      };

      const isCanonicalUnit = (u) => {
        const unit = normalizeUnit(u);
        return unit === "g" || unit === "ml" || unit === "serving";
      };

      payload.items = items.map((it) => {
        if (!it || typeof it !== "object") return it;

        // Read UI quantity (support either legacy numeric fields or object form)
        const uiQty = typeof it.quantity === "object" && it.quantity
          ? (isFiniteNumber(it.quantity.value) ? it.quantity.value : null)
          : (isFiniteNumber(it.quantity) ? it.quantity : null);

        const uiUnit = typeof it.quantity === "object" && it.quantity
          ? normalizeUnit(it.quantity.unit)
          : normalizeUnit(it.quantityUnit || it.unit);

        const uiIsEstimate = typeof it.quantity === "object" && it.quantity
          ? (typeof it.quantity.isEstimate === "boolean" ? it.quantity.isEstimate : null)
          : (typeof it.quantityIsEstimate === "boolean" ? it.quantityIsEstimate : null);

        // Read normalized quantity (support either numeric flat fields or object form)
        const nQty = typeof it.normalizedQuantity === "object" && it.normalizedQuantity
          ? (isFiniteNumber(it.normalizedQuantity.value) ? it.normalizedQuantity.value : null)
          : (isFiniteNumber(it.normalizedQuantity) ? it.normalizedQuantity : null);

        const nUnit = typeof it.normalizedQuantity === "object" && it.normalizedQuantity
          ? normalizeUnit(it.normalizedQuantity.unit)
          : normalizeUnit(it.normalizedQuantityUnit || it.normalizedQuantity_unit);

        const nIsEstimate = typeof it.normalizedQuantity === "object" && it.normalizedQuantity
          ? (typeof it.normalizedQuantity.isEstimate === "boolean" ? it.normalizedQuantity.isEstimate : null)
          : (typeof it.normalizedQuantityIsEstimate === "boolean" ? it.normalizedQuantityIsEstimate : null);

        const nBasis = typeof it.normalizedQuantity === "object" && it.normalizedQuantity
          ? (it.normalizedQuantity.basis != null ? String(it.normalizedQuantity.basis) : null)
          : (it.normalizedQuantityBasis != null ? String(it.normalizedQuantityBasis) : null);

        const nConf = typeof it.normalizedQuantity === "object" && it.normalizedQuantity
          ? (isFiniteNumber(it.normalizedQuantity.confidence) ? it.normalizedQuantity.confidence : null)
          : (isFiniteNumber(it.normalizedQuantityConfidence) ? it.normalizedQuantityConfidence : null);

        // If the client gave us a canonical normalized quantity, use it for calculations.
        if (nQty != null && nUnit && isCanonicalUnit(nUnit)) {
          // Preserve UI quantity for display/audit.
          it.uiQuantity = uiQty;
          it.uiQuantityUnit = uiUnit || null;
          if (uiIsEstimate != null) it.uiQuantityIsEstimate = uiIsEstimate;

          // Force canonical quantity for downstream math.
          it.quantity = nQty;
          it.quantityUnit = normalizeUnit(nUnit);
          if (nIsEstimate != null) it.quantityIsEstimate = nIsEstimate;
          if (nBasis != null) it.quantityBasis = nBasis;
          if (nConf != null) it.quantityConfidence = nConf;

          // Also keep a structured normalizedQuantity object for persistence.
          it.normalizedQuantity = {
            value: nQty,
            unit: normalizeUnit(nUnit),
            isEstimate: nIsEstimate === true,
            basis: nBasis || "gpt",
            confidence: nConf != null ? nConf : 1,
          };

          // Mirror common legacy keys (flat) so older code can still read them.
          it.normalizedQuantityUnit = normalizeUnit(nUnit);
          it.normalizedQuantityIsEstimate = nIsEstimate === true;
          if (nBasis != null) it.normalizedQuantityBasis = nBasis;
          if (nConf != null) it.normalizedQuantityConfidence = nConf;
        }

        return it;
      });

      return payload;
    }

    normalizeMealItemsForNormalizedQuantity(payload);

    // Debug: warn if a non-canonical UI unit is provided but we did not receive a canonical normalized fallback.
    try {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const bad = items
        .map((it) => {
          const unit = String(it?.quantityUnit || it?.quantity?.unit || "").trim().toLowerCase();
          const hasNorm = !!(it?.normalizedQuantity && (it.normalizedQuantity.value != null) && it.normalizedQuantity.unit);
          const isCanonical = unit === "g" || unit === "ml" || unit === "serving";
          return !isCanonical && unit && !hasNorm ? unit : null;
        })
        .filter(Boolean);
      if (bad.length > 0) {
        console.warn("[Users/Meals] Missing normalizedQuantity fallback for non-canonical units:", bad.slice(0, 10));
      }
    } catch {
      // ignore
    }

    // Debug: trace USDA-equivalent linkage coming from the client
    try {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const toggled = items.filter((it) => it?.useUSDAEquivalent === true).length;
      const withUsdaId = items.filter((it) => !!(it?.usdaEquivalentFoodId || it?.usda_equivalent_food_id)).length;
      if (toggled > 0 || withUsdaId > 0) {
        console.log("[Users/Meals] USDA-equivalent fields:", {
          items: items.length,
          toggled,
          withUsdaId,
          sample: items.slice(0, 2).map((it) => ({
            foodId: it?.foodId,
            useUSDAEquivalent: it?.useUSDAEquivalent,
            usdaEquivalentFoodId: it?.usdaEquivalentFoodId || it?.usda_equivalent_food_id || null,
          })),
        });
      }
    } catch {
      // ignore
    }

    // Enforce logical-day dateKey (3am→3am) from now on.
    // If the client supplied a valid dateKey, we respect it.
    // Otherwise compute from loggedAt+timezone using the cutoff rule.
    const tzFromPayload = typeof payload?.timezone === "string" ? payload.timezone.trim() : "";
    const tzFromHeader = String(req.headers["x-timezone"] || req.headers["X-Timezone"] || "").trim();
    const timezone = tzFromPayload || tzFromHeader || "America/Toronto";

    // Normalize/ensure loggedAt exists (store as ISO so Mongo sorting is stable)
    const loggedAt = payload?.loggedAt ? payload.loggedAt : new Date().toISOString();
    payload.loggedAt = loggedAt;
    payload.timezone = timezone;

    if (!isValidDateKey(payload?.dateKey)) {
      payload.dateKey = computeLogicalDateKeyFromLoggedAt(loggedAt, timezone, 3);
    }

    // Helper: detect drink-water logged as a meal item
    function extractDrinkWaterMlFromPayload(payload) {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      let total = 0;
      for (const it of items) {
        const name = String(it?.name || "").trim().toLowerCase();
        const unit = String(it?.quantityUnit || it?.unit || "").trim().toLowerCase();
        const qty = typeof it?.quantity === "number" ? it.quantity : null;
        if (name === "water" && unit === "ml" && Number.isFinite(qty) && qty > 0) {
          total += qty;
        }
      }
      return total;
    }

    const drinkWaterMl = extractDrinkWaterMlFromPayload(payload);

    // 1) Log the meal itself
    const result = await logUserMeal(userIdValue, payload);

    // 1b) Increment awards tally for meals logged (best-effort; never block response)
    applyAwardEvent(db, { userId }, { eventKey: "mealsLogged", amount: 1 }).catch(
      (err) => {
        console.error("[Users/Meals] Failed to apply mealsLogged award event:", err);
      }
    );

    // 1c) Optional awards hook: drink-water logged (best-effort; never block response)
    // Note: This is a simple per-event tally (1 per water log). Daily hydration streak awards
    // should still be derived from daily totals.
    if (drinkWaterMl > 0) {
      applyAwardEvent(db, { userId }, { eventKey: "waterLogged", amount: 1 }).catch((err) => {
        console.error("[Users/Meals] Failed to apply waterLogged award event:", err);
      });
    }

    // 2) Kick off daily nutrition total recompute in the background.
    //    We don't block the response on this — it's best-effort.
    const recomputeDateKey = (result && result.dateKey) ? result.dateKey : (payload && payload.dateKey ? payload.dateKey : null);

    if (db && recomputeDateKey) {
      // IMPORTANT: use the same coerced userId type as logUserMeal (ObjectId when possible)
      recomputeDailyNutritionTotals(db, userIdValue, recomputeDateKey, timezone).catch((err) => {
        console.error(
          "[Users/Meals] Failed to recompute daily nutrition totals:",
          err
        );
      });
    } else {
      console.warn(
        "[Users/Meals] Skipping recomputeDailyNutritionTotals — missing db or dateKey",
        { hasDb: !!db, hasDateKey: !!recomputeDateKey }
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
    // user_meals.userId has historically been stored as a string.
    // Passing the raw string here avoids type-mismatch deletes.
    const userIdForDelete = String(userId);

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

    if (!isValidDateKey(dateKey)) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid required query parameter 'dateKey' (expected YYYY-MM-DD).",
      });
    }

    // Collection lives in the same DB as everything else
    const totalsCol = db.collection("user_daily_totals");

    // Use helper to coerce userId to ObjectId if needed
    const userIdValue = coerceUserIdValue(userId);

    // Energy: Snapshot today's average energy into totals, and finalize yesterday.
    // Best-effort: never fail the daily totals request if this helper fails.
    try {
      // Snapshot the requested day (often "today") so UI can render a running average.
      await upsertUserEnergySnapshotForDate(db, userIdValue, String(dateKey), { finalize: false });

      // Finalize yesterday once we are looking at today.
      const yesterdayKey = addDaysDateKeyUTC(String(dateKey), -1);
      if (isValidDateKey(yesterdayKey)) {
        await upsertUserEnergySnapshotForDate(db, userIdValue, String(yesterdayKey), { finalize: true });
      }
    } catch (energySnapErr) {
      console.error("[Users/DailyTotals] Energy snapshot/finalize failed (best-effort):", energySnapErr);
    }

    // IMPORTANT:
    // user_daily_totals.userId may be stored as an ObjectId (newer docs) OR a string (older docs).
    // Query both so the API returns totals regardless of storage type.
    const userIdFilters = [{ userId: userIdValue }];
    const userIdStr = String(userId || "").trim();
    if (userIdStr && userIdStr !== String(userIdValue)) {
      userIdFilters.push({ userId: userIdStr });
    }

    const doc = await totalsCol.findOne({
      $and: [
        { $or: userIdFilters },
        { dateKey },
      ],
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
      totals_estimated: doc.totals_estimated || {},
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
    const userIdValue = coerceUserIdValue(userId);
    const { dateKey, patch, timezone, pain_regions, painRegions, pain_details, painDetails } = req.body || {};

    // Enforce logical-day dateKey (3am→3am) from now on for check-ins.
    // If the client provided a valid dateKey, keep it. Otherwise compute from now + timezone.
    const tzCheckinRaw = typeof timezone === "string" ? timezone.trim() : "";
    const tzHeader = String(req.headers["x-timezone"] || req.headers["X-Timezone"] || "").trim();
    const tzCheckin = tzCheckinRaw || tzHeader || "America/Toronto";

    // Check-ins don't include a timestamp today, so we use 'now' for the logical-day key.
    // (Client can still explicitly send dateKey to override.)
    const dateKeyResolved = isValidDateKey(dateKey)
      ? String(dateKey)
      : computeLogicalDateKeyFromLoggedAt(new Date(), tzCheckin, 3);

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

    const result = await patchUserDailyTotals(db, userId, dateKeyResolved, patch, tzCheckin);

    // User Analysis: after each check-in update, run correlation engine + promotion (best-effort).
    // This surfaces stable insights as early as they arrive.
    try {
      if (db && result?.ok) {
        runCorrelationEngineAndPromoteForUser(db, {
          userId: String(userId),
          windowDays: 120,
          lagDays: 1,
          minSupportDays: 4,
          topK: 150,
        }).catch((uaErr) => {
          console.error("[UserAnalysis/AutoRunAfterCheckIn] Failed (best-effort):", uaErr);
        });
      }
    } catch (uaOuterErr) {
      console.error("[UserAnalysis/AutoRunAfterCheckIn] Unexpected error (best-effort):", uaOuterErr);
    }

    // Energy: whenever we patch a check-in, also snapshot the running energy average for that date.
    // Best-effort: do not fail the check-in if snapshotting fails.
    try {
      if (dateKeyResolved && isValidDateKey(String(dateKeyResolved))) {
        await upsertUserEnergySnapshotForDate(db, userIdValue, String(dateKeyResolved), { finalize: false });
      }
    } catch (energySnapErr) {
      console.error("[Users/DailyTotals/CheckIn] Energy snapshot failed (best-effort):", energySnapErr);
    }

    // Persist detailed pain region/detailed intensities (optional)
    // Stored separately from totals so we don't mix numeric totals with object fields.
    try {
      if (db && result?.ok && (painRegionsPayload || painDetailsPayload) && dateKeyResolved) {
        const totalsCol = db.collection("user_daily_totals");

        // userIdValue is already set above using coerceUserIdValue
        // (coercion already exists above)

        const setPatch = { updatedAt: new Date() };
        if (painRegionsPayload) setPatch["checkin.pain_regions"] = painRegionsPayload;
        if (painDetailsPayload) setPatch["checkin.pain_details"] = painDetailsPayload;

        await totalsCol.updateOne(
          { userId: userIdValue, dateKey: String(dateKeyResolved) },
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
      if (db && result?.ok && dateKeyResolved && ObjectId.isValid(String(userId))) {
        const usersCol = db.collection("users");

        // De-dupe per dateKey so edits don't double-count
        const dedupe = await usersCol.updateOne(
          { _id: new ObjectId(String(userId)), dailyCheckinDateKeys: { $ne: String(dateKeyResolved) } },
          { $addToSet: { dailyCheckinDateKeys: String(dateKeyResolved) } }
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

//------------------------------------------------------------------------------------------------------------
// POST /users/:id/daily-totals/energy-samples
// Body: { dateKey: "YYYY-MM-DD", samples: [{ ts: number, level: number }], timezone?: "America/Toronto" }
// Appends cleaned energy samples to checkin.energy_samples and updates derived totals.
app.post("/users/:id/daily-totals/energy-samples", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userId = String(req.params?.id || "").trim();
    const userIdValue = coerceUserIdValue(userId);
    if (!userId) {
      return res.status(400).json({ ok: false, error: "Missing required path parameter ':id' (userId)." });
    }

    const { dateKey, samples, timezone } = req.body || {};

    // Enforce logical-day dateKey (3am→3am) from now on for energy samples.
    // If a valid dateKey is provided, keep it. Otherwise compute from the latest sample ts (or now) + timezone.
    const tzEnergyRaw = typeof timezone === "string" ? timezone.trim() : "";
    const tzHeaderEnergy = String(req.headers["x-timezone"] || req.headers["X-Timezone"] || "").trim();
    const tzEnergy = tzEnergyRaw || tzHeaderEnergy || "America/Toronto";

    // dateKey is optional going forward; if missing/invalid we compute it below.

    // Accept either an array of samples or a single sample object
    let samplesArr = [];
    if (Array.isArray(samples)) {
      samplesArr = samples;
    } else if (samples && typeof samples === "object") {
      samplesArr = [samples];
    }

    if (!Array.isArray(samplesArr) || samplesArr.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Missing required field 'samples' (expected a non-empty array).",
      });
    }

    // Pick the latest sample timestamp as the best representation of "when" this batch belongs.
    const latestTs = samplesArr.reduce((acc, s) => {
      const ts = typeof s?.ts === "number" && Number.isFinite(s.ts) ? s.ts : null;
      if (ts == null) return acc;
      return acc == null ? ts : Math.max(acc, ts);
    }, null);

    const dateKeyResolved = isValidDateKey(dateKey)
      ? String(dateKey)
      : computeLogicalDateKeyFromLoggedAt(
          latestTs != null ? new Date(latestTs) : new Date(),
          tzEnergy,
          3
        );

    const tz = tzEnergy; // keep existing service signature (string or null)

    const result = await storeUserEnergySamples(db, userIdValue, String(dateKeyResolved), samplesArr, tz);
    // Energy: after storing samples, snapshot the running average into totals.
    try {
      await upsertUserEnergySnapshotForDate(db, userIdValue, String(dateKeyResolved), { finalize: false });
    } catch (energySnapErr) {
      console.error("[Users/DailyTotals/EnergySamples] Energy snapshot failed (best-effort):", energySnapErr);
    }
    return res.json(result);
  } catch (err) {
    console.error("[Users/DailyTotals/EnergySamples] Error:", err);
    const status = err?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || "Failed to store energy samples",
    });
  }
});


//-------------------------------------------------------------------------------------------------------

// DEBUG: GET /user-analysis/debug-window?userId=...&windowDays=30&lagDays=1
// Returns which days exist in user_daily_totals and whether they have the required outputs to form lagged pairs.
app.get("/user-analysis/debug-window", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready" });

    const userIdRaw = String(req.query?.userId || "").trim();
    if (!userIdRaw) return res.status(400).json({ ok: false, error: "Missing required query param 'userId'." });

    const windowDaysRaw = req.query?.windowDays;
    const lagDaysRaw = req.query?.lagDays;

    const windowDays =
      typeof windowDaysRaw === "string" && /^[0-9]+$/.test(windowDaysRaw)
        ? Math.min(Math.max(parseInt(windowDaysRaw, 10), 2), 365)
        : 30;

    const lagDays =
      typeof lagDaysRaw === "string" && /^[0-9]+$/.test(lagDaysRaw)
        ? Math.min(Math.max(parseInt(lagDaysRaw, 10), 0), 14)
        : 1;

    const totalsCol = db.collection("user_daily_totals");

    // Query both ObjectId + string userId variants
    const userIdValue = coerceUserIdValue(userIdRaw);
    const userIdFilters = [{ userId: userIdValue }];
    const userIdStr = String(userIdRaw);
    if (userIdStr && userIdStr !== String(userIdValue)) {
      userIdFilters.push({ userId: userIdStr });
    }

    // Pull the most recent windowDays docs (dateKey is YYYY-MM-DD; lexicographic sort works)
    const docs = await totalsCol
      .find({ $or: userIdFilters }, { projection: { dateKey: 1, timezone: 1, totals: 1, updatedAt: 1, createdAt: 1 } })
      .sort({ dateKey: -1 })
      .limit(windowDays + lagDays + 2)
      .toArray();

    const byDateKey = new Map();
    for (const d of docs || []) {
      if (!d?.dateKey) continue;
      byDateKey.set(String(d.dateKey), d);
    }

    const dateKeys = Array.from(byDateKey.keys()).sort();

    const hasOutput = (totals) => {
      const t = totals || {};
      const mood = t.checkin_mood;
      const clarity = t.checkin_clarity_score;
      const painPeak = t.checkin_pain_peak;
      const outside = t.checkin_outside_minutes;
      const exercise = t.checkin_exercise;

      // Consider the day “output-ready” if any check-in signal exists.
      return (
        (typeof mood === "number" && Number.isFinite(mood)) ||
        (typeof clarity === "number" && Number.isFinite(clarity)) ||
        (typeof painPeak === "number" && Number.isFinite(painPeak)) ||
        (typeof outside === "number" && Number.isFinite(outside)) ||
        (typeof exercise === "number" && Number.isFinite(exercise))
      );
    };

    const hasInput = (totals) => {
      const t = totals || {};
      const energy = t.energy_kcal;
      const protein = t.protein_g;
      const carbs = t.carbs_g;
      const fat = t.fat_g;
      const weather = t.weather_temp_c;

      // Consider the day “input-ready” if any nutrition or weather signal exists.
      return (
        (typeof energy === "number" && Number.isFinite(energy) && energy > 0) ||
        (typeof protein === "number" && Number.isFinite(protein) && protein > 0) ||
        (typeof carbs === "number" && Number.isFinite(carbs) && carbs > 0) ||
        (typeof fat === "number" && Number.isFinite(fat) && fat > 0) ||
        (typeof weather === "number" && Number.isFinite(weather))
      );
    };

    const days = dateKeys.map((k) => {
      const d = byDateKey.get(k);
      const totals = d?.totals || {};
      return {
        dateKey: k,
        hasInput: hasInput(totals),
        hasOutput: hasOutput(totals),
        mood: totals.checkin_mood ?? null,
        painPeak: totals.checkin_pain_peak ?? null,
        clarity: totals.checkin_clarity_score ?? null,
        energy_kcal: totals.energy_kcal ?? null,
        outsideMin: totals.checkin_outside_minutes ?? null,
        updatedAt: d?.updatedAt ?? null,
        createdAt: d?.createdAt ?? null,
      };
    });

    // Build lagged pairs DayT -> Day(T+lagDays)
    const pairs = [];
    for (let i = 0; i < dateKeys.length; i++) {
      const kIn = dateKeys[i];
      const kOut = addDaysDateKeyUTC(kIn, lagDays);
      if (!byDateKey.has(kOut)) continue;
      const dIn = byDateKey.get(kIn);
      const dOut = byDateKey.get(kOut);

      const inOk = hasInput(dIn?.totals);
      const outOk = hasOutput(dOut?.totals);
      pairs.push({ inputDateKey: kIn, outputDateKey: kOut, inOk, outOk, ok: inOk && outOk });
    }

    const okPairs = pairs.filter((p) => p.ok);

    return res.json({
      ok: true,
      userId: userIdRaw,
      windowDays,
      lagDays,
      dayCount: days.length,
      pairCount: pairs.length,
      okPairCount: okPairs.length,
      days,
      pairs,
    });
  } catch (err) {
    console.error("[UserAnalysis/DebugWindow] Error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to debug window" });
  }
});

// GET /users/:id/correlations
// Returns user-facing (surfaced) correlations from `user_correlations`.
// Query params:
//   - surfacedOnly (default "true"): when true, only returns isSurfaced=true
//   - limit (default 50, max 200)
//   - includeAll (default "false"): when true, returns all correlations (surfaced + unsurfaced)
app.get("/users/:id/correlations", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const userIdRaw = String(req.params?.id || "").trim();
    if (!userIdRaw || !ObjectId.isValid(userIdRaw)) {
      return res.status(400).json({ ok: false, error: "Missing or invalid ':id' (userId)." });
    }

    const userIdValue = coerceUserIdValue(userIdRaw);

    const surfacedOnlyParam = String(req.query?.surfacedOnly ?? "true").trim().toLowerCase();
    const includeAllParam = String(req.query?.includeAll ?? "false").trim().toLowerCase();

    const includeAll = includeAllParam === "true" || includeAllParam === "1";
    const surfacedOnly = includeAll ? false : !(surfacedOnlyParam === "false" || surfacedOnlyParam === "0");

    const limitRaw = req.query?.limit;
    const limit =
      typeof limitRaw === "string" && /^[0-9]+$/.test(limitRaw)
        ? Math.min(Math.max(parseInt(limitRaw, 10), 1), 200)
        : 50;

    const col = db.collection("user_correlations");

    // user_correlations.userId is stored as ObjectId in the promotion layer.
    // For safety, we query both ObjectId + string representations.
    const userIdFilters = [{ userId: userIdValue }];
    const userIdStr = String(userIdRaw);
    if (userIdStr && userIdStr !== String(userIdValue)) {
      userIdFilters.push({ userId: userIdStr });
    }

    const filter = {
      $and: [
        { $or: userIdFilters },
        ...(surfacedOnly ? [{ isSurfaced: true }] : []),

        // Only return complete correlation rows (avoid legacy/placeholder docs)
        { inputKey: { $exists: true, $type: "string", $ne: "" } },
        { outputKey: { $exists: true, $type: "string", $ne: "" } },
      ],
    };

    // Return newest surfaced first; tie-break by absolute strength.
    // NOTE: abs sort is done in JS (Mongo sort can't do abs without pipeline).
    const docs = await col
      .find(filter, {
        projection: {
          userId: 1,
          inputKey: 1,
          outputKey: 1,
          mode: 1,
          lagDays: 1,
          direction: 1,
          strength: 1,
          n: 1,
          nEvent: 1,
          nNonEvent: 1,
          meanEvent: 1,
          meanNonEvent: 1,
          threshold: 1,
          delta: 1,
          seenCount: 1,
          confirmStreak: 1,
          isSurfaced: 1,
          surfacedAt: 1,
          surfacedDateKey: 1,
          firstSeenDateKey: 1,
          lastSeenDateKey: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .sort({ surfacedAt: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();

    const items = (docs || []).map((d) => {
      const out = { ...d };
      // Normalize ObjectId for clients
      if (out && out._id) out.id = String(out._id);
      if (out && out.userId && typeof out.userId === "object") out.userId = String(out.userId);
      delete out._id;
      return out;
    });

    // Secondary sort by abs(strength) while preserving surfacedAt recency bias.
    items.sort((a, b) => {
      const aSurf = a?.surfacedAt ? new Date(a.surfacedAt).getTime() : 0;
      const bSurf = b?.surfacedAt ? new Date(b.surfacedAt).getTime() : 0;
      if (bSurf !== aSurf) return bSurf - aSurf;
      const aAbs = Math.abs(typeof a?.strength === "number" ? a.strength : Number(a?.strength) || 0);
      const bAbs = Math.abs(typeof b?.strength === "number" ? b.strength : Number(b?.strength) || 0);
      return bAbs - aAbs;
    });

    return res.json({ ok: true, userId: userIdRaw, count: items.length, items });
  } catch (err) {
    console.error("[Users/Correlations/List] Error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to fetch correlations" });
  }
});

//----------------------------------------------------------------------------------------------------------------------------

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

// POST /user-analysis/run-correlation-engine
// Server-side longitudinal correlation engine (lag-1 / next-day effects)
// Body: { userId: string, windowDays?: number, minSupportDays?: number, topK?: number }
app.post("/user-analysis/run-correlation-engine", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready" });

    const userId = String(req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "Missing required field 'userId'." });

    const windowDaysRaw = req.body?.windowDays;
    const minSupportDaysRaw = req.body?.minSupportDays;
    const topKRaw = req.body?.topK;

    const windowDays =
      typeof windowDaysRaw === "number" && Number.isFinite(windowDaysRaw) && windowDaysRaw > 7 && windowDaysRaw <= 365
        ? Math.trunc(windowDaysRaw)
        : 120;

    const minSupportDays =
      typeof minSupportDaysRaw === "number" && Number.isFinite(minSupportDaysRaw) && minSupportDaysRaw >= 2 && minSupportDaysRaw <= 30
        ? Math.trunc(minSupportDaysRaw)
        : 4;

    const topK =
      typeof topKRaw === "number" && Number.isFinite(topKRaw) && topKRaw >= 10 && topKRaw <= 500
        ? Math.trunc(topKRaw)
        : 150;

    const result = await runCorrelationEngineAndPromoteForUser(db, {
      userId,
      windowDays,
      lagDays: 1,
      minSupportDays,
      topK,
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[UserAnalysis/RunCorrelationEngine] Error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to run correlation engine" });
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
      if (Array.isArray(doc.nutrients)) {
        doc.nutrients = normalizeNutrientsForClient(doc.nutrients);
      }
      console.log("[API] Lookup result: DIRECT USDA branded match for barcode", normalized);
      return res.json(doc);
    }

    // 2) Prefer the *best* Canadian doc for this UPC:
    //    - user-submitted OCR/label docs first (richer + cleaned)
    //    - then OFF/import Canadian docs
    //    This ensures the client sees the best-available representation.
    doc = await chooseBestCanadianDocForUPC(db, normalized);

    if (doc) {
      if (Array.isArray(doc.nutrients)) {
        doc.nutrients = normalizeNutrientsForClient(doc.nutrients);
      }
      const userSubmitted = !!doc?.source?.user_submitted;
      const sourceType = doc?.source?.type || "";
      const tag = userSubmitted
        ? `USER-SUBMITTED (${sourceType || "unknown"})`
        : doc?.is_canadian_product
          ? "OFF/Canadian"
          : "Canadian (other)";

      console.log("[API] Lookup result:", tag, "product for barcode", normalized, "_id:", doc._id);
      doc = await attachUSDAEquivalentFoodIdToDoc(db, doc);
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
    if (doc && Array.isArray(doc.nutrients)) {
      doc.nutrients = normalizeNutrientsForClient(doc.nutrients);
    }
    doc = await attachUSDAEquivalentFoodIdToDoc(db, doc);
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
app.get("/foods/details", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    let { ids } = req.query;

    if (!ids) {
      return res.status(400).json({ ok: false, error: "Missing required query parameter 'ids'." });
    }

    // Allow either a single comma-separated string or repeated ?ids=...&ids=...
    if (Array.isArray(ids)) {
      ids = ids
        .flatMap((v) => String(v).split(",").map((s) => s.trim()))
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
        error: "No valid IDs provided. Pass one or more MongoDB IDs via ?ids=id1,id2,…",
      });
    }

    console.log("[FoodDetails] Incoming ids:", ids);

    // Service layer owns projections/mapping/ordering (including OFF nutrient fallbacks)
    const result = await getFoodDetails(db, ids);

    // Support either a raw array return or an object with `items`
    const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];

    return res.json({
      ok: true,
      count: items.length,
      items,
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

    const { favoriteFoodIds, favoriteMeta, favoriteDocs } = await getFavoritesForRequest(db, req);

    let result = await findBestMatchesForMealItems(db, parsedMeal, {
      mode: "fast",
      maxPerItem: 5,
      favoriteFoodIds,
      favoriteMeta,
      favoriteDocs,
    });

    result = await enrichMealSearchResultWithUSDAEquivalent(db, result);

    // --- Barcode override: barcode-confirmed items are authoritative and must not be replaced by favorites.
    // We forcibly set the top candidate to the barcode lookup result.
    try {
      const parsedItems = Array.isArray(parsedMeal?.items) ? parsedMeal.items : [];
      const outItems = Array.isArray(result?.items) ? result.items : [];

      const overrideJobs = [];
      for (let i = 0; i < parsedItems.length && i < outItems.length; i++) {
        const pIt = parsedItems[i];
        if (!isBarcodeLockedParsedMealItem(pIt)) continue;

        const barcode16 = normalizeBarcodeTo16(pIt.barcode || pIt.upc || "");
        if (!barcode16) continue;

        overrideJobs.push(
          (async () => {
            const doc = await fetchBestDocForBarcode(db, barcode16);
            if (!doc) return;

            const cand = makeBarcodeLockedCandidateFromDoc(doc, barcode16);
            if (!cand) return;

            // Mutate the existing result item in place.
            const rIt = outItems[i];
            if (rIt && typeof rIt === "object") {
              rIt.candidates = [cand];
              // Common shapes used by clients/services
              if ("best" in rIt) rIt.best = cand;
              if ("bestCandidate" in rIt) rIt.bestCandidate = cand;
              if ("chosen" in rIt) rIt.chosen = cand;
              if ("chosenId" in rIt) rIt.chosenId = cand.id;
              if ("foodId" in rIt) rIt.foodId = cand.id;
              if ("id" in rIt && !rIt.id) rIt.id = cand.id;

              // Optional debug/flags
              rIt.is_barcode_confirmed = true;
              rIt.isBarcodeConfirmed = true;
              rIt.barcode = barcode16;
            }
          })()
        );
      }

      if (overrideJobs.length > 0) {
        await Promise.all(overrideJobs);
      }
    } catch (barcodeOverrideErr) {
      console.error("[MealSearch] Barcode override failed (best-effort):", barcodeOverrideErr);
    }

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

//--------------------------------------------------------------------------------------------------

// POST /api/meal-search/options
// Accepts a single parsed meal item and returns a larger set of DB matches.
// Intended for the client "Edit" flow (lazy-load alternatives).
// Body: { rawText?: string, mealType?: string, item: { originalPhrase, canonicalName, kind?, mealType? } }
app.post("/api/meal-search/options", async (req, res) => {
  try {
    if (!db || !collection) {
      return res.status(500).json({ ok: false, error: "DB not ready" });
    }

    const body = req.body || {};
    const item = body.item;

    if (!item || typeof item !== "object") {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload: expected { rawText?, mealType?, item: { originalPhrase, canonicalName, ... } }",
      });
    }

    const originalPhrase = String(item.originalPhrase || "").trim();
    const canonicalName = String(item.canonicalName || "").trim();
    const kind = item.kind != null ? String(item.kind).trim() : null;

    if (!originalPhrase || !canonicalName) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload: item.originalPhrase and item.canonicalName are required",
      });
    }

    const parsedMeal = {
      rawText: body.rawText != null ? String(body.rawText) : null,
      mealType: body.mealType != null ? String(body.mealType) : null,
      items: [
        {
          originalPhrase,
          canonicalName,
          kind,
          // allow per-item override, else fall back to top-level mealType
          mealType: item.mealType != null ? String(item.mealType) : (body.mealType != null ? String(body.mealType) : null),
        },
      ],
    };

    const { favoriteFoodIds, favoriteMeta, favoriteDocs } = await getFavoritesForRequest(db, req);

    // Options call is allowed to be broader. Keep a sane cap.
    let result = await findBestMatchesForMealItems(db, parsedMeal, {
      mode: "options",
      maxPerItem: 40,
      favoriteFoodIds,
      favoriteMeta,
      favoriteDocs,
    });

    result = await enrichMealSearchResultWithUSDAEquivalent(db, result);

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("[MealSearch/Options] Error:", err);
    return res.status(500).json({
      ok: false,
      error: "Meal search options failed",
      details: err?.message || String(err),
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

    // ------------------------------------------------------------------
    // Server-side gating: only run USDA candidate search when we have a
    // user-enriched Canadian base product for this barcode.
    //
    // Why: We do NOT want to link USDA data to an OFF/import doc. The iOS
    // app already tries to gate this, but we also enforce it here so we
    // don't waste cycles or accidentally return candidates too early.
    //
    // The client can pass either `barcode` (raw) or `normalizedUPC16`.
    // If neither is provided, we fall back to the old behavior.
    // ------------------------------------------------------------------
    const rawBarcode = typeof req.body?.barcode === "string" ? req.body.barcode : null;
    const rawNormalizedUPC16 = typeof req.body?.normalizedUPC16 === "string" ? req.body.normalizedUPC16 : null;

    const barcodeDigits = rawBarcode ? String(rawBarcode).replace(/\D/g, "") : "";
    const normalizedUPC16 = rawNormalizedUPC16
      ? String(rawNormalizedUPC16).replace(/\D/g, "").padStart(16, "0")
      : (barcodeDigits ? barcodeDigits.padStart(16, "0") : "");

    if (normalizedUPC16) {
      // A USDA branded doc can share the same UPC; we specifically require
      // a Canadian user-enriched base doc (source.user_submitted === true).
      const baseUserEnriched = await collection.findOne({
        ...notIgnoredQuery(),
        normalized_upc_16: normalizedUPC16,
        "source.user_submitted": true,
      }, { projection: { _id: 1 } });

      if (!baseUserEnriched) {
        console.log(
          "[USDA Candidates] Skipping candidate search (base not user-enriched) for normalizedUPC16:",
          normalizedUPC16
        );
        return res.json({
          ok: true,
          count: 0,
          candidates: [],
          searchString: null,
          skipped: true,
          reason: "base_not_user_enriched",
          normalizedUPC16,
        });
      }
    }

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
    const usdaMongoId = usdaDoc?._id ? String(usdaDoc._id) : null;

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
            food_id: usdaMongoId && ObjectId.isValid(usdaMongoId) ? new ObjectId(usdaMongoId) : null,
          },
        },
      }
    );

    console.log("[Link Canadian→USDA] Stored usda_equivalent.food_id:", usdaMongoId);

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
