// Version reference for update log
const METRACKER_VERSION = "0.1.6";

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
// ANSI color codes for console logs
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
};

// Colorized log function
function colorLog(message, color = "reset") {
  const colorCode = colors[color] || colors.reset;
  console.log(`${colorCode}${message}${colors.reset}`);
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmpPath, filePath);
}

function normalizeTracksData(data) {
  return {
    ...(data && typeof data === "object" ? data : {}),
    collections:
      data && typeof data.collections === "object" && !Array.isArray(data.collections)
        ? data.collections
        : {},
    sales_collections:
      data &&
      typeof data.sales_collections === "object" &&
      !Array.isArray(data.sales_collections)
        ? data.sales_collections
        : {},
  };
}

function readTracks() {
  return normalizeTracksData(readJsonFile(TRACKS_PATH, {}));
}

function writeTracks(data) {
  writeJsonAtomic(TRACKS_PATH, normalizeTracksData(data));
}

function boundedSetAdd(set, value, maxSize = MAX_SEEN_IDS) {
  if (!value) return;
  if (set.has(value)) return;
  set.add(value);
  while (set.size > maxSize) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

function getActivityId(activity, type, symbol) {
  const tokenMint = activity.tokenMint || activity.mint || activity.token?.mint || "";
  const eventId =
    activity.id ||
    activity.signature ||
    activity.txId ||
    activity.txid ||
    activity.transactionId ||
    activity.blockTime ||
    activity.createdAt ||
    activity.created_at ||
    "";
  const price = activity.price || activity.priceSol || activity.buyNowPrice || "";
  if (eventId || tokenMint || price) {
    return [type, symbol, eventId, tokenMint, price].filter(Boolean).join(":");
  }
  return `${type}:${symbol}:${JSON.stringify(activity)}`;
}

let fetch;
try {
  fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
} catch (e) {
  fetch = require("node-fetch");
}

const CONFIG_PATH = "./config.json";
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  colorLog("Could not read config.json. Please create it.", "red");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const DISCORD_CHANNEL_ID = config.DISCORD_CHANNEL_ID;
const TRACKS_PATH = "./data/tracks.json";
const OWNER_ID = config.OWNER_ID;
const TEST_MESSAGE_DELETE_SECONDS = config.TEST_MESSAGE_DELETE_SECONDS || 5;
const DEBUG_MODE = process.argv.includes("--debug");
const TOKEN_METADATA_TTL_MS = Number(config.TOKEN_METADATA_TTL_MS || 10 * 60 * 1000);
const MAX_SEEN_IDS = Number(config.MAX_SEEN_IDS || 5000);
const STARTUP_LISTINGS_PAGE_LIMIT = Number(config.STARTUP_LISTINGS_PAGE_LIMIT || 100);
const STARTUP_LISTINGS_MAX_PAGES = Number(config.STARTUP_LISTINGS_MAX_PAGES || 50);
const RARITY_ORDER = [
  "Mythic",
  "Legendary",
  "Epic",
  "Rare",
  "Uncommon",
  "Common",
];

const pollStatus = {
  startedAt: null,
  lastPollAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastTask: null,
  lastBackoffAt: null,
};

// Magic Eden/HowRare rarity tiers and color chart (as provided by user)
const RARITY_COLORS = {
  Mythic: "#ff4747", // Red
  Legendary: "#ff9900", // Orange
  Epic: "#a259ff", // Purple
  Rare: "#0099ff", // Blue
  Uncommon: "#00e599", // Green
  Common: "#b0b8c1", // Gray
};

function getRarityTier(rank, supply) {
  if (!rank || !supply || isNaN(rank) || isNaN(supply)) return "Common";
  const p = rank / supply;
  if (p <= 0.01) return "Mythic";
  if (p <= 0.05) return "Legendary";
  if (p <= 0.15) return "Epic";
  if (p <= 0.35) return "Rare";
  if (p <= 0.7) return "Uncommon";
  return "Common";
}

function normalizeTraitText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function parseTraitFilters(input) {
  if (!input || typeof input !== "string") return null;
  const filters = {};
  const pairs = input
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === pair.length - 1) {
      return null;
    }

    const traitType = pair.slice(0, separatorIndex).trim();
    const values = pair
      .slice(separatorIndex + 1)
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);

    if (!traitType || values.length === 0) return null;
    filters[traitType] = values;
  }

  return Object.keys(filters).length ? filters : null;
}

function getTraitFilters(collectionConfig) {
  const traits = collectionConfig?.traits;
  if (!traits || typeof traits !== "object" || Array.isArray(traits)) {
    return null;
  }

  const filters = {};
  for (const [traitType, rawValues] of Object.entries(traits)) {
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    const normalizedValues = values
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (traitType.trim() && normalizedValues.length) {
      filters[traitType.trim()] = normalizedValues;
    }
  }

  return Object.keys(filters).length ? filters : null;
}

function getTraitMatchMode(collectionConfig) {
  return collectionConfig?.trait_match === "any" ? "any" : "all";
}

function getTraitAlertRepeats(collectionConfig) {
  const repeats = Number(collectionConfig?.trait_alert_repeats || 1);
  if (!Number.isFinite(repeats) || repeats < 1) return 1;
  return Math.min(Math.floor(repeats), 5);
}

function extractTokenAttributes(activity, tokenData) {
  const candidates = [
    tokenData?.attributes,
    tokenData?.properties?.attributes,
    tokenData?.metadata?.attributes,
    tokenData?.token?.attributes,
    activity?.attributes,
    activity?.token?.attributes,
    activity?.metadata?.attributes,
    activity?.extra?.attributes,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((attribute) => ({
          trait_type:
            attribute.trait_type ||
            attribute.traitType ||
            attribute.type ||
            attribute.name,
          value: attribute.value,
        }))
        .filter((attribute) => attribute.trait_type && attribute.value != null);
    }
  }

  return [];
}

function matchTraitFilters(attributes, filters, mode = "all") {
  if (!filters) return { matches: true, matchedTraits: [] };

  const attributeMap = new Map();
  for (const attribute of attributes) {
    const traitType = normalizeTraitText(attribute.trait_type);
    if (!traitType) continue;
    if (!attributeMap.has(traitType)) attributeMap.set(traitType, []);
    attributeMap.get(traitType).push(normalizeTraitText(attribute.value));
  }

  const matchedTraits = [];
  for (const [traitType, allowedValues] of Object.entries(filters)) {
    const actualValues = attributeMap.get(normalizeTraitText(traitType)) || [];
    const matchedValue = allowedValues.find((allowedValue) =>
      actualValues.includes(normalizeTraitText(allowedValue))
    );

    if (!matchedValue && mode === "all") {
      return { matches: false, matchedTraits };
    }

    if (matchedValue) {
      matchedTraits.push(`${traitType}: ${matchedValue}`);
    }
  }

  return {
    matches: mode === "any" ? matchedTraits.length > 0 : true,
    matchedTraits,
  };
}

