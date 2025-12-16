// services/userMeals.js
import { ObjectId } from "mongodb";
import { usersCollection, userMealsCollection, foodItemsCollection } from "./mongo.js";

// userMealsCollection should be initialized in mongo.js like:
// export const userMealsCollection = db.collection("user_meals");

// Nutrient keys from foods.nutrients[].key that we want to aggregate
const DAILY_PANEL_NUTRIENTS = {
  // Calories / energy
  energy_kcal: { field: "energy_kcal", unit: "kcal" },
  energy_kj: { field: "energy_kj", unit: "kj" },

  // Macros
  protein: { field: "protein_g", unit: "g" },
  carbohydrate: { field: "carbs_g", unit: "g" },
  fiber: { field: "fiber_g", unit: "g" },
  total_sugars: { field: "sugars_g", unit: "g" },
  total_lipid_fat: { field: "fat_g", unit: "g" },

  // Fat breakdown
  fatty_acids_total_saturated: { field: "sat_fat_g", unit: "g" },
  fatty_acids_total_trans: { field: "trans_fat_g", unit: "g" },
  fatty_acids_total_monounsaturated: { field: "mono_fat_g", unit: "g" },
  fatty_acids_total_polyunsaturated: { field: "poly_fat_g", unit: "g" },

  // Common fatty-acid details (store now; derive SCFA/MCFA/LCFA and omegas in-app later)
  // Saturated chain lengths
  sfa_4_0: { field: "sfa_4_0_g", unit: "g" },
  sfa_6_0: { field: "sfa_6_0_g", unit: "g" },
  sfa_8_0: { field: "sfa_8_0_g", unit: "g" },
  sfa_10_0: { field: "sfa_10_0_g", unit: "g" },
  sfa_12_0: { field: "sfa_12_0_g", unit: "g" },
  sfa_14_0: { field: "sfa_14_0_g", unit: "g" },
  sfa_16_0: { field: "sfa_16_0_g", unit: "g" },
  sfa_18_0: { field: "sfa_18_0_g", unit: "g" },

  // MUFAs
  mufa_16_1: { field: "mufa_16_1_g", unit: "g" },
  mufa_18_1: { field: "mufa_18_1_g", unit: "g" },
  mufa_20_1: { field: "mufa_20_1_g", unit: "g" },
  mufa_22_1: { field: "mufa_22_1_g", unit: "g" },

  // PUFAs (omega families can be derived client-side)
  pufa_18_2: { field: "pufa_18_2_g", unit: "g" }, // often LA (omega-6)
  pufa_18_3: { field: "pufa_18_3_g", unit: "g" }, // often ALA (omega-3)
  pufa_18_4: { field: "pufa_18_4_g", unit: "g" },
  pufa_20_4: { field: "pufa_20_4_g", unit: "g" }, // often AA (omega-6)
  pufa_20_5_n_3_epa: { field: "epa_g", unit: "g" },
  pufa_22_6_n_3_dha: { field: "dha_g", unit: "g" },
  pufa_22_5_n_3_dpa: { field: "dpa_g", unit: "g" },

  // Other macro-adjacent
  cholesterol: { field: "cholesterol_mg", unit: "mg" },
  water: { field: "water_g", unit: "g" },

  // Micros — vitamins
  vitamin_c: { field: "vitamin_c_mg", unit: "mg" },
  thiamin: { field: "vitamin_b1_mg", unit: "mg" },
  riboflavin: { field: "vitamin_b2_mg", unit: "mg" },
  niacin: { field: "vitamin_b3_mg", unit: "mg" },
  vitamin_b_6: { field: "vitamin_b6_mg", unit: "mg" },
  folate_total: { field: "folate_total_ug", unit: "µg" },
  folate_dfe: { field: "folate_dfe_ug", unit: "µg" },
  folate_food: { field: "folate_food_ug", unit: "µg" },
  folic_acid: { field: "folic_acid_ug", unit: "µg" },
  vitamin_b_12: { field: "vitamin_b12_ug", unit: "µg" },
  vitamin_k_phylloquinone: { field: "vitamin_k_ug", unit: "µg" },
  vitamin_e_alpha_tocopherol: { field: "vitamin_e_mg", unit: "mg" },

  // Vitamin A is messy in USDA because the key is often reused for both IU and RAE.
  // We only aggregate the RAE form when it appears (unit µg).
  vitamin_a: { field: "vitamin_a_rae_ug", unit: "µg" },

  // Vitamin D similarly appears as IU and µg under the same key in some datasets.
  // Prefer µg for aggregation.
  vitamin_d: { field: "vitamin_d_ug", unit: "µg" },

  // Micros — minerals
  sodium: { field: "sodium_mg", unit: "mg" },
  potassium_k: { field: "potassium_mg", unit: "mg" },
  calcium: { field: "calcium_mg", unit: "mg" },
  iron: { field: "iron_mg", unit: "mg" },
  magnesium_mg: { field: "magnesium_mg", unit: "mg" },
  phosphorus_p: { field: "phosphorus_mg", unit: "mg" },
  zinc_zn: { field: "zinc_mg", unit: "mg" },
  copper_cu: { field: "copper_mg", unit: "mg" },
  selenium_se: { field: "selenium_ug", unit: "µg" },
  manganese_mn: { field: "manganese_mg", unit: "mg" },

  // Other compounds
  caffeine: { field: "caffeine_mg", unit: "mg" },
  theobromine: { field: "theobromine_mg", unit: "mg" },
  alcohol_ethyl: { field: "alcohol_g", unit: "g" },

  // Useful health-related micros
  choline_total: { field: "choline_mg", unit: "mg" },
};

