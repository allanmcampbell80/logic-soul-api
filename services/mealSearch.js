// mealSearch.js

/**
 * Scoring heuristic:
 * - Count word hits across a broad "haystack" that includes enriched naming fields.
 * - Add small bonuses for brand/common-name/display-name hits.
 */
function scoreCandidate(canonicalWords, candidate) {
  const haystackParts = [
    candidate.normalized_name,
    candidate.name,
    candidate.common_name,
    candidate.normalized_common_name,
    candidate.display_product_name,
    // enriched v2
    candidate.names_enrichment_v2 && candidate.names_enrichment_v2.brand_name,
    candidate.names_enrichment_v2 && candidate.names_enrichment_v2.product_name,
    candidate.names_enrichment_v2 && candidate.names_enrichment_v2.common_name,
    // arrays
    Array.isArray(candidate.alt_names) ? candidate.alt_names.join(" ") : "",
    Array.isArray(candidate.normalized_alt_names) ? candidate.normalized_alt_names.join(" ") : "",
    candidate.names_enrichment_v2 && Array.isArray(candidate.names_enrichment_v2.alt_names)
      ? candidate.names_enrichment_v2.alt_names.join(" ")
      : "",
    // brand
    (candidate.brand && candidate.brand.name) || "",
    (candidate.brand && candidate.brand.owner) || "",
    // restaurant / prep context (sometimes included in prompts)
    candidate.preparation_context,
    candidate.is_restaurant_item ? "restaurant" : "",
    candidate.restaurant_chain || "",
    // ingredients can sometimes contain brand/product hints
    candidate.ingredients_text || ""
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  let hits = 0;

  for (const w of canonicalWords) {
    if (!w) continue;
    if (haystackParts.includes(w)) {
      score += 1;
      hits += 1;

      // Light boosts for high-signal fields
      if ((candidate.brand && (candidate.brand.name || "").toLowerCase().includes(w)) ||
          (candidate.names_enrichment_v2 && (candidate.names_enrichment_v2.brand_name || "").toLowerCase().includes(w))) {
        score += 0.5;
      }
      if ((candidate.normalized_common_name || "").toLowerCase().includes(w) ||
          (candidate.names_enrichment_v2 && (candidate.names_enrichment_v2.common_name || "").toLowerCase().includes(w))) {
        score += 0.5;
      }
      if ((candidate.display_product_name || "").toLowerCase().includes(w)) {
        score += 0.25;
      }
    }
  }

  // Prefer candidates that match more unique words (small non-linear bonus)
  if (hits >= 3) score += 0.5;
  if (hits >= 5) score += 0.75;

  return score;
}

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Remove very common, low-signal words + common unit/quantity noise.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "with", "without", "of", "for", "to", "in",
  "on", "at", "from", "by", "as", "is", "it", "this", "that",
  "cup", "cups", "tbsp", "tsp", "tablespoon", "tablespoons", "teaspoon", "teaspoons",
  "g", "gram", "grams", "kg", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
  "ml", "l", "liter", "litre", "liters", "litres",
  "slice", "slices", "piece", "pieces", "serving", "servings",
  "small", "medium", "large",
  "fresh", "frozen", "cooked", "raw"
]);

function tokenizeMealPhrase(phrase) {
  const txt = normalizeText(phrase);
  if (!txt) return [];
  return txt
    .split(" ")
    .filter(Boolean)
    // drop pure numbers and stopwords
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !STOPWORDS.has(w))
    // avoid super-short noise
    .filter((w) => w.length >= 2);
}