function formatTraitFilters(filters) {
  if (!filters) return "";
  return Object.entries(filters)
    .map(([traitType, values]) => `${traitType}=${values.join("|")}`)
    .join("; ");
}

// To avoid spamming the same item over and over:
let seenListingIds = new Set();
let seenSalesIds = new Set();

// Cache for collection supplies
let collectionSupplies = {};

// Cache for HowRare collection data (mint -> rank)
let howRareCache = {};

const tokenMetadataCache = new Map();

// Mapping of Magic Eden symbols to HowRare collection slugs
const ME_TO_HOWRARE = {
  great__goats: "greatgoats",
  undead_genesis: "undead_genesis",
  candies: "candies",
  morbie: "morbie",
  // Add more mappings as needed
};

// Fetch total supply for a collection from Magic Eden and HowRare (fallback), then tracks.json as last resort
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
    const tracks = readTracks();
    const trackConfig =
      tracks.collections[symbol] || tracks.sales_collections[symbol] || null;
    if (trackConfig && typeof trackConfig.supply_override === "number") {
      colorLog(
        `[SUPPLY] Using tracks.json override for ${symbol}: ${trackConfig.supply_override}`,
        "yellow"
      );
      return trackConfig.supply_override;
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

async function fetchCollectionActivities(symbol, activityType, limit = 100, throwOn429 = false) {
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/activities?limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429 && throwOn429) {
    const err = new Error("HTTP 429");
    err.is429 = true;
    throw err;
  }
  if (!res.ok) {
    console.error(`Error fetching activities for ${symbol}:`, res.status, await res.text());
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter((event) => event.type === activityType);
}

// Fetch recent listing activities for a collection from Magic Eden
// Returns only 'list' events (new listings), sorted by newest first
async function fetchRecentListings(symbol, limit = 20) {
  return fetchCollectionActivities(symbol, "list", limit);
}

// Fetch and cache supply for all tracked collections at startup
async function cacheAllCollectionSupplies() {
  try {
    const parsed = readTracks();
    const collections = parsed.collections || {};
    const salesCollections = parsed.sales_collections || {};
    const allSymbols = new Set([
      ...Object.keys(collections),
      ...Object.keys(salesCollections),
    ]);
    for (const symbol of allSymbols) {
      console.log(`[DEBUG] Starting supply check for collection: ${symbol}`);
      // First try to get supply from HowRare (faster and more reliable)
      console.log(`[DEBUG] Fetching HowRare data for ${symbol}...`);
      const howRareSupply = await cacheHowRareCollection(symbol);
      if (howRareSupply) {
        console.log(
          `[DEBUG] Got HowRare supply for ${symbol}: ${howRareSupply}`
        );
      } else {
        console.log(`[DEBUG] No HowRare supply for ${symbol}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (!collectionSupplies[symbol]) {
        const fallbackSupply = await fetchCollectionSupply(symbol);
        if (fallbackSupply) {
          collectionSupplies[symbol] = fallbackSupply;
          colorLog(`[SUPPLY] Cached fallback supply for ${symbol}: ${fallbackSupply}`, "yellow");
        } else {
          colorLog(`[SUPPLY] No supply found for ${symbol}. Rarity tiers will default to Common.`, "magenta");
        }
      }
    }
  } catch (err) {
    console.log(`Error caching collection supplies: ${err}`);
  }
}
// --- GLOBAL ROUND-ROBIN LIMITER FOR COLLECTION POLLING ---
const TICK_MS = config.ROUND_ROBIN_TICK_MS || 550; // ~1.8 requests per second
let roundRobinIdx = 0;
let globalBackoffUntil = 0;
let dynamicTickMs = TICK_MS;
const BACKOFF_MS = config.BACKOFF_MS || 10000;
let pollTimer = null;

// Index all current listings and sales at startup so only new ones trigger alerts
async function indexCurrentListings() {
  try {
    const parsed = readTracks();
    const collections = parsed.collections || {};
    const salesCollections = parsed.sales_collections || {};

    // Index listings
    const symbols = Object.keys(collections);
    for (const symbol of symbols) {
      const listings = await fetchLatestListings(symbol);
      console.log(`[INDEX] Indexing ${listings.length} listings for ${symbol}`);
      for (const listing of listings) {
        const id = getActivityId(listing, "listing", symbol);
        boundedSetAdd(seenListingIds, id);
        if (DEBUG_MODE) {
          console.log(`[INDEX] Marked as seen: ${id}`);
        }
      }
    }

    // Index sales
    const salesSymbols = Object.keys(salesCollections);
    for (const symbol of salesSymbols) {
      const sales = await fetchSales(symbol);
      console.log(`[INDEX] Indexing ${sales.length} sales for ${symbol}`);
      for (const sale of sales) {
        const id = getActivityId(sale, "sales", symbol);
        boundedSetAdd(seenSalesIds, id);
        if (DEBUG_MODE) {
          console.log(`[INDEX] Marked as seen: ${id}`);
        }
      }
    }

    console.log(
      `[INDEX] Indexed ${seenListingIds.size} listings and ${seenSalesIds.size} sales at startup.`
    );
  } catch (err) {
    console.log(`Error indexing current listings/sales: ${err}`);
  }
}

async function fetchListings(symbol) {
  return symbol ? fetchCollectionActivities(symbol, "list", 100, false) : [];
}

// Wrap fetchListings to throw on 429
async function fetchListingsWithBackoff(symbol) {
  return symbol ? fetchCollectionActivities(symbol, "list", 100, true) : [];
}

// Alias for compatibility with previous code
const fetchLatestListings = fetchListings;
const fetchLatestListingsWithBackoff = fetchListingsWithBackoff;

// Fetch sales (buyNow activities)
async function fetchSales(symbol) {
  return symbol ? fetchCollectionActivities(symbol, "buyNow", 100, false) : [];
}

// Wrap fetchSales to throw on 429
async function fetchSalesWithBackoff(symbol) {
  return symbol ? fetchCollectionActivities(symbol, "buyNow", 100, true) : [];
}

// Fetch token metadata for a specific tokenMint
async function fetchTokenMetadata(tokenMint) {
  if (!tokenMint) return null;
  const cached = tokenMetadataCache.get(tokenMint);
  if (cached && Date.now() - cached.cachedAt < TOKEN_METADATA_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(
      tokenMint
    )}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      if (res.status === 429) {
        if (DEBUG_MODE) {
          console.error(`Rate limited fetching token metadata for ${tokenMint}`);
        }
      } else {
        console.error(
          `Error fetching token metadata for ${tokenMint}:`,
          res.status
        );
      }
      return null;
    }
    const data = await res.json();
    tokenMetadataCache.set(tokenMint, { cachedAt: Date.now(), data });
    return data;
  } catch (err) {
    console.error(`Exception fetching token metadata for ${tokenMint}:`, err);
    return null;
  }
}

async function validateMagicEdenCollection(symbol) {
  try {
    const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
      symbol
    )}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429) {
      return { ok: true, warning: "Magic Eden rate limited validation; saved anyway." };
    }
    if (!res.ok) {
      return { ok: false, warning: `Magic Eden returned ${res.status} for ${symbol}.` };
    }
    const data = await res.json();
    if (!data || typeof data !== "object") {
      return { ok: false, warning: `Magic Eden returned invalid collection data for ${symbol}.` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: true, warning: `Could not validate with Magic Eden: ${err.message}` };
  }
}

async function fetchCollectionInfo(symbol) {
  try {
    const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
      symbol
    )}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(`[STARTUP] Could not fetch collection info for ${symbol}: ${err.message}`);
    }
    return null;
  }
}

function getListedCount(collectionInfo) {
  const candidates = [
    collectionInfo?.stats?.listedCount,
    collectionInfo?.stats?.listed_count,
    collectionInfo?.listedCount,
    collectionInfo?.listed_count,
  ];
  const listedCount = candidates.find((value) => Number.isFinite(Number(value)));
  return listedCount == null ? null : Number(listedCount);
}

function getCollectionImageUrl(collectionInfo, listings = []) {
  const candidates = [
    collectionInfo?.image,
    collectionInfo?.imageUrl,
    collectionInfo?.image_url,
    collectionInfo?.img,
    collectionInfo?.thumbnail,
    collectionInfo?.symbolImage,
    collectionInfo?.collectionImage,
    listings[0]?.token?.image,
    listings[0]?.extra?.img,
    listings[0]?.image,
    listings[0]?.img,
  ];
  return candidates.find((value) => typeof value === "string" && value.startsWith("http")) || null;
}

function getActivityRarityRank(activity, tokenData) {
  return (
    activity?.rarity?.howrare?.rank ||
    activity?.rarity?.meInstant?.rank ||
    activity?.rarity?.rank ||
    activity?.extra?.howrare_rank ||
    activity?.extra?.howrare?.rank ||
    activity?.token?.howrare_rank ||
    activity?.token?.rarity?.rank ||
    tokenData?.rarity?.howrare?.rank ||
    tokenData?.rarity?.meInstant?.rank ||
    tokenData?.rarity?.rank ||
    null
  );
}

async function fetchCurrentListingsPage(symbol, offset, limit) {
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/listings?offset=${offset}&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.error(`Error fetching current listings for ${symbol}:`, res.status, await res.text());
    return null;
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchCurrentListingsSnapshot(symbol) {
  const pageLimit = Math.min(Math.max(STARTUP_LISTINGS_PAGE_LIMIT, 1), 100);
  const maxPages = Math.max(STARTUP_LISTINGS_MAX_PAGES, 1);
  const listings = [];
  let exact = true;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageLimit;
    const pageListings = await fetchCurrentListingsPage(symbol, offset, pageLimit);
    if (!pageListings) {
      return { listings, listedCount: listings.length || null, exact: false };
    }

    listings.push(...pageListings);
    if (pageListings.length < pageLimit) {
      return { listings, listedCount: listings.length, exact };
    }
  }

  exact = false;
  return { listings, listedCount: listings.length, exact };
}

function getActivityFilterSummary(activity, symbol, collectionConfig) {
  const price = activity.price || activity.priceSol || activity.buyNowPrice || 0;
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum)) {
    return { matchesFilters: false, isTraitMatch: false, matchedTraits: [] };
  }

  let maxPrice = Number(collectionConfig.max_price);
  if (!Number.isFinite(maxPrice) || maxPrice === 0) maxPrice = null;
  if (maxPrice !== null && priceNum > maxPrice) {
    return { matchesFilters: false, isTraitMatch: false, matchedTraits: [] };
  }

  const tokenMint = activity.tokenMint || activity.mint;
  const howrare = getActivityRarityRank(activity, null) || getHowRareRank(symbol, tokenMint);
  const supply = collectionSupplies[symbol] || null;
  const rarityTier = getRarityTier(Number(howrare), supply);
  const minRarity = collectionConfig.min_rarity || null;

  if (
    minRarity &&
    RARITY_ORDER.indexOf(rarityTier) > RARITY_ORDER.indexOf(minRarity)
  ) {
    return { matchesFilters: false, isTraitMatch: false, matchedTraits: [] };
  }

  const traitFilters = getTraitFilters(collectionConfig);
  const traitMatch = matchTraitFilters(
    extractTokenAttributes(activity, null),
    traitFilters,
    getTraitMatchMode(collectionConfig)
  );

  return {
    matchesFilters: true,
    isTraitMatch: Boolean(traitFilters && traitMatch.matches),
    matchedTraits: traitMatch.matchedTraits,
  };
}

async function buildStartupSummary() {
  const tracks = readTracks();
  const rows = [];
  const listingSymbols = Object.keys(tracks.collections || {});
  const salesSymbols = Object.keys(tracks.sales_collections || {});

  for (const symbol of listingSymbols) {
    const collectionConfig = tracks.collections[symbol] || {};
    const collectionInfo = await fetchCollectionInfo(symbol);
    const currentListings = await fetchCurrentListingsSnapshot(symbol);
    const listedCount =
      currentListings.listedCount ?? getListedCount(collectionInfo);
    const listings = currentListings.listings;
    let filterMatches = 0;
    let priorityMatches = 0;
    const matchedTraits = new Set();

    for (const listing of listings) {
      const summary = await getActivityFilterSummary(listing, symbol, collectionConfig);
      if (summary.matchesFilters) filterMatches++;
      if (summary.isTraitMatch) {
        priorityMatches++;
        for (const trait of summary.matchedTraits) matchedTraits.add(trait);
      }
    }

    rows.push({
      symbol,
      type: "listings",
      listedCount,
      listedCountExact: currentListings.exact,
      imageUrl: getCollectionImageUrl(collectionInfo, listings),
      recentCount: listings.length,
      filterMatches,
      priorityMatches,
      matchedTraits: [...matchedTraits],
      filters: [
        collectionConfig.max_price ? `max ${collectionConfig.max_price} SOL` : "no max",
        collectionConfig.min_rarity ? `min ${collectionConfig.min_rarity}` : null,
        getTraitFilters(collectionConfig)
          ? `${getTraitMatchMode(collectionConfig)} traits ${formatTraitFilters(
              getTraitFilters(collectionConfig)
            )}`
          : null,
      ].filter(Boolean),
    });
  }

  for (const symbol of salesSymbols) {
    rows.push({
      symbol,
      type: "sales",
      listedCount: null,
      listedCountExact: false,
      imageUrl: null,
      recentCount: null,
      filterMatches: null,
      priorityMatches: null,
      matchedTraits: [],
      filters: ["sales tracking enabled"],
    });
  }

  return {
    rows,
    listingCount: listingSymbols.length,
    salesCount: salesSymbols.length,
  };
}

function formatStartupSummaryForConsole(summary) {
  const lines = [
    `[STARTUP] METRACKER v${METRACKER_VERSION}`,
    `[STARTUP] Tracking ${summary.listingCount} listing collection(s), ${summary.salesCount} sales collection(s).`,
  ];

  for (const row of summary.rows) {
    const listedLabel =
      row.listedCount == null
        ? "unknown"
        : `${row.listedCountExact ? "" : ">="}${row.listedCount}`;
    lines.push(
      `[STARTUP] ${row.symbol} (${row.type}) listed=${listedLabel} currentSample=${row.recentCount ?? "n/a"} filterMatches=${row.filterMatches ?? "n/a"} priorityMatches=${row.priorityMatches ?? "n/a"} filters=${row.filters.join(", ")}`
    );
    if (row.matchedTraits.length) {
      lines.push(`[STARTUP] ${row.symbol} matched traits: ${row.matchedTraits.join(", ")}`);
    }
  }

  return lines;
}

async function sendStartupSummary() {
  try {
    const summary = await buildStartupSummary();
    for (const line of formatStartupSummaryForConsole(summary)) {
      colorLog(line, "cyan");
    }

    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel) return;

    const headerEmbed = {
      title: "METRACKER STARTUP",
      description: `Tracking ${summary.listingCount} listing collection(s) and ${summary.salesCount} sales collection(s).`,
      color: 0x9b59ff,
      footer: {
        text: `Polling every ${Math.round(dynamicTickMs / 1000)}s per task`,
      },
      timestamp: new Date().toISOString(),
    };

    const collectionEmbeds = summary.rows.map((row) => {
      const listedLabel =
        row.listedCount == null
          ? "unknown"
          : `${row.listedCountExact ? "" : ">="}${row.listedCount}`;
      const embed = {
        title: `${row.symbol} - ${row.type}`,
        color: row.priorityMatches > 0 ? 0xffd700 : 0x9b59ff,
        fields: [
          { name: "Listed", value: String(listedLabel), inline: true },
          row.recentCount == null
            ? null
            : { name: "Current sampled", value: String(row.recentCount), inline: true },
          row.filterMatches == null
            ? null
            : { name: "Filter matches", value: String(row.filterMatches), inline: true },
          row.priorityMatches == null
            ? null
            : { name: "Priority matches", value: String(row.priorityMatches), inline: true },
          row.matchedTraits.length
            ? {
                name: "Matched traits",
                value: row.matchedTraits.join("\n").slice(0, 1024),
                inline: false,
              }
            : null,
          {
            name: "Filters",
            value: (row.filters.join(", ") || "none").slice(0, 1024),
            inline: false,
          },
        ].filter(Boolean),
      };
      if (row.imageUrl) {
        embed.thumbnail = { url: row.imageUrl };
      }
      return embed;
    });

    const embeds = [headerEmbed, ...collectionEmbeds];
    for (let i = 0; i < embeds.length; i += 10) {
      await channel.send({ embeds: embeds.slice(i, i + 10) });
    }
  } catch (err) {
    console.log(`[STARTUP] Could not send startup summary: ${err.message}`);
  }
}

// Fetch and cache entire HowRare collection data
async function cacheHowRareCollection(meSymbol) {
  const howRareSlug = ME_TO_HOWRARE[meSymbol];
  if (!howRareSlug) {
    console.log(
      `${colors.magenta}[HOWRARE] No HowRare mapping for ${meSymbol}${colors.reset}`
    );
    return null;
  }

  if (howRareCache[meSymbol]) {
    console.log(
      `${colors.magenta}[HOWRARE] ${meSymbol} already cached${colors.reset}`
    );
    return collectionSupplies[meSymbol] || null;
  }

  try {
    console.log(
      `${colors.magenta}[HOWRARE] Fetching collection data for ${howRareSlug}...${colors.reset}`
    );
    const url = `https://api.howrare.is/v0.1/collections/${howRareSlug}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.log(
        `${colors.magenta}[HOWRARE] Error fetching ${howRareSlug}: ${res.status}${colors.reset}`
      );
      return null;
    }
    const data = await res.json();
    const items = data?.result?.data?.items || [];

    // Build mint -> rank mapping
    const cache = {};
    for (const item of items) {
      if (item.mint && item.rank) {
        cache[item.mint] = item.rank;
      }
    }

    howRareCache[meSymbol] = cache;
    const totalItems = Object.keys(cache).length;
    console.log(
      `${colors.magenta}[HOWRARE] Cached ${totalItems} items for ${meSymbol}${colors.reset}`
    );

    // Also cache the supply from HowRare
    if (totalItems > 0 && !collectionSupplies[meSymbol]) {
      collectionSupplies[meSymbol] = totalItems;
      console.log(
        `${colors.yellow}[SUPPLY] Using HowRare supply for ${meSymbol}: ${totalItems}${colors.reset}`
      );
    }

    return totalItems;
  } catch (err) {
    console.log(
      `${colors.magenta}[HOWRARE] Exception fetching ${howRareSlug}: ${err}${colors.reset}`
    );
    return null;
  }
}

// Get HowRare rank from cache
function getHowRareRank(meSymbol, tokenMint) {
  if (!tokenMint || !howRareCache[meSymbol]) return null;
  return howRareCache[meSymbol][tokenMint] || null;
}

// Register slash commands on startup (guild only for fast update)
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("metrack")
      .setDescription(
        "Track a collection. Traits format: Background=Blue; Eyes=Laser|Gold"
      )
      .addStringOption((opt) =>
        opt
          .setName("symbol")
          .setDescription("magicedenURL:<url> (see prompt)")
          .setRequired(true)
      )
      .addNumberOption((opt) =>
        opt
          .setName("max_price")
          .setDescription("Max price in SOL")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("traits")
          .setDescription(
            "Optional trait filters. Example: Background=Blue; Eyes=Laser|Gold"
          )
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("meuntrack")
      .setDescription(
        "Untrack a collection. Usage: /meuntrack magicedenURL:<url>"
      )
      .addStringOption((opt) =>
        opt
          .setName("symbol")
          .setDescription("magicedenURL:<url> (see prompt)")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("mesalestrack")
      .setDescription(
        "Track sales for a collection. Traits format: Background=Blue; Eyes=Laser|Gold"
      )
      .addStringOption((opt) =>
        opt
          .setName("symbol")
          .setDescription("magicedenURL:<url> (see prompt)")
          .setRequired(true)
      )
      .addNumberOption((opt) =>
        opt
          .setName("max_price")
          .setDescription("Max price in SOL")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("traits")
          .setDescription(
            "Optional trait filters. Example: Background=Blue; Eyes=Laser|Gold"
          )
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("mesalesuntrack")
      .setDescription(
        "Untrack sales for a collection. Usage: /mesalesuntrack magicedenURL:<url>"
      )
      .addStringOption((opt) =>
        opt
          .setName("symbol")
          .setDescription("magicedenURL:<url> (see prompt)")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("melist")
      .setDescription("List tracked collections"),
    new SlashCommandBuilder()
      .setName("mestatus")
      .setDescription("Show tracker health and polling status"),
    new SlashCommandBuilder()
      .setName("metest")
      .setDescription("Clear cache and re-alert on current listings/sales"),
    new SlashCommandBuilder()
      .setName("mecleanup")
      .setDescription("Delete my messages in this channel"),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID),
      { body: commands }
    );
    console.log("Slash commands registered!");
  } catch (err) {
    console.log("Failed to register slash commands: " + err);
  }
}

client.once("ready", () => {
  (async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerSlashCommands();
    console.log("[DEBUG] Finished registering slash commands.");
    await cacheAllCollectionSupplies();
    console.log("[DEBUG] Finished caching all collection supplies.");

    // Always index all current listings at startup FIRST to avoid spam
    await indexCurrentListings();
    console.log("[DEBUG] Finished indexing current listings.");
    await sendStartupSummary();
    console.log("[DEBUG] Finished startup summary.");

    // Only show startup debug post if --debug flag is present
    const debugMode = process.argv.includes("--debug");
    if (debugMode) {
      try {
        const debugChannel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        const raw = fs.readFileSync(TRACKS_PATH, "utf8");
        const parsed = JSON.parse(raw);
        const collections = parsed.collections || {};
        const symbols = Object.keys(collections);
        if (symbols.length > 0) {
          const symbol = symbols[0];
          let listings = await fetchLatestListings(symbol);
          if (listings.length > 0) {
            // Sort by blockTime descending to get newest listings first
            listings.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));
            colorLog(
              `[DEBUG] Sorted ${listings.length} listings by blockTime. Newest: ${listings[0].blockTime}`,
              "cyan"
            );

            const minRarity = collections[symbol].min_rarity || null;
            let shown = 0;
            const RARITY_ORDER = [
              "Mythic",
              "Legendary",
              "Epic",
              "Rare",
              "Uncommon",
              "Common",
            ];
            for (let i = 0; i < listings.length && shown < 3; i++) {
              const listing = listings[i];
              // Debug: print the full listing object to console
              console.log(
                `DEBUG: Listing #${i + 1} object: ${JSON.stringify(
                  listing,
                  null,
                  2
                )}`
              );
              // Fetch token metadata from the token endpoint
              const tokenMint = listing.tokenMint || listing.mint;
              console.log(
                `[DEBUG] Fetching token metadata for ${tokenMint}...`
              );
              const tokenData = tokenMint
                ? await fetchTokenMetadata(tokenMint)
                : null;
              console.log(
                `[DEBUG] Token data: ${
                  tokenData ? JSON.stringify(tokenData, null, 2) : "null"
                }`
              );

              const price = listing.price || 0; // Already in SOL
              let name = tokenData?.name || "Unknown NFT";

              // Get rarity rank from cached HowRare data
              let howrare = getHowRareRank(symbol, tokenMint);
              // Print HowRare prefix in magenta, rank in yellow
              console.log(
                `${colors.magenta}[HOWRARE] HowRare rank for ${tokenMint}: ${colors.yellow}${howrare}${colors.magenta}${colors.reset}`
              );
              const link = `https://magiceden.io/item-details/${
                tokenMint || ""
              }`;
              let imageUrl =
                listing.image || tokenData?.image || tokenData?.img || null;

              // Use cached supply for rarity tier
              let supply = collectionSupplies[symbol] || null;
              let rankNum = Number(howrare);
              let rarityTier = getRarityTier(rankNum, supply);
              let rarityColor = RARITY_COLORS[rarityTier] || "#9b59ff";

              // Rarity filtering logic for debug/test
              if (
                minRarity &&
                RARITY_ORDER.indexOf(rarityTier) >
                  RARITY_ORDER.indexOf(minRarity)
              ) {
                continue;
              }

              const embed = {
                title: `DEBUG: Listing #${i + 1} for ${symbol}`,
                description: [
                  `Name: **${name}**`,
                  `Price: **${price} SOL**`,
                  howrare !== null && !isNaN(rankNum) && supply
                    ? `Rarity: **${howrare}** (${rarityTier})`
                    : howrare !== null
                    ? `Rarity: **${howrare}**`
                    : null,
                  `Link: ${link}`,
                ]
                  .filter(Boolean)
                  .join("\n"),
                url: link,
                color: parseInt(rarityColor.replace("#", ""), 16),
              };
              if (imageUrl) {
                embed.image = { url: imageUrl };
              }
              const msg = await debugChannel.send({ embeds: [embed] });
              setTimeout(
                () => msg.delete().catch(() => {}),
                TEST_MESSAGE_DELETE_SECONDS * 1000
              );
              shown++;
              if (shown >= 3) break;
            }
          }
        }
      } catch (err) {
        console.log(`DEBUG fetch error: ${err}`);
      }
    }

    startRoundRobinPolling();
  })();
});

