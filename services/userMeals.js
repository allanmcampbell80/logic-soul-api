// services/userMeals.js
import { ObjectId } from "mongodb";
import { usersCollection, userMealsCollection, foodItemsCollection } from "./mongo.js";
import crypto from "crypto";

// --- ObjectId helpers ---
function coerceObjectId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  if (typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value);
  // Allow passing an object shaped like { $oid: "..." } defensively
  if (typeof value === "object" && typeof value.$oid === "string" && ObjectId.isValid(value.$oid)) {
    return new ObjectId(value.$oid);
  }
  return null;
}

function toObjectIdString(value) {
  const oid = coerceObjectId(value);
  return oid ? oid.toString() : (typeof value === "string" ? value : null);
}

// userMealsCollection should be initialized in mongo.js like:
// export const userMealsCollection = db.collection("user_meals");

// --- DateKey helpers (timezone-aware logical day) ---
function isValidDateKey(dateKey) {
  return typeof dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
}

function safeTimeZone(tz) {
  const s = typeof tz === "string" ? tz.trim() : "";
  return s.length > 0 ? s : null;
}

function dateKeyFromInstantInTimeZone(dt, timeZone) {
  // dt is a Date representing an instant.
  // Return YYYY-MM-DD in the provided IANA timezone.
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const parts = fmt.formatToParts(dt);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;

    const s = fmt.format(dt);
    if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch {
    // ignore
  }

  // Fallback: UTC dateKey
  return dt.toISOString().slice(0, 10);
}

function computeLogicalDateKeyFromLoggedAt(loggedAt, timezone, cutoffHour = 3) {
  // loggedAt can be ISO string, number (ms), or Date.
  let dt;
  if (loggedAt instanceof Date) dt = loggedAt;
  else if (typeof loggedAt === "number" && Number.isFinite(loggedAt)) dt = new Date(loggedAt);
  else dt = new Date(String(loggedAt || ""));

  if (!dt || Number.isNaN(dt.getTime())) {
    dt = new Date();
  }

  const tz = safeTimeZone(timezone);

  // Shift the instant backwards by cutoffHour so that the dateKey boundary becomes cutoffHour.
  const shifted = new Date(dt.getTime() - (Number(cutoffHour) || 0) * 60 * 60 * 1000);

  return tz ? dateKeyFromInstantInTimeZone(shifted, tz) : shifted.toISOString().slice(0, 10);
}

// Nutrient keys from foods.nutrients[].key that we want to aggregate
const DAILY_PANEL_NUTRIENTS = {
  // Calories / energy
  energy_kcal: { field: "energy_kcal", unit: "kcal" },
  energy_kj: { field: "energy_kj", unit: "kj" },

  // Macros
  protein: { field: "protein_g", unit: "g" },

  // Protein breakdown (amino acids)
  tryptophan: { field: "tryptophan_g", unit: "g" },
  threonine: { field: "threonine_g", unit: "g" },
  isoleucine: { field: "isoleucine_g", unit: "g" },
  leucine: { field: "leucine_g", unit: "g" },
  lysine: { field: "lysine_g", unit: "g" },
  methionine: { field: "methionine_g", unit: "g" },
  cystine: { field: "cystine_g", unit: "g" },
  phenylalanine: { field: "phenylalanine_g", unit: "g" },
  tyrosine: { field: "tyrosine_g", unit: "g" },
  valine: { field: "valine_g", unit: "g" },
  arginine: { field: "arginine_g", unit: "g" },
  histidine: { field: "histidine_g", unit: "g" },
  alanine: { field: "alanine_g", unit: "g" },
  aspartic_acid: { field: "aspartic_acid_g", unit: "g" },
  glutamic_acid: { field: "glutamic_acid_g", unit: "g" },
  glycine: { field: "glycine_g", unit: "g" },
  proline: { field: "proline_g", unit: "g" },
  serine: { field: "serine_g", unit: "g" },

  carbohydrate: { field: "carbs_g", unit: "g" },
  fiber: { field: "fiber_g", unit: "g" },
  total_sugars: { field: "sugars_g", unit: "g" },
  total_lipid_fat: { field: "fat_g", unit: "g" },

  // Carbs breakdown / label-style extras (when available)
  starch: { field: "starch_g", unit: "g" },
  added_sugars: { field: "added_sugars_g", unit: "g" },
  sugar_alcohol: { field: "sugar_alcohol_g", unit: "g" },

  // Specific sugars (when provided)
  sucrose: { field: "sucrose_g", unit: "g" },
  glucose: { field: "glucose_g", unit: "g" },
  fructose: { field: "fructose_g", unit: "g" },
  lactose: { field: "lactose_g", unit: "g" },
  maltose: { field: "maltose_g", unit: "g" },
  galactose: { field: "galactose_g", unit: "g" },

  // Common sugar alcohols (some datasets expose these explicitly)
  sorbitol: { field: "sorbitol_g", unit: "g" },
  mannitol: { field: "mannitol_g", unit: "g" },
  xylitol: { field: "xylitol_g", unit: "g" },
  erythritol: { field: "erythritol_g", unit: "g" },
  maltitol: { field: "maltitol_g", unit: "g" },
  lactitol: { field: "lactitol_g", unit: "g" },

  // Fat breakdown
  fatty_acids_total_saturated: { field: "sat_fat_g", unit: "g" },
  fatty_acids_total_trans: { field: "trans_fat_g", unit: "g" },
  fatty_acids_total_monounsaturated: { field: "mono_fat_g", unit: "g" },
  fatty_acids_total_polyunsaturated: { field: "poly_fat_g", unit: "g" },

  // OFF label-style keys (aliases) — map into the same daily fields
  saturated_fat: { field: "sat_fat_g", unit: "g" },
  trans_fat: { field: "trans_fat_g", unit: "g" },
  monounsaturated_fat: { field: "mono_fat_g", unit: "g" },
  polyunsaturated_fat: { field: "poly_fat_g", unit: "g" },

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
  // Water from foods (USDA reports in grams; store as mL for easy merging with user hydration)
  water: { field: "water_from_food_ml", unit: "g" },

  // Micros — vitamins
  vitamin_c: { field: "vitamin_c_mg", unit: "mg" },
  thiamin: { field: "vitamin_b1_mg", unit: "mg" },
  riboflavin: { field: "vitamin_b2_mg", unit: "mg" },
  niacin: { field: "vitamin_b3_mg", unit: "mg" },
  pantothenic_acid: { field: "vitamin_b5_mg", unit: "mg" },
  vitamin_b_6: { field: "vitamin_b6_mg", unit: "mg" },
  biotin: { field: "vitamin_b7_ug", unit: "µg" },
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
  retinol: { field: "retinol_ug", unit: "µg" },

  // Vitamin D similarly appears as IU and µg under the same key in some datasets.
  // Prefer µg for aggregation.
  vitamin_d: { field: "vitamin_d_ug", unit: "µg" },

  // Micros — minerals
  sodium: { field: "sodium_mg", unit: "mg" },
  // OFF sometimes provides salt (g). We store sodium separately, so keep salt as its own field if desired.
  // If you later want to convert salt->sodium, do it explicitly (1 g salt ≈ 393 mg sodium).
  potassium_k: { field: "potassium_mg", unit: "mg" },
  potassium: { field: "potassium_mg", unit: "mg" },
  // Defensive alias for common misspelling in upstream sources.
  // If present, we map it to the same daily potassium field.
  pottasium: { field: "potassium_mg", unit: "mg" },

  calcium: { field: "calcium_mg", unit: "mg" },
  iron: { field: "iron_mg", unit: "mg" },

  // Some label/OCR foods use short keys without element suffixes.
  // Keep both variants so USDA/label/OCR can be diffed reliably.
  magnesium: { field: "magnesium_mg", unit: "mg" },
  magnesium_mg: { field: "magnesium_mg", unit: "mg" },

  phosphorus: { field: "phosphorus_mg", unit: "mg" },
  phosphorus_p: { field: "phosphorus_mg", unit: "mg" },

  zinc: { field: "zinc_mg", unit: "mg" },
  zinc_zn: { field: "zinc_mg", unit: "mg" },

  copper: { field: "copper_mg", unit: "mg" },
  copper_cu: { field: "copper_mg", unit: "mg" },

  selenium: { field: "selenium_ug", unit: "µg" },
  selenium_se: { field: "selenium_ug", unit: "µg" },

  manganese: { field: "manganese_mg", unit: "mg" },
  manganese_mn: { field: "manganese_mg", unit: "mg" },

  iodine: { field: "iodine_ug", unit: "µg" },
  chromium_cr: { field: "chromium_ug", unit: "µg" },

  // Other compounds
  caffeine: { field: "caffeine_mg", unit: "mg" },
  theobromine: { field: "theobromine_mg", unit: "mg" },
  betaine: { field: "betaine_mg", unit: "mg" },
  alcohol_ethyl: { field: "alcohol_g", unit: "g" },
  fluoride_f: { field: "fluoride_ug", unit: "µg" },
  beta_sitosterol: { field: "beta_sitosterol_mg", unit: "mg" },

  // Useful health-related micros
  choline_total: { field: "choline_mg", unit: "mg" },

  // Phytonutrients / carotenoids (when available)
  carotene_beta: { field: "carotene_beta_ug", unit: "µg" },
  carotene_alpha: { field: "carotene_alpha_ug", unit: "µg" },
  cryptoxanthin_beta: { field: "cryptoxanthin_beta_ug", unit: "µg" },
  lycopene: { field: "lycopene_ug", unit: "µg" },
  lutein_zeaxanthin: { field: "lutein_zeaxanthin_ug", unit: "µg" },
};

