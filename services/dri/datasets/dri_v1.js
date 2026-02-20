// datasets/dri_v1.js
export const DRI_V1_VERSION = 1;
export const DRI_V1_PROFILE_KEY = "dri_v1";

export const driV1Bands = [
  // -----------------
  // MACROS / ENERGY
  // -----------------
  // Energy (heuristic adult maintenance targets; sex + age banded)
  // NOTE: These are heuristic maintenance targets (not EER). We can refine later using height/weight/activity.

  // -----------------
  // MEN (kcal)
  // -----------------
  {
    nutrientKey: "energy_kcal",
    sex: "male",
    minYears: 19,
    maxYears: 30,
    referenceType: "ai",
    recommended: 2600,
    lowerSafe: 1900,
    upperSafe: 3600,
    upperLimit: null,
    unit: "kcal",
    source: "Heuristic (male 19–30 maintenance; adjust per activity/body size)",
  },
  {
    nutrientKey: "energy_kcal",
    sex: "male",
    minYears: 31,
    maxYears: 50,
    referenceType: "ai",
    recommended: 2400,
    lowerSafe: 1800,
    upperSafe: 3400,
    upperLimit: null,
    unit: "kcal",
    source: "Heuristic (male 31–50 maintenance; adjust per activity/body size)",
  },
  {
    nutrientKey: "energy_kcal",
    sex: "male",
    minYears: 51,
    maxYears: 70,
    referenceType: "ai",
    recommended: 2200,
    lowerSafe: 1700,
    upperSafe: 3200,
    upperLimit: null,
    unit: "kcal",
    source: "Heuristic (male 51–70 maintenance; adjust per activity/body size)",
  },
  {
    nutrientKey: "energy_kcal",
    sex: "male",
    minYears: 71,
    maxYears: null,
    referenceType: "ai",
    recommended: 2000,
    lowerSafe: 1600,
    upperSafe: 3000,
    upperLimit: null,
    unit: "kcal",
    source: "Heuristic (male 71+ maintenance; adjust per activity/body size)",
  },

  // -----------------
  // WOMEN (kcal)
  // -----------------
  {
    nutrientKey: "energy_kcal",
    sex: "female",
    minYears: 19,
    maxYears: 30,
    referenceType: "ai",
    recommended: 2000,
    lowerSafe: 1500,
    upperSafe: 3000,
    upperLimit: null,
    unit: "kcal",
    source: "Heuristic (female 19–30 maintenance; adjust per activity/body size)",
  },
  {
    nutrientKey: "energy_kcal",
    sex: "female",
    minYears: 31,
    maxYears: 50,
    referenceType: "ai",
    recommended: 1800,
    lowerSafe: 1400,
    upperSafe: 2800,
    upperLimit: null,
    unit: "kcal",
    source: "Heuristic (female 31–50 maintenance; adjust per activity/body size)",
  },
  {
    nutrientKey: "energy_kcal",
    sex: "female",
    minYears: 51,
    maxYears: 70,
    referenceType: "ai",
    recommended: 1700,
    lowerSafe: 1300,
    upperSafe: 2600,
    upperLimit: null,
    unit: "kcal",
    source: "Heuristic (female 51–70 maintenance; adjust per activity/body size)",
  },
  {
    nutrientKey: "energy_kcal",
    sex: "female",
    minYears: 71,
    maxYears: null,
    referenceType: "ai",
    recommended: 1600,
    lowerSafe: 1200,
    upperSafe: 2400,
    upperLimit: null,
    unit: "kcal",
    source: "Heuristic (female 71+ maintenance; adjust per activity/body size)",
  },

  // -----------------
  // MEN (kJ)  (kcal × 4.184)
  // -----------------
  {
    nutrientKey: "energy_kj",
    sex: "male",
    minYears: 19,
    maxYears: 30,
    referenceType: "ai",
    recommended: 10878,
    lowerSafe: 7949.6,
    upperSafe: 15062.4,
    upperLimit: null,
    unit: "kJ",
    source: "Heuristic (male 19–30; kcal × 4.184)",
  },
  {
    nutrientKey: "energy_kj",
    sex: "male",
    minYears: 31,
    maxYears: 50,
    referenceType: "ai",
    recommended: 10041.6,
    lowerSafe: 7531.2,
    upperSafe: 14225.6,
    upperLimit: null,
    unit: "kJ",
    source: "Heuristic (male 31–50; kcal × 4.184)",
  },
  {
    nutrientKey: "energy_kj",
    sex: "male",
    minYears: 51,
    maxYears: 70,
    referenceType: "ai",
    recommended: 9204.8,
    lowerSafe: 7112.8,
    upperSafe: 13388.8,
    upperLimit: null,
    unit: "kJ",
    source: "Heuristic (male 51–70; kcal × 4.184)",
  },
  {
    nutrientKey: "energy_kj",
    sex: "male",
    minYears: 71,
    maxYears: null,
    referenceType: "ai",
    recommended: 8368,
    lowerSafe: 6694.4,
    upperSafe: 12552,
    upperLimit: null,
    unit: "kJ",
    source: "Heuristic (male 71+; kcal × 4.184)",
  },

  // -----------------
  // WOMEN (kJ) (kcal × 4.184)
  // -----------------
  {
    nutrientKey: "energy_kj",
    sex: "female",
    minYears: 19,
    maxYears: 30,
    referenceType: "ai",
    recommended: 8368,
    lowerSafe: 6276,
    upperSafe: 12552,
    upperLimit: null,
    unit: "kJ",
    source: "Heuristic (female 19–30; kcal × 4.184)",
  },
  {
    nutrientKey: "energy_kj",
    sex: "female",
    minYears: 31,
    maxYears: 50,
    referenceType: "ai",
    recommended: 7531.2,
    lowerSafe: 5857.6,
    upperSafe: 11715.2,
    upperLimit: null,
    unit: "kJ",
    source: "Heuristic (female 31–50; kcal × 4.184)",
  },
  {
    nutrientKey: "energy_kj",
    sex: "female",
    minYears: 51,
    maxYears: 70,
    referenceType: "ai",
    recommended: 7112.8,
    lowerSafe: 5439.2,
    upperSafe: 10878.4,
    upperLimit: null,
    unit: "kJ",
    source: "Heuristic (female 51–70; kcal × 4.184)",
  },
  {
    nutrientKey: "energy_kj",
    sex: "female",
    minYears: 71,
    maxYears: null,
    referenceType: "ai",
    recommended: 6694.4,
    lowerSafe: 5020.8,
    upperSafe: 10041.6,
    upperLimit: null,
    unit: "kJ",
    source: "Heuristic (female 71+; kcal × 4.184)",
  },

  // Carbohydrate (digestible)

  {
    nutrientKey: "carbs_g",
    sex: null,
    minYears: 19,
    maxYears: null,
    referenceType: "rda",
    recommended: 130,
    lowerSafe: 104,
    upperSafe: null,
    upperLimit: null,
    unit: "g",
    source: "DRI",
  },

  // Protein (adult RDA)
  {
    nutrientKey: "protein_g",
    sex: "male",
    minYears: 19,
    maxYears: 50,
    referenceType: "rda",
    recommended: 56,
    lowerSafe: 45,
    upperSafe: null,
    upperLimit: null,
    unit: "g",
    source: "DRI",
  },
  {
    nutrientKey: "protein_g",
    sex: "female",
    minYears: 19,
    maxYears: 50,
    referenceType: "rda",
    recommended: 46,
    lowerSafe: 37,
    upperSafe: null,
    upperLimit: null,
    unit: "g",
    source: "DRI",
  },

  // --------------------------
  // AMINO ACIDS (INFORMATIONAL)
  // --------------------------
  // No specific DRI targets exist for individual amino acids here.
  // These are informational so they can appear in totals when present.
{ nutrientKey: "histidine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "histidine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "isoleucine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "isoleucine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "leucine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "leucine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "lysine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "lysine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "methionine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "methionine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "phenylalanine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "phenylalanine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "threonine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "threonine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "tryptophan", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "tryptophan_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "valine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "valine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },

{ nutrientKey: "arginine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "arginine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "cystine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "cystine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "tyrosine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "tyrosine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "alanine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "alanine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "aspartic_acid", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "aspartic_acid_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "glutamic_acid", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "glutamic_acid_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "glycine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "glycine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "proline", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "proline_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "serine", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },
{ nutrientKey: "serine_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual amino acids (informational tracking)" },

  // Total Fat (AMDR-style)
  {
    nutrientKey: "fat_g",
    sex: null,
    minYears: 19,
    maxYears: null,
    referenceType: "ai",
    recommended: 65,
    lowerSafe: 44,
    upperSafe: 78,
    upperLimit: null,
    unit: "g",
    source: "AMDR (assumes 2000 kcal)",
  },

  // Saturated / trans / mono / poly fats
  {
    nutrientKey: "sat_fat_g",
    sex: null,
    minYears: 19,
    maxYears: null,
    referenceType: "ai",
    recommended: 22,
    lowerSafe: 0,
    upperSafe: 22,
    upperLimit: null,
    unit: "g",
    source: "Guideline cap (assumes 2000 kcal)",
  },
  {
    nutrientKey: "trans_fat_g",
    sex: null,
    minYears: 19,
    maxYears: null,
    referenceType: "ai",
    recommended: null,
    lowerSafe: null,
    upperSafe: 2,
    upperLimit: null,
    unit: "g",
    source: "Guideline (as low as possible)",
  },
  {
    nutrientKey: "mono_fat_g",
    sex: null,
    minYears: 19,
    maxYears: null,
    referenceType: "ai",
    recommended: 33,
    lowerSafe: 20,
    upperSafe: 44,
    upperLimit: null,
    unit: "g",
    source: "Heuristic (assumes 2000 kcal)",
  },

  // SFA subtypes (informational)
  { nutrientKey: "sfa_4_0_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual SFAs (informational tracking)" },
  { nutrientKey: "sfa_6_0_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual SFAs (informational tracking)" },
  { nutrientKey: "sfa_8_0_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual SFAs (informational tracking)" },
  { nutrientKey: "sfa_10_0_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual SFAs (informational tracking)" },
  { nutrientKey: "sfa_12_0_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual SFAs (informational tracking)" },
  { nutrientKey: "sfa_14_0_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual SFAs (informational tracking)" },
  { nutrientKey: "sfa_16_0_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual SFAs (informational tracking)" },
  { nutrientKey: "sfa_18_0_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual SFAs (informational tracking)" },

  // MUFA subtypes (informational)
  { nutrientKey: "mufa_16_1_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "DRI: No specific target established for individual MUFAs (informational tracking)" },
  { nutrientKey: "mufa_18_1_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "DRI: No specific target established for individual MUFAs (informational tracking)" },
  { nutrientKey: "mufa_20_1_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "DRI: No specific target established for individual MUFAs (informational tracking)" },
  { nutrientKey: "mufa_22_1_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "DRI: No specific target established for individual MUFAs (informational tracking)" },

  // PUFA + omega targets
  {
    nutrientKey: "poly_fat_g",
    sex: null,
    minYears: 19,
    maxYears: null,
    referenceType: "ai",
    recommended: 22,
    lowerSafe: 12,
    upperSafe: 33,
    upperLimit: null,
    unit: "g",
    source: "Heuristic (assumes 2000 kcal)",
  },
  { nutrientKey: "pufa_18_2_g", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 17, lowerSafe: 14, upperSafe: null, upperLimit: null, unit: "g", source: "DRI" },
  { nutrientKey: "pufa_18_2_g", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 12, lowerSafe: 10, upperSafe: null, upperLimit: null, unit: "g", source: "DRI" },
  { nutrientKey: "pufa_18_3_g", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 1.6, lowerSafe: 1.28, upperSafe: null, upperLimit: null, unit: "g", source: "DRI" },
  { nutrientKey: "pufa_18_3_g", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 1.1, lowerSafe: 0.88, upperSafe: null, upperLimit: null, unit: "g", source: "DRI" },

  // Additional PUFA subtypes (informational)
  { nutrientKey: "pufa_18_4_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for this PUFA subtype (informational tracking)" },
  { nutrientKey: "pufa_20_4_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for this PUFA subtype (informational tracking)" },
  { nutrientKey: "epa_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for EPA (informational tracking)" },
  { nutrientKey: "dha_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for DHA (informational tracking)" },
  { nutrientKey: "dpa_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for DPA (informational tracking)" },

  // Sugars + sugar alcohols
  { nutrientKey: "sugars_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "Informational (no specific DRI for total sugars)" },
  { nutrientKey: "sucrose_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual sugars (informational tracking)" },
  { nutrientKey: "glucose_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual sugars (informational tracking)" },
  { nutrientKey: "fructose_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual sugars (informational tracking)" },
  { nutrientKey: "lactose_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual sugars (informational tracking)" },
  { nutrientKey: "maltose_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "No specific DRI for individual sugars (informational tracking)" },
  {
    nutrientKey: "added_sugars_g",
    sex: null,
    minYears: 19,
    maxYears: null,
    referenceType: "ai",
    recommended: null,
    lowerSafe: null,
    upperSafe: 50,
    upperLimit: null,
    unit: "g",
    source: "Guideline cap (<10% of calories as added sugars)",
  },
  { nutrientKey: "sugar_alcohol_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "Informational (no specific DRI for sugar alcohols)" },
  { nutrientKey: "sorbitol_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "Informational (sugar alcohol subtype)" },
  { nutrientKey: "mannitol_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "Informational (sugar alcohol subtype)" },
  { nutrientKey: "xylitol_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "Informational (sugar alcohol subtype)" },
  { nutrientKey: "erythritol_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "Informational (sugar alcohol subtype)" },
  { nutrientKey: "maltitol_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "Informational (sugar alcohol subtype)" },
  { nutrientKey: "lactitol_g", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "g", source: "Informational (sugar alcohol subtype)" },

  // Fiber
  { nutrientKey: "fiber_g", sex: "male", minYears: 19, maxYears: 50, referenceType: "ai", recommended: 38, lowerSafe: 30, upperSafe: null, upperLimit: null, unit: "g", source: "DRI" },
  { nutrientKey: "fiber_g", sex: "female", minYears: 19, maxYears: 50, referenceType: "ai", recommended: 25, lowerSafe: 20, upperSafe: null, upperLimit: null, unit: "g", source: "DRI" },

  // Water (align to stored daily totals: water_total_ml)
  // DRI AI values are typically expressed in mL/day (numerically equivalent to g/day for water).
  { nutrientKey: "water_total_ml", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 3700, lowerSafe: 3000, upperSafe: null, upperLimit: null, unit: "ml", source: "DRI" },
  { nutrientKey: "water_total_ml", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 2700, lowerSafe: 2200, upperSafe: null, upperLimit: null, unit: "ml", source: "DRI" },

  // Sleep (adult baseline guideline)
  // General adult recommendation: 7–9 hours per night
  {
    nutrientKey: "sleep_hours",
    sex: null,
    minYears: 19,
    maxYears: null,
    referenceType: "ai",
    recommended: 8,
    lowerSafe: 7,
    upperSafe: 9,
    upperLimit: null,
    unit: "h",
    source: "Consensus guideline (7–9 hours per night for adults)",
  },

  // -----------------
  // VITAMINS
  // -----------------
  { nutrientKey: "vitamin_a_rae_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 900, lowerSafe: 720, upperSafe: 3000, upperLimit: 3000, unit: "µg", source: "DRI" },
  { nutrientKey: "vitamin_a_rae_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 700, lowerSafe: 560, upperSafe: 3000, upperLimit: 3000, unit: "µg", source: "DRI" },

  // Carotenoids / related (informational)
  { nutrientKey: "retinol_ug", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "µg", source: "Informational (no specific DRI for retinol as a separate line item)" },
  { nutrientKey: "carotene_alpha_ug", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "µg", source: "Informational (no specific DRI for individual carotenoids)" },
  { nutrientKey: "carotene_beta_ug", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "µg", source: "Informational (no specific DRI for individual carotenoids)" },
  { nutrientKey: "cryptoxanthin_beta_ug", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "µg", source: "Informational (no specific DRI for individual carotenoids)" },
  { nutrientKey: "lycopene_ug", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "µg", source: "Informational (no specific DRI for individual carotenoids)" },
  { nutrientKey: "lutein_zeaxanthin_ug", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "µg", source: "Informational (no specific DRI for individual carotenoids)" },

  // Vitamin C
  { nutrientKey: "vitamin_c_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 90, lowerSafe: 72, upperSafe: 2000, upperLimit: 2000, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_c_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 75, lowerSafe: 60, upperSafe: 2000, upperLimit: 2000, unit: "mg", source: "DRI" },

  // B vitamins
  { nutrientKey: "vitamin_b1_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 1.2, lowerSafe: 1.0, upperSafe: null, upperLimit: null, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b1_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 1.1, lowerSafe: 0.9, upperSafe: null, upperLimit: null, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b2_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 1.3, lowerSafe: 1.04, upperSafe: null, upperLimit: null, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b2_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 1.1, lowerSafe: 0.88, upperSafe: null, upperLimit: null, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b3_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 16, lowerSafe: 12.8, upperSafe: 35, upperLimit: 35, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b3_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 14, lowerSafe: 11.2, upperSafe: 35, upperLimit: 35, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b5_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 5, lowerSafe: 4, upperSafe: null, upperLimit: null, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b5_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 5, lowerSafe: 4, upperSafe: null, upperLimit: null, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b6_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 1.3, lowerSafe: 1.0, upperSafe: 100, upperLimit: 100, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b6_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 1.3, lowerSafe: 1.0, upperSafe: 100, upperLimit: 100, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_b7_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 30, lowerSafe: 24, upperSafe: null, upperLimit: null, unit: "µg", source: "DRI" },
  { nutrientKey: "vitamin_b7_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 30, lowerSafe: 24, upperSafe: null, upperLimit: null, unit: "µg", source: "DRI" },
  { nutrientKey: "vitamin_b12_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 2.4, lowerSafe: 1.9, upperSafe: null, upperLimit: null, unit: "µg", source: "DRI" },
  { nutrientKey: "vitamin_b12_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 2.4, lowerSafe: 1.9, upperSafe: null, upperLimit: null, unit: "µg", source: "DRI" },
  { nutrientKey: "folate_dfe_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 400, lowerSafe: 320, upperSafe: 1000, upperLimit: 1000, unit: "µg", source: "DRI" },
  { nutrientKey: "folate_dfe_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 400, lowerSafe: 320, upperSafe: 1000, upperLimit: 1000, unit: "µg", source: "DRI" },

  // D / E / K
  { nutrientKey: "vitamin_d_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 15, lowerSafe: 12, upperSafe: 100, upperLimit: 100, unit: "µg", source: "DRI" },
  { nutrientKey: "vitamin_d_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 15, lowerSafe: 12, upperSafe: 100, upperLimit: 100, unit: "µg", source: "DRI" },
  { nutrientKey: "vitamin_e_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 15, lowerSafe: 12, upperSafe: 1000, upperLimit: 1000, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_e_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 15, lowerSafe: 12, upperSafe: 1000, upperLimit: 1000, unit: "mg", source: "DRI" },
  { nutrientKey: "vitamin_k_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 120, lowerSafe: 100, upperSafe: null, upperLimit: null, unit: "µg", source: "DRI" },
  { nutrientKey: "vitamin_k_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 90, lowerSafe: 75, upperSafe: null, upperLimit: null, unit: "µg", source: "DRI" },

  // -----------------
  // MINERALS
  // -----------------
  // Calcium
  { nutrientKey: "calcium_mg", sex: "male", minYears: 19, maxYears: 50, referenceType: "rda", recommended: 1000, lowerSafe: 800, upperSafe: 2500, upperLimit: 2500, unit: "mg", source: "DRI" },
  { nutrientKey: "calcium_mg", sex: "female", minYears: 19, maxYears: 50, referenceType: "rda", recommended: 1000, lowerSafe: 800, upperSafe: 2500, upperLimit: 2500, unit: "mg", source: "DRI" },
  { nutrientKey: "calcium_mg", sex: "male", minYears: 51, maxYears: 70, referenceType: "rda", recommended: 1000, lowerSafe: 800, upperSafe: 2000, upperLimit: 2000, unit: "mg", source: "DRI" },
  { nutrientKey: "calcium_mg", sex: "female", minYears: 51, maxYears: 70, referenceType: "rda", recommended: 1200, lowerSafe: 960, upperSafe: 2000, upperLimit: 2000, unit: "mg", source: "DRI" },
  { nutrientKey: "calcium_mg", sex: "male", minYears: 71, maxYears: null, referenceType: "rda", recommended: 1200, lowerSafe: 960, upperSafe: 2000, upperLimit: 2000, unit: "mg", source: "DRI" },
  { nutrientKey: "calcium_mg", sex: "female", minYears: 71, maxYears: null, referenceType: "rda", recommended: 1200, lowerSafe: 960, upperSafe: 2000, upperLimit: 2000, unit: "mg", source: "DRI" },

  // Iron
  { nutrientKey: "iron_mg", sex: "male", minYears: 19, maxYears: 50, referenceType: "rda", recommended: 8, lowerSafe: 6, upperSafe: 45, upperLimit: 45, unit: "mg", source: "DRI" },
  { nutrientKey: "iron_mg", sex: "female", minYears: 19, maxYears: 50, referenceType: "rda", recommended: 18, lowerSafe: 14, upperSafe: 45, upperLimit: 45, unit: "mg", source: "DRI" },
  { nutrientKey: "iron_mg", sex: "male", minYears: 51, maxYears: null, referenceType: "rda", recommended: 8, lowerSafe: 6, upperSafe: 45, upperLimit: 45, unit: "mg", source: "DRI" },
  { nutrientKey: "iron_mg", sex: "female", minYears: 51, maxYears: null, referenceType: "rda", recommended: 8, lowerSafe: 6, upperSafe: 45, upperLimit: 45, unit: "mg", source: "DRI" },

  // Magnesium
  { nutrientKey: "magnesium_mg", sex: "male", minYears: 19, maxYears: 30, referenceType: "rda", recommended: 400, lowerSafe: 320, upperSafe: 350, upperLimit: 350, unit: "mg", source: "DRI" },
  { nutrientKey: "magnesium_mg", sex: "male", minYears: 31, maxYears: null, referenceType: "rda", recommended: 420, lowerSafe: 336, upperSafe: 350, upperLimit: 350, unit: "mg", source: "DRI" },
  { nutrientKey: "magnesium_mg", sex: "female", minYears: 19, maxYears: 30, referenceType: "rda", recommended: 310, lowerSafe: 248, upperSafe: 350, upperLimit: 350, unit: "mg", source: "DRI" },
  { nutrientKey: "magnesium_mg", sex: "female", minYears: 31, maxYears: null, referenceType: "rda", recommended: 320, lowerSafe: 256, upperSafe: 350, upperLimit: 350, unit: "mg", source: "DRI" },

  // Potassium
  { nutrientKey: "potassium_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 3400, lowerSafe: 2720, upperSafe: null, upperLimit: null, unit: "mg", source: "DRI" },
  { nutrientKey: "potassium_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 2600, lowerSafe: 2080, upperSafe: null, upperLimit: null, unit: "mg", source: "DRI" },

  // Phosphorus
  { nutrientKey: "phosphorus_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 700, lowerSafe: 560, upperSafe: 4000, upperLimit: 4000, unit: "mg", source: "DRI" },
  { nutrientKey: "phosphorus_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 700, lowerSafe: 560, upperSafe: 4000, upperLimit: 4000, unit: "mg", source: "DRI" },

  // Zinc
  { nutrientKey: "zinc_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 11, lowerSafe: 8.8, upperSafe: 40, upperLimit: 40, unit: "mg", source: "DRI" },
  { nutrientKey: "zinc_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 8, lowerSafe: 6.4, upperSafe: 40, upperLimit: 40, unit: "mg", source: "DRI" },

  // Copper
  { nutrientKey: "copper_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 0.9, lowerSafe: 0.72, upperSafe: 10, upperLimit: 10, unit: "mg", source: "DRI" },
  { nutrientKey: "copper_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 0.9, lowerSafe: 0.72, upperSafe: 10, upperLimit: 10, unit: "mg", source: "DRI" },

  // Selenium
  { nutrientKey: "selenium_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 55, lowerSafe: 44, upperSafe: 400, upperLimit: 400, unit: "µg", source: "DRI" },
  { nutrientKey: "selenium_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 55, lowerSafe: 44, upperSafe: 400, upperLimit: 400, unit: "µg", source: "DRI" },

  // Manganese
  { nutrientKey: "manganese_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 2.3, lowerSafe: 1.84, upperSafe: 11, upperLimit: 11, unit: "mg", source: "DRI" },
  { nutrientKey: "manganese_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 1.8, lowerSafe: 1.44, upperSafe: 11, upperLimit: 11, unit: "mg", source: "DRI" },

  // Iodine
  { nutrientKey: "iodine_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "rda", recommended: 150, lowerSafe: 120, upperSafe: 1100, upperLimit: 1100, unit: "µg", source: "DRI" },
  { nutrientKey: "iodine_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "rda", recommended: 150, lowerSafe: 120, upperSafe: 1100, upperLimit: 1100, unit: "µg", source: "DRI" },

  // Chromium
  { nutrientKey: "chromium_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 35, lowerSafe: 28, upperSafe: null, upperLimit: null, unit: "µg", source: "DRI" },
  { nutrientKey: "chromium_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 25, lowerSafe: 20, upperSafe: null, upperLimit: null, unit: "µg", source: "DRI" },

  // -----------------
  // OTHER NUTRIENTS
  // -----------------
  { nutrientKey: "sodium_mg", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: 1500, lowerSafe: 1200, upperSafe: 2300, upperLimit: 2300, unit: "mg", source: "DRI" },
  { nutrientKey: "cholesterol_mg", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: 300, upperLimit: null, unit: "mg", source: "DRI" },
  { nutrientKey: "caffeine_mg", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: 400, upperLimit: 400, unit: "mg", source: "DRI" },

  // Choline
  { nutrientKey: "choline_mg", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 550, lowerSafe: 425, upperSafe: null, upperLimit: 3500, unit: "mg", source: "DRI" },
  { nutrientKey: "choline_mg", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 425, lowerSafe: 325, upperSafe: null, upperLimit: 3500, unit: "mg", source: "DRI" },

  // Betaine (informational)
  { nutrientKey: "betaine_mg", sex: null, minYears: 19, maxYears: null, referenceType: "ai", recommended: null, lowerSafe: null, upperSafe: null, upperLimit: null, unit: "mg", source: "No specific DRI for betaine (informational tracking)" },

  // Fluoride (align to stored daily totals: fluoride_ug)
  // DRI values are commonly listed in mg/day; convert to µg/day for storage alignment.
  { nutrientKey: "fluoride_ug", sex: "male", minYears: 19, maxYears: null, referenceType: "ai", recommended: 4000, lowerSafe: 3000, upperSafe: null, upperLimit: 10000, unit: "µg", source: "DRI" },
  { nutrientKey: "fluoride_ug", sex: "female", minYears: 19, maxYears: null, referenceType: "ai", recommended: 3000, lowerSafe: 2500, upperSafe: null, upperLimit: 10000, unit: "µg", source: "DRI" },
];

// Default export for consumers that `import dri_v1 from ...`
const dri_v1 = {
  profileKey: DRI_V1_PROFILE_KEY,
  version: DRI_V1_VERSION,
  bands: driV1Bands,
};

export default dri_v1;

