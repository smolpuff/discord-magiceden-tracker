// Fetch total supply for a collection from Magic Eden and HowRare (fallback), then config.json as last resort
const fetch = require("node-fetch");
const fs = require("fs");
const TRACKS_PATH = "./data/tracks.json";

async function fetchCollectionSupply(symbol) {
  let meFailed = false;
  let hrFailed = false;

  // Try Magic Eden first
  try {
    const meUrl = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
      symbol
    )}`;
    const res = await fetch(meUrl, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const data = await res.json();
      if (data && data.stats && typeof data.stats.listedCount === "number") {
        // Sometimes listedCount is not the full supply, but it's the best available from ME
        if (typeof data.stats.supply === "number") return data.stats.supply;
        if (typeof data.supply === "number") return data.supply;
      }
      if (typeof data.supply === "number") return data.supply;
    }
    meFailed = true;
  } catch (e) {
    meFailed = true;
  }

  // Try HowRare fallback
  try {
    const hrUrl = `https://api.howrare.is/v0.1/collections/${encodeURIComponent(
      symbol
    )}`;
    const res = await fetch(hrUrl, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const data = await res.json();
      if (
        data &&
        data.result &&
        data.result.collection &&
        typeof data.result.collection.supply === "number"
      ) {
        return data.result.collection.supply;
      }
    }
    hrFailed = true;
  } catch (e) {
    hrFailed = true;
  }

  // If both APIs failed, log debug before tracks.json fallback
  if (meFailed && hrFailed) {
    colorLog(
      `[SUPPLY][DEBUG] Both Magic Eden and HowRare API fetches failed for ${symbol}, falling back to tracks.json override if available.`,
      "magenta"
    );
  }

  // Try tracks.json fallback
  try {
    const tracks = JSON.parse(fs.readFileSync(TRACKS_PATH, "utf8"));
    if (
      tracks &&
      tracks.collections &&
      tracks.collections[symbol] &&
      typeof tracks.collections[symbol].supply_override === "number"
    ) {
      colorLog(
        `[SUPPLY] Using tracks.json override for ${symbol}: ${tracks.collections[symbol].supply_override}`,
        "yellow"
      );
      return tracks.collections[symbol].supply_override;
    } else {
      colorLog(
        `[SUPPLY] No tracks.json override found for ${symbol}`,
        "magenta"
      );
    }
  } catch (e) {
    colorLog(
      `[SUPPLY] Error reading tracks.json override for ${symbol}: ${e}`,
      "red"
    );
  }
  return null;
}

module.exports = { fetchCollectionSupply };
