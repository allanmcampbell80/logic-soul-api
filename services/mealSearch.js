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

  // --- Single-token tie-breakers (e.g., "egg" should prefer actual eggs over "egg noodles") ---
  // When the query is one token, many items can tie on score. Add a couple of light heuristics
  // to push true "atomic" foods upward.
  if (canonicalWords && canonicalWords.length === 1) {
    const token = String(canonicalWords[0] || "").toLowerCase().trim();
    if (token) {
      const nn = String(candidate.normalized_name || "").toLowerCase();
      const cn = String(candidate.normalized_common_name || candidate.common_name || "").toLowerCase();
      const dp = String(candidate.display_product_name || "").toLowerCase();

      // Strong signal in USDA-ish naming: "egg, whole, raw" (token followed by comma)
      if (nn.startsWith(`${token},`)) score += 0.6;
      if (dp.startsWith(`${token},`)) score += 0.2;

      // If the common-name starts with the token but immediately becomes a known compound food,
      // demote it (e.g., "egg noodles", "egg rolls").
      const compoundFollowers = new Set([
        "noodle", "noodles", "pasta", "roll", "rolls", "salad", "soup", "sandwich", "burger",
        "pizza", "bread", "cake", "cookie", "cookies", "muffin", "muffins", "omelet", "omelette"
      ]);

      const parts = cn.split(/\s+/).filter(Boolean);
      if (parts.length >= 2 && parts[0] === token && compoundFollowers.has(parts[1])) {
        score -= 1.25;
      }

      // Mild bonus if the normalized name starts with the token as a standalone word.
      // (Keeps "egg" -> "egg, whole, raw" ahead of "raw whole egg" ties.)
      if (new RegExp(`^${token}(?:\\b|,)`, "i").test(nn)) score += 0.2;
    }
  }

  // If something is explicitly a prepared dish, slightly demote it in general ranking.
  // (Still searchable via relaxed stages / product searches when needed.)
  if ((candidate.food_type || "").toLowerCase() === "prepared_dish") {
    score -= 0.5;
  }

  return score;
}

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    // preserve common nutrition shorthand
    .replace(/%/g, " percent ")
    .replace(/\b(\d+)\s*(?:pct)\b/g, "$1 percent")
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
  "ml", "liter", "litre", "liters", "litres",
  "slice", "slices", "piece", "pieces", "serving", "servings",
  "small", "medium", "large",
]);

function tokenizeMealPhrase(phrase) {
  const txt = normalizeText(phrase);
  if (!txt) return [];

  const parts = txt.split(" ").filter(Boolean);
  const kept = [];

  for (let i = 0; i < parts.length; i++) {
    const w = parts[i];
    const prev = i > 0 ? parts[i - 1] : "";
    const next = i + 1 < parts.length ? parts[i + 1] : "";

    // Keep numbers only if they are tied to a percent phrase: "2 percent"
    const isPureNumber = /^\d+$/.test(w);
    const isPercentNumber = isPureNumber && (next === "percent" || prev === "percent");

    if (isPureNumber && !isPercentNumber) continue;
    if (STOPWORDS.has(w)) continue;
    if (w.length < 2 && !isPureNumber) continue;

    kept.push(w);
  }

  return kept;
}

function labelBoost(label) {
  // Earlier stages should win ties.
  switch (label) {
    case "common-name-exact": return 3.0;
    case "common-name-phrase": return 2.0;
    case "alt-name-exact": return 1.5;
    case "product-primary": return 1.0;
    case "ingredient-primary": return 1.0;
    case "product-fallback": return 0.5;
    case "ingredient-fallback": return 0.5;
    case "single-word": return 0.0;
    case "restaurant-common-name-exact": return 3.25;
    case "restaurant-common-name-phrase": return 2.25;
    case "restaurant-primary": return 1.25;
    case "ingredient-primary-relaxed": return 0.75;
    case "ingredient-fallback-relaxed": return 0.25;
    case "single-word-ingredient": return 0.1;
    case "single-token-ingredient-prefix": return 3.5;
    // New single-ingredient-first stages
    case "single-ingredient-common-name-exact": return 3.1;
    case "single-ingredient-common-name-phrase": return 2.1;
    case "single-ingredient-primary": return 1.1;
    case "single-token-single-ingredient-prefix": return 3.6;
    case "single-token-simple-ingredient-prefix": return 3.4;
    default: return 0.0;
  }
}