// Start the global round-robin polling
function startRoundRobinPolling() {
  pollStatus.startedAt = new Date();

  const scheduleNextPoll = () => {
    pollTimer = setTimeout(async () => {
      await pollNextCollectionRoundRobin();
      scheduleNextPoll();
    }, dynamicTickMs);
  };

  if (pollTimer) clearTimeout(pollTimer);
  scheduleNextPoll();
}

// Poll the next collection in a round-robin fashion (handles both listings and sales)
async function pollNextCollectionRoundRobin() {
  let collections = {};
  let salesCollections = {};
  try {
    const parsed = readTracks();
    collections = parsed.collections || {};
    salesCollections = parsed.sales_collections || {};
  } catch (e) {
    // No collections or error reading file
    return;
  }

  // Create a combined list of all tracking tasks (listings + sales)
  const listingTasks = Object.keys(collections).map((symbol) => ({
    symbol,
    type: "listing",
    config: collections[symbol],
  }));
  const salesTasks = Object.keys(salesCollections).map((symbol) => ({
    symbol,
    type: "sales",
    config: salesCollections[symbol],
  }));
  const allTasks = [...listingTasks, ...salesTasks];

  if (!allTasks.length) return;
  // Backoff logic
  if (Date.now() < globalBackoffUntil) return;

  // Pick next task
  const task = allTasks[roundRobinIdx % allTasks.length];
  const { symbol, type, config: collectionConfig } = task;

  let maxPrice = Number(collectionConfig.max_price);
  if (!Number.isFinite(maxPrice) || maxPrice === 0) maxPrice = null;
  const minRarity = collectionConfig.min_rarity || null;
  const traitFilters = getTraitFilters(collectionConfig);
  const traitMatchMode = getTraitMatchMode(collectionConfig);
  const traitAlertRepeats = getTraitAlertRepeats(collectionConfig);
  const filterOptions = [`maxPrice: ${maxPrice !== null ? maxPrice : "None"}`];
  if (minRarity) filterOptions.push(`minRarity: ${minRarity}`);
  if (traitFilters) {
    filterOptions.push(
      `traits: ${traitMatchMode} ${formatTraitFilters(traitFilters)}`
    );
  }

  console.log(`[Polling] Checking ${type} for ${symbol} (${filterOptions.join(", ")})`);
  pollStatus.lastPollAt = new Date();
  pollStatus.lastTask = `${type}:${symbol}`;
  roundRobinIdx = (roundRobinIdx + 1) % allTasks.length;

  // Use cached supply for rarity math
  const supply = collectionSupplies[symbol] || null;

  try {
    // Fetch either listings or sales based on type
    const activities =
      type === "listing"
        ? await fetchLatestListingsWithBackoff(symbol)
        : await fetchSalesWithBackoff(symbol);

    if (!activities.length) return;
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    const seenSet = type === "listing" ? seenListingIds : seenSalesIds;

    for (const activity of activities) {
      const id = getActivityId(activity, type, symbol);
      if (seenSet.has(id)) {
        if (DEBUG_MODE) {
          colorLog(`[SKIP] Already seen: ${id}`, "gray");
        }
        continue;
      }
      const price =
        activity.price || activity.priceSol || activity.buyNowPrice || 0;
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum)) {
        if (DEBUG_MODE) {
          colorLog(`[SKIP] Invalid price for ${id}: ${priceNum}`, "yellow");
        }
        continue;
      }
      if (maxPrice !== null && priceNum > maxPrice) {
        if (DEBUG_MODE) {
          colorLog(
            `[SKIP] Price ${priceNum} > max ${maxPrice} for ${id}`,
            "yellow"
          );
        }
        continue;
      }
      colorLog(`[NEW] Found new ${type}: ${id} at ${priceNum} SOL`, "cyan");

      // Fetch token metadata to get name and image
      const tokenMint = activity.tokenMint || activity.mint;
      if (DEBUG_MODE) console.log(`[DEBUG] Fetching token metadata for ${tokenMint}...`);
      const tokenData = tokenMint ? await fetchTokenMetadata(tokenMint) : null;
      if (DEBUG_MODE) {
        console.log(
          `[DEBUG] Token data: ${
            tokenData ? JSON.stringify(tokenData, null, 2) : "null"
          }`
        );
      }

      let name = tokenData?.name || "Unknown NFT";
      const attributes = extractTokenAttributes(activity, tokenData);
      const traitMatch = matchTraitFilters(
        attributes,
        traitFilters,
        traitMatchMode
      );
      const isTraitMatch = Boolean(traitFilters && traitMatch.matches);

      // Get rarity rank from cached HowRare data
      let howrare = getHowRareRank(symbol, tokenMint);
      if (DEBUG_MODE) {
        console.log(
          `${colors.magenta}[HOWRARE] HowRare rank for ${tokenMint}: ${colors.yellow}${howrare}${colors.magenta}${colors.reset}`
        );
      }
      let rankNum = Number(howrare);
      let rarityTier = getRarityTier(rankNum, supply);
      let rarityColor = isTraitMatch
        ? "#ffd700"
        : RARITY_COLORS[rarityTier] || "#9b59ff";

      // Rarity filtering logic
      if (
        minRarity &&
        RARITY_ORDER.indexOf(rarityTier) > RARITY_ORDER.indexOf(minRarity)
      ) {
        // Skip if this NFT is lower rarity than the filter
        boundedSetAdd(seenSet, id); // Mark as seen even when filtered to avoid reprocessing
        if (DEBUG_MODE) {
          colorLog(
            `[SKIP] Rarity ${rarityTier} < min ${minRarity} for ${id}`,
            "yellow"
          );
        }
        continue;
      }

      boundedSetAdd(seenSet, id);
      if (DEBUG_MODE) {
        colorLog(`[CACHE] Added to seen cache: ${id}`, "cyan");
      }
      const link = `https://magiceden.io/item-details/${tokenMint || ""}`;
      let imageUrl =
        activity.image || tokenData?.image || tokenData?.img || null;
      const priceLabel =
        maxPrice !== null ? `${priceNum} SOL (<= ${maxPrice} SOL)` : `${priceNum} SOL`;
      const priorityContent = isTraitMatch
        ? [
            config.PRIORITY_MENTION_OWNER ? `<@${OWNER_ID}>` : null,
            "PRIORITY TRAIT MATCH",
            `Matched: ${traitMatch.matchedTraits.join(", ")}`,
          ]
            .filter(Boolean)
            .join(" | ")
        : null;
      const embed = {
        title:
          (isTraitMatch ? "[PRIORITY] " : "") +
          (type === "listing"
            ? `New listing in ${symbol}!`
            : `New sale in ${symbol}!`),
        description: isTraitMatch
          ? "**This listing matched one of your watched traits.**"
          : null,
        fields: [
          { name: "NFT", value: name, inline: true },
          { name: "Price", value: priceLabel, inline: true },
          traitMatch.matchedTraits.length
            ? {
                name: isTraitMatch ? "Priority Traits" : "Traits",
                value: traitMatch.matchedTraits.join("\n"),
                inline: false,
              }
            : null,
          howrare !== null && !isNaN(rankNum) && supply
            ? {
                name: "Rarity",
                value: `${howrare} (${rarityTier})`,
                inline: true,
              }
            : howrare !== null
            ? { name: "Rarity", value: String(howrare), inline: true }
            : null,
          { name: "Open", value: `[View on Magic Eden](${link})`, inline: true },
        ].filter(Boolean),
        url: link,
        color: parseInt(rarityColor.replace("#", ""), 16),
        footer: {
          text: isTraitMatch
            ? "Priority match - repeated alert"
            : "Magic Eden tracker",
        },
        timestamp: new Date().toISOString(),
      };
      if (imageUrl) embed.image = { url: imageUrl };

      try {
        const sendCount = isTraitMatch ? traitAlertRepeats : 1;
        for (let i = 0; i < sendCount; i++) {
          await channel.send({
            content: priorityContent,
            embeds: [embed],
            allowedMentions: {
              users:
                isTraitMatch && config.PRIORITY_MENTION_OWNER
                  ? [OWNER_ID]
                  : [],
            },
          });
        }
        // Colorize alert log in green
        colorLog(
          `Sent ${sendCount} alert(s) for ${type}: ${id} (${symbol})`,
          "green"
        );
        pollStatus.lastSuccessAt = new Date();
        pollStatus.lastError = null;
      } catch (sendErr) {
        console.error(
          `[ERROR] Failed to send Discord message: ${sendErr.message}`
        );
        console.error(`[ERROR] Embed data: ${JSON.stringify(embed, null, 2)}`);
      }
    }
  } catch (err) {
    if (err && err.is429) {
      // Backoff for BACKOFF_MS and increase tick interval for safety
      globalBackoffUntil = Date.now() + BACKOFF_MS;
      dynamicTickMs = Math.min(Math.max(dynamicTickMs + 30000, TICK_MS), 10 * 60 * 1000);
      pollStatus.lastBackoffAt = new Date();
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      const msg = `[BACKOFF] Magic Eden API rate limit hit (429). Pausing all polling for ${
        BACKOFF_MS / 1000
      }s. Slowing down to ${Math.round(dynamicTickMs / 1000)}s per task.`;
      if (channel) {
        channel.send(msg).catch(() => {});
      }
      console.log(msg);
    } else {
      pollStatus.lastError = err?.message || String(err);
      console.log(`Error in round-robin polling: ${err}`);
    }
  }
}

function reloadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.log(`Could not reload config.json: ${e}`);
  }
}

client.on("interactionCreate", async (interaction) => {
  reloadConfig();
  if (!interaction.isCommand()) return;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({
      content: "You're not my daddy.",
      flags: 64, // 64 = EPHEMERAL
    });
    return;
  }

  // Helper to extract symbol from Magic Eden URL
  function extractSymbol(url) {
    try {
      const match = url.match(/magiceden\.io\/marketplace\/([\w_\-]+)/i);
      if (match) return match[1];
      // If not a URL, but a valid symbol (letters, numbers, _, -), return as-is
      if (/^[\w\-]+$/.test(url)) return url;
      return null;
    } catch {
      return null;
    }
  }

  if (interaction.commandName === "metrack") {
    const urlOrSymbol = interaction.options.getString("symbol");
    const maxPrice = interaction.options.getNumber("max_price");
    const traitsInput = interaction.options.getString("traits");
    const traitFilters = traitsInput ? parseTraitFilters(traitsInput) : null;
    const symbol = extractSymbol(urlOrSymbol);
    if (!symbol) {
      await interaction.reply({
        content:
          "Could not extract collection symbol from the provided URL. Please provide a valid Magic Eden collection URL or symbol.",
        flags: 64,
      });
      return;
    }
    if (traitsInput && !traitFilters) {
      await interaction.reply({
        content:
          "Could not parse traits. Use this format: `Background=Blue; Eyes=Laser|Gold`.",
        flags: 64,
      });
      return;
    }
    const validation = await validateMagicEdenCollection(symbol);
    if (!validation.ok) {
      await interaction.reply({
        content: `Could not validate collection "${symbol}". ${validation.warning}`,
        flags: 64,
      });
      return;
    }
    // Load existing tracks
    let data = readTracks();
    data.collections[symbol] = {
      ...(data.collections[symbol] || {}),
      max_price: maxPrice,
    };
    if (traitFilters) {
      data.collections[symbol].traits = traitFilters;
    } else if (traitsInput === "") {
      delete data.collections[symbol].traits;
    }
    writeTracks(data);
    await interaction.reply(
      `✅ Now tracking listings for ${symbol} with max price ${maxPrice} SOL${
        traitFilters ? ` and traits ${formatTraitFilters(traitFilters)}` : ""
      }.${validation.warning ? ` ${validation.warning}` : ""}`
    );
    await indexCurrentListings();
    return;
  }

  if (interaction.commandName === "meuntrack") {
    const urlOrSymbol = interaction.options.getString("symbol");
    const symbol = extractSymbol(urlOrSymbol);
    if (!symbol) {
      await interaction.reply({
        content:
          "Could not extract collection symbol from the provided URL. Please provide a valid Magic Eden collection URL or symbol.",
        flags: 64,
      });
      return;
    }
    let data = readTracks();
    delete data.collections[symbol];
    writeTracks(data);
    await interaction.reply(`✅ Stopped tracking listings for ${symbol}.`);
    return;
  }

  if (interaction.commandName === "mesalestrack") {
    const urlOrSymbol = interaction.options.getString("symbol");
    const maxPrice = interaction.options.getNumber("max_price");
    const traitsInput = interaction.options.getString("traits");
    const traitFilters = traitsInput ? parseTraitFilters(traitsInput) : null;
    const symbol = extractSymbol(urlOrSymbol);
    if (!symbol) {
      await interaction.reply({
        content:
          "Could not extract collection symbol from the provided URL. Please provide a valid Magic Eden collection URL or symbol.",
        flags: 64,
      });
      return;
    }
    if (traitsInput && !traitFilters) {
      await interaction.reply({
        content:
          "Could not parse traits. Use this format: `Background=Blue; Eyes=Laser|Gold`.",
        flags: 64,
      });
      return;
    }
    const validation = await validateMagicEdenCollection(symbol);
    if (!validation.ok) {
      await interaction.reply({
        content: `Could not validate collection "${symbol}". ${validation.warning}`,
        flags: 64,
      });
      return;
    }
    // Load existing tracks
    let data = readTracks();
    data.sales_collections[symbol] = {
      ...(data.sales_collections[symbol] || {}),
      max_price: maxPrice,
    };
    if (traitFilters) {
      data.sales_collections[symbol].traits = traitFilters;
    } else if (traitsInput === "") {
      delete data.sales_collections[symbol].traits;
    }
    writeTracks(data);
    await interaction.reply(
      `✅ Now tracking sales for ${symbol} with max price ${maxPrice} SOL${
        traitFilters ? ` and traits ${formatTraitFilters(traitFilters)}` : ""
      }.${validation.warning ? ` ${validation.warning}` : ""}`
    );
    await indexCurrentListings();
    return;
  }

  if (interaction.commandName === "mesalesuntrack") {
    const urlOrSymbol = interaction.options.getString("symbol");
    const symbol = extractSymbol(urlOrSymbol);
    if (!symbol) {
      await interaction.reply({
        content:
          "Could not extract collection symbol from the provided URL. Please provide a valid Magic Eden collection URL or symbol.",
        flags: 64,
      });
      return;
    }
    let data = readTracks();
    delete data.sales_collections[symbol];
    writeTracks(data);
    await interaction.reply(`✅ Stopped tracking sales for ${symbol}.`);
    return;
  }

  if (interaction.commandName === "melist") {
    let data = readTracks();
    const listingSymbols = Object.keys(data.collections || {});
    const salesSymbols = Object.keys(data.sales_collections || {});

    if (listingSymbols.length === 0 && salesSymbols.length === 0) {
      await interaction.reply("No collections are being tracked.");
      return;
    }

    let response = "";
    if (listingSymbols.length > 0) {
      const listingList = listingSymbols
        .map((symbol) => {
          const maxPrice = data.collections[symbol].max_price;
          const traits = formatTraitFilters(
            getTraitFilters(data.collections[symbol])
          );
          return `- ${symbol}: max price ${maxPrice} SOL${
            traits ? `, traits ${traits}` : ""
          }`;
        })
        .join("\n");
      response += `**Tracking Listings:**\n${listingList}\n`;
    }

    if (salesSymbols.length > 0) {
      const salesList = salesSymbols
        .map((symbol) => {
          const maxPrice = data.sales_collections[symbol].max_price;
          const traits = formatTraitFilters(
            getTraitFilters(data.sales_collections[symbol])
          );
          return `- ${symbol}: max price ${maxPrice} SOL${
            traits ? `, traits ${traits}` : ""
          }`;
        })
        .join("\n");
      if (response) response += "\n";
      response += `**Tracking Sales:**\n${salesList}`;
    }

    await interaction.reply(response);
    return;
  }

  if (interaction.commandName === "mestatus") {
    const data = readTracks();
    const listingCount = Object.keys(data.collections || {}).length;
    const salesCount = Object.keys(data.sales_collections || {}).length;
    const backoffRemainingMs = Math.max(0, globalBackoffUntil - Date.now());
    await interaction.reply({
      content: [
        `Version: ${METRACKER_VERSION}`,
        `Tracked tasks: ${listingCount} listings, ${salesCount} sales`,
        `Tick: ${Math.round(dynamicTickMs / 1000)}s per task`,
        `Backoff: ${backoffRemainingMs ? `${Math.ceil(backoffRemainingMs / 1000)}s remaining` : "none"}`,
        `Last task: ${pollStatus.lastTask || "none"}`,
        `Last poll: ${pollStatus.lastPollAt ? pollStatus.lastPollAt.toISOString() : "never"}`,
        `Last success: ${pollStatus.lastSuccessAt ? pollStatus.lastSuccessAt.toISOString() : "never"}`,
        `Last error: ${pollStatus.lastError || "none"}`,
        `Seen cache: ${seenListingIds.size} listings, ${seenSalesIds.size} sales`,
        `Token metadata cache: ${tokenMetadataCache.size}`,
      ].join("\n"),
      flags: 64,
    });
    return;
  }

  if (interaction.commandName === "metest") {
    const beforeListings = seenListingIds.size;
    const beforeSales = seenSalesIds.size;
    seenListingIds.clear();
    seenSalesIds.clear();
    colorLog(
      `[TEST] Cleared seen cache: ${beforeListings} listings, ${beforeSales} sales. Re-checking now...`,
      "cyan"
    );
    await interaction.reply({
      content: `🔄 Cleared seen cache: ${beforeListings} listings, ${beforeSales} sales. Will re-alert on current activities.`,
      flags: 64,
    });
    return;
  }

  if (interaction.commandName === "mecleanup") {
    const channel = interaction.channel;
    try {
      let totalDeleted = 0;
      let lastBatchSize = 0;
      do {
        const fetched = await channel.messages.fetch({ limit: 100 });
        const botMessages = fetched.filter(
          (m) => m.author.id === client.user.id
        );
        lastBatchSize = botMessages.size;
        if (lastBatchSize > 0) {
          await channel.bulkDelete(botMessages, true);
          totalDeleted += lastBatchSize;
        }
      } while (lastBatchSize === 100);
      await interaction.reply({
        content: `🧹 Deleted ${totalDeleted} of my messages in this channel.`,
        flags: 64,
      });
    } catch (err) {
      console.log(`Cleanup error: ${err}`);
      await interaction.reply({
        content: "Failed to delete messages: " + err.message,
        flags: 64,
      });
    }
    return;
  }
});

