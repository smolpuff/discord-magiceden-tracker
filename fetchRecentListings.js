// Fetch recent listing activities for a collection from Magic Eden
// Returns only 'list' events (new listings), sorted by newest first
// fetchRecentListings now takes fetch as a parameter for compatibility
async function fetchRecentListings(fetch, symbol, limit = 20) {
  const url = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(
    symbol
  )}/activities?offset=0&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    colorLog(
      `Error fetching activities for ${symbol}: ${
        res.status
      } ${await res.text()}`,
      "red"
    );
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // Filter for 'list' events (new listings)
  return data.filter((event) => event.type === "list");
}

module.exports = { fetchRecentListings };
