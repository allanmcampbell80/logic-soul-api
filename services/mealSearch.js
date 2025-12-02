// mealSearch.js

/**
 * Very simple scoring: more matching words = better.
 */
function scoreCandidate(canonicalWords, candidate) {
  const haystack = [
    candidate.normalized_name,
    candidate.name,
    (candidate.brand && candidate.brand.name) || "",
    (candidate.brand && candidate.brand.owner) || "",
    (candidate.ingredients_text || "")
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const w of canonicalWords) {
    if (!w) continue;
    if (haystack.includes(w)) score += 1;
  }
  return score;
}

export async function findBestMatchesForMealItems(db, parsedMeal, options = {}) {
  const foodItems = db.collection("food_items");
  const maxPerItem = options.maxPerItem ?? 5;

  const results = [];

  for (const item of parsedMeal.items) {
    const canonical = (item.canonicalName || item.originalPhrase || "").trim();
    if (!canonical) continue;

    const lower = canonical.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);

    // Build a lenient regex: "kelloggs rice krispies" -> /kelloggs.*rice.*krispies/i
    const regex = new RegExp(words.join(".*"), "i");
    const singleWordRegexes = words.map((w) => new RegExp(`\\b${w}\\b`, "i"));

    const isProductPreferred =
      item.kind === "product" ||
      (item.kind === "either" && /cereal|bar|chips|soup|yogurt|cookie|crackers|pizza|soda|cola|juice|rice krispies|kellogg/.test(lower));

    const queries = [];

    if (isProductPreferred) {
      // 1) Packaged products focus
      queries.push({
        filter: {
          food_type: "packaged_product",
          $or: [
            { normalized_name: regex },
            { alt_names: regex },
            { name: regex },
            { "brand.name": regex },
            { "brand.owner": regex },
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
                { type: "ingredient" },
                { is_simple_ingredient: true }
              ]
            },
            {
              $or: [
                { normalized_name: regex },
                { name: regex },
                { alt_names: regex },
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
                { type: "ingredient" },
                { is_simple_ingredient: true }
              ]
            },
            {
              $or: [
                { normalized_name: regex },
                { name: regex },
                { alt_names: regex },
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
            { alt_names: regex },
            { name: regex },
            { "brand.name": regex },
            { "brand.owner": regex },
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
          { name: { $in: singleWordRegexes } },
          { "brand.name": { $in: singleWordRegexes } },
          { "brand.owner": { $in: singleWordRegexes } },
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
        const score = scoreCandidate(words, doc);
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
