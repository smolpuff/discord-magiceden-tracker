const fs = require("fs");
const { Client, GatewayIntentBits } = require("discord.js");
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
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
  console.error("Could not read config.json. Please create it.");
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

// To avoid spamming the same item over and over:
let seenListingIds = new Set();

// --- GLOBAL ROUND-ROBIN LIMITER FOR COLLECTION POLLING ---
const TICK_MS = config.ROUND_ROBIN_TICK_MS || 550; // ~1.8 requests per second
let roundRobinIdx = 0;
let globalBackoffUntil = 0;
let dynamicTickMs = TICK_MS;
const BACKOFF_MS = config.BACKOFF_MS || 10000;

// Index all current listings at startup so only new ones trigger alerts
async function indexCurrentListings() {
  try {
    const raw = fs.readFileSync(TRACKS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const collections = parsed.collections || {};
    const symbols = Object.keys(collections);
    for (const symbol of symbols) {
      const listings = await fetchListings(symbol);
      for (const listing of listings) {
        const id = listing.tokenMint || listing.id || JSON.stringify(listing);
        seenListingIds.add(id);
      }
    }
    console.log("Indexed current listings at startup.");
  } catch (err) {
    console.error("Error indexing current listings:", err);
  }
}

async function fetchListings(symbol) {
  if (!symbol) return [];
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/listings?offset=0&limit=20`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 429) {
    console.error(
      `[DEBUG] Magic Eden API throttled (429) for symbol: ${symbol}`
    );
    return [];
  }
  if (!res.ok) {
    console.error(
      `Error fetching listings for ${symbol}:`,
      res.status,
      await res.text()
    );
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data;
}

// Wrap fetchListings to throw on 429
async function fetchListingsWithBackoff(symbol) {
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/listings?offset=0&limit=20`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 429) {
    const err = new Error("HTTP 429");
    err.is429 = true;
    throw err;
  }
  if (!res.ok) {
    console.error(
      `Error fetching listings for ${symbol}:`,
      res.status,
      await res.text()
    );
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data;
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
      console.log(
        "No collections to track or error reading tracks.json. Bot is idling."
      );
      return;
    }
    const symbols = Object.keys(collections);
    if (!symbols.length) {
      console.log("No collections to track. Bot is idling.");
      return;
    }
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel) {
      console.error("Channel not found. Check DISCORD_CHANNEL_ID.");
      return;
    }
    for (const symbol of symbols) {
      const maxPrice = Number(collections[symbol].max_price) || Infinity;
      console.log(
        `Checking listings for ${symbol} (max price: ${maxPrice})...`
      );
      const listings = await fetchListings(symbol);
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
        if (priceNum > maxPrice) continue;

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
          console.warn(
            "[WARN] Listing missing all name fields:",
            JSON.stringify(listing, null, 2)
          );
          name = "Unknown NFT";
        }
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
            howrare !== null ? `HowRare: **${howrare}**` : null,
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
        console.log(`Sent alert for listing: ${id} (${symbol})`);
      }
    }
  } catch (err) {
    console.error("Error in checkListingsAndNotify:", err);
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
      .setName("melist")
      .setDescription("List tracked collections"),
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
    console.error("Failed to register slash commands:", err);
  }
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerSlashCommands();
  // DEBUG: Post the first listing as an embed and auto-delete after 5s (for testing)
  (async () => {
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      const collections = parsed.collections || {};
      const symbols = Object.keys(collections);
      if (!symbols.length) return;
      const symbol = symbols[0];
      const listings = await fetchListings(symbol);
      if (!listings.length) return;
      const listing = listings[0];
      // Debug: print the full listing object to console
      console.log(
        "DEBUG: First listing object:",
        JSON.stringify(listing, null, 2)
      );
      const price =
        listing.price || listing.priceSol || listing.buyNowPrice || 0;
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
        console.warn(
          "[WARN] DEBUG listing missing all name fields:",
          JSON.stringify(listing, null, 2)
        );
        name = "Unknown NFT";
      }
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
      const link =
        listing.marketplaceLink ||
        listing.listingURL ||
        `https://magiceden.io/item-details/${listing.tokenMint || ""}`;
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
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      const embed = {
        title: `DEBUG: First listing for ${symbol} (auto-deletes in 5s)`,
        description: [
          `Name: **${name}**`,
          `Price: **${price} SOL**`,
          howrare !== null ? `HowRare: **${howrare}**` : null,
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
      const msg = await channel.send({ embeds: [embed] });
      setTimeout(() => msg.delete().catch(() => {}), 5000);
    } catch (err) {
      console.error("DEBUG fetch error:", err);
    }
  })();
  // Always index all current listings at startup to avoid spam
  indexCurrentListings().then(() => {
    startRoundRobinPolling();
  });
});

// Start the global round-robin polling
function startRoundRobinPolling() {
  setInterval(() => {
    pollNextCollectionRoundRobin();
  }, dynamicTickMs);
}

