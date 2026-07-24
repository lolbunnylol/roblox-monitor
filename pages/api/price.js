export default async function handler(req, res) {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid item ID" });
  }

  // Headers that make Roblox treat the request as a real browser.
  // Without these, Railway's server IPs get 403/blocked — which is
  // exactly what was causing "API error — retrying…" on every check.
  const BROWSER_HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.roblox.com/",
    "Origin": "https://www.roblox.com",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
  };

  // Wrap fetch with a timeout so a hung Roblox request doesn't
  // block the serverless function until it hard-times-out.
  const fetchWithTimeout = (url, opts = {}, ms = 8000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
      clearTimeout(timer)
    );
  };

  // Two-stage lookup instead of always firing all 4 endpoints:
  //   Stage 1 (parallel): economy v2 + catalog v1 — covers most items.
  //   Stage 2 (parallel, only if stage 1 came up empty): resale + marketplace.
  // This roughly halves the request volume sent to Roblox per check for
  // the common case, which matters because at fast polling intervals
  // (e.g. 0.2s) firing all 4 every time trips Roblox's own rate limiting
  // (HTTP 429) very quickly.
  const TIMEOUT_MS = 5000;

  const call = (url) =>
    fetchWithTimeout(url, { headers: BROWSER_HEADERS }, TIMEOUT_MS)
      .then(async (r) => ({
        status: r.status,
        ok: r.ok,
        data: r.ok ? await r.json() : null,
      }))
      .catch(() => null);

  let itemName = null;
  let price = null;
  let lastStatus = null;
  let sawRateLimit = false;

  const noteStatus = (r) => {
    if (!r) return;
    if (lastStatus == null) lastStatus = r.status;
    if (r.status === 429) sawRateLimit = true;
  };

  // Stage 1
  const [rEconomyV2, rCatalogV1] = await Promise.all([
    call(`https://economy.roblox.com/v2/assets/${id}/details`),
    call(`https://catalog.roblox.com/v1/catalog/items/${id}/details`),
  ]);
  noteStatus(rEconomyV2);
  noteStatus(rCatalogV1);

  if (rEconomyV2?.ok) {
    itemName = rEconomyV2.data.Name ?? null;
    price = rEconomyV2.data.PriceInRobux != null ? Number(rEconomyV2.data.PriceInRobux) : null;
  }
  if ((price == null || itemName == null) && rCatalogV1?.ok) {
    if (itemName == null) itemName = rCatalogV1.data.name ?? null;
    if (price == null) {
      const p = rCatalogV1.data.price ?? rCatalogV1.data.lowestPrice ?? null;
      price = p != null ? Number(p) : null;
    }
  }

  // Stage 2 — only run if stage 1 didn't give us both a name and a price
  if (price == null || itemName == null) {
    const [rResale, rMarketplace] = await Promise.all([
      call(`https://economy.roblox.com/v1/assets/${id}/resale-data`),
      call(`https://marketplace.roblox.com/v1/assets/${id}/resellers?limit=1`),
    ]);
    noteStatus(rResale);
    noteStatus(rMarketplace);

    if (price == null && rResale?.ok) {
      const p = rResale.data.price ?? null;
      price = p != null ? Number(p) : null;
      if (itemName == null) itemName = "Limited Item";
    }
    if ((price == null || itemName == null) && rMarketplace?.ok) {
      const lowestPrice = rMarketplace.data?.data?.[0]?.price ?? null;
      if (price == null && lowestPrice != null) price = Number(lowestPrice);
      if (itemName == null) itemName = "Marketplace Item";
    }
  }

  if (itemName == null && price == null) {
    // Surface the actual HTTP status (and whether it was a rate limit)
    // so the client can back off instead of just retrying at full speed.
    return res.status(sawRateLimit ? 429 : 404).json({
      error: sawRateLimit
        ? "Rate limited by Roblox"
        : "Item not found or Roblox API unavailable",
      robloxStatus: lastStatus,
      rateLimited: sawRateLimit,
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ id, name: itemName, price });
}
