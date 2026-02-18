// services/enrich.js
import { ObjectId } from "mongodb";

/**
 * Build a Mongo-ready user-enriched food doc.
 * - Preserves GPT-provided alt_names, adds deterministic corrected aliases
 * - Normalizes normalized_name from FINAL brand+product
 * - Stamps source.submitted_by_device and best-effort source.submitted_by_userId
 */
export async function buildUserEnrichedDoc(payload, headers, db) {
  const { rawGPTData } = payload || {};
  // Accept both client shapes: `user_submission` (snake) and `userSubmission` (camel)
  const userSubmission = (payload && (payload.user_submission || payload.userSubmission)) || null;

  if (!rawGPTData || typeof rawGPTData !== "object") {
    throw new Error("Missing or invalid 'rawGPTData' in request body");
  }

  // --- Normalization helpers for alt_names and canonical fields ---
  const normalizeForSearch = (v) => {
    if (v == null) return "";
    return String(v)
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const buildDeterministicAltNames = ({ brandName, productName, commonName }) => {
    const out = [];
    const b = normalizeForSearch(brandName);
    const p = normalizeForSearch(productName);
    const c = normalizeForSearch(commonName);

    if (p) out.push(p);
    if (c && c !== p) out.push(c);
    if (b && p) out.push(`${b} ${p}`);
    if (b && c) out.push(`${b} ${c}`);

    return out;
  };

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
    submitted_at: (() => {
      const v = userSubmission && (userSubmission.submittedAt || userSubmission.submitted_at);
      return v ? new Date(v) : new Date();
    })(),
    submitted_by_device: (() => {
      // Prefer explicit user submission device id (camel or snake)
      const fromUserSubmission =
        userSubmission && (userSubmission.submittedByDevice || userSubmission.submitted_by_device);

      // Allow top-level body deviceId (some clients may send this)
      const fromBody = payload && payload.deviceId ? payload.deviceId : null;

      // Allow header fallback
      const fromHeader =
        headers["x-device-id"] ||
        headers["X-Device-Id"] ||
        headers["x-deviceid"] ||
        headers["X-DeviceID"];

      const chosen = fromUserSubmission || fromBody || fromHeader || null;
      return chosen ? String(chosen).trim() : undefined;
    })(),
    note: userSubmission && userSubmission.note ? userSubmission.note : undefined,
  };

  // Best-effort: resolve the submitting userId from submitted_by_device and stamp it on the source.
  // This enables future moderation and attribution even if deviceId policies change.
  try {
    const deviceIdForUserLookup = source.submitted_by_device;
    if (db && deviceIdForUserLookup) {
      const usersCol = db.collection("users");
      const user = await usersCol.findOne(
        { deviceId: String(deviceIdForUserLookup).trim() },
        { projection: { _id: 1 } }
      );
      if (user && user._id) {
        source.submitted_by_userId = String(user._id);
      }
    }
  } catch (err) {
    console.warn("[User-Enriched] Failed resolving submitted_by_userId:", err);
  }

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

  // --- Parse low-confidence quantified ingredient estimates (if provided by GPT) ---
  // GPT stores a minified JSON string at: health_flags.ingredients_amounts_estimate_v1
  // We parse and store a structured copy on the doc for downstream deterministic enrichment.
  try {
    const hf = docToInsert && docToInsert.health_flags && typeof docToInsert.health_flags === "object" ? docToInsert.health_flags : null;
    const nonFood = hf && (hf.non_food_suspected === true || hf.nonFoodSuspected === true);

    if (!nonFood) {
      const raw = hf && typeof hf.ingredients_amounts_estimate_v1 === "string" ? hf.ingredients_amounts_estimate_v1.trim() : "";
      if (raw) {
        const parsed = JSON.parse(raw);

        const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
        const unit = parsed && typeof parsed.unit === "string" ? parsed.unit : "g_per_100g";
        const version = parsed && Number.isFinite(parsed.version) ? parsed.version : 1;
        const method = parsed && typeof parsed.method === "string" ? parsed.method : "ranked_weighting_v1";
        const basis = parsed && typeof parsed.basis === "string" ? parsed.basis : "ingredient_order_only";

        if (items && items.length > 0) {
          // Normalize and validate items
          const cleanedItems = [];
          for (const it of items) {
            if (!it || typeof it !== "object") continue;

            const name = typeof it.name === "string" ? it.name.trim() : "";
            const g = typeof it.g === "number" && Number.isFinite(it.g) ? it.g : null;
            const conf = typeof it.confidence === "number" && Number.isFinite(it.confidence) ? it.confidence : null;

            if (!name || g == null) continue;
            if (g < 0 || g > 100) continue;

            // Bound confidence to the low-confidence range we expect
            const boundedConf = conf == null ? null : Math.max(0.0, Math.min(0.6, conf));

            cleanedItems.push({
              name,
              g: Math.round(g * 10) / 10, // keep 0.1g resolution
              confidence: boundedConf == null ? undefined : boundedConf,
            });
          }

          const sum = cleanedItems.reduce((acc, it) => acc + (typeof it.g === "number" ? it.g : 0), 0);

          // Accept within ±0.5g rounding tolerance.
          if (cleanedItems.length > 0 && Math.abs(sum - 100) <= 0.5) {
            docToInsert.ingredients_amounts_estimate_v1 = {
              version,
              method,
              basis,
              unit,
              items: cleanedItems,
            };

            docToInsert.ingredients_amounts_estimation_meta = {
              version: 1,
              parsed_at: now,
              source: "gpt",
              note: "Low-confidence ingredient grams-per-100g estimate parsed from health_flags.ingredients_amounts_estimate_v1",
            };
          }
        }
      }
    }
  } catch (e) {
    // If parsing fails, just omit the structured estimate (non-fatal)
    console.warn("[User-Enriched] Failed parsing ingredients_amounts_estimate_v1:", e);
  }

  // --- Finalize canonical + alias fields using the FINAL corrected identity ---
  // Keep any GPT-provided semantic aliases (even if misspelled), but ensure
  // corrected brand/product spellings are always included.
  try {
    const finalBrandName = docToInsert?.brand?.name || "";
    const finalProductName = docToInsert?.display_product_name || docToInsert?.name || "";

    // Canonical normalized_name should reflect corrected brand + product name.
    const canonicalNormalized = normalizeForSearch(
      [finalBrandName, finalProductName].filter(Boolean).join(" ")
    );
    if (canonicalNormalized) {
      docToInsert.normalized_name = canonicalNormalized;
    }

    // Merge existing (GPT) alt_names with deterministic corrected aliases.
    const existingAlt = Array.isArray(docToInsert.alt_names) ? docToInsert.alt_names : [];
    const correctedAlt = buildDeterministicAltNames({
      brandName: finalBrandName,
      productName: finalProductName,
      commonName: docToInsert.common_name,
    });

    const merged = new Set();
    for (const a of existingAlt) {
      const n = normalizeForSearch(a);
      if (n) merged.add(n);
    }
    for (const a of correctedAlt) {
      const n = normalizeForSearch(a);
      if (n) merged.add(n);
    }

    // Keep a reasonable cap so docs don't grow unbounded.
    docToInsert.alt_names = Array.from(merged).slice(0, 20);

    // Keep normalized_common_name consistent if common_name is present.
    if (docToInsert.common_name) {
      const ncc = normalizeForSearch(docToInsert.common_name);
      if (ncc) docToInsert.normalized_common_name = ncc;
    }
  } catch (e) {
    console.warn("[User-Enriched] Failed to finalize normalized/alt fields:", e);
  }

  return docToInsert;
}

