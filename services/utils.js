// services/utils.js

// Helper: Coerce userId to the same type used in Mongo (ObjectId when possible, else string)
export function coerceUserIdValue(userId) {
  const s = String(userId || "").trim();
  if (s && ObjectId.isValid(s)) {
    try {
      return new ObjectId(s);
    } catch {
      // fall through to string
    }
  }
  return s;
}

export function notIgnoredQuery() {
  return { "moderation.is_ignored": { $ne: true } };
}

export function safeTrimString(v) {
  if (v == null) return "";
  return String(v).trim();
}

export function hasNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

export function isBarcodeLockedParsedMealItem(it) {
  if (!it || typeof it !== "object") return false;
  const bc = String(it.barcode || it.upc || "").trim();
  const confirmed = !!(it.is_barcode_confirmed || it.isBarcodeConfirmed);
  return confirmed || bc.length > 0;
}

export function normalizeBarcodeTo16(raw) {
  const cleaned = String(raw || "").replace(/\D/g, "");
  return cleaned ? cleaned.padStart(16, "0") : "";
}

export function isLikelyDvBoilerplate(text) {
  const t = safeTrimString(text).toLowerCase();
  if (!t) return false;
  // Common Canadian %DV boilerplate in EN/FR
  if (t.includes("5% or less is a little")) return true;
  if (t.includes("15% or more is a lot")) return true;
  if (t.includes("5% ou moins")) return true;
  if (t.includes("15% ou plus")) return true;
  return false;
}

export function scoreCanadianDoc(doc) {
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

export function normalizeNutrientsForClient(nutrients) {
  if (!Array.isArray(nutrients) || nutrients.length === 0) return nutrients;

  return nutrients.map((n) => {
    if (!n || typeof n !== "object") return n;

    const per_serving = n.per_serving ?? n.perServing ?? null;
    const per_100g = n.per_100g ?? n.per100g ?? null;
    const display_name = n.display_name ?? n.displayName ?? null;
    const data_quality = n.data_quality ?? n.dataQuality ?? null;

    // Stable row identifier to avoid collisions for legacy/survey nutrients
    // Distinguish by key + unit + USDA nutrient id (when present)
    const key = String(n.key || "");
    const unit = String(n.unit || "").trim();
    const usdaId = String(n.usda_nutrient_id || n.usdaNutrientId || "");
    const row_id = `${key}|${unit}|${usdaId}`;

    // Preserve original keys, but add camelCase aliases so older iOS decoders
    // (that don't use convertFromSnakeCase) can still parse user-enriched docs.
    return {
      ...n,
      row_id,
      rowId: row_id,
      per_serving,
      perServing: per_serving,
      per_100g,
      per100g: per_100g,
      display_name,
      displayName: display_name,
      data_quality,
      dataQuality: data_quality,
    };
  });
}