// Poll the next collection in a round-robin fashion
async function pollNextCollectionRoundRobin() {
  let collections = {};
  try {
    const raw = fs.readFileSync(TRACKS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    collections = parsed.collections || {};
  } catch (e) {
    // No collections or error reading file
    return;
  }
  const symbols = Object.keys(collections);
  if (!symbols.length) return;
  // Backoff logic
  if (Date.now() < globalBackoffUntil) return;
  // Pick next collection
  const symbol = symbols[roundRobinIdx % symbols.length];
  console.log(`[Polling] Checking collection: ${symbol}`);
  roundRobinIdx = (roundRobinIdx + 1) % symbols.length;
  const maxPrice = Number(collections[symbol].max_price) || Infinity;
  try {
    const listings = await fetchListingsWithBackoff(symbol);
    if (!listings.length) return;
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    for (const listing of listings) {
      const id = listing.tokenMint || listing.id || JSON.stringify(listing);
      if (seenListingIds.has(id)) continue;
      const price =
        listing.price || listing.priceSol || listing.buyNowPrice || 0;
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum)) continue;
      if (priceNum > maxPrice) continue;
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
        name = "Unknown NFT";
      }
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
      const embed = {
        title: `New listing in ${symbol}!`,
        description: [
          `Name: **${name}**`,
          `Price: **${priceNum} SOL** (<= ${maxPrice} SOL)`,
          moonrank !== null ? `Moonrank: **${moonrank}**` : null,
          howrare !== null ? `HowRare: **${howrare}**` : null,
          `Link: ${link}`,
        ]
          .filter(Boolean)
          .join("\n"),
        url: link,
        color: 0x9b59ff,
      };
      if (imageUrl) embed.image = { url: imageUrl };
      await channel.send({ embeds: [embed] });
      console.log(`Sent alert for listing: ${id} (${symbol})`);
    }
  } catch (err) {
    if (err && err.is429) {
      // Backoff for BACKOFF_MS and increase tick interval for safety
      globalBackoffUntil = Date.now() + BACKOFF_MS;
      dynamicTickMs = Math.min(dynamicTickMs + 100, 2000); // Cap at 2s
      console.error(
        `[BACKOFF] 429 detected, pausing all polling for ${
          BACKOFF_MS / 1000
        }s, tick now ${dynamicTickMs}ms`
      );
    } else {
      console.error("Error in round-robin polling:", err);
    }
  }
}

function reloadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error("Could not reload config.json:", e);
  }
}

client.on("interactionCreate", async (interaction) => {
  reloadConfig();
  if (!interaction.isCommand()) return;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({
      content: "You are not authorized to use this command.",
      ephemeral: true,
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
        ephemeral: true,
      });
      return;
    }
    // Load existing tracks
    let tracks = {};
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      tracks = parsed.collections || {};
    } catch (e) {
      console.error("Error reading tracks.json:", e);
    }
    tracks[symbol] = { max_price: maxPrice };
    fs.writeFileSync(
      TRACKS_PATH,
      JSON.stringify({ collections: tracks }, null, 2)
    );
    await interaction.reply(
      `✅ Now tracking ${symbol} with max price ${maxPrice} SOL.`
    );
    await indexCurrentListings();
    checkListingsAndNotify();
    return;
  }

  if (interaction.commandName === "meuntrack") {
    const urlOrSymbol = interaction.options.getString("symbol");
    const symbol = extractSymbol(urlOrSymbol);
    if (!symbol) {
      await interaction.reply({
        content:
          "Could not extract collection symbol from the provided URL. Please provide a valid Magic Eden collection URL or symbol.",
        ephemeral: true,
      });
      return;
    }
    let tracks = {};
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      tracks = parsed.collections || {};
    } catch (e) {
      console.error("Error reading tracks.json:", e);
    }
    delete tracks[symbol];
    fs.writeFileSync(
      TRACKS_PATH,
      JSON.stringify({ collections: tracks }, null, 2)
    );
    await interaction.reply(`✅ Stopped tracking ${symbol}.`);
    return;
  }

  if (interaction.commandName === "melist") {
    let tracks = {};
    try {
      const raw = fs.readFileSync(TRACKS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      tracks = parsed.collections || {};
    } catch (e) {
      console.error("Error reading tracks.json:", e);
    }
    const symbols = Object.keys(tracks);
    if (symbols.length === 0) {
      await interaction.reply("No collections are being tracked.");
      return;
    }
    const trackList = symbols
      .map((symbol) => {
        const maxPrice = tracks[symbol].max_price;
        return `- ${symbol}: max price ${maxPrice} SOL`;
      })
      .join("\n");
    await interaction.reply(`Currently tracked collections:\n${trackList}`);
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
        ephemeral: true,
      });
    } catch (err) {
      console.error("Cleanup error:", err);
      await interaction.reply({
        content: "Failed to delete messages: " + err.message,
        ephemeral: true,
      });
    }
    return;
  }
});

client.on("messageCreate", async (message) => {
  reloadConfig();
  // Ignore messages from the bot itself
  if (message.author.id === client.user.id) return;
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
      console.error("Error reading tracks.json:", e);
    }
    // Add or update the track
    tracks[symbol] = { max_price: maxPrice };
    // Save the updated tracks
    fs.writeFileSync(
      TRACKS_PATH,
      JSON.stringify({ collections: tracks }, null, 2)
    );
    message.reply(`✅ Now tracking ${symbol} with max price ${maxPrice} SOL.`);
    console.log(`Tracked new collection: ${symbol} (max price: ${maxPrice})`);
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
      console.error("Error reading tracks.json:", e);
    }
    // Remove the track
    delete tracks[symbol];
    // Save the updated tracks
    fs.writeFileSync(
      TRACKS_PATH,
      JSON.stringify({ collections: tracks }, null, 2)
    );
    message.reply(`✅ Stopped tracking ${symbol}.`);
    console.log(`Untracked collection: ${symbol}`);
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
      console.error("Error reading tracks.json:", e);
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
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 5000));
    } catch (err) {
      console.error("Cleanup error:", err);
      message
        .reply("Failed to delete messages: " + err.message)
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }
  }
});

client.login(config.DISCORD_TOKEN);
