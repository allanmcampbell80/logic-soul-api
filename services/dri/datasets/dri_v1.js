// datasets/dri_v1.js
export const DRI_V1_VERSION = 1;
export const DRI_V1_PROFILE_KEY = "dri_v1";

export const driV1Bands = [
  {
    nutrientKey: "vitamin_c_mg",
    sex: "male",            // "male" | "female" | null
    minYears: 19,
    maxYears: null,
    referenceType: "rda",   // "rda" | "ai" | "ul" etc
    recommended: 90,
    lowerSafe: 72,
    upperSafe: 2000,
    upperLimit: 2000,
    unit: "mg",
    source: "DRI",
  },
  // ...
];
