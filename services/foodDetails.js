// services/foodDetails.js
import { ObjectId } from "mongodb";

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
        },
      }
    )
    .toArray();

  // Normalize each document into a stable shape for the client
  const items = docs.map((doc) => {
    const nutrientsArray = Array.isArray(doc.nutrients) ? doc.nutrients : [];

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
      id: doc._id,
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
