# discord-magiceden-tracker

Track Magic Eden NFT listings and sales in Discord. Price/rarity filters, unified polling, supply overrides, and rich Discord alerts.

## Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click "New Application".
2. Name your application (e.g., "Magic Eden Tracker").
3. In the left sidebar, go to "Bot" and click "Add Bot".
4. Under the Bot settings, click "Reset Token" to get your bot token. **Copy this token**—you'll need it for `config.json`.
5. Under "Privileged Gateway Intents", enable the "Message Content Intent" if you want the bot to read message content (not required for slash commands only).
6. In the left sidebar, go to "OAuth2" > "URL Generator":

- Select "bot" and "applications.commands" scopes.
- Under "Bot Permissions", select at least "Send Messages" and "Read Messages" for the channel you want the bot to use.
- Copy the generated URL and use it to invite the bot to your server.

7. In "General Information", copy the "Application ID" (Client ID) and your server's ID (GUILD_ID) for use in `config.json`.
8. To get your channel ID, right-click the target Discord channel and select "Copy ID" (you may need to enable Developer Mode in Discord settings).

You can now use your bot token, channel ID, client ID, and guild ID in your `config.json` file. See the example config below for details.

## Commands

| Command           | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `/metrack`        | Track new listings for a collection                                |
| `/meuntrack`      | Stop tracking listings for a collection                            |
| `/mesalestrack`   | Track sales for a collection                                       |
| `/mesalesuntrack` | Stop tracking sales for a collection                               |
| `/melist`         | List all tracked collections (listings & sales)                    |
| `/mecleanup`      | Delete the bot's own messages in the channel                       |
| `/metest`         | Clear the seen cache and force re-alerts on current listings/sales |

## Usage

1. Install dependencies:

```bash
npm install
```

2. Copy the example config and fill in your details:

```bash
cp config.json.sample config.json
# Edit config.json with your bot token, channel ID, client ID, and guild ID
```

3. Start the bot:

```bash
node metracker.js
```

4. In Discord, use one of the slash commands (see Commands section below) to start tracking a collection, list tracked collections, clear cache, or clean up messages.
5. After you use a tracking command (e.g., `/metrack` or `/mesalestrack`), the bot will update and begin tracking/alerting for that collection automatically.
6. You can add, remove, or list tracked collections at any time using the appropriate slash commands. The bot will always reflect your latest tracking configuration.

## Features

- Track listings and sales for multiple collections
- Per-collection price and rarity filtering (HowRare.is integration)
- Unified round-robin polling
- Supply overrides for fallback rarity math
- Discord alerts with NFT images, rarity tiers, and direct Magic Eden links
- Owner-only slash commands for all bot controls
- Cache of seen listings/sales only clears at startup or via `/metest`
- Handles Magic Eden API rate limits with backoff and slower polling

---

## Example config

```json
{
  "DISCORD_TOKEN": "YOUR_DISCORD_BOT_TOKEN",
  "DISCORD_CHANNEL_ID": "YOUR_DISCORD_CHANNEL_ID",
  "CLIENT_ID": "YOUR_BOT_CLIENT_ID",
  "GUILD_ID": "YOUR_GUILD_ID",
  "ROUND_ROBIN_TICK_MS": 750,
  "BACKOFF_MS": 10000,
  "OWNER_ID": "YOUR_DISCORD_USER_ID"
}
```

---

## Changelog (Summary)

**Latest:**

- v0.1.5: Integrated sales tracking into main tracker with unified round-robin polling; added `/mesalestrack`, `/mesalesuntrack`, `/metest` commands; cache only clears at startup or via `/metest` (no hourly spam)
- v0.1.4: Added rarity filtering, added rarity coloring in notification
- v0.1.3: Added rarity rating with HowRare API; fallback in config for max_supply
- v0.1.2: Added max price filter
- v0.1.1: General update
- v0.1.0: Initial release

<details>
<summary>Full changelog</summary>

---

### metracker.js

#### 0.1.5

- Integrated sales tracking into main tracker with unified round-robin polling
- Added `/mesalestrack`, `/mesalesuntrack`, `/metest` commands
- Cache only clears at startup or via `/metest` (no hourly spam)

#### 0.1.4

- Added rarity filtering, added rarity coloring in notification

#### 0.1.3

- Added rarity rating with HowRare API; fallback in config for max_supply

#### 0.1.2

- Added max price filter

#### 0.1.1

- General update

#### 0.1.0

- Initial release

</details>

---

## License

MIT
