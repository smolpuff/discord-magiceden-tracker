// Version reference for update log
const METRACKER_VERSION = "0.1.5";

const fs = require("fs");
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
const POLL_INTERVAL_SECONDS = parseInt(config.POLL_INTERVAL_SECONDS || "2", 10);
const OWNER_ID = config.OWNER_ID;
const TEST_MESSAGE_DELETE_SECONDS = config.TEST_MESSAGE_DELETE_SECONDS || 5;

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

// To avoid spamming the same item over and over:
let seenListingIds = new Set();
let seenSalesIds = new Set();

// Track when we last cleared the seen caches (to prevent infinite growth)
let lastCacheClear = Date.now();
const CACHE_CLEAR_INTERVAL_MS = 3600000; // Clear cache every 1 hour

// Cache for collection supplies
let collectionSupplies = {};

// Cache for HowRare collection data (mint -> rank)
let howRareCache = {};

// Mapping of Magic Eden symbols to HowRare collection slugs
const ME_TO_HOWRARE = {
  great__goats: "greatgoats",
  undead_genesis: "undead_genesis",
  candies: "candies",
  morbie: "morbie",
  // Add more mappings as needed
};

// Import fetchCollectionSupply
const { fetchCollectionSupply } = require("./fetchCollectionSupply");