export async function logUserMeal(userId, payload) {
  if (!ObjectId.isValid(userId)) {
    const err = new Error("Invalid userId");
    err.statusCode = 400;
    throw err;
  }

  const userObjectId = new ObjectId(userId);

  // Make sure user exists
  const user = await usersCollection.findOne({ _id: userObjectId });
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const now = new Date();

  const {
    loggedAt,        // optional ISO string or omitted = now
    timezone,        // e.g. "America/Toronto"
    description,     // free-text like "steak, cauliflower mash..."
    items            // array of meal items
  } = payload;

  const loggedAtDate = loggedAt ? new Date(loggedAt) : now;
  const dateKey = (payload.dateKey) || loggedAtDate.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const safeItems = Array.isArray(items) ? items.map((it) => ({
    name: it.name,
    foodId: it.foodId ? new ObjectId(it.foodId) : null,
    quantity: it.quantity,              // e.g. 120
    quantityUnit: it.quantityUnit || "g",
    confidence: typeof it.confidence === "number" ? it.confidence : null
  })) : [];

  const doc = {
    userId: userObjectId,
    loggedAt: loggedAtDate,
    dateKey,
    timezone: timezone || "UTC",
    description: description || null,
    items: safeItems,
    createdAt: now,
    updatedAt: now
  };

  const result = await userMealsCollection.insertOne(doc);

  // Shape a small response back to the app
  return {
    id: result.insertedId.toString(),
    userId: userId,
    loggedAt: loggedAtDate.toISOString(),
    dateKey,
    timezone: doc.timezone,
    description: doc.description,
    items: safeItems.map((it) => ({
      name: it.name,
      foodId: it.foodId ? it.foodId.toString() : null,
      quantity: it.quantity,
      quantityUnit: it.quantityUnit,
      confidence: it.confidence
    }))
  };
}