function buildSingleWordOr(singleWordRegexes) {
  const ors = [];

  const stringFields = [
    "normalized_name",
    "name",
    "common_name",
    "normalized_common_name",
    "display_product_name",
    "brand.name",
    "brand.owner",
    "names_enrichment_v2.brand_name",
    "names_enrichment_v2.product_name",
    "names_enrichment_v2.common_name",
    "ingredients_text"
  ];

  const arrayFields = [
    "alt_names",
    "normalized_alt_names",
    "names_enrichment_v2.alt_names"
  ];

  for (const re of singleWordRegexes) {
    for (const f of stringFields) {
      ors.push({ [f]: re });
    }
    for (const f of arrayFields) {
      // For array fields, regex match against any element
      ors.push({ [f]: re });
    }
  }

  return ors;
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

    const canonicalNorm = normalizeText(canonical);
    const exactNormRegex = new RegExp(`^${canonicalNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

    // Build a lenient regex: "kelloggs rice krispies" -> /\bkelloggs\b.*\brice\b.*\bkrispies\b/i
    const regex = new RegExp(
      finalWords
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .map((w) => `\\b${w}\\b`)
        .join(".*"),
      "i"
    );
    const singleWordRegexes = finalWords
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .map((w) => new RegExp(`\\b${w}\\b`, "i"));

    const isSingleToken = finalWords.length === 1;

    const singleToken = isSingleToken ? finalWords[0] : null;
    const isVeryShortSingleToken = isSingleToken && singleToken && singleToken.length <= 4;
    const parserSaysSimpleIngredient =
      item.is_simple_ingredient === true ||
      item.isSimpleIngredient === true ||
      item.is_simple_ingredient === "true" ||
      item.isSimpleIngredient === "true";

    const requireSimpleIngredient = item.kind === "ingredient" || parserSaysSimpleIngredient;

    // For single-token ingredient searches (e.g., "egg"), prefer items whose names START with that token.
    // This avoids high-frequency substring matches like "egg noodles" / "made without egg" and prevents "egg" -> "eggplant".
    const escapedSingleToken = singleToken
      ? singleToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : null;

    // Allow a simple plural (eggs) for single-token searches.
    const singleTokenPrefixRegex = escapedSingleToken
      ? new RegExp(`^${escapedSingleToken}s?\\b`, "i")
      : null;

    // If the parser strongly indicates this is a restaurant item, prioritize restaurant-only matches first.
    // (We still allow fallback to non-restaurant foods if nothing matches.)
    const requireRestaurantItem =
      item.kind === "restaurant" ||
      item.isRestaurantItem === true ||
      item.is_restaurant_item === true ||
      item.preparation_context === "restaurant" ||
      item.preparationContext === "restaurant" ||
      (typeof item.preparation_context === "string" && item.preparation_context.toLowerCase().includes("restaurant")) ||
      (typeof item.preparationContext === "string" && item.preparationContext.toLowerCase().includes("restaurant"));

    const restaurantOnlyFilter = {
      $or: [
        { is_restaurant_item: true },
        { "names_enrichment_v2.is_restaurant_item": true }
      ]
    };

    const singleIngredientFilter = { is_single_ingredient: true };
    const simpleIngredientFilter = { is_simple_ingredient: true };

    // Build match ORs we can reuse, with a safer version for short single-token queries.
    const ingredientNameOr = isVeryShortSingleToken
      ? [
          { normalized_name: regex },
          { display_product_name: regex },
          { name: regex },
          { "names_enrichment_v2.brand_name": regex },
          { "names_enrichment_v2.product_name": regex }
        ]
      : [
          { normalized_name: regex },
          { display_product_name: regex },
          { name: regex },
          { "names_enrichment_v2.brand_name": regex },
          { "names_enrichment_v2.product_name": regex },
          { ingredients_text: regex }
        ];

    const commonNameOrExact = [
      { normalized_common_name: canonicalNorm },
      { "names_enrichment_v2.common_name": canonicalNorm },
      { common_name: exactNormRegex },
      { "names_enrichment_v2.common_name": exactNormRegex },
      { normalized_alt_names: canonicalNorm },
      { "names_enrichment_v2.alt_names": exactNormRegex },
      { alt_names: exactNormRegex }
    ];

    const commonNameOrPhrase = [
      { normalized_common_name: regex },
      { common_name: regex },
      { "names_enrichment_v2.common_name": regex },
      { normalized_alt_names: regex },
      { alt_names: regex },
      { "names_enrichment_v2.alt_names": regex }
    ];

    const isProductPreferred =
      item.kind === "product" ||
      (item.kind === "either" && /cereal|bar|chips|soup|yogurt|cookie|crackers|pizza|soda|cola|juice|rice krispies|kellogg|shake\s*n\s*bake|betty\s*crocker|pillsbury/.test(lower));

    const queries = [];

    // Restaurant-first passes (only when the parser indicates a restaurant item)
    if (requireRestaurantItem) {
      queries.push({
        filter: {
          $and: [
            restaurantOnlyFilter,
            { $or: commonNameOrExact }
          ]
        },
        label: "restaurant-common-name-exact"
      });

      queries.push({
        filter: {
          $and: [
            restaurantOnlyFilter,
            { $or: commonNameOrPhrase }
          ]
        },
        label: "restaurant-common-name-phrase"
      });

      // Restaurant-focused name match (broad but still restaurant-only)
      queries.push({
        filter: {
          $and: [
            restaurantOnlyFilter,
            { $or: [
                { normalized_name: regex },
                { display_product_name: regex },
                { name: regex },
                { common_name: regex },
                { normalized_common_name: regex },
                { "names_enrichment_v2.common_name": regex },
                { ingredients_text: regex }
              ]
            }
          ]
        },
        label: "restaurant-primary"
      });
    }

    // 0-pre) Single-token ingredient prefix match (highest precision for things like "egg")
    // Prefer true single-ingredient foods first; then allow simple-ingredient foods.
    if (requireSimpleIngredient && isSingleToken && singleTokenPrefixRegex) {
      // Single-ingredient pass
      queries.push({
        filter: {
          $and: [
            singleIngredientFilter,
            {
              $or: [
                { normalized_name: singleTokenPrefixRegex },
                { name: singleTokenPrefixRegex },
                { normalized_common_name: singleTokenPrefixRegex },
                { common_name: singleTokenPrefixRegex },
                { "names_enrichment_v2.common_name": singleTokenPrefixRegex },
                { display_product_name: singleTokenPrefixRegex }
              ]
            }
          ]
        },
        label: "single-token-single-ingredient-prefix"
      });

      // Simple-ingredient fallback pass
      queries.push({
        filter: {
          $and: [
            simpleIngredientFilter,
            {
              $or: [
                { normalized_name: singleTokenPrefixRegex },
                { name: singleTokenPrefixRegex },
                { normalized_common_name: singleTokenPrefixRegex },
                { common_name: singleTokenPrefixRegex },
                { "names_enrichment_v2.common_name": singleTokenPrefixRegex },
                { display_product_name: singleTokenPrefixRegex }
              ]
            }
          ]
        },
        label: "single-token-simple-ingredient-prefix"
      });
    }

    // 0) Best signal first: common_name / normalized_common_name exact matches
    // If parser indicates ingredient intent, try true single-ingredient foods first.
    if (requireSimpleIngredient) {
      queries.push({
        filter: {
          $and: [
            { $or: commonNameOrExact },
            singleIngredientFilter
          ]
        },
        label: "single-ingredient-common-name-exact"
      });
    }

    queries.push({
      filter: (isVeryShortSingleToken || requireSimpleIngredient)
        ? {
            $and: [
              { $or: commonNameOrExact },
              simpleIngredientFilter
            ]
          }
        : {
            $or: commonNameOrExact
          },
      label: "common-name-exact"
    });

    // 0b) Next best: common_name phrase match with boundaries
    if (requireSimpleIngredient) {
      queries.push({
        filter: {
          $and: [
            { $or: commonNameOrPhrase },
            singleIngredientFilter
          ]
        },
        label: "single-ingredient-common-name-phrase"
      });
    }

    queries.push({
      filter: (isVeryShortSingleToken || requireSimpleIngredient)
        ? {
            $and: [
              { $or: commonNameOrPhrase },
              simpleIngredientFilter
            ]
          }
        : {
            $or: commonNameOrPhrase
          },
      label: "common-name-phrase"
    });

    if (isProductPreferred) {
      // 1) Packaged products focus
      queries.push({
        filter: {
          food_type: "packaged_product",
          $or: [
            { normalized_name: regex },
            { display_product_name: regex },
            { name: regex },
            { "brand.name": regex },
            { "brand.owner": regex },
            { "names_enrichment_v2.brand_name": regex },
            { "names_enrichment_v2.product_name": regex },
            { ingredients_text: regex }
          ]
        },
        label: "product-primary"
      });

      // 2) Simple ingredient fallback
      queries.push({
        filter: {
          $and: [
            requireSimpleIngredient
              ? { is_simple_ingredient: true }
              : {
                  $or: [
                    { food_type: { $in: ["ingredient", "prepared_dish"] } },
                    { is_simple_ingredient: true }
                  ]
                },
            {
              $or: ingredientNameOr
            }
          ]
        },
        label: "ingredient-fallback"
      });

      if (requireSimpleIngredient) {
        queries.push({
          filter: {
            $and: [
              { food_type: { $in: ["ingredient", "prepared_dish"] } },
              { $or: ingredientNameOr }
            ]
          },
          label: "ingredient-fallback-relaxed"
        });
      }
    } else {
      // Ingredient first
      if (requireSimpleIngredient) {
        // True single-ingredient foods first
        queries.push({
          filter: {
            $and: [
              singleIngredientFilter,
              { $or: ingredientNameOr }
            ]
          },
          label: "single-ingredient-primary"
        });
      }

      queries.push({
        filter: (isVeryShortSingleToken || requireSimpleIngredient)
          ? {
              $and: [
                simpleIngredientFilter,
                { $or: ingredientNameOr }
              ]
            }
          : {
              $and: [
                {
                  $or: [
                    { food_type: { $in: ["ingredient", "prepared_dish"] } },
                    simpleIngredientFilter
                  ]
                },
                {
                  $or: ingredientNameOr
                }
              ]
            },
        label: "ingredient-primary"
      });

      // If we required a simple ingredient but found nothing, allow drifting to non-simple items later.
      if (requireSimpleIngredient) {
        queries.push({
          filter: {
            $and: [
              { food_type: { $in: ["ingredient", "prepared_dish"] } },
              { $or: ingredientNameOr }
            ]
          },
          label: "ingredient-primary-relaxed"
        });
      }

      queries.push({
        filter: {
          food_type: "packaged_product",
          $or: [
            { normalized_name: regex },
            { display_product_name: regex },
            { name: regex },
            { "brand.name": regex },
            { "brand.owner": regex },
            { "names_enrichment_v2.brand_name": regex },
            { "names_enrichment_v2.product_name": regex },
            { ingredients_text: regex }
          ]
        },
        label: "product-fallback"
      });
    }

    // 3) Single-word fallback (VERY broad; limit hard)
    if (isVeryShortSingleToken || requireSimpleIngredient) {
      // Strict pass first
      queries.push({
        filter: {
          $and: [
            { is_simple_ingredient: true },
            { $or: buildSingleWordOr(singleWordRegexes) }
          ]
        },
        label: "single-word-ingredient"
      });

      // If strict finds nothing, allow drifting to anything (still broad)
      queries.push({
        filter: {
          $or: buildSingleWordOr(singleWordRegexes)
        },
        label: "single-word"
      });
    } else {
      queries.push({
        filter: {
          $or: buildSingleWordOr(singleWordRegexes)
        },
        label: "single-word"
      });
    }

    // Dedupe across query stages; keep the best-scoring entry per document.
    const candidatesById = new Map();

    for (const q of queries) {
      const cursor = foodItems.find(q.filter).limit(40); // keep it reasonable
      const batch = await cursor.toArray();
      for (const doc of batch) {
        const score = scoreCandidate(finalWords, doc) + labelBoost(q.label);
        if (score <= 0) continue;

        const id = String(doc._id);
        const existing = candidatesById.get(id);

        // Keep the highest score; if tied, prefer the earlier-stage label via labelBoost.
        if (!existing || score > existing.score || (score === existing.score && labelBoost(q.label) > labelBoost(existing.label))) {
          candidatesById.set(id, { label: q.label, score, doc });
        }
      }
    }

    const candidates = Array.from(candidatesById.values());

    // Sort by score desc; if tied, prefer earlier-stage labels.
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return labelBoost(b.label) - labelBoost(a.label);
    });

    const top = candidates.slice(0, maxPerItem);

    results.push({
      originalPhrase: item.originalPhrase,
      canonicalName: canonical,
      kind: item.kind,
      mealType: parsedMeal.mealType,
      candidates: top.map((c) => ({
        // Always return a plain string ID (not a BSON ObjectId / {$oid: ...} wrapper)
        id: String(c.doc._id),
        name: c.doc.name,
        normalized_name: c.doc.normalized_name,
        common_name: c.doc.common_name || null,
        normalized_common_name: c.doc.normalized_common_name || null,
        display_product_name: c.doc.display_product_name || null,
        preparation_context: c.doc.preparation_context || (c.doc.names_enrichment_v2 && c.doc.names_enrichment_v2.preparation_context) || null,
        is_restaurant_item: Boolean(c.doc.is_restaurant_item || (c.doc.names_enrichment_v2 && c.doc.names_enrichment_v2.is_restaurant_item)),
        restaurant_chain: c.doc.restaurant_chain || null,
        brand: c.doc.brand || null,
        food_type: c.doc.food_type || null,
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