// Fetch and cache supply for all tracked collections at startup
async function cacheAllCollectionSupplies() {
  try {
    const raw = fs.readFileSync(TRACKS_PATH, "utf8");
    const parsed = JSON.parse(raw);
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

      // If HowRare didn't provide supply, fallback is now handled in fetchCollectionSupply.js using tracks.json
      if (!collectionSupplies[symbol]) {
        colorLog(
          `[SUPPLY] No supply found for ${symbol} from HowRare. Fallback handled in fetchCollectionSupply.js. Skipping this collection if still missing.`,
          "magenta"
        );
        continue;
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

// Index all current listings and sales at startup so only new ones trigger alerts
async function indexCurrentListings() {
  try {
    const raw = fs.readFileSync(TRACKS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const collections = parsed.collections || {};
    const salesCollections = parsed.sales_collections || {};

    // Index listings
    const symbols = Object.keys(collections);
    for (const symbol of symbols) {
      const listings = await fetchLatestListings(symbol);
      for (const listing of listings) {
        const id = listing.tokenMint || listing.id || JSON.stringify(listing);
        seenListingIds.add(id);
      }
    }

    // Index sales
    const salesSymbols = Object.keys(salesCollections);
    for (const symbol of salesSymbols) {
      const sales = await fetchSales(symbol);
      for (const sale of sales) {
        const id = sale.tokenMint || sale.id || JSON.stringify(sale);
        seenSalesIds.add(id);
      }
    }

    console.log("Indexed current listings and sales at startup.");
  } catch (err) {
    console.log(`Error indexing current listings/sales: ${err}`);
  }
}

async function fetchListings(symbol) {
  if (!symbol) return [];
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/activities?limit=40`;
  let res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429) {
    console.error(
      `[DEBUG] Magic Eden API throttled (429) for symbol: ${symbol}`
    );
    return [];
  }
  if (!res.ok) {
    console.error(
      `Error fetching activities for ${symbol}:`,
      res.status,
      await res.text()
    );
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // Only keep 'list' activities (new listings)
  return data.filter((activity) => activity.type === "list");
}

// Wrap fetchListings to throw on 429
async function fetchListingsWithBackoff(symbol) {
  if (!symbol) return [];
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/activities?limit=40`;
  let res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429) {
    const err = new Error("HTTP 429");
    err.is429 = true;
    throw err;
  }
  if (!res.ok) {
    console.error(
      `Error fetching activities for ${symbol}:`,
      res.status,
      await res.text()
    );
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter((activity) => activity.type === "list");
}

// Alias for compatibility with previous code
const fetchLatestListings = fetchListings;
const fetchLatestListingsWithBackoff = fetchListingsWithBackoff;

// Fetch sales (buyNow activities)
async function fetchSales(symbol) {
  if (!symbol) return [];
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/activities?limit=40`;
  let res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429) {
    console.error(
      `[DEBUG] Magic Eden API throttled (429) for symbol: ${symbol}`
    );
    return [];
  }
  if (!res.ok) {
    console.error(
      `Error fetching activities for ${symbol}:`,
      res.status,
      await res.text()
    );
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // Only keep 'buyNow' activities (sales)
  return data.filter((activity) => activity.type === "buyNow");
}

// Wrap fetchSales to throw on 429
async function fetchSalesWithBackoff(symbol) {
  if (!symbol) return [];
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/activities?limit=40`;
  let res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429) {
    const err = new Error("HTTP 429");
    err.is429 = true;
    throw err;
  }
  if (!res.ok) {
    console.error(
      `Error fetching activities for ${symbol}:`,
      res.status,
      await res.text()
    );
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter((activity) => activity.type === "buyNow");
}

// Fetch token metadata for a specific tokenMint
async function fetchTokenMetadata(tokenMint) {
  if (!tokenMint) return null;
  try {
    const url = `https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(
      tokenMint
    )}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(
        `Error fetching token metadata for ${tokenMint}:`,
        res.status
      );
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`Exception fetching token metadata for ${tokenMint}:`, err);
    return null;
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

async function checkListingsAndNotify() {
  try {
    // Load collections from tracks.json
    let collections = {};
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      collections = parsed.collections || {};
    } catch (e) {
      colorLog(
        "No collections to track or error reading tracks.json. Bot is idling.",
        "gray"
      );
      return;
    }
    const symbols = Object.keys(collections);
    if (!symbols.length) {
      colorLog("No collections to track. Bot is idling.", "gray");
      return;
    }
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel) {
      colorLog("Channel not found. Check DISCORD_CHANNEL_ID.", "red");
      return;
    }
    for (const symbol of symbols) {
      let maxPrice = Number(collections[symbol].max_price);
      if (!Number.isFinite(maxPrice) || maxPrice === 0) maxPrice = null;
      // Optional: rarity filter (e.g., Legendary, Epic, etc.)
      const minRarity = collections[symbol].min_rarity || null;
      // Rarity order for comparison
      const RARITY_ORDER = [
        "Mythic",
        "Legendary",
        "Epic",
        "Rare",
        "Uncommon",
        "Common",
      ];
      console.log(
        `Checking listings for ${symbol} (max price: ${
          maxPrice !== null ? maxPrice + " SOL" : "None"
        }${minRarity ? ", min rarity: " + minRarity : ""})...`
      );
      const listings = await fetchLatestListings(symbol);
      if (!listings.length) {
        console.log(`No listings returned for ${symbol}.`);
        continue;
      }
      for (const listing of listings) {
        const id = listing.tokenMint || listing.id || JSON.stringify(listing);
        if (seenListingIds.has(id)) continue;
        const price =
          listing.price || listing.priceSol || listing.buyNowPrice || 0;
        const priceNum = Number(price);
        if (!Number.isFinite(priceNum)) continue;
        if (maxPrice !== null && priceNum > maxPrice) continue;

        // Only extract howrare rarity fields if present, including nested rarity fields
        let howrare =
          (listing.rarity &&
            listing.rarity.howrare &&
            listing.rarity.howrare.rank) ||
          (listing.extra &&
            (listing.extra.howrare_rank ||
              (listing.extra.howrare && listing.extra.howrare.rank) ||
              listing.extra.howrare)) ||
          listing.howrare_rank ||
          (listing.howrare && listing.howrare.rank) ||
          listing.howrare ||
          (listing.token &&
            (listing.token.howrare_rank ||
              (listing.token.howrare && listing.token.howrare.rank) ||
              listing.token.howrare)) ||
          (listing.metadata &&
            (listing.metadata.howrare_rank ||
              (listing.metadata.howrare && listing.metadata.howrare.rank) ||
              listing.metadata.howrare)) ||
          null;

        // Get rarity tier for this listing
        const supply = collectionSupplies[symbol] || null;
        let rankNum = Number(howrare);
        let rarityTier = getRarityTier(rankNum, supply);

        // Rarity filtering logic
        if (
          minRarity &&
          RARITY_ORDER.indexOf(rarityTier) > RARITY_ORDER.indexOf(minRarity)
        ) {
          // Skip if this NFT is lower rarity than the filter
          continue;
        }

        seenListingIds.add(id);
        let name =
          listing.name ||
          listing.title ||
          (listing.extra && (listing.extra.name || listing.extra.title)) ||
          (listing.token && (listing.token.name || listing.token.title)) ||
          (listing.metadata &&
            (listing.metadata.name || listing.metadata.title)) ||
          null;
        if (!name) {
          // Log the full listing for debugging if name is missing
          colorLog(
            `[WARN] Listing missing all name fields: ${JSON.stringify(
              listing,
              null,
              2
            )}`,
            "magenta"
          );
          name = "Unknown NFT";
        }
        const link =
          listing.marketplaceLink ||
          listing.listingURL ||
          `https://magiceden.io/item-details/${listing.tokenMint || ""}`;
        // Robust image URL extraction
        let imageUrl = null;
        if (listing.extra && listing.extra.img) {
          imageUrl = listing.extra.img;
        } else if (listing.token && listing.token.image) {
          imageUrl = listing.token.image;
        } else if (listing.img) {
          imageUrl = listing.img;
        } else if (listing.image) {
          imageUrl = listing.image;
        } else if (listing.extra && listing.extra.image) {
          imageUrl = listing.extra.image;
        } else if (
          listing.token &&
          listing.token.properties &&
          Array.isArray(listing.token.properties.files)
        ) {
          const file = listing.token.properties.files.find(
            (f) => f.type && f.type.startsWith("image/") && f.uri
          );
          if (file) imageUrl = file.uri;
        }
        // Always send an embed, with or without image
        const embed = {
          title: `New listing in ${symbol}!`,
          description: [
            `Name: **${name}**`,
            `Price: **${priceNum} SOL** (<= ${maxPrice} SOL)`,
            howrare !== null ? `Rarity: **${howrare}** (${rarityTier})` : null,
            `Link: ${link}`,
          ]
            .filter(Boolean)
            .join("\n"),
          url: link,
          color: 0x9b59ff, // Magic Eden purple accent
        };
        if (imageUrl) {
          embed.image = { url: imageUrl };
        }
        await channel.send({ embeds: [embed] });
        // Colorize new listing log in green
        colorLog(`Sent alert for listing: ${id} (${symbol})`, "green");
      }
    }
  } catch (err) {
    console.log(`Error in checkListingsAndNotify: ${err}`);
  }
}

// Register slash commands on startup (guild only for fast update)
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("metrack")
      .setDescription(
        "Track a collection. Usage: /metrack magicedenURL:<url> <max_price>"
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
        "Track sales for a collection. Usage: /mesalestrack magicedenURL:<url> <max_price>"
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

    // DEBUG: Post the first real listing as an embed and auto-delete after 5s (for testing)
    // These are NOT added to seenListingIds so they can be notified again if still present
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
            console.log(`[DEBUG] Fetching token metadata for ${tokenMint}...`);
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
            const link = `https://magiceden.io/item-details/${tokenMint || ""}`;
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
              RARITY_ORDER.indexOf(rarityTier) > RARITY_ORDER.indexOf(minRarity)
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

    startRoundRobinPolling();
  })();
});

