import { driV1Bands, DRI_V1_PROFILE_KEY } from "./datasets/dri_v1.js";

export function getDriDataset(profileKey) {
  if (profileKey === DRI_V1_PROFILE_KEY) {
    return { profileKey, bands: driV1Bands, version: 1 };
  }
  return null;
}
