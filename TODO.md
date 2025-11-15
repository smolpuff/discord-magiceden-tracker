# TODO List for Discord Magic Eden Tracker

## Features & Improvements

- [ ] **Add filtering by trait**

  - Allow users to specify trait filters per collection (e.g., only alert for NFTs with certain attributes)

- [ ] **Add header similar to missions.js**

  - Add a visually distinct header or banner to bot output/messages, inspired by the style in `missions.js`

- [ ] **Add sales tracking on its own longer tick**

  - Track and alert on sales events (not just listings), using a separate polling interval to avoid rate limits

- [ ] **Add auto purchase via web3.js if possible; else puppeteer 2nd profile**
  - Implement automatic NFT purchasing using web3.js (preferred)
  - If not feasible, use Puppeteer with a second browser profile for automation

---

## Completed Migration / Config Tasks

- [x] Move supply overrides from config.json to tracks.json per collection
- [x] Add test message auto-delete time to config.json and update metracker.js
- [x] Update fetchCollectionSupply.js to use tracks.json for supply fallback
- [ ] Update README.md to document new config and tracks structure
- [ ] Debug and validate all changes (run bot, test supply fallback, test test-message delete time)

---

_Update this file as features are completed or new ideas are added._