export async function findBestMatchesForMealItems(db, parsedMeal, options = {}) {
  const foodItems = db.collection("food_items");
  const maxPerItem = options.maxPerItem ?? 5;

  const results = [];

  for (const item of parsedMeal.items) {
    const canonical = (item.canonicalName || item.originalPhrase || "").trim();
    if (!canonical) continue;

    const lower = canonical.toLowerCase();

    // Tokenize more like a human search query (drop amounts/units/stopwords)
    const words = tokenizeMealPhrase(canonical);

    // If tokenization removed everything, fall back to basic split
    const fallbackWords = normalizeText(canonical).split(/\s+/).filter(Boolean);
    const finalWords = words.length ? words : fallbackWords;

    // Build a lenient regex: "kelloggs rice krispies" -> /kelloggs.*rice.*krispies/i
    const regex = new RegExp(finalWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"), "i");
    const singleWordRegexes = finalWords
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .map((w) => new RegExp(`\\b${w}\\b`, "i"));

    const isProductPreferred =
      item.kind === "product" ||
      (item.kind === "either" && /cereal|bar|chips|soup|yogurt|cookie|crackers|pizza|soda|cola|juice|rice krispies|kellogg|shake\s*n\s*bake|betty\s*crocker|pillsbury/.test(lower));

    const queries = [];

    if (isProductPreferred) {
      // 1) Packaged products focus
      queries.push({
        filter: {
          food_type: "packaged_product",
          $or: [
            { normalized_name: regex },
            { normalized_common_name: regex },
            { common_name: regex },
            { display_product_name: regex },
            { alt_names: regex },
            { normalized_alt_names: regex },
            { name: regex },
            { "brand.name": regex },
            { "brand.owner": regex },
            { "names_enrichment_v2.brand_name": regex },
            { "names_enrichment_v2.product_name": regex },
            { "names_enrichment_v2.common_name": regex },
            { "names_enrichment_v2.alt_names": regex },
            { ingredients_text: regex }
          ]
        },
        label: "product-primary"
      });

      // 2) Simple ingredient fallback
      queries.push({
        filter: {
          $and: [
            {
              $or: [
                { food_type: "ingredient" },
                { is_simple_ingredient: true }
              ]
            },
            {
              $or: [
                { normalized_name: regex },
                { normalized_common_name: regex },
                { common_name: regex },
                { display_product_name: regex },
                { name: regex },
                { alt_names: regex },
                { normalized_alt_names: regex },
                { "names_enrichment_v2.brand_name": regex },
                { "names_enrichment_v2.product_name": regex },
                { "names_enrichment_v2.common_name": regex },
                { "names_enrichment_v2.alt_names": regex },
                { ingredients_text: regex }
              ]
            }
          ]
        },
        label: "ingredient-fallback"
      });
    } else {
      // Ingredient first
      queries.push({
        filter: {
          $and: [
            {
              $or: [
                { food_type: "ingredient" },
                { is_simple_ingredient: true }
              ]
            },
            {
              $or: [
                { normalized_name: regex },
                { normalized_common_name: regex },
                { common_name: regex },
                { display_product_name: regex },
                { name: regex },
                { alt_names: regex },
                { normalized_alt_names: regex },
                { "names_enrichment_v2.brand_name": regex },
                { "names_enrichment_v2.product_name": regex },
                { "names_enrichment_v2.common_name": regex },
                { "names_enrichment_v2.alt_names": regex },
                { ingredients_text: regex }
              ]
            }
          ]
        },
        label: "ingredient-primary"
      });

      queries.push({
        filter: {
          food_type: "packaged_product",
          $or: [
            { normalized_name: regex },
            { normalized_common_name: regex },
            { common_name: regex },
            { display_product_name: regex },
            { alt_names: regex },
            { normalized_alt_names: regex },
            { name: regex },
            { "brand.name": regex },
            { "brand.owner": regex },
            { "names_enrichment_v2.brand_name": regex },
            { "names_enrichment_v2.product_name": regex },
            { "names_enrichment_v2.common_name": regex },
            { "names_enrichment_v2.alt_names": regex },
            { ingredients_text: regex }
          ]
        },
        label: "product-fallback"
      });
    }

    // 3) Single-word fallback (VERY broad; limit hard)
    queries.push({
      filter: {
        $or: [
          { normalized_name: { $in: singleWordRegexes } },
          { normalized_common_name: { $in: singleWordRegexes } },
          { common_name: { $in: singleWordRegexes } },
          { display_product_name: { $in: singleWordRegexes } },
          { name: { $in: singleWordRegexes } },
          { alt_names: { $in: singleWordRegexes } },
          { normalized_alt_names: { $in: singleWordRegexes } },
          { "brand.name": { $in: singleWordRegexes } },
          { "brand.owner": { $in: singleWordRegexes } },
          { "names_enrichment_v2.brand_name": { $in: singleWordRegexes } },
          { "names_enrichment_v2.product_name": { $in: singleWordRegexes } },
          { "names_enrichment_v2.common_name": { $in: singleWordRegexes } },
          { "names_enrichment_v2.alt_names": { $in: singleWordRegexes } },
          { ingredients_text: { $in: singleWordRegexes } }
        ]
      },
      label: "single-word"
    });

    const candidates = [];

    for (const q of queries) {
      const cursor = foodItems.find(q.filter).limit(40); // keep it reasonable
      const batch = await cursor.toArray();
      for (const doc of batch) {
        const score = scoreCandidate(finalWords, doc);
        if (score > 0) {
          candidates.push({
            label: q.label,
            score,
            doc
          });
        }
      }
    }

    // Sort by score desc, then maybe prefer label ordering
    candidates.sort((a, b) => b.score - a.score);

    const top = candidates.slice(0, maxPerItem);

    results.push({
      originalPhrase: item.originalPhrase,
      canonicalName: canonical,
      kind: item.kind,
      mealType: parsedMeal.mealType,
      candidates: top.map((c) => ({
        id: c.doc._id,
        name: c.doc.name,
        normalized_name: c.doc.normalized_name,
        common_name: c.doc.common_name || null,
        normalized_common_name: c.doc.normalized_common_name || null,
        display_product_name: c.doc.display_product_name || null,
        preparation_context: c.doc.preparation_context || (c.doc.names_enrichment_v2 && c.doc.names_enrichment_v2.preparation_context) || null,
        is_restaurant_item: Boolean(c.doc.is_restaurant_item || (c.doc.names_enrichment_v2 && c.doc.names_enrichment_v2.is_restaurant_item)),
        restaurant_chain: c.doc.restaurant_chain || null,
        brand: c.doc.brand || null,
        food_type: c.doc.food_type || (c.doc.is_simple_ingredient ? "ingredient" : null),
        label: c.label,
        score: c.score
      }))
    });
  }

  return {
    rawText: parsedMeal.rawText,
    mealType: parsedMeal.mealType,
    items: results
  };
}