// Ensure that each parsed ingredient has a corresponding simple-ingredient entry.
// Simple ingredients live in the same collection as docs with:
//   type: "ingredient", is_simple_ingredient: true
export async function ensureSimpleIngredientsFromParsedList(
  db,
  ingredientsParsed,
  normalizedUPC16,
  sourceTag
) {
  if (!db) return;
  const foodsCollectionName =
    process.env.MONGODB_COLLECTION_FOODS ||
    process.env.MONGODB_COLLECTION_FOOD_ITEMS ||
    "food_items";
  const collection = db.collection(foodsCollectionName);

  if (!Array.isArray(ingredientsParsed) || ingredientsParsed.length === 0) return;

  const now = new Date();
  const normalized = normalizedUPC16 || null;

  // 1. Skip entirely if we've already indexed simple ingredients for this UPC
  if (normalized) {
    const alreadyIndexed = await collection.findOne({
      normalized_upc_16: normalized,
      ingredients_indexed_for_simple: true,
    });

    if (alreadyIndexed) {
      console.log(
        "[Ingredients] Simple ingredients already indexed for product",
        normalized
      );
      return;
    }
  }

  const normalizeName = (s) => {
    if (!s || typeof s !== "string") return null;
    return s
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  };

  // Build a unique set of normalized ingredient names
  const normalizedNamesSet = new Set();
  for (const raw of ingredientsParsed) {
    const norm = normalizeName(raw);
    if (!norm) continue;
    normalizedNamesSet.add(norm);
  }

  const normalizedNames = Array.from(normalizedNamesSet);
  if (normalizedNames.length === 0) return;

  // Look up which of these normalized names already exist as either a confirmed
  // simple ingredient or a potential simple ingredient stub created from
  // previous product ingredient parsing.
  const existing = await collection
    .find({
      normalized_name: { $in: normalizedNames },
      $or: [
        { is_simple_ingredient: true },
        { is_potential_simple_ingredient: true },
      ],
    })
    .project({ normalized_name: 1 })
    .toArray();

  const existingSet = new Set(existing.map((doc) => doc.normalized_name));

  const docsToInsert = [];

  for (const norm of normalizedNames) {
    if (existingSet.has(norm)) continue; // already have this simple ingredient

    // Find a representative original string to use as the display name
    const original =
      ingredientsParsed.find((raw) => normalizeName(raw) === norm) || norm;

    docsToInsert.push({
      type: "ingredient",
      // These are *not* confirmed canonical simple ingredients yet.
      // They are potential simple ingredients inferred from product labels,
      // and will later go through a verification/enrichment process before
      // being promoted to is_simple_ingredient: true.
      is_potential_simple_ingredient: true,
      enriched: false, // stub; to be enriched by GPT later
      name: original,
      normalized_name: norm,
      first_seen: {
        normalized_upc_16: normalized,
        source: sourceTag || "user_enriched_canadian_product",
        at: now,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  if (docsToInsert.length > 0) {
    try {
      await collection.insertMany(docsToInsert, { ordered: false });
      console.log(
        "[Ingredients] Inserted",
        docsToInsert.length,
        "new simple ingredients from product",
        normalized
      );
    } catch (ingErr) {
      console.error("[Ingredients] Error inserting simple ingredients:", ingErr);
    }
  } else {
    console.log(
      "[Ingredients] No new simple ingredients to insert for product",
      normalized
    );
  }

  // 2. Mark this UPC as "indexed for simple ingredients" so we don't do this again
  if (normalized) {
    try {
      await collection.updateMany(
        { normalized_upc_16: normalized },
        { $set: { ingredients_indexed_for_simple: true } }
      );
      console.log(
        "[Ingredients] Marked UPC as indexed for simple ingredients:",
        normalized
      );
    } catch (flagErr) {
      console.error(
        "[Ingredients] Error marking UPC as ingredients_indexed_for_simple:",
        flagErr
      );
    }
  }
}