export async function logUserMeal(userId, payload) {
  const userObjectId = coerceObjectId(userId);
  if (!userObjectId) {
    const err = new Error("Invalid userId");
    err.statusCode = 400;
    throw err;
  }

  const userIdString = userObjectId.toString();

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

  // Optional idempotency key (recommended): if the client retries, we can safely avoid duplicates.
  const idempotencyKeyRaw =
    payload?.idempotencyKey ||
    payload?.requestId ||
    payload?.clientRequestId ||
    payload?.client_request_id ||
    null;

  const idempotencyKey =
    typeof idempotencyKeyRaw === "string" && idempotencyKeyRaw.trim()
      ? idempotencyKeyRaw.trim()
      : null;

  const loggedAtDate = loggedAt ? new Date(loggedAt) : now;

  // Use the same logical-day rule as the API (3am→3am). If the client/server already
  // provided a valid dateKey, keep it. Otherwise compute from loggedAt + timezone.
  const tzForMeal = timezone || user.timezone || "UTC";
  const dateKey = isValidDateKey(payload?.dateKey)
    ? String(payload.dateKey)
    : computeLogicalDateKeyFromLoggedAt(loggedAtDate, tzForMeal, 3);

  // If no explicit idempotency key is provided, create a deterministic one from the payload.
  // This prevents accidental duplicates on network retries for the exact same meal payload.
  const buildDeterministicKey = () => {
    try {
      const canonicalItems = Array.isArray(items)
        ? items
            .map((it) => {
              const foodId = toObjectIdString(it.canadianFoodId || it.originalFoodId || it.primaryFoodId || it.foodId);
              const usdaEq = toObjectIdString(it.usdaEquivalentFoodId || it.usda_equivalent_food_id || it.usdaFoodId);
              const useUsdaEq =
                typeof it.useUSDAEquivalent === "boolean"
                  ? it.useUSDAEquivalent
                  : typeof it.useUsdaEquivalent === "boolean"
                    ? it.useUsdaEquivalent
                    : typeof it.use_usda_equivalent === "boolean"
                      ? it.use_usda_equivalent
                      : false;

              const qtyVal =
                typeof it?.quantity?.value === "number"
                  ? it.quantity.value
                  : (typeof it.quantity === "number" ? it.quantity : null);

              const qtyUnit =
                typeof it?.quantity?.unit === "string"
                  ? it.quantity.unit
                  : (typeof it.quantityUnit === "string" ? it.quantityUnit : "g");

              return {
                name: typeof it?.name === "string" ? it.name : null,
                foodId: foodId || null,
                usdaEq: usdaEq || null,
                useUsdaEq: Boolean(useUsdaEq),
                qtyVal: typeof qtyVal === "number" && Number.isFinite(qtyVal) ? qtyVal : null,
                qtyUnit: typeof qtyUnit === "string" ? qtyUnit : "g",
              };
            })
            // stable ordering regardless of UI order
            .sort((a, b) => String(a.foodId || a.name || "").localeCompare(String(b.foodId || b.name || "")))
        : [];

      // Round loggedAt to the minute so a retry doesn’t differ by milliseconds
      const loggedAtMinute = new Date(loggedAtDate);
      loggedAtMinute.setSeconds(0, 0);

      const base = JSON.stringify({
        userId: userIdString,
        dateKey,
        loggedAt: loggedAtMinute.toISOString(),
        description: typeof description === "string" ? description.trim() : "",
        items: canonicalItems,
      });

      return crypto.createHash("sha256").update(base).digest("hex");
    } catch {
      return null;
    }
  };

  const effectiveIdempotencyKey = idempotencyKey || buildDeterministicKey();

  // If we’ve already inserted this exact meal for this user, return the existing row instead of duplicating.
  if (effectiveIdempotencyKey) {
    const existing = await userMealsCollection.findOne({
      userId: userObjectId,
      idempotencyKey: effectiveIdempotencyKey,
    });

    if (existing) {
      return {
        id: existing._id.toString(),
        userId: userIdString,
        loggedAt: (existing.loggedAt instanceof Date ? existing.loggedAt : loggedAtDate).toISOString(),
        dateKey: existing.dateKey || dateKey,
        timezone: existing.timezone || tzForMeal,
        description: existing.description || null,
        items: Array.isArray(existing.items)
          ? existing.items.map((it) => ({
              name: it.name,
              foodId: it.foodId ? it.foodId.toString() : null,
              usdaEquivalentFoodId: it.usdaEquivalentFoodId ? it.usdaEquivalentFoodId.toString() : null,
              useUSDAEquivalent: Boolean(it.useUSDAEquivalent),
              quantity: it.quantity,
              quantityUnit: it.quantityUnit,
              confidence: it.confidence,
            }))
          : [],
        deduped: true,
      };
    }
  }

  const safeItems = Array.isArray(items)
    ? items.map((it) => {
        // quantity can be either the newer object shape ({ value, unit, isEstimate, ... })
        // or a legacy/simple number (e.g. 250) with quantityUnit (e.g. "ml").
        let qty = null;
        if (it.quantity && typeof it.quantity === "object") {
          qty = it.quantity;
        } else if (typeof it.quantity === "number" && Number.isFinite(it.quantity)) {
          qty = {
            value: it.quantity,
            unit: it.quantityUnit || "g",
            isEstimate: false,
            basis: "ui",
            confidence: 1,
          };
        }

        const qtyUnit = qty?.unit ? String(qty.unit) : null;

        // Canadian (primary) id
        const primaryFoodIdRaw = it.canadianFoodId || it.originalFoodId || it.primaryFoodId || it.foodId;
        // USDA equivalent id
        const usdaEqRaw = it.usdaEquivalentFoodId || it.usda_equivalent_food_id || it.usdaFoodId;
        // Toggle for using USDA equivalent
        const useUsdaEq =
          typeof it.useUSDAEquivalent === "boolean"
            ? it.useUSDAEquivalent
            : typeof it.useUsdaEquivalent === "boolean"
              ? it.useUsdaEquivalent
              : typeof it.use_usda_equivalent === "boolean"
                ? it.use_usda_equivalent
                : false;

        return {
          name: it.name,

          // Always store the PRIMARY (typically Canadian) food id as the meal's foodId
          foodId: primaryFoodIdRaw ? new ObjectId(primaryFoodIdRaw) : null,

          // Preserve the USDA equivalent separately so daily totals can compute a delta
          usdaEquivalentFoodId: usdaEqRaw ? new ObjectId(usdaEqRaw) : null,
          useUSDAEquivalent: useUsdaEq,

          quantity: qty, // { value, unit, isEstimate, ... }

          // Keep a convenient top-level unit for older clients / debugging.
          // Prefer the explicit quantity.unit when present.
          quantityUnit: qtyUnit || it.quantityUnit || "g",

          confidence: typeof it.confidence === "number" ? it.confidence : null,
        };
      })
    : [];

  const doc = {
    userId: userObjectId,
    idempotencyKey: effectiveIdempotencyKey || null,
    loggedAt: loggedAtDate,
    dateKey,
    timezone: tzForMeal,
    description: description || null,
    items: safeItems,
    createdAt: now,
    updatedAt: now
  };

  const result = await userMealsCollection.insertOne(doc);

  // Recompute daily totals immediately so rings update without relying on other code paths.
  // Use the collection's db handle (avoids needing to thread `db` through every caller).
  try {
    const db = userMealsCollection?.db;
    if (db && dateKey) {
      await recomputeDailyNutritionTotals(db, userObjectId, dateKey);
      await recomputeDailyIngredientExposure(db, userObjectId, dateKey);
    } else {
      console.warn("[logUserMeal] skip recompute (missing db/dateKey)", {
        hasDb: Boolean(db),
        dateKey,
      });
    }
  } catch (e) {
    console.error("[logUserMeal] recomputeDailyNutritionTotals failed", e?.message || e);
  }

  // Shape a small response back to the app
  return {
    id: result.insertedId.toString(),
    userId: userIdString,
    loggedAt: loggedAtDate.toISOString(),
    dateKey,
    timezone: doc.timezone,
    description: doc.description,
    items: safeItems.map((it) => ({
      name: it.name,
      foodId: it.foodId ? it.foodId.toString() : null,
      usdaEquivalentFoodId: it.usdaEquivalentFoodId ? it.usdaEquivalentFoodId.toString() : null,
      useUSDAEquivalent: Boolean(it.useUSDAEquivalent),
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
  const userObjectId = coerceObjectId(userId);
  if (!userObjectId) {
    console.warn("[recomputeDailyNutritionTotals] invalid userId", userId);
    return;
  }

  console.log("[recomputeDailyNutritionTotals] userId:", userObjectId.toString(), "dateKey:", dateKey);

  // --- helpers for safe number/unit parsing ---
  const toNumber = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;

    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    // Handle Mongo numeric wrappers (e.g., Decimal128) and other numeric-like objects.
    // We rely on toString() and then Number(...) so this stays dataset-agnostic.
    if (v && typeof v === "object") {
      try {
        const s = typeof v.toString === "function" ? String(v.toString()) : "";
        if (s) {
          const n = Number(s);
          return Number.isFinite(n) ? n : null;
        }
      } catch {
        // ignore
      }
    }

    return null;
  };

  // Debug logging for recompute
  const DEBUG_RECOMPUTE = String(process.env.DEBUG_RECOMPUTE || "").toLowerCase() === "true";
  const debugLog = (...args) => {
    if (DEBUG_RECOMPUTE) console.log(...args);
  };
  const debugWarn = (...args) => {
    if (DEBUG_RECOMPUTE) console.warn(...args);
  };

  const toUnitString = (v) => (typeof v === "string" ? v.trim() : "");
  // Normalize common unit variants so OFF/USDA differences don't silently drop nutrients.
  const normalizeUnit = (u) => {
    const s = String(u || "").trim();
    if (!s) return "";
    const lower = s.toLowerCase();
    if (lower === "ug") return "µg";
    if (lower === "mcg") return "µg";
    if (lower === "iu") return "iu";
    if (lower === "kj") return "kj";
    if (lower === "kcal") return "kcal";
    if (lower === "mg") return "mg";
    if (lower === "g") return "g";
    return s;
  };

  // --- Safe mass-unit conversion (g <-> mg <-> µg) ---
  function unitMultiplier(fromUnit, toUnit) {
    const from = normalizeUnit(fromUnit);
    const to = normalizeUnit(toUnit);
    if (!from || !to) return null;
    if (from === to) return 1;

    // Only support mass conversions here (avoid kcal<->kJ, IU<->µg, etc.)
    const mass = new Set(["g", "mg", "µg"]);
    if (!mass.has(from) || !mass.has(to)) return null;

    const scale = { "g": 1, "mg": 1e-3, "µg": 1e-6 };
    const fromG = scale[from];
    const toG = scale[to];
    if (typeof fromG !== "number" || typeof toG !== "number") return null;

    // Convert value in `from` to `to`:
    // value_to = value_from * (from_in_g / to_in_g)
    return fromG / toG;
  }

  function convertIfNeeded(value, fromUnit, toUnit) {
    if (typeof value !== "number" || Number.isNaN(value)) return null;
    const mult = unitMultiplier(fromUnit, toUnit);
    if (mult == null) return null;
    return value * mult;
  }

  // --- OFF fallback: synthesize a nutrients[] array from food.off_nutriments so serving-based meals work ---
  function getNormalizedNutrientsForFood(food) {
    const arr = Array.isArray(food?.nutrients) ? food.nutrients : [];
    if (arr.length) return arr;

    const off = food?.off_nutriments;
    if (!off || typeof off !== "object") return [];

    const out = [];

    // Helper to push an OFF nutrient (supports both per 100g and per serving)
    const pushOff = (offBaseKey, unifiedKey, fallbackUnit) => {
      const unitRaw = off[`${offBaseKey}_unit`] || fallbackUnit || "";
      const unit = unitRaw ? String(unitRaw) : "";

      // OFF commonly stores *_100g and *_serving.
      // If *_serving is missing, *_value is often present and usually corresponds to serving.
      const per100g = toNumber(off[`${offBaseKey}_100g`]);
      const perServing =
        toNumber(off[`${offBaseKey}_serving`]) ??
        toNumber(off[`${offBaseKey}_value`]) ??
        toNumber(off[offBaseKey]);

      if (per100g == null && perServing == null) return;

      out.push({
        key: unifiedKey,
        unit,
        per_100g: per100g,
        per_serving: perServing,
        source: "off",
        dataQuality: "off",
        confidence: 0.6,
      });
    };

    // OFF key -> our unified nutrient key mapping
    pushOff("energy-kcal", "energy_kcal", "kcal");
    pushOff("proteins", "protein", "g");
    pushOff("carbohydrates", "carbohydrate", "g");
    pushOff("fat", "total_lipid_fat", "g");
    pushOff("sugars", "total_sugars", "g");
    pushOff("fiber", "fiber", "g");
    pushOff("sodium", "sodium", "g");
    pushOff("saturated-fat", "saturated_fat", "g");
    pushOff("salt", "salt", "g");
    pushOff("potassium", "potassium", "g");
    pushOff("calcium", "calcium", "g");
    pushOff("iron", "iron", "g");
    pushOff("vitamin-c", "vitamin_c", "g");
    pushOff("vitamin-a", "vitamin_a", "g");

    return out;
  }

  function foodHasPerServingNutrients(food) {
    // True if food.nutrients has any per-serving values OR OFF has any *_serving fields.
    const nutrientsArr = Array.isArray(food?.nutrients) ? food.nutrients : [];
    const hasPerServing = nutrientsArr.some((n) => {
      const ps = n?.per_serving ?? n?.perServing;
      return toNumber(ps) != null;
    });
    if (hasPerServing) return true;

    const off = food?.off_nutriments;
    if (!off || typeof off !== "object") return false;

    // Cheap check: any key ending with _serving counts as per-serving data available.
    // Also treat *_value as per-serving (OFF often uses *_value for the label/serving value).
    return Object.keys(off).some((k) =>
      typeof k === "string" && (k.endsWith("_serving") || k.endsWith("_value"))
    );
  }

  // 1. Load all meals for this user + date
  const meals = await userMealsCollection
    .find({ userId: userObjectId, dateKey })
    .toArray();

  // --- Drink water from "water" meal items (ml) ---
  // We treat any meal item with name "water" and unit "ml" as drink-water.
  // This allows hydration drops to be logged as meal events (timestamped) while still
  // rolling up into daily totals as water_from_drinks_ml.
  function sumDrinkWaterMl(meals) {
    if (!Array.isArray(meals)) return 0;
    let total = 0;
    for (const meal of meals) {
      const items = Array.isArray(meal?.items) ? meal.items : [];
      for (const it of items) {
        try {
          const name = String(it?.name || "").trim().toLowerCase();
          const unit = String(it?.quantity?.unit || it?.quantityUnit || "").trim().toLowerCase();
          const qty = toNumber(it?.quantity?.value);
          if (name === "water" && unit === "ml" && Number.isFinite(qty) && qty > 0) {
            total += qty;
          }
        } catch {
          // never let a malformed hydration item break recompute
          continue;
        }
      }
    }
    return total;
  }

  const waterFromDrinksMl = sumDrinkWaterMl(meals);

  if (!meals.length) {
    console.log("[recomputeDailyNutritionTotals] no meals for this date, upserting zero totals");

    const now = new Date();
    const emptyTotals = Object.values(DAILY_PANEL_NUTRIENTS).reduce((acc, cfg) => {
      acc[cfg.field] = 0;
      return acc;
    }, {});
    // Add water fields for both buckets
    emptyTotals.water_from_drinks_ml = 0;
    emptyTotals.water_total_ml = 0;
    const emptyTotalsEstimated = { ...emptyTotals };

    await dailyTotalsCollection.updateOne(
      { userId: userObjectId, dateKey },
      {
        $set: {
          totals: emptyTotals,
          totals_estimated: emptyTotalsEstimated,
          timezone: "UTC",
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    return;
  }

  // 2. Aggregate quantities by foodId for that day.
  // We track grams (and ml treated as grams) separately from servings.
  // This allows datasets like OFF that provide per-serving nutrients even when
  // we don't have a reliable grams-per-serving.
  const foodGramsById = new Map();    // foodId string -> grams
  const foodServingsById = new Map(); // foodId string -> serving count
  const servingMetaCache = new Map(); // foodId string -> { gramsPerServing, hasPerServing }
  const normalizedItems = []; // array of { primaryFoodIdStr, grams, servings, usdaEquivalentFoodIdStr, useUSDAEquivalent }

  for (const meal of meals) {
    for (const item of meal.items || []) {
      if (!item.foodId) continue;

      const foodIdStr =
        typeof item.foodId === "string"
          ? item.foodId
          : item.foodId.toString();

      // Read USDA equivalent info
      const usdaEqIdStr = item.usdaEquivalentFoodId
        ? (typeof item.usdaEquivalentFoodId === "string"
            ? item.usdaEquivalentFoodId
            : item.usdaEquivalentFoodId.toString())
        : null;
      const useUsdaEq = Boolean(item.useUSDAEquivalent);

      const qty = item.quantity || {};
      const unitRaw = qty.unit || item.quantityUnit || "g";
      const unit = String(unitRaw || "").trim().toLowerCase();
      const value = toNumber(qty.value);

      debugLog("[recomputeDailyNutritionTotals] item parsed", {
        foodIdStr,
        name: item?.name || null,
        value,
        unit,
        qtyRawUnit: unitRaw,
        qtyRawValue: qty.value,
      });

      // Serving-like units need special handling:
      // - If the food has per-serving nutrients (common for OFF/label), aggregate by servings.
      // - If the food does NOT have per-serving nutrients (common for USDA), convert servings -> grams
      //   using serving_info/default_portion so per-100g nutrients can still roll up.
      const looksLikeServingUnit = unit.startsWith("serv");

      // Cache per-food serving metadata within this recompute run to avoid repeated DB hits.
      // foodIdStr -> { gramsPerServing: number|null, hasPerServing: boolean }
      if (!servingMetaCache) {
        // Defensive: should always exist, but keep this safe.
        // eslint-disable-next-line no-use-before-define
      }

      if (looksLikeServingUnit) {
        const servingsCount = value && value > 0 ? value : 1;

        let meta = servingMetaCache.get(foodIdStr);
        if (!meta) {
          let food = null;
          try {
            food = await foodItemsCollection.findOne({ _id: new ObjectId(foodIdStr) });
          } catch (e) {
            console.error("[recomputeDailyNutritionTotals] serving meta lookup failed", {
              foodIdStr,
              error: e?.message || e,
            });
          }

          let gramsPerServing = null;

          if (
            food &&
            food.serving_info &&
            typeof food.serving_info.serving_size === "number"
          ) {
            const servingUnit = String(food.serving_info.serving_size_unit || "").toLowerCase();
            if (servingUnit === "g" || servingUnit === "gram" || servingUnit === "grams") {
              gramsPerServing = food.serving_info.serving_size;
            }
          }

          if (
            gramsPerServing == null &&
            food &&
            food.default_portion &&
            typeof food.default_portion.gram_weight === "number"
          ) {
            gramsPerServing = food.default_portion.gram_weight;
          }

          // Detect whether this food actually has per-serving nutrients available
          const hasPerServing = foodHasPerServingNutrients(food);

          meta = { gramsPerServing, hasPerServing };
          servingMetaCache.set(foodIdStr, meta);
          debugLog("[recomputeDailyNutritionTotals] serving meta", {
            foodIdStr,
            gramsPerServing,
            hasPerServing,
            hasOff: Boolean(food?.off_nutriments),
            nutrientsCount: Array.isArray(food?.nutrients) ? food.nutrients.length : 0,
          });
        }

        if (meta.hasPerServing) {
          // For label/OCR foods we often have per-serving nutrients, so we aggregate the PRIMARY food by servings.
          // However, USDA equivalents are usually per-100g only (per_serving often null), so for the USDA-delta
          // path we ALSO need a grams value for the same consumed amount.
          const gramsForUsda =
            typeof meta.gramsPerServing === "number" && meta.gramsPerServing > 0
              ? meta.gramsPerServing * servingsCount
              : 0;

          debugLog("[recomputeDailyNutritionTotals] servings+perServing", {
            foodIdStr,
            servingsCount,
            gramsForUsda,
            meta,
          });

          const prevServ = foodServingsById.get(foodIdStr) || 0;
          foodServingsById.set(foodIdStr, prevServ + servingsCount);

          // Push normalized entry with BOTH servings (for primary per-serving nutrients)
          // and grams (so USDA per-100g nutrients can be computed for delta).
          normalizedItems.push({
            primaryFoodIdStr: foodIdStr,
            grams: gramsForUsda,
            servings: servingsCount,
            usdaEquivalentFoodIdStr: usdaEqIdStr,
            useUSDAEquivalent: useUsdaEq,
          });

          if (useUsdaEq && usdaEqIdStr && (!gramsForUsda || Number.isNaN(gramsForUsda))) {
            debugWarn("[recomputeDailyNutritionTotals] USDA delta may be skipped (missing gramsPerServing)", {
              foodIdStr,
              usdaEqIdStr,
              servingsCount,
              gramsPerServing: meta.gramsPerServing,
            });
          }

          continue;
        }

        // No per-serving nutrients: convert serving count -> grams so per-100g can be used.
        if (typeof meta.gramsPerServing === "number" && meta.gramsPerServing > 0) {
          const gramsToAdd = meta.gramsPerServing * servingsCount;
          debugLog("[recomputeDailyNutritionTotals] servings->grams fallback", {
            foodIdStr,
            servingsCount,
            gramsPerServing: meta.gramsPerServing,
            gramsToAdd,
          });
          const prev = foodGramsById.get(foodIdStr) || 0;
          foodGramsById.set(foodIdStr, prev + gramsToAdd);
          // Push normalized entry for fallback grams
          normalizedItems.push({
            primaryFoodIdStr: foodIdStr,
            grams: gramsToAdd,
            servings: 0,
            usdaEquivalentFoodIdStr: usdaEqIdStr,
            useUSDAEquivalent: useUsdaEq,
          });
        }

        // Whether we converted or not, we're done with this item.
        continue;
      }

      let gramsToAdd = 0;

      // Case 1: explicit grams
      if (value && unit === "g") {
        gramsToAdd = value;

      // Case 1b: explicit milliliters
      // For now, treat 1 mL ≈ 1 g (good approximation for water/coffee-like liquids).
      // Later we can add food-specific density if needed.
      } else if (value && unit === "ml") {
        gramsToAdd = value;

      } else {
        // Case 2: fallback to serving size (grams-per-serving) when:
        //  - unit is not grams/ml and we still want a best-effort conversion
        // NOTE: OFF may not have grams-per-serving; that's why we also support explicit serving units above.
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

          const servingsCount = value && value > 0 ? value : 1;
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
      // Push normalized entry for grams path
      normalizedItems.push({
        primaryFoodIdStr: foodIdStr,
        grams: gramsToAdd,
        servings: 0,
        usdaEquivalentFoodIdStr: usdaEqIdStr,
        useUSDAEquivalent: useUsdaEq,
      });
    }
  }

  if (!foodGramsById.size && !foodServingsById.size && !normalizedItems.length) {
    console.log("[recomputeDailyNutritionTotals] no gram- or serving-based quantities found, writing zero totals");
    const now = new Date();
    const emptyTotals = Object.values(DAILY_PANEL_NUTRIENTS).reduce((acc, cfg) => {
      acc[cfg.field] = 0;
      return acc;
    }, {});
    emptyTotals.water_from_drinks_ml = 0;
    emptyTotals.water_total_ml = 0;
    const emptyTotalsEstimated = { ...emptyTotals };

    await dailyTotalsCollection.updateOne(
      { userId: userObjectId, dateKey },
      {
        $set: {
          totals: emptyTotals,
          totals_estimated: emptyTotalsEstimated,
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
  // Union foodGramsById keys, foodServingsById keys, and any usdaEquivalentFoodIdStr in normalizedItems
  const allFoodIds = Array.from(
    new Set([
      ...foodGramsById.keys(),
      ...foodServingsById.keys(),
      ...normalizedItems.map(e => e.usdaEquivalentFoodIdStr).filter(Boolean),
    ])
  );
  const foodObjectIds = allFoodIds.map((id) => new ObjectId(id));
  const foods = await foodItemsCollection
    .find({ _id: { $in: foodObjectIds } })
    .toArray();

  // 4. Initialize daily totals for both buckets
  const totals = Object.values(DAILY_PANEL_NUTRIENTS).reduce((acc, cfg) => {
    acc[cfg.field] = 0;
    return acc;
  }, {});
  const totals_estimated = Object.values(DAILY_PANEL_NUTRIENTS).reduce((acc, cfg) => {
    acc[cfg.field] = 0;
    return acc;
  }, {});

  // Helpers for both buckets
  const addToTotals = (field, value) => {
    if (typeof value !== "number" || Number.isNaN(value)) return;
    totals[field] += value;
  };
  const addToTotalsEstimated = (field, value) => {
    if (typeof value !== "number" || Number.isNaN(value)) return;
    totals_estimated[field] += value;
  };

  // Build a per-food contribution map for this specific consumed amount.
  // Returns { byFieldAll, byFieldMain, byFieldEstimated } where:
  // - byFieldAll includes ALL contributions regardless of estimated/confidence
  // - byFieldMain includes only non-estimated contributions
  // - byFieldEstimated includes only estimated contributions
  function computeContributionMapsForFood(food, grams, servings) {
    const byFieldAll = {};
    const byFieldMain = {};
    const byFieldEstimated = {};

    const factor = grams ? grams / 100.0 : 0;
    const nutrients = getNormalizedNutrientsForFood(food);

    for (const nutrient of nutrients) {
      try {
        const nutrientKey = typeof nutrient?.key === "string" ? nutrient.key : "";
        if (!nutrientKey) continue;

        const cfg = DAILY_PANEL_NUTRIENTS[nutrientKey];
        if (!cfg) continue;

        const unit = normalizeUnit(toUnitString(nutrient.unit));
        const expectedUnit = normalizeUnit(cfg.unit);

        let per100g = toNumber(nutrient.per_100g ?? nutrient.per100g);
        let perServing = toNumber(nutrient.per_serving ?? nutrient.perServing);

        if (expectedUnit && unit && String(unit) !== String(expectedUnit)) {
          const canConvert100g = per100g != null && convertIfNeeded(per100g, unit, expectedUnit) != null;
          const canConvertServing = perServing != null && convertIfNeeded(perServing, unit, expectedUnit) != null;

          if (!canConvert100g && !canConvertServing) continue;

          if (per100g != null) {
            const converted = convertIfNeeded(per100g, unit, expectedUnit);
            if (converted != null) per100g = converted;
          }
          if (perServing != null) {
            const converted = convertIfNeeded(perServing, unit, expectedUnit);
            if (converted != null) perServing = converted;
          }
        }

        const src = toUnitString(nutrient.source).toLowerCase();
        const dq = toUnitString(nutrient.dataQuality ?? nutrient.data_quality).toLowerCase();
        const conf = toNumber(nutrient.confidence);
        const isEstimated = src === "off" || dq === "off" || (conf != null && conf < 0.9);

        let contribution = null;
        if (servings && typeof perServing === "number") {
          contribution = perServing * servings;
        } else if (grams && typeof per100g === "number") {
          contribution = per100g * factor;
        }

        if (typeof contribution !== "number" || Number.isNaN(contribution)) continue;

        // water is stored as mL (1 g ~ 1 mL)
        if (nutrientKey === "water" && cfg.field === "water_from_food_ml") {
          contribution = contribution * 1;
        }

        byFieldAll[cfg.field] = (byFieldAll[cfg.field] || 0) + contribution;
        if (isEstimated) {
          byFieldEstimated[cfg.field] = (byFieldEstimated[cfg.field] || 0) + contribution;
        } else {
          byFieldMain[cfg.field] = (byFieldMain[cfg.field] || 0) + contribution;
        }
      } catch {
        continue;
      }
    }

    return { byFieldAll, byFieldMain, byFieldEstimated };
  }

  function addMapInto(targetAdder, map) {
    for (const [field, value] of Object.entries(map || {})) {
      targetAdder(field, value);
    }
  }

  function addDeltaIntoEstimated(primaryAll, usdaAll) {
    for (const field of Object.keys(totals)) {
      const hasPrimary = Object.prototype.hasOwnProperty.call(primaryAll || {}, field);
      const hasUsda = Object.prototype.hasOwnProperty.call(usdaAll || {}, field);

      const p = hasPrimary ? Number(primaryAll?.[field]) : 0;
      const u = hasUsda ? Number(usdaAll?.[field]) : 0;

      // If USDA has a value but the primary food doesn't provide this nutrient at all,
      // treat the USDA value as an estimated enrichment.
      if (!hasPrimary && hasUsda && Number.isFinite(u) && u > 0) {
        addToTotalsEstimated(field, u);
        continue;
      }

      // Otherwise, only add the positive delta (USDA - primary).
      const delta = u - p;
      if (Number.isFinite(delta) && delta > 0) {
        addToTotalsEstimated(field, delta);
      }
    }
  }

  // 5. Aggregate nutrients per logged meal item so we can apply USDA-delta estimates
  const foodsById = new Map(foods.map((f) => [f._id.toString(), f]));

  for (const entry of normalizedItems) {
    const primaryFood = foodsById.get(entry.primaryFoodIdStr);
    if (!primaryFood) continue;

    const grams = Number(entry.grams || 0);
    const servings = Number(entry.servings || 0);

    const primaryMaps = computeContributionMapsForFood(primaryFood, grams, servings);

    // Add primary contributions into their respective buckets
    addMapInto(addToTotals, primaryMaps.byFieldMain);
    addMapInto(addToTotalsEstimated, primaryMaps.byFieldEstimated);

    // If user chose USDA equivalent, add ONLY the positive difference (USDA - primary) into estimated
    if (entry.useUSDAEquivalent && entry.usdaEquivalentFoodIdStr) {
      const usdaFood = foodsById.get(entry.usdaEquivalentFoodIdStr);
      if (usdaFood) {
        const usdaMaps = computeContributionMapsForFood(usdaFood, grams, servings);
        addDeltaIntoEstimated(primaryMaps.byFieldAll, usdaMaps.byFieldAll);
      }
    }
  }

  // 6. Round totals to something sane (e.g. 1 decimal place) for both buckets
  for (const [k, v] of Object.entries(totals)) {
    totals[k] = Math.round((v + Number.EPSILON) * 10) / 10;
  }
  for (const [k, v] of Object.entries(totals_estimated)) {
    totals_estimated[k] = Math.round((v + Number.EPSILON) * 10) / 10;
  }
  // Tiny cleanup so we don't store -0
  for (const [k, v] of Object.entries(totals)) {
    if (Object.is(v, -0)) totals[k] = 0;
  }
  for (const [k, v] of Object.entries(totals_estimated)) {
    if (Object.is(v, -0)) totals_estimated[k] = 0;
  }

  // Merge drink-water into daily totals and keep a combined total.
  totals.water_from_drinks_ml = Math.round((waterFromDrinksMl + Number.EPSILON) * 10) / 10;
  totals.water_total_ml = (Number(totals.water_from_food_ml) || 0) + (Number(totals.water_from_drinks_ml) || 0);
  // For estimated, only add water_from_food_ml (from estimated bucket); drinks only go to main bucket
  totals_estimated.water_from_drinks_ml = 0;
  totals_estimated.water_total_ml = Number(totals_estimated.water_from_food_ml) || 0;

  debugLog("[recomputeDailyNutritionTotals] water merge", {
    dateKey,
    waterFromDrinksMl,
    water_from_food_ml: totals.water_from_food_ml,
    water_from_drinks_ml: totals.water_from_drinks_ml,
    water_total_ml: totals.water_total_ml,
    est_water_from_food_ml: totals_estimated.water_from_food_ml,
    est_water_total_ml: totals_estimated.water_total_ml,
  });

  debugLog("[recomputeDailyNutritionTotals] totals snapshot", {
    dateKey,
    totals,
    totals_estimated,
    foodsCount: foods.length,
    gramsFoods: foodGramsById.size,
    servingFoods: foodServingsById.size,
  });

  // 7. Upsert into user_daily_totals
  const now = new Date();
  const update = {
    $set: {
      totals,
      totals_estimated,
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

// --- Ingredient exposure (count-only) ---
function normalizeIngredientToken(raw) {
  if (raw == null) return null;

  // If a parser stored ingredient tokens as objects, extract a usable string.
  // This prevents keys like "[object Object]" from polluting exposure maps.
  let candidate = raw;
  if (candidate && typeof candidate === "object") {
    const name =
      (typeof candidate.name === "string" && candidate.name) ||
      (typeof candidate.text === "string" && candidate.text) ||
      (typeof candidate.value === "string" && candidate.value) ||
      (typeof candidate.label === "string" && candidate.label) ||
      null;

    if (name) {
      candidate = name;
    } else {
      return null;
    }
  }

  let s = String(candidate).toLowerCase();

  s = s.replace(/^[\s,;:.\-]+/, "");
  s = s.replace(/[\s,;:.\-]+$/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;

  if (s.startsWith("(") && s.endsWith(")") && s.length > 2) {
    s = s.slice(1, -1).trim();
  }

  return s || null;
}

function splitIngredientsTextSimple(ingredientsText) {
  const text = typeof ingredientsText === "string" ? ingredientsText : "";
  if (!text.trim()) return { definite: [], mayContain: [] };

  const lower = text.toLowerCase();
  const idx = lower.indexOf("may contain");

  let definiteText = text;
  let mayText = "";

  if (idx >= 0) {
    definiteText = text.slice(0, idx);
    mayText = text.slice(idx);
  }

  const parseList = (s) => {
    const cleaned = String(s || "")
      .replace(/may contain\s*:?/i, "")
      .replace(/contains\s*:?/i, "")
      .replace(/[.]+/g, ",")
      .trim();

    const parts = cleaned.split(/[,;]+/g);
    const out = [];
    for (const p of parts) {
      const t = normalizeIngredientToken(p);
      if (t) out.push(t);
    }
    return out;
  };

  return {
    definite: parseList(definiteText),
    mayContain: parseList(mayText),
  };
}

function extractIngredientsFromFoodDoc(food) {
  const parsed = Array.isArray(food?.ingredients_parsed) ? food.ingredients_parsed : [];
  const parsedNorm = parsed.map(normalizeIngredientToken).filter(Boolean);

  if (parsedNorm.length) {
    return { definite: parsedNorm, mayContain: [] };
  }

  const text = typeof food?.ingredients_text === "string" ? food.ingredients_text : null;
  if (text && text.trim()) {
    return splitIngredientsTextSimple(text);
  }

  return { definite: [], mayContain: [] };
}

function bumpCounts(map, tokens) {
  if (!tokens || !tokens.length) return;
  const unique = new Set(tokens); // count ingredient once per meal item
  for (const t of unique) {
    map.set(t, (map.get(t) || 0) + 1);
  }
}

export async function recomputeDailyIngredientExposure(db, userId, dateKey) {
  if (!db) throw new Error("DB not ready");
  if (!userId || !dateKey) return;

  const userObjectId = coerceObjectId(userId);
  if (!userObjectId) {
    console.warn("[recomputeDailyIngredientExposure] invalid userId", userId);
    return;
  }

  const dailyTotalsCollection = db.collection("user_daily_totals");

  // Load meals
  const meals = await userMealsCollection.find({ userId: userObjectId, dateKey }).toArray();
  const now = new Date();

  if (!meals.length) {
    await dailyTotalsCollection.updateOne(
      { userId: userObjectId, dateKey },
      {
        $set: {
          ingredients_exposure: {},
          ingredients_exposure_may_contain: {},
          ingredients_exposure_meta: {
            uniqueCount: 0,
            uniqueMayContainCount: 0,
            totalMentions: 0,
            totalMayContainMentions: 0,
            updatedAt: now,
          },
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
    return;
  }

  // Collect food ids referenced in meals (primary + optional USDA equivalents)
  const foodIdSet = new Set();
  const itemRefs = [];

  for (const meal of meals) {
    const items = Array.isArray(meal?.items) ? meal.items : [];
    for (const it of items) {
      if (!it?.foodId) continue;

      const primaryIdStr = typeof it.foodId === "string" ? it.foodId : it.foodId.toString();
      const usdaEqIdStr = it.usdaEquivalentFoodId
        ? (typeof it.usdaEquivalentFoodId === "string"
            ? it.usdaEquivalentFoodId
            : it.usdaEquivalentFoodId.toString())
        : null;

      const useUsdaEq = Boolean(it.useUSDAEquivalent);

      foodIdSet.add(primaryIdStr);
      if (usdaEqIdStr) foodIdSet.add(usdaEqIdStr);

      itemRefs.push({ primaryIdStr, usdaEqIdStr, useUsdaEq });
    }
  }

  const foodObjectIds = Array.from(foodIdSet)
    .filter((id) => typeof id === "string" && ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const foods = await foodItemsCollection
    .find(
      { _id: { $in: foodObjectIds } },
      { projection: { ingredients_parsed: 1, ingredients_text: 1 } }
    )
    .toArray();

  const foodsById = new Map(foods.map((f) => [f._id.toString(), f]));

  const exposure = new Map();
  const exposureMay = new Map();

  for (const ref of itemRefs) {
    const primaryFood = foodsById.get(ref.primaryIdStr);
    if (!primaryFood) continue;

    let { definite, mayContain } = extractIngredientsFromFoodDoc(primaryFood);

    // If primary has none and USDA equivalent is enabled, fall back to USDA ingredients
    if ((!definite?.length && !mayContain?.length) && ref.useUsdaEq && ref.usdaEqIdStr) {
      const usdaFood = foodsById.get(ref.usdaEqIdStr);
      if (usdaFood) {
        const extracted = extractIngredientsFromFoodDoc(usdaFood);
        definite = extracted.definite;
        mayContain = extracted.mayContain;
      }
    }

    bumpCounts(exposure, definite);
    bumpCounts(exposureMay, mayContain);
  }

  const exposureObj = Object.fromEntries(exposure.entries());
  const exposureMayObj = Object.fromEntries(exposureMay.entries());

  const meta = {
    uniqueCount: Object.keys(exposureObj).length,
    uniqueMayContainCount: Object.keys(exposureMayObj).length,
    totalMentions: Object.values(exposureObj).reduce((a, b) => a + (Number(b) || 0), 0),
    totalMayContainMentions: Object.values(exposureMayObj).reduce((a, b) => a + (Number(b) || 0), 0),
    updatedAt: now,
  };

  await dailyTotalsCollection.updateOne(
    { userId: userObjectId, dateKey },
    {
      $set: {
        ingredients_exposure: exposureObj,
        ingredients_exposure_may_contain: exposureMayObj,
        ingredients_exposure_meta: meta,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  console.log("[recomputeDailyIngredientExposure] upserted", {
    userId: userObjectId.toString(),
    dateKey,
    unique: meta.uniqueCount,
    uniqueMay: meta.uniqueMayContainCount,
  });
}


function normalizeDateKey(dateKey) {
  // Expect YYYY-MM-DD
  if (!dateKey || typeof dateKey !== "string") return null;
  const trimmed = dateKey.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

function safeString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function mapUserMealDoc(doc) {
  if (!doc) return null;

  // Prefer "humanized" names if present (your pipeline sets common_name / display_product_name)
  const commonName =
    safeString(doc.common_name) ||
    safeString(doc.display_product_name) ||
    safeString(doc.name) ||
    safeString(doc.canonicalName) ||
    safeString(doc.canonical_name) ||
    safeString(doc.originalPhrase) ||
    safeString(doc.original_phrase) ||
    "Unknown item";

  return {
    id: doc._id?.toString?.() ?? null,
    dateKey: safeString(doc.dateKey) || null,
    loggedAt: doc.loggedAt || null,
    common_name: commonName,

    // Pass-through fields that help the UI show the “category” context
    kind: safeString(doc.kind) || null,
    is_simple_ingredient:
      typeof doc.is_simple_ingredient === "boolean"
        ? doc.is_simple_ingredient
        : null,
    preparation_context: safeString(doc.preparation_context) || null,
    is_restaurant_item:
      typeof doc.is_restaurant_item === "boolean"
        ? doc.is_restaurant_item
        : null,
    restaurant_chain: safeString(doc.restaurant_chain) || null,

    // Quantity (shape from MealParser output)
    quantity:
      doc.quantity && typeof doc.quantity === "object"
        ? {
            value: typeof doc.quantity.value === "number" ? doc.quantity.value : null,
            unit: safeString(doc.quantity.unit) || null,
            isEstimate:
              typeof doc.quantity.isEstimate === "boolean"
                ? doc.quantity.isEstimate
                : null,
            basis: safeString(doc.quantity.basis) || null,
            confidence:
              typeof doc.quantity.confidence === "number"
                ? doc.quantity.confidence
                : null,
          }
        : null,

    // Useful for debugging / future work
    food_item_id:
      safeString(doc.food_item_id) || safeString(doc.foodItemId) || null,
  };
}

/**
 * Fetch user_meals rows for a given user + dateKey (YYYY-MM-DD)
 * Used by DailyMealView.swift.
 */
export async function getUserMealsForDate(db, userId, dateKey, opts = {}) {
  if (!db) throw new Error("DB not ready");

  const userObjectId = coerceObjectId(userId);
  if (!userObjectId) {
    const err = new Error("Invalid userId");
    err.statusCode = 400;
    throw err;
  }

  const normalizedDateKey = normalizeDateKey(dateKey);
  if (!normalizedDateKey) {
    const err = new Error("Missing or invalid 'dateKey' (expected YYYY-MM-DD)");
    err.statusCode = 400;
    throw err;
  }

  const limit = Number.isFinite(Number(opts.limit))
    ? Math.max(1, Math.min(500, Number(opts.limit)))
    : 200;

  // NOTE: Some older docs might not have loggedAt; createdAt fallback keeps ordering sane.
  const docs = await userMealsCollection
    .find({ userId: userObjectId, dateKey: normalizedDateKey })
    .sort({ loggedAt: 1, createdAt: 1, _id: 1 })
    .limit(limit)
    .toArray();

  return {
    ok: true,
    dateKey: normalizedDateKey,
    count: docs.length,
    meals: docs.map(mapUserMealDoc).filter(Boolean),
  };
}

/**
 * Delete a single user_meals row by id.
 * For now we also recompute daily totals for that meal's dateKey so the rings update correctly.
 */
export async function deleteUserMeal(db, userId, mealId) {
  if (!db) throw new Error("DB not ready");

  const userObjectId = coerceObjectId(userId);
  if (!userObjectId) {
    const err = new Error("Invalid userId");
    err.statusCode = 400;
    throw err;
  }

  if (!mealId || typeof mealId !== "string" || !ObjectId.isValid(mealId)) {
    const err = new Error("Missing or invalid 'mealId'");
    err.statusCode = 400;
    throw err;
  }

  const mealObjectId = new ObjectId(mealId);

  // Load the meal first so we know which day to recompute.
  const existing = await userMealsCollection.findOne({
    _id: mealObjectId,
    userId: userObjectId,
  });

  if (!existing) {
    return { ok: true, deletedCount: 0 };
  }

  const dateKey = safeString(existing.dateKey);

  const result = await userMealsCollection.deleteOne({
    _id: mealObjectId,
    userId: userObjectId,
  });

  // Keep the daily rings / totals in sync
  if (dateKey) {
    try {
      await recomputeDailyNutritionTotals(db, userObjectId, dateKey);
      await recomputeDailyIngredientExposure(db, userObjectId, dateKey);
    } catch (e) {
      console.error("[deleteUserMeal] recompute failed", e?.message || e);
    }
  }

  return {
    ok: true,
    deletedCount: result.deletedCount ?? 0,
    dateKey: dateKey || null,
  };
}