// Start the global round-robin polling
function startRoundRobinPolling() {
  setInterval(() => {
    pollNextCollectionRoundRobin();
  }, dynamicTickMs);
}

// Poll the next collection in a round-robin fashion (handles both listings and sales)
async function pollNextCollectionRoundRobin() {
  // ...existing code...

  let collections = {};
  let salesCollections = {};
  try {
    const raw = fs.readFileSync(TRACKS_PATH, "utf8");
    const parsed = JSON.parse(raw);
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
  const filterOptions = [`maxPrice: ${maxPrice !== null ? maxPrice : "None"}`];
  if (minRarity) filterOptions.push(`minRarity: ${minRarity}`);

  console.log(`[Polling] Checking ${type} for collection: ${symbol}`);
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
      const id = activity.tokenMint || activity.id || JSON.stringify(activity);
      if (seenSet.has(id)) continue;
      const price =
        activity.price || activity.priceSol || activity.buyNowPrice || 0;
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum)) continue;
      if (maxPrice !== null && priceNum > maxPrice) continue;

      // Fetch token metadata to get name and image
      const tokenMint = activity.tokenMint || activity.mint;
      console.log(`[DEBUG] Fetching token metadata for ${tokenMint}...`);
      const tokenData = tokenMint ? await fetchTokenMetadata(tokenMint) : null;
      console.log(
        `[DEBUG] Token data: ${
          tokenData ? JSON.stringify(tokenData, null, 2) : "null"
        }`
      );

      let name = tokenData?.name || "Unknown NFT";

      // Get rarity rank from cached HowRare data
      let howrare = getHowRareRank(symbol, tokenMint);
      console.log(
        `${colors.magenta}[HOWRARE] HowRare rank for ${tokenMint}: ${colors.yellow}${howrare}${colors.magenta}${colors.reset}`
      );
      let rankNum = Number(howrare);
      let rarityTier = getRarityTier(rankNum, supply);
      let rarityColor = RARITY_COLORS[rarityTier] || "#9b59ff";

      // Rarity filtering logic
      const RARITY_ORDER = [
        "Mythic",
        "Legendary",
        "Epic",
        "Rare",
        "Uncommon",
        "Common",
      ];
      if (
        minRarity &&
        RARITY_ORDER.indexOf(rarityTier) > RARITY_ORDER.indexOf(minRarity)
      ) {
        // Skip if this NFT is lower rarity than the filter
        continue;
      }

      seenSet.add(id);
      const link = `https://magiceden.io/item-details/${tokenMint || ""}`;
      let imageUrl =
        activity.image || tokenData?.image || tokenData?.img || null;
      const embed = {
        title:
          type === "listing"
            ? `New listing in ${symbol}!`
            : `New sale in ${symbol}!`,
        description: [
          `Name: **${name}**`,
          `Price: **${priceNum} SOL** (<= ${maxPrice} SOL)`,
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
      if (imageUrl) embed.image = { url: imageUrl };
      await channel.send({ embeds: [embed] });
      // Colorize alert log in green
      colorLog(`Sent alert for ${type}: ${id} (${symbol})`, "green");
    }
  } catch (err) {
    if (err && err.is429) {
      // Backoff for BACKOFF_MS and increase tick interval for safety
      globalBackoffUntil = Date.now() + BACKOFF_MS;
      dynamicTickMs = Math.min(dynamicTickMs + 100, 2000); // Cap at 2s
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      const msg = `[BACKOFF] Magic Eden API rate limit hit (429). Pausing all polling for ${
        BACKOFF_MS / 1000
      }s. Slowing down to ${dynamicTickMs}ms per collection.`;
      if (channel) {
        channel.send(msg).catch(() => {});
      }
      console.log(msg);
    } else {
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
    const symbol = extractSymbol(urlOrSymbol);
    if (!symbol) {
      await interaction.reply({
        content:
          "Could not extract collection symbol from the provided URL. Please provide a valid Magic Eden collection URL or symbol.",
        flags: 64,
      });
      return;
    }
    // Load existing tracks
    let data = { collections: {}, sales_collections: {} };
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      data = JSON.parse(raw);
      if (!data.collections) data.collections = {};
      if (!data.sales_collections) data.sales_collections = {};
    } catch (e) {
      console.log(`Error reading tracks.json: ${e}`);
    }
    data.collections[symbol] = { max_price: maxPrice };
    fs.writeFileSync(TRACKS_PATH, JSON.stringify(data, null, 2));
    await interaction.reply(
      `✅ Now tracking listings for ${symbol} with max price ${maxPrice} SOL.`
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
    let data = { collections: {}, sales_collections: {} };
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      data = JSON.parse(raw);
    } catch (e) {
      console.log(`Error reading tracks.json: ${e}`);
    }
    delete data.collections[symbol];
    fs.writeFileSync(TRACKS_PATH, JSON.stringify(data, null, 2));
    await interaction.reply(`✅ Stopped tracking listings for ${symbol}.`);
    return;
  }

  if (interaction.commandName === "mesalestrack") {
    const urlOrSymbol = interaction.options.getString("symbol");
    const maxPrice = interaction.options.getNumber("max_price");
    const symbol = extractSymbol(urlOrSymbol);
    if (!symbol) {
      await interaction.reply({
        content:
          "Could not extract collection symbol from the provided URL. Please provide a valid Magic Eden collection URL or symbol.",
        flags: 64,
      });
      return;
    }
    // Load existing tracks
    let data = { collections: {}, sales_collections: {} };
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      data = JSON.parse(raw);
      if (!data.collections) data.collections = {};
      if (!data.sales_collections) data.sales_collections = {};
    } catch (e) {
      console.log(`Error reading tracks.json: ${e}`);
    }
    data.sales_collections[symbol] = { max_price: maxPrice };
    fs.writeFileSync(TRACKS_PATH, JSON.stringify(data, null, 2));
    await interaction.reply(
      `✅ Now tracking sales for ${symbol} with max price ${maxPrice} SOL.`
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
    let data = { collections: {}, sales_collections: {} };
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      data = JSON.parse(raw);
    } catch (e) {
      console.log(`Error reading tracks.json: ${e}`);
    }
    delete data.sales_collections[symbol];
    fs.writeFileSync(TRACKS_PATH, JSON.stringify(data, null, 2));
    await interaction.reply(`✅ Stopped tracking sales for ${symbol}.`);
    return;
  }

  if (interaction.commandName === "melist") {
    let data = { collections: {}, sales_collections: {} };
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      data = JSON.parse(raw);
    } catch (e) {
      console.log(`Error reading tracks.json: ${e}`);
    }
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
          return `- ${symbol}: max price ${maxPrice} SOL`;
        })
        .join("\n");
      response += `**Tracking Listings:**\n${listingList}\n`;
    }

    if (salesSymbols.length > 0) {
      const salesList = salesSymbols
        .map((symbol) => {
          const maxPrice = data.sales_collections[symbol].max_price;
          return `- ${symbol}: max price ${maxPrice} SOL`;
        })
        .join("\n");
      if (response) response += "\n";
      response += `**Tracking Sales:**\n${salesList}`;
    }

    await interaction.reply(response);
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
  console.log(
    `[MESSAGE] Received from ${message.author.tag}: "${message.content}"`
  );

  if (message.author.id !== OWNER_ID) return;

  // Command: /track [symbol] [max_price]
  if (message.content.startsWith("/track")) {
    const args = message.content.split(" ").slice(1);
    const symbol = args[0]?.toUpperCase();
    const maxPrice = parseFloat(args[1]);
    if (!symbol) {
      return message.reply("Usage: /track [symbol] [max_price]");
    }
    if (isNaN(maxPrice)) {
      return message.reply("Max price must be a valid number.");
    }
    // Load existing tracks
    let tracks = {};
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      tracks = parsed.collections || {};
    } catch (e) {
      console.log(`Error reading tracks.json: ${e}`);
    }
    // Add or update the track
    tracks[symbol] = { max_price: maxPrice };
    // Save the updated tracks
    fs.writeFileSync(
      TRACKS_PATH,
      JSON.stringify({ collections: tracks }, null, 2)
    );
    message.reply(`✅ Now tracking ${symbol} with max price ${maxPrice} SOL.`);
    colorLog(
      `Tracked new collection: ${symbol} (max price: ${maxPrice})`,
      "green"
    );
    // Auto-index and check listings for the new track
    await indexCurrentListings();
    checkListingsAndNotify();
    return;
  }

  // Command: /untrack [symbol]
  if (message.content.startsWith("/untrack")) {
    const args = message.content.split(" ").slice(1);
    const symbol = args[0]?.toUpperCase();
    if (!symbol) {
      return message.reply("Usage: /untrack [symbol]");
    }
    // Load existing tracks
    let tracks = {};
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      tracks = parsed.collections || {};
    } catch (e) {
      console.log(`Error reading tracks.json: ${e}`);
    }
    // Remove the track
    delete tracks[symbol];
    // Save the updated tracks
    fs.writeFileSync(
      TRACKS_PATH,
      JSON.stringify({ collections: tracks }, null, 2)
    );
    message.reply(`✅ Stopped tracking ${symbol}.`);
    colorLog(`Untracked collection: ${symbol}`, "yellow");
    return;
  }

  // Command: /list
  if (message.content.trim().toLowerCase() === "/list") {
    // Load existing tracks
    let tracks = {};
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      tracks = parsed.collections || {};
    } catch (e) {
      console.log(`Error reading tracks.json: ${e}`);
    }
    const symbols = Object.keys(tracks);
    if (symbols.length === 0) {
      return message.reply("No collections are being tracked.");
    }
    const trackList = symbols
      .map((symbol) => {
        const maxPrice = tracks[symbol].max_price;
        return `- ${symbol}: max price ${maxPrice} SOL`;
      })
      .join("\n");
    message.reply(`Currently tracked collections:\n${trackList}`);
    return;
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