client.on("messageCreate", async (message) => {
  reloadConfig();
  // Ignore messages from the bot itself
  if (message.author.id === client.user.id) return;

  // Log all messages for debugging
  if (DEBUG_MODE) {
    console.log(
      `[MESSAGE] Received from ${message.author.tag}: "${message.content}"`
    );
  }

  if (message.author.id !== OWNER_ID) return;

  const legacyCommand = message.content.trim().split(/\s+/)[0]?.toLowerCase();
  if (["/track", "/untrack", "/list"].includes(legacyCommand)) {
    return message.reply(
      "Text commands are disabled to protect the tracker config. Use `/metrack`, `/meuntrack`, or `/melist` instead."
    );
  }

  // Cleanup command: delete bot's own messages in the current channel
  if (message.content.trim().toLowerCase() === "/cleanup") {
    if (!message.guild) return;
    const channel = message.channel;
    try {
      let totalDeleted = 0;
      let lastBatchSize = 0;
      do {
        // Fetch up to 100 recent messages
        const fetched = await channel.messages.fetch({ limit: 100 });
        // Filter to only messages sent by this bot
        const botMessages = fetched.filter(
          (m) => m.author.id === client.user.id
        );
        lastBatchSize = botMessages.size;
        if (lastBatchSize > 0) {
          await channel.bulkDelete(botMessages, true);
          totalDeleted += lastBatchSize;
        }
      } while (lastBatchSize === 100); // Repeat if there might be more
      message
        .reply(`🧹 Deleted ${totalDeleted} of my messages in this channel.`)
        .then((msg) =>
          setTimeout(
            () => msg.delete().catch(() => {}),
            TEST_MESSAGE_DELETE_SECONDS * 1000
          )
        );
    } catch (err) {
      console.log(`Cleanup error: ${err}`);
      message
        .reply("Failed to delete messages: " + err.message)
        .then((msg) =>
          setTimeout(
            () => msg.delete().catch(() => {}),
            TEST_MESSAGE_DELETE_SECONDS * 1000
          )
        );
    }
  }

  // Test command: clear seen listings and sales and re-check
  if (message.content.trim().toLowerCase() === "/test") {
    const beforeListings = seenListingIds.size;
    const beforeSales = seenSalesIds.size;
    seenListingIds.clear();
    seenSalesIds.clear();
    colorLog(
      `[TEST] Cleared seen cache: ${beforeListings} listings, ${beforeSales} sales. Re-checking now...`,
      "cyan"
    );
    message.reply(
      `🔄 Cleared seen cache: ${beforeListings} listings, ${beforeSales} sales. Will re-alert on current activities.`
    );
    return;
  }
});

client.login(config.DISCORD_TOKEN);
