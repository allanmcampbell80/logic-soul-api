// services/foodDetails.js
import { ObjectId } from "mongodb";
import { notIgnoredQuery, scoreCanadianDoc, normalizeNutrientsForClient } from "./utils.js";

// --- OFF nutriments → normalized nutrients[] fallback ---

function toNumberOrNull(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickFirstNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) {
      const n = toNumberOrNull(obj[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

function buildOffNutrientsArray(off) {
  if (!off || typeof off !== "object") return [];

  // OFF is inconsistent: values may be per 100g or per serving, and units vary.
  // We prefer true per-100g and true per-serving values when available.
  // If only per-serving exists, we still mirror it into per_100g as a conservative fallback
  // (to avoid hard rejects / empty nutrition), while keeping per_serving populated.

  const nutrients = [];

  function addOffNutrient({ key, display_name, unit, per100gKeys, perServingKeys, normalize }) {
    let per100g = pickFirstNumber(off, per100gKeys);
    let perServing = pickFirstNumber(off, perServingKeys);

    if (typeof normalize === "function") {
      if (per100g !== null) per100g = normalize(per100g);
      if (perServing !== null) perServing = normalize(perServing);
    }

    // Removed fallback: do not mirror per_serving into per_100g.

    if (per100g === null && perServing === null) return;

    nutrients.push({
      key,
      display_name,
      unit,
      per_100g: per100g,
      per_serving: perServing,
      source: "off",
      data_quality: "off",
      confidence: 0.6,
    });
  }

  // --- Unit normalizers (heuristics) ---
  const gToMgIfSmall = (v) => (v <= 10 ? v * 1000 : v); // e.g. 0.33 g -> 330 mg
  const gToMgIfTiny = (v) => (v <= 1 ? v * 1000 : v); // e.g. 0.012 g -> 12 mg
  const gToUgIfTiny = (v) => (v <= 1 ? v * 1_000_000 : v); // e.g. 0.00009 g -> 90 µg

  // Energy (kcal)
  addOffNutrient({
    key: "energy_kcal",
    display_name: "Energy",
    unit: "kcal",
    per100gKeys: ["energy-kcal_100g"],
    perServingKeys: ["energy-kcal_serving"],
  });

  // Protein (g)
  addOffNutrient({
    key: "protein",
    display_name: "Protein",
    unit: "g",
    per100gKeys: ["proteins_100g"],
    perServingKeys: ["proteins_serving"],
  });

  // Carbs (g)
  addOffNutrient({
    key: "carbohydrate",
    display_name: "Carbohydrate",
    unit: "g",
    per100gKeys: ["carbohydrates_100g"],
    perServingKeys: ["carbohydrates_serving"],
  });

  // Fat (g)
  addOffNutrient({
    key: "total_lipid_fat",
    display_name: "Total lipid (fat)",
    unit: "g",
    per100gKeys: ["fat_100g"],
    perServingKeys: ["fat_serving"],
  });

  // Sugars (g)
  addOffNutrient({
    key: "total_sugars",
    display_name: "Total Sugars",
    unit: "g",
    per100gKeys: ["sugars_100g"],
    perServingKeys: ["sugars_serving"],
  });

  // Fiber (g)
  addOffNutrient({
    key: "fiber",
    display_name: "Fiber, total dietary",
    unit: "g",
    per100gKeys: ["fiber_100g"],
    perServingKeys: ["fiber_serving"],
  });

  // Sodium (mg)
  addOffNutrient({
    key: "sodium",
    display_name: "Sodium, Na",
    unit: "mg",
    per100gKeys: ["sodium_100g"],
    perServingKeys: ["sodium_serving"],
    normalize: gToMgIfSmall,
  });

  // Saturated fat (g)
  addOffNutrient({
    key: "saturated_fat",
    display_name: "Saturated fat",
    unit: "g",
    per100gKeys: ["saturated-fat_100g"],
    perServingKeys: ["saturated-fat_serving"],
  });

  // Salt (g)
  addOffNutrient({
    key: "salt",
    display_name: "Salt",
    unit: "g",
    per100gKeys: ["salt_100g"],
    perServingKeys: ["salt_serving"],
  });

  // Potassium (mg)
  addOffNutrient({
    key: "potassium",
    display_name: "Potassium, K",
    unit: "mg",
    per100gKeys: ["potassium_100g"],
    perServingKeys: ["potassium_serving"],
    normalize: gToMgIfSmall,
  });

  // Calcium (mg)
  addOffNutrient({
    key: "calcium",
    display_name: "Calcium, Ca",
    unit: "mg",
    per100gKeys: ["calcium_100g"],
    perServingKeys: ["calcium_serving"],
    normalize: gToMgIfSmall,
  });

  // Iron (mg)
  addOffNutrient({
    key: "iron",
    display_name: "Iron, Fe",
    unit: "mg",
    per100gKeys: ["iron_100g"],
    perServingKeys: ["iron_serving"],
    normalize: gToMgIfTiny,
  });

  // Vitamin C (mg)
  addOffNutrient({
    key: "vitamin_c",
    display_name: "Vitamin C",
    unit: "mg",
    per100gKeys: ["vitamin-c_100g"],
    perServingKeys: ["vitamin-c_serving"],
    normalize: gToMgIfTiny,
  });

  // Vitamin A (µg)
  addOffNutrient({
    key: "vitamin_a",
    display_name: "Vitamin A",
    unit: "µg",
    per100gKeys: ["vitamin-a_100g"],
    perServingKeys: ["vitamin-a_serving"],
    normalize: gToUgIfTiny,
  });

  // --- Extra fallbacks for older OFF shapes ---
  // Some OFF records may only have non-suffixed keys (e.g. "proteins") or *_value.
  // If we still have nothing for a given nutrient, try those as a last resort.

  if (!nutrients.some((n) => n.key === "energy_kcal")) {
    addOffNutrient({
      key: "energy_kcal",
      display_name: "Energy",
      unit: "kcal",
      per100gKeys: ["energy-kcal_100g", "energy-kcal", "energy_value"],
      perServingKeys: ["energy-kcal_serving", "energy-kcal", "energy_value"],
    });
  }

  if (!nutrients.some((n) => n.key === "protein")) {
    addOffNutrient({
      key: "protein",
      display_name: "Protein",
      unit: "g",
      per100gKeys: ["proteins_100g", "proteins", "proteins_value"],
      perServingKeys: ["proteins_serving", "proteins", "proteins_value"],
    });
  }

  if (!nutrients.some((n) => n.key === "carbohydrate")) {
    addOffNutrient({
      key: "carbohydrate",
      display_name: "Carbohydrate",
      unit: "g",
      per100gKeys: ["carbohydrates_100g", "carbohydrates", "carbohydrates_value"],
      perServingKeys: ["carbohydrates_serving", "carbohydrates", "carbohydrates_value"],
    });
  }

  if (!nutrients.some((n) => n.key === "total_lipid_fat")) {
    addOffNutrient({
      key: "total_lipid_fat",
      display_name: "Total lipid (fat)",
      unit: "g",
      per100gKeys: ["fat_100g", "fat", "fat_value"],
      perServingKeys: ["fat_serving", "fat", "fat_value"],
    });
  }

  if (!nutrients.some((n) => n.key === "total_sugars")) {
    addOffNutrient({
      key: "total_sugars",
      display_name: "Total Sugars",
      unit: "g",
      per100gKeys: ["sugars_100g", "sugars", "sugars_value"],
      perServingKeys: ["sugars_serving", "sugars", "sugars_value"],
    });
  }

  if (!nutrients.some((n) => n.key === "fiber")) {
    addOffNutrient({
      key: "fiber",
      display_name: "Fiber, total dietary",
      unit: "g",
      per100gKeys: ["fiber_100g", "fiber", "fiber_value"],
      perServingKeys: ["fiber_serving", "fiber", "fiber_value"],
    });
  }

  if (!nutrients.some((n) => n.key === "sodium")) {
    addOffNutrient({
      key: "sodium",
      display_name: "Sodium, Na",
      unit: "mg",
      per100gKeys: ["sodium_100g", "sodium", "sodium_value"],
      perServingKeys: ["sodium_serving", "sodium", "sodium_value"],
      normalize: gToMgIfSmall,
    });
  }

  if (!nutrients.some((n) => n.key === "saturated_fat")) {
    addOffNutrient({
      key: "saturated_fat",
      display_name: "Saturated fat",
      unit: "g",
      per100gKeys: ["saturated-fat_100g", "saturated-fat", "saturated-fat_value"],
      perServingKeys: ["saturated-fat_serving", "saturated-fat", "saturated-fat_value"],
    });
  }

  if (!nutrients.some((n) => n.key === "salt")) {
    addOffNutrient({
      key: "salt",
      display_name: "Salt",
      unit: "g",
      per100gKeys: ["salt_100g", "salt", "salt_value"],
      perServingKeys: ["salt_serving", "salt", "salt_value"],
    });
  }

  if (!nutrients.some((n) => n.key === "potassium")) {
    addOffNutrient({
      key: "potassium",
      display_name: "Potassium, K",
      unit: "mg",
      per100gKeys: ["potassium_100g", "potassium", "potassium_value"],
      perServingKeys: ["potassium_serving", "potassium", "potassium_value"],
      normalize: gToMgIfSmall,
    });
  }

  if (!nutrients.some((n) => n.key === "calcium")) {
    addOffNutrient({
      key: "calcium",
      display_name: "Calcium, Ca",
      unit: "mg",
      per100gKeys: ["calcium_100g", "calcium", "calcium_value"],
      perServingKeys: ["calcium_serving", "calcium", "calcium_value"],
      normalize: gToMgIfSmall,
    });
  }

  if (!nutrients.some((n) => n.key === "iron")) {
    addOffNutrient({
      key: "iron",
      display_name: "Iron, Fe",
      unit: "mg",
      per100gKeys: ["iron_100g", "iron", "iron_value"],
      perServingKeys: ["iron_serving", "iron", "iron_value"],
      normalize: gToMgIfTiny,
    });
  }

  if (!nutrients.some((n) => n.key === "vitamin_c")) {
    addOffNutrient({
      key: "vitamin_c",
      display_name: "Vitamin C",
      unit: "mg",
      per100gKeys: ["vitamin-c_100g", "vitamin-c", "vitamin-c_value"],
      perServingKeys: ["vitamin-c_serving", "vitamin-c", "vitamin-c_value"],
      normalize: gToMgIfTiny,
    });
  }

  if (!nutrients.some((n) => n.key === "vitamin_a")) {
    addOffNutrient({
      key: "vitamin_a",
      display_name: "Vitamin A",
      unit: "µg",
      per100gKeys: ["vitamin-a_100g", "vitamin-a", "vitamin-a_value"],
      perServingKeys: ["vitamin-a_serving", "vitamin-a", "vitamin-a_value"],
      normalize: gToUgIfTiny,
    });
  }

  return nutrients;
}

function ensureNutrientsFallback(doc) {
  const hasNutrients = Array.isArray(doc?.nutrients) && doc.nutrients.length > 0;
  const base = hasNutrients ? doc.nutrients : [];

  const off = doc?.off_nutriments;
  const derived = buildOffNutrientsArray(off);

  // If we have no derived OFF nutrients, just return what we already have.
  if (!Array.isArray(derived) || derived.length === 0) {
    return base;
  }

  // If there are no existing nutrients, use the derived OFF nutrients.
  if (!hasNutrients) {
    return derived;
  }

  // Merge: prefer existing values, but fill missing per_serving/per_100g from OFF when available.
  const byKey = new Map();
  for (const n of base) {
    const k = n?.key;
    if (k) byKey.set(k, n);
  }

  for (const offN of derived) {
    const k = offN?.key;
    if (!k) continue;

    const existing = byKey.get(k);
    if (!existing) {
      base.push(offN);
      byKey.set(k, offN);
      continue;
    }

    // Fill missing numbers only (do not overwrite).
    if ((existing.per_100g === null || existing.per_100g === undefined) && offN.per_100g !== null && offN.per_100g !== undefined) {
      existing.per_100g = offN.per_100g;
    }
    if ((existing.per_serving === null || existing.per_serving === undefined) && offN.per_serving !== null && offN.per_serving !== undefined) {
      existing.per_serving = offN.per_serving;
    }

    // Also fill metadata if missing.
    if (!existing.source && offN.source) existing.source = offN.source;
    if (!existing.data_quality && offN.data_quality) existing.data_quality = offN.data_quality;
    if ((existing.confidence === null || existing.confidence === undefined) && typeof offN.confidence === "number") {
      existing.confidence = offN.confidence;
    }
  }

  return base;
}

/**
 * Fetch details for one or more foods by Mongo _id.
 *
 * The goal is to:
 * - Return a lean, predictable shape for the iOS app.
 * - Keep all nutrient math on the client (per-user portion).
 * - Preserve per_100g from USDA (or other sources) as the canonical baseline.
 */
export async function getFoodDetails(db, ids) {
  const collection = db.collection(process.env.MONGODB_COLLECTION_FOODS);

  // Convert incoming string IDs → ObjectId, skip invalid ones
  const objectIds = [];

  for (const id of ids) {
    try {
      objectIds.push(new ObjectId(String(id)));
    } catch {
      // ignore invalid id
    }
  }

  if (!objectIds.length) {
    // Nothing valid to look up; return empty list rather than throwing.
    return [];
  }

  // Pull only the fields we care about for the app
  const docs = await collection
    .find(
      { _id: { $in: objectIds } },
      {
        projection: {
          name: 1,
          normalized_name: 1,
          category: 1,
          food_type: 1,
          brand: 1,
          default_portion: 1,
          serving_info: 1,
          nutrients: 1,
          ingredient_profile_v1: 1,
          ingredients_text: 1,
          ingredients_parsed: 1,

          // OFF support (some docs store nutrition under off_nutriments)
          off_nutriments: 1,
          off_meta: 1,
          source_dataset: 1,
          source: 1,

          // USDA equivalent linkage (for Canadian barcode foods)
          usda_equivalent: 1,
          barcode: 1,
          normalized_upc: 1,
        },
      }
    )
    .toArray();

  // Normalize each document into a stable shape for the client
  const items = docs.map((doc) => {
    const nutrientsArray = ensureNutrientsFallback(doc);

    // Ensure per_100g is correctly derived when only per_serving exists.
    // We pass serving context so normalizeNutrientsForClient can compute per_100g.
    const servingCtx = {
      servingSize: doc?.serving_info?.serving_size ?? null,
      servingSizeUnit: doc?.serving_info?.serving_size_unit ?? null,
    };

    const normalizedNutrientsArray = normalizeNutrientsForClient(nutrientsArray, servingCtx);

    // Shape for Swift.
    const nutrients = normalizedNutrientsArray.map((n) => ({
      key: n.key || null,
      label: n.display_name || null,
      unit: n.unit || null,
      per100g: typeof n.per_100g === "number" ? n.per_100g : null,
      perServing: typeof n.per_serving === "number" ? n.per_serving : null,
      source: n.source || null,
      dataQuality: n.data_quality || null,
      confidence: typeof n.confidence === "number" ? n.confidence : null,
    }));

    return {
      id: String(doc._id),
      name: doc.name || doc.normalized_name || null,
      normalizedName: doc.normalized_name || null,
      category: doc.category || null,
      foodType: doc.food_type || null,

      // Expose barcode and normalized UPC at top level
      barcode: doc.barcode || null,
      normalizedUpc: doc.normalized_upc || null,

      // Expose USDA equivalent linkage (stable shape)
      usdaEquivalent: doc.usda_equivalent
        ? {
            foodId: doc.usda_equivalent.food_id ? String(doc.usda_equivalent.food_id) : null,
            usdaFdcId: doc.usda_equivalent.usda_fdc_id ?? null,
            normalizedUpc: doc.usda_equivalent.normalized_upc ?? null,
            userVerified: !!doc.usda_equivalent.user_verified,
            linkSource: doc.usda_equivalent.link_source ?? null,
            linkedAt: doc.usda_equivalent.linked_at ?? null,
          }
        : null,

      brand: doc.brand
        ? {
            name: doc.brand.name || null,
            owner: doc.brand.owner || null,
            marketCountry: doc.brand.market_country || null,
          }
        : null,

      // This is critical for “1 waffle = 35 g” type logic on-device
      defaultPortion: doc.default_portion || null,

      // Add ingredientsText and ingredientsParsed for iOS decoder
      ingredientsText: doc.ingredients_text || doc.ingredientsText || null,
      ingredientsParsed: doc.ingredients_parsed || doc.ingredientsParsed || null,

      // Canonical per-100g nutrient baseline for all calculations
      nutrients,

      // Your nicer health narrative (ingredient_profile_v1) — optional
      healthProfile: doc.ingredient_profile_v1 || null,
    };
  });

  return items;
}


// --- USDA equivalent linkage helpers (candidates to move into services/foods.js) ---
// Helper: attach Mongo _id of the USDA branded equivalent (if linked) so clients can submit either.
// Uses doc.usda_equivalent.food_id when present; otherwise does a one-time lookup by normalized UPC.
export async function attachUSDAEquivalentFoodIdToDoc(db, doc) {
  try {
    if (!db || !doc || typeof doc !== "object") return doc;

    const eq = doc.usda_equivalent;
    if (!eq || typeof eq !== "object") return doc;

    // Already have a stored Mongo id → nothing to do.
    const existingFoodId = eq.food_id || eq.foodId || doc.usda_equivalent_food_id || doc.usdaEquivalentFoodId;
    if (existingFoodId && ObjectId.isValid(String(existingFoodId))) {
      const fid = String(existingFoodId);
      // Normalize the outward-facing convenience alias fields.
      doc.usda_equivalent_food_id = fid;
      doc.usdaEquivalentFoodId = fid;
      doc.usda_equivalent = { ...eq, food_id: fid, foodId: fid };
      return doc;
    }

    const upcRaw = eq.normalized_upc || eq.normalizedUPC || "";
    const normalizedUSDA = String(upcRaw).replace(/\D/g, "").padStart(16, "0");
    if (!normalizedUSDA) return doc;

    const foodsCol = db.collection(process.env.MONGODB_COLLECTION_FOODS);

    const usdaDoc = await foodsCol.findOne(
      {
        ...notIgnoredQuery(),
        "source.usda_data_type": "Branded",
        $or: [{ normalized_upc: normalizedUSDA }, { normalized_upc_16: normalizedUSDA }],
      },
      { projection: { _id: 1 } }
    );

    if (!usdaDoc?._id) return doc;

    const foodIdStr = String(usdaDoc._id);

    // Attach to response
    doc.usda_equivalent_food_id = foodIdStr;
    doc.usdaEquivalentFoodId = foodIdStr;
    doc.usda_equivalent = { ...eq, food_id: foodIdStr, foodId: foodIdStr };

    // Best-effort: persist the discovered food_id back onto the Canadian doc so future calls avoid lookup.
    // Only do this when the current doc is a Mongo doc (has _id) and looks valid.
    if (doc._id && ObjectId.isValid(String(doc._id))) {
      try {
        await foodsCol.updateOne(
          { _id: new ObjectId(String(doc._id)) },
          { $set: { "usda_equivalent.food_id": new ObjectId(foodIdStr) } }
        );
      } catch (persistErr) {
        console.error("[USDAEquivalent] Failed to persist usda_equivalent.food_id (best-effort):", persistErr);
      }
    }

    return doc;
  } catch (err) {
    console.error("[USDAEquivalent] attachUSDAEquivalentFoodIdToDoc failed:", err);
    return doc;
  }
}

export async function attachUSDAEquivalentFoodIdToCandidates(db, result) {
  try {
    if (!db || !result || typeof result !== "object") return result;
    const items = Array.isArray(result.items) ? result.items : [];
    if (items.length === 0) return result;

    // Only do lookups for candidates that actually need it.
    for (const it of items) {
      const cands = Array.isArray(it?.candidates) ? it.candidates : [];
      for (const c of cands) {
        if (!c || typeof c !== "object") continue;
        if (!c.usda_equivalent || typeof c.usda_equivalent !== "object") continue;

        const hasId =
          (c.usda_equivalent.food_id || c.usda_equivalent.foodId || c.usda_equivalent_food_id || c.usdaEquivalentFoodId) != null;
        if (hasId) {
          // normalize outward alias
          const fid = c.usda_equivalent.food_id || c.usda_equivalent.foodId || c.usda_equivalent_food_id || c.usdaEquivalentFoodId;
          if (ObjectId.isValid(String(fid))) {
            const fidStr = String(fid);
            c.usda_equivalent_food_id = fidStr;
            c.usdaEquivalentFoodId = fidStr;
            c.usda_equivalent = { ...c.usda_equivalent, food_id: fidStr, foodId: fidStr };
          }
          continue;
        }

        await attachUSDAEquivalentFoodIdToDoc(db, c);
      }
    }

    return result;
  } catch (err) {
    console.error("[MealSearch] Failed to attach usda_equivalent food_id:", err);
    return result;
  }
}

// --- Barcode lookup helpers (candidates to move into services/foods.js) ---
export async function chooseBestCanadianDocForUPC(db, normalizedUPC16) {
  if (!db) return null;
  const collection = db.collection(process.env.MONGODB_COLLECTION_FOODS);

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

// --- Barcode lookup helpers ---
export async function fetchBestDocForBarcode(db, normalizedUPC16) {
  if (!db) return null;
  const collection = db.collection(process.env.MONGODB_COLLECTION_FOODS);

  const normalized = String(normalizedUPC16 || "").replace(/\D/g, "").padStart(16, "0");
  if (!normalized) return null;

  // 1) Direct USDA branded match (gold standard for US products)
  let doc = await collection.findOne({
    ...notIgnoredQuery(),
    "source.usda_data_type": "Branded",
    $or: [{ normalized_upc: normalized }, { normalized_upc_16: normalized }],
  });

  if (!doc) {
    // 2) Best Canadian doc
    doc = await chooseBestCanadianDocForUPC(db, normalized);
  }

  if (!doc) {
    // 3) Generic fallback
    doc = await collection.findOne({
      ...notIgnoredQuery(),
      $or: [{ normalized_upc: normalized }, { normalized_upc_16: normalized }],
    });
  }

  if (!doc) return null;

  // Normalize nutrient keys for client compatibility
  if (Array.isArray(doc.nutrients)) {
    const servingCtx = {
      servingSize: doc?.serving_info?.serving_size ?? null,
      servingSizeUnit: doc?.serving_info?.serving_size_unit ?? null,
    };
    doc.nutrients = normalizeNutrientsForClient(doc.nutrients, servingCtx);
  }

  // Attach submit-ready USDA equivalent food_id when possible
  doc = await attachUSDAEquivalentFoodIdToDoc(db, doc);

  return doc;
}

export function makeBarcodeLockedCandidateFromDoc(doc, barcode16) {
  if (!doc || typeof doc !== "object") return null;
  const name = doc.display_product_name || doc.common_name || doc.name || "";
  const brandName = (doc.brand && (doc.brand.name || doc.brand.owner)) || null;

  return {
    id: doc._id ? String(doc._id) : null,
    name,
    brandName,
    normalizedUPC16: barcode16 || doc.normalized_upc_16 || doc.normalized_upc || null,
    // Make it unmistakably dominant
    score: 1_000_000,
    _combinedScore: 1_000_000,
    // Optional flags for clients / debugging
    is_barcode_confirmed: true,
    isBarcodeConfirmed: true,
    barcode: barcode16 || null,
    source: doc.source || null,
    is_canadian_product: doc.is_canadian_product ?? null,
    usda_equivalent: doc.usda_equivalent ?? null,
    usda_equivalent_food_id: doc.usda_equivalent_food_id ?? doc.usdaEquivalentFoodId ?? null,
    usdaEquivalentFoodId: doc.usdaEquivalentFoodId ?? doc.usda_equivalent_food_id ?? null,
  };
}

// --- Ingredient-based micronutrient estimation (best-effort, never overwrites) ---

function normalizeIngredientKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // remove parentheticals
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function roundSmart(v) {
  if (!isFiniteNumber(v)) return v;
  if (Math.abs(v) >= 100) return Math.round(v * 10) / 10;
  if (Math.abs(v) >= 10) return Math.round(v * 100) / 100;
  return Math.round(v * 1000) / 1000;
}

function buildExistingKeySet(nutrients) {
  const s = new Set();
  for (const n of Array.isArray(nutrients) ? nutrients : []) {
    const k = n?.key;
    if (k) s.add(String(k));
  }
  return s;
}

function hasExistingIngredientEstimate(nutrients) {
  for (const n of Array.isArray(nutrients) ? nutrients : []) {
    if (n?.source === "ingredients_estimate" || n?.data_quality === "ingredients_estimate_v1") return true;
  }
  return false;
}

async function findSimpleIngredientDoc(db, foodsCol, ingredientName, cache) {
  const norm = normalizeIngredientKey(ingredientName);
  if (!norm) return null;
  if (cache.has(norm)) return cache.get(norm);

  // Try exact normalized_name match first.
  let doc = await foodsCol.findOne(
    {
      ...notIgnoredQuery(),
      is_simple_ingredient: true,
      $or: [{ normalized_name: norm }, { normalized_common_name: norm }, { normalized_alt_names: norm }],
    },
    { projection: { _id: 1, name: 1, normalized_name: 1, nutrients: 1 } }
  );

  // If no direct hit, try a light regex on normalized_alt_names/common_name to catch minor variations.
  if (!doc) {
    const rx = new RegExp(`^${norm.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}$`, "i");
    doc = await foodsCol.findOne(
      {
        ...notIgnoredQuery(),
        is_simple_ingredient: true,
        $or: [{ normalized_name: rx }, { normalized_common_name: rx }, { normalized_alt_names: rx }],
      },
      { projection: { _id: 1, name: 1, normalized_name: 1, nutrients: 1 } }
    );
  }

  cache.set(norm, doc || null);
  return doc || null;
}

/**
 * Best-effort: estimate missing micronutrients from `ingredients_amounts_estimate_v1`.
 * - NEVER overwrites existing nutrient keys.
 * - Adds only new keys as `source: ingredients_estimate`, `data_quality: ingredients_estimate_v1`.
 * - Skips when non-food suspected.
 *
 * Usage: call after inserting a user-enriched product.
 *
 * @param {import("mongodb").Db} db
 * @param {string|import("mongodb").ObjectId} foodId Mongo _id of the food doc to enrich
 * @returns {Promise<{ok:boolean, added:number, id:string}>}
 */
export async function applyIngredientMicronutrientEstimates(db, foodId) {
  const foodsCol = db.collection(process.env.MONGODB_COLLECTION_FOODS);

  if (!foodId || !ObjectId.isValid(String(foodId))) {
    return { ok: false, added: 0, id: String(foodId || "") };
  }

  const _id = new ObjectId(String(foodId));

  const doc = await foodsCol.findOne(
    { _id, ...notIgnoredQuery() },
    {
      projection: {
        nutrients: 1,
        ingredients_amounts_estimate_v1: 1,
        ingredients_parsed: 1,
        health_flags: 1,
      },
    }
  );

  if (!doc) return { ok: false, added: 0, id: String(foodId) };

  const hf = doc.health_flags && typeof doc.health_flags === "object" ? doc.health_flags : null;
  const nonFood = hf && (hf.non_food_suspected === true || hf.nonFoodSuspected === true);
  if (nonFood) return { ok: true, added: 0, id: String(foodId) };

  // Require structured estimate.
  const est = doc.ingredients_amounts_estimate_v1;
  const items = est && Array.isArray(est.items) ? est.items : null;
  if (!items || items.length === 0) return { ok: true, added: 0, id: String(foodId) };

  const baseNutrients = Array.isArray(doc.nutrients) ? doc.nutrients : [];

  // Prevent double-application.
  if (hasExistingIngredientEstimate(baseNutrients)) {
    return { ok: true, added: 0, id: String(foodId) };
  }

  const existingKeys = buildExistingKeySet(baseNutrients);

  // Accumulate contributions by key.
  const acc = new Map(); // key -> { unit, display_name, value, confSum, weightSum }

  const cache = new Map();

  for (const it of items) {
    const name = typeof it?.name === "string" ? it.name.trim() : "";
    const g = typeof it?.g === "number" && Number.isFinite(it.g) ? it.g : null;
    if (!name || g == null || g <= 0) continue;

    const frac = g / 100.0;
    const ingConf = typeof it?.confidence === "number" && Number.isFinite(it.confidence) ? it.confidence : 0.25;

    const ingDoc = await findSimpleIngredientDoc(db, foodsCol, name, cache);
    if (!ingDoc || !Array.isArray(ingDoc.nutrients) || ingDoc.nutrients.length === 0) continue;

    for (const n of ingDoc.nutrients) {
      const key = n?.key ? String(n.key) : null;
      if (!key) continue;
      if (existingKeys.has(key)) continue; // never overwrite

      const per100g = n?.per_100g;
      if (!isFiniteNumber(per100g) || per100g === 0) continue;

      const unit = n?.unit || null;
      const display_name = n?.display_name || null;

      const add = per100g * frac;

      const prev = acc.get(key) || {
        unit,
        display_name,
        value: 0,
        confSum: 0,
        weightSum: 0,
      };

      // If units mismatch across ingredients, skip accumulating that key to avoid bad merges.
      if (prev.unit && unit && String(prev.unit) !== String(unit)) {
        continue;
      }

      prev.value += add;
      prev.confSum += ingConf * frac;
      prev.weightSum += frac;
      if (!prev.unit) prev.unit = unit;
      if (!prev.display_name) prev.display_name = display_name;
      acc.set(key, prev);
    }
  }

  if (acc.size === 0) return { ok: true, added: 0, id: String(foodId) };

  const newNutrients = [];
  for (const [key, v] of acc.entries()) {
    const per_100g = roundSmart(v.value);
    if (!isFiniteNumber(per_100g) || per_100g === 0) continue;

    // Low-confidence estimate; scale by average ingredient confidence contribution.
    const avgConf = v.weightSum > 0 ? v.confSum / v.weightSum : 0.2;
    const confidence = Math.max(0.05, Math.min(0.35, avgConf * 0.6));

    newNutrients.push({
      key,
      display_name: v.display_name || key,
      unit: v.unit || null,
      per_100g,
      per_serving: null,
      source: "ingredients_estimate",
      data_quality: "ingredients_estimate_v1",
      confidence,
      is_estimated: true,
    });
  }

  if (newNutrients.length === 0) return { ok: true, added: 0, id: String(foodId) };

  const merged = [...baseNutrients, ...newNutrients];

  await foodsCol.updateOne(
    { _id },
    {
      $set: {
        nutrients: merged,
        ingredient_micros_estimation_meta: {
          version: 1,
          method: "ingredients_amounts_estimate_v1",
          applied_at: new Date(),
          note: "Estimated missing nutrient keys from simple-ingredient lab profiles. Never overwrites existing keys.",
        },
      },
    }
  );

  return { ok: true, added: newNutrients.length, id: String(foodId) };
}

  return { ok: true, added: newNutrients.length, id: String(foodId) };
}
