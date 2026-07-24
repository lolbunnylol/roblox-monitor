cat > /tmp/roblox-fixed/pages/api/price.js << 'EOF'
export default async function handler(req, res) {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid item ID" });
  }

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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fetch with timeout + automatic retry on 429 rate-limit.
  // Roblox throttles burst requests from server IPs — this absorbs
  // those blips silently so the frontend never logs an error.
  const fetchSmart = async (url, ms = 7000, retries = 3) => {
    for (let attempt = 0; attempt < retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        const r = await fetch(url, {
          headers: BROWSER_HEADERS,
          signal: controller.signal,
        });
        clearTimeout(timer);
        // 429 = rate limited — wait and retry
        if (r.status === 429) {
          const wait = 150 * (attempt + 1); // 150ms, 300ms, 450ms
          await sleep(wait);
          continue;
        }
        return r;
      } catch (_) {
        clearTimeout(timer);
        if (attempt < retries - 1) await sleep(100);
      }
    }
    return null;
  };

  let itemName = null;
  let price = null;
  let lastStatus = null;

  // 1. economy v2 — classic catalog items
  try {
    const r = await fetchSmart(`https://economy.roblox.com/v2/assets/${id}/details`);
    if (r) {
      lastStatus = r.status;
      if (r.ok) {
        const data = await r.json();
        itemName = data.Name ?? null;
        price = data.PriceInRobux != null ? Number(data.PriceInRobux) : null;
      }
    }
  } catch (_) {}

  // 2. catalog v1 — newer UGC items & bundles
  if (price == null || itemName == null) {
    try {
      const r = await fetchSmart(`https://catalog.roblox.com/v1/catalog/items/${id}/details`);
      if (r) {
        if (lastStatus == null) lastStatus = r.status;
        if (r.ok) {
          const data = await r.json();
          if (itemName == null) itemName = data.name ?? null;
          if (price == null) {
            const p = data.price ?? data.lowestPrice ?? null;
            price = p != null ? Number(p) : null;
          }
        }
      }
    } catch (_) {}
  }

  // 3. resale data — limiteds
  if (price == null) {
    try {
      const r = await fetchSmart(`https://economy.roblox.com/v1/assets/${id}/resale-data`);
      if (r?.ok) {
        const data = await r.json();
        const p = data.price ?? null;
        price = p != null ? Number(p) : null;
        if (itemName == null) itemName = "Limited Item";
      }
    } catch (_) {}
  }

  // 4. marketplace resellers — final fallback
  if (price == null || itemName == null) {
    try {
      const r = await fetchSmart(
        `https://marketplace.roblox.com/v1/assets/${id}/resellers?limit=1`
      );
      if (r?.ok) {
        const data = await r.json();
        const lowestPrice = data?.data?.[0]?.price ?? null;
        if (price == null && lowestPrice != null) price = Number(lowestPrice);
        if (itemName == null) itemName = "Marketplace Item";
      }
    } catch (_) {}
  }

  if (itemName == null && price == null) {
    return res.status(404).json({
      error: "Item not found or Roblox API unavailable",
      robloxStatus: lastStatus,
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ id, name: itemName, price });
}
EOF