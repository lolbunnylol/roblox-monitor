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

  let itemName = null;
  let price = null;
  let lastStatus = null;

  // 1. economy v2 — works for classic catalog items
  try {
    const r = await fetchWithTimeout(
      `https://economy.roblox.com/v2/assets/${id}/details`,
      { headers: BROWSER_HEADERS }
    );
    lastStatus = r.status;
    if (r.ok) {
      const data = await r.json();
      itemName = data.Name ?? null;
      price = data.PriceInRobux != null ? Number(data.PriceInRobux) : null;
    }
  } catch (_) {}

  // 2. catalog v1 — newer UGC items & bundles
  if (price == null || itemName == null) {
    try {
      const r = await fetchWithTimeout(
        `https://catalog.roblox.com/v1/catalog/items/${id}/details`,
        { headers: BROWSER_HEADERS }
      );
      if (lastStatus == null) lastStatus = r.status;
      if (r.ok) {
        const data = await r.json();
        if (itemName == null) itemName = data.name ?? null;
        if (price == null) {
          const p = data.price ?? data.lowestPrice ?? null;
          price = p != null ? Number(p) : null;
        }
      }
    } catch (_) {}
  }

  // 3. resale data — limiteds without a fixed price
  if (price == null) {
    try {
      const r = await fetchWithTimeout(
        `https://economy.roblox.com/v1/assets/${id}/resale-data`,
        { headers: BROWSER_HEADERS }
      );
      if (r.ok) {
        const data = await r.json();
        const p = data.price ?? null;
        price = p != null ? Number(p) : null;
        if (itemName == null) itemName = "Limited Item";
      }
    } catch (_) {}
  }

  // 4. marketplace v1 — another fallback for some item types
  if (price == null || itemName == null) {
    try {
      const r = await fetchWithTimeout(
        `https://marketplace.roblox.com/v1/assets/${id}/resellers?limit=1`,
        { headers: BROWSER_HEADERS }
      );
      if (r.ok) {
        const data = await r.json();
        const lowestPrice = data?.data?.[0]?.price ?? null;
        if (price == null && lowestPrice != null) price = Number(lowestPrice);
        if (itemName == null) itemName = "Marketplace Item";
      }
    } catch (_) {}
  }

  if (itemName == null && price == null) {
    // Surface the actual HTTP status so you can debug in logs
    return res.status(404).json({
      error: "Item not found or Roblox API unavailable",
      robloxStatus: lastStatus,
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ id, name: itemName, price });
}
