export default async function handler(req, res) {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid item ID" });
  }

  let itemName = null;
  let price = null;

  // 1. economy v2
  try {
    const r = await fetch(`https://economy.roblox.com/v2/assets/${id}/details`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.ok) {
      const data = await r.json();
      itemName = data.Name ?? null;
      price = data.PriceInRobux != null ? Number(data.PriceInRobux) : null;
    }
  } catch (_) {}

  // 2. catalog v1
  if (price == null || itemName == null) {
    try {
      const r = await fetch(`https://catalog.roblox.com/v1/catalog/items/${id}/details`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
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

  // 3. resale fallback (limiteds)
  if (price == null) {
    try {
      const r = await fetch(`https://economy.roblox.com/v1/assets/${id}/resale-data`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (r.ok) {
        const data = await r.json();
        const p = data.price ?? null;
        price = p != null ? Number(p) : null;
        if (itemName == null) itemName = "Limited Item";
      }
    } catch (_) {}
  }

  if (itemName == null && price == null) {
    return res.status(404).json({ error: "Item not found or API unavailable" });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ id, name: itemName, price });
}