export async function recomputeDailyNutritionTotals(db, userId, dateKey) {
  if (!db) throw new Error("DB not ready");
  if (!userId || !dateKey) return;

  // We use the shared collections from mongo.js for meals and foods,
  // and only use `db` directly for the daily totals collection.
  const dailyTotalsCollection = db.collection("user_daily_totals");
  const userObjectId = new ObjectId(userId);

  console.log("[recomputeDailyNutritionTotals] userId:", userId, "dateKey:", dateKey);

  // 1. Load all meals for this user + date
  const meals = await userMealsCollection
    .find({ userId: userObjectId, dateKey })
    .toArray();

  if (!meals.length) {
    console.log("[recomputeDailyNutritionTotals] no meals for this date, upserting zero totals");

    const now = new Date();
    const emptyTotals = Object.values(DAILY_PANEL_NUTRIENTS).reduce((acc, cfg) => {
      acc[cfg.field] = 0;
      return acc;
    }, {});

    await dailyTotalsCollection.updateOne(
      { userId: userObjectId, dateKey },
      {
        $set: {
          totals: emptyTotals,
          timezone: "UTC",
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    return;
  }

  // 2. Aggregate total grams per foodId for that day, with a fallback to
  // the food's serving size if the logged quantity is missing/zero or
  // expressed in servings.
  const foodGramsById = new Map(); // foodId string -> grams

  for (const meal of meals) {
    for (const item of meal.items || []) {
      if (!item.foodId) continue;

      const foodIdStr =
        typeof item.foodId === "string"
          ? item.foodId
          : item.foodId.toString();

      const qty = item.quantity || {};
      const unitRaw = qty.unit || item.quantityUnit || "g";
      const unit = String(unitRaw).toLowerCase();
      const value = typeof qty.value === "number" ? qty.value : null;

      let gramsToAdd = 0;

      // Case 1: explicit grams
      if (value && unit === "g") {
        gramsToAdd = value;
      } else {
        // Case 2: fallback to serving size when:
        //  - unit looks like "serving"/"servings", OR
        //  - value is missing/zero and we still want at least one serving
        try {
          const food = await foodItemsCollection.findOne({
            _id: new ObjectId(foodIdStr),
          });
          if (!food) continue;

          let gramsPerServing = null;

          // Prefer serving_info.serving_size when unit is grams
          if (
            food.serving_info &&
            typeof food.serving_info.serving_size === "number"
          ) {
            const servingUnit = String(
              food.serving_info.serving_size_unit || ""
            ).toLowerCase();
            if (
              servingUnit === "g" ||
              servingUnit === "gram" ||
              servingUnit === "grams"
            ) {
              gramsPerServing = food.serving_info.serving_size;
            }
          }

          // Fallback to default_portion.gram_weight if available
          if (
            gramsPerServing == null &&
            food.default_portion &&
            typeof food.default_portion.gram_weight === "number"
          ) {
            gramsPerServing = food.default_portion.gram_weight;
          }

          if (gramsPerServing == null) {
            // No usable serving/portion info; skip this item
            continue;
          }

          const looksLikeServingUnit = unit.startsWith("serv");
          const servingsCount =
            looksLikeServingUnit && value && value > 0 ? value : 1;

          gramsToAdd = gramsPerServing * servingsCount;
        } catch (err) {
          console.error(
            "[recomputeDailyNutritionTotals] failed to load food for serving fallback",
            {
              foodIdStr,
              error: err?.message || err,
            }
          );
          continue;
        }
      }

      if (!gramsToAdd || Number.isNaN(gramsToAdd)) continue;

      const prev = foodGramsById.get(foodIdStr) || 0;
      foodGramsById.set(foodIdStr, prev + gramsToAdd);
    }
  }

  if (!foodGramsById.size) {
    console.log("[recomputeDailyNutritionTotals] no gram-based quantities found, writing zero totals");
    const now = new Date();
    const emptyTotals = Object.values(DAILY_PANEL_NUTRIENTS).reduce((acc, cfg) => {
      acc[cfg.field] = 0;
      return acc;
    }, {});

    await dailyTotalsCollection.updateOne(
      { userId: userObjectId, dateKey },
      {
        $set: {
          totals: emptyTotals,
          timezone: "UTC",
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
    return;
  }

  // 3. Load the corresponding foods
  const foodObjectIds = Array.from(foodGramsById.keys()).map((id) => new ObjectId(id));
  const foods = await foodItemsCollection
    .find({ _id: { $in: foodObjectIds } })
    .toArray();

  // 4. Initialize daily totals
  const totals = Object.values(DAILY_PANEL_NUTRIENTS).reduce((acc, cfg) => {
    acc[cfg.field] = 0;
    return acc;
  }, {});

  // Helper to safely add
  const addToTotal = (field, value) => {
    if (typeof value !== "number" || Number.isNaN(value)) return;
    totals[field] += value;
  };

  // 5. For each food, scale per_100g nutrients by total grams eaten
  for (const food of foods) {
    const foodIdStr = food._id.toString();
    const grams = foodGramsById.get(foodIdStr) || 0;
    if (!grams) continue;

    const factor = grams / 100.0;
    const nutrients = food.nutrients || [];

    for (const nutrient of nutrients) {
      const cfg = DAILY_PANEL_NUTRIENTS[nutrient.key];
      if (!cfg) continue; // skip nutrients we don't care about in the panel

      // Some datasets reuse the same `key` for different units (e.g., vitamin_a IU vs RAE µg).
      // Only aggregate when the unit matches what we expect for this panel field.
      const unit = nutrient.unit;
      if (cfg.unit && unit && String(unit) !== String(cfg.unit)) continue;

      const per100g = nutrient.per_100g;
      if (typeof per100g !== "number") continue;

      const contribution = per100g * factor;
      addToTotal(cfg.field, contribution);
    }
  }

  // 6. Round totals to something sane (e.g. 1 decimal place)
  for (const [k, v] of Object.entries(totals)) {
    totals[k] = Math.round((v + Number.EPSILON) * 10) / 10;
  }
  // Tiny cleanup so we don't store -0
  for (const [k, v] of Object.entries(totals)) {
    if (Object.is(v, -0)) totals[k] = 0;
  }

  // 7. Upsert into user_daily_totals
  const now = new Date();
  const update = {
    $set: {
      totals,
      timezone: "UTC", // TODO: switch to user's tz later
      updatedAt: now,
    },
    $setOnInsert: {
      createdAt: now,
    },
  };

  const res = await dailyTotalsCollection.updateOne(
    { userId: userObjectId, dateKey },
    update,
    { upsert: true }
  );

  console.log("[recomputeDailyNutritionTotals] upsert result:", {
    matchedCount: res.matchedCount,
    modifiedCount: res.modifiedCount,
    upsertedId: res.upsertedId,
  });
}
