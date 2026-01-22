// services/foodDetails.js
import { ObjectId } from "mongodb";
import { foodItemsCollection } from "./mongo.js";

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
  // For now, we derive a conservative per-100g baseline only when clearly available.
  // If only per-serving exists, we still pass it as per100g to avoid hard rejects on the client;
  // the app can treat OFF as lower-confidence data.

  const nutrients = [];

  // Energy (kcal)
  const kcal = pickFirstNumber(off, ["energy-kcal_100g", "energy-kcal", "energy_value"]);
  if (kcal !== null) nutrients.push({ key: "energy_kcal", display_name: "Energy", unit: "kcal", per_100g: kcal, source: "off", data_quality: "off", confidence: 0.6 });

  // Protein (g)
  const protein = pickFirstNumber(off, ["proteins_100g", "proteins", "proteins_value", "proteins_serving"]);
  if (protein !== null) nutrients.push({ key: "protein", display_name: "Protein", unit: "g", per_100g: protein, source: "off", data_quality: "off", confidence: 0.6 });

  // Carbs (g)
  const carbs = pickFirstNumber(off, ["carbohydrates_100g", "carbohydrates", "carbohydrates_value", "carbohydrates_serving"]);
  if (carbs !== null) nutrients.push({ key: "carbohydrate", display_name: "Carbohydrate", unit: "g", per_100g: carbs, source: "off", data_quality: "off", confidence: 0.6 });

  // Fat (g)
  const fat = pickFirstNumber(off, ["fat_100g", "fat", "fat_value", "fat_serving"]);
  if (fat !== null) nutrients.push({ key: "total_lipid_fat", display_name: "Total lipid (fat)", unit: "g", per_100g: fat, source: "off", data_quality: "off", confidence: 0.6 });

  // Sugars (g)
  const sugars = pickFirstNumber(off, ["sugars_100g", "sugars", "sugars_value", "sugars_serving"]);
  if (sugars !== null) nutrients.push({ key: "total_sugars", display_name: "Total Sugars", unit: "g", per_100g: sugars, source: "off", data_quality: "off", confidence: 0.6 });

  // Fiber (g)
  const fiber = pickFirstNumber(off, ["fiber_100g", "fiber", "fiber_value", "fiber_serving"]);
  if (fiber !== null) nutrients.push({ key: "fiber", display_name: "Fiber, total dietary", unit: "g", per_100g: fiber, source: "off", data_quality: "off", confidence: 0.6 });

  // Sodium (mg) — OFF often stores sodium in grams (e.g. 0.33 g). Convert g → mg when value looks like grams.
  let sodium = pickFirstNumber(off, ["sodium_100g", "sodium", "sodium_value", "sodium_serving"]);
  if (sodium !== null) {
    // Heuristic: if <= 10, assume grams → convert to mg.
    const sodiumMg = sodium <= 10 ? sodium * 1000 : sodium;
    nutrients.push({ key: "sodium", display_name: "Sodium, Na", unit: "mg", per_100g: sodiumMg, source: "off", data_quality: "off", confidence: 0.6 });
  }

  return nutrients;
}

function ensureNutrientsFallback(doc) {
  const hasNutrients = Array.isArray(doc?.nutrients) && doc.nutrients.length > 0;
  if (hasNutrients) return doc.nutrients;

  const off = doc?.off_nutriments;
  const derived = buildOffNutrientsArray(off);
  return derived;
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
  const invalidIds = [];

  for (const id of ids) {
    try {
      objectIds.push(new ObjectId(String(id)));
    } catch {
      invalidIds.push(id);
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
          nutrients: 1,
          ingredient_profile_v1: 1,

          // OFF support (some docs store nutrition under off_nutriments)
          off_nutriments: 1,
          off_meta: 1,
          source_dataset: 1,
          source: 1,
        },
      }
    )
    .toArray();

  // Normalize each document into a stable shape for the client
  const items = docs.map((doc) => {
    const nutrientsArray = ensureNutrientsFallback(doc);

    // Normalize nutrients to something easy for Swift:
    // - keep key, display label, unit, per_100g
    // - ignore per_serving for now (you’ll compute based on actual portion)
    const nutrients = nutrientsArray.map((n) => ({
      key: n.key || null,
      label: n.display_name || null,
      unit: n.unit || null,
      per100g: typeof n.per_100g === "number" ? n.per_100g : null,
      // Keep raw fields if you ever want them:
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

      brand: doc.brand
        ? {
            name: doc.brand.name || null,
            owner: doc.brand.owner || null,
            marketCountry: doc.brand.market_country || null,
          }
        : null,

      // This is critical for “1 waffle = 35 g” type logic on-device
      defaultPortion: doc.default_portion || null,
      // e.g.
      // {
      //   description: "waffle",
      //   gram_weight: 35,
      //   amount: 1,
      //   unit: "undetermined"
      // }

      // Canonical per-100g nutrient baseline for all calculations
      nutrients,

      // Your nicer health narrative (ingredient_profile_v1) — optional
      healthProfile: doc.ingredient_profile_v1 || null,
    };
  });

  return items;
}
