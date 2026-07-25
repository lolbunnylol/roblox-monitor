import { useState, useEffect, useRef, useCallback } from "react";
import Head from "next/head";

// Update this list whenever you ship a change — newest entry first.
// Rendered as-is in the Changelog card at the bottom of the page.
const CHANGELOG = [
  {
    version: "v1.6",
    date: "2026-07-25",
    changes: [
      "Fixed the event log auto-scrolling the whole page down on every single check, which made it impossible to scroll up and use settings while monitoring was running",
      "Auto-scroll is now contained to the log box itself, and only kicks in if you were already near the bottom of it",
    ],
  },
  {
    version: "v1.5",
    date: "2026-07-25",
    changes: [
      "Added support for multiple Discord webhook URLs",
      "Spam pings now split round-robin across all configured webhooks, since each webhook has its own separate Discord rate limit — lets a burst land much faster during a short sale window",
    ],
  },
  {
    version: "v1.4",
    date: "2026-07-25",
    changes: [
      "Raised the spam-ping cap from 5 to 20 messages",
      "Added real handling for Discord's own rate limit during a spam-ping burst (respects retry_after instead of silently dropping messages)",
    ],
  },
  {
    version: "v1.3",
    date: "2026-07-25",
    changes: [
      "Added Discord webhook alerts with per-event toggles (price up/down, off sale, back on sale)",
      "Added optional single-user ping targeting for Discord alerts, with an anti-raid guard (never @everyone/@here, always locked to one Discord user ID)",
      "Added optional \"spam ping\" mode (up to 5 messages in a row) so an alert can't get missed",
      "Added a volume slider and a test-sound button for the pew-pew alert",
      "Added this changelog section",
    ],
  },
  {
    version: "v1.2",
    date: "2026-07-25",
    changes: [
      "Fixed rate-limit backoff streak carrying over between Start/Stop sessions",
      "Stopped firing fallback API lookups while already being rate-limited by Roblox",
      "Fixed misleading HTTP status shown in error logs",
      "Fixed the pew-pew sound sometimes not playing on the very first alert (audio now unlocks on the Start click)",
      "Added a demo item (ID 12345678) that goes off-sale on check #50, for testing alerts on demand",
    ],
  },
  {
    version: "v1.1",
    date: "2026-07-25",
    changes: [
      "Parallelized Roblox lookups (2-stage instead of 4-sequential) — fixed ~30s silent delays on the first check",
      "Added exponential backoff and a clearer message when Roblox rate-limits requests (HTTP 429)",
    ],
  },
  {
    version: "v1.0",
    date: "2026-07-24",
    changes: [
      "Fixed checks overlapping/piling up when the API responded slowly",
      "Fixed monitoring continuing to log after pressing Stop — checks are now properly cancelled",
    ],
  },
];

const SETTINGS_KEY = "robloxMonitorSettings";
const MAX_SPAM_PINGS = 20;

const DISCORD_COLORS = {
  up: 0xff6644,
  down: 0x44aaff,
  offSale: 0xcc8844,
  backOnSale: 0x44cc88,
  test: 0x8888ff,
};

export default function Home() {
  // A fully client-side simulated item — no network call, no rate limits.
  // Stays at a fixed price for the first 49 checks, then goes "off sale"
  // on the 50th check so you can see/hear the off-sale alert on demand
  // instead of waiting for a real item to happen to sell out.
  const DEMO_ITEM_ID = "12345678";
  const DEMO_ITEM_NAME = "Demo Blade (Test Item)";
  const DEMO_PRICE = 4200;
  const DEMO_OFFSALE_AT_CHECK = 50;

  const [itemId, setItemId] = useState("");
  const [interval, setIntervalMs] = useState(500);
  const [monitoring, setMonitoring] = useState(false);
  const [itemName, setItemName] = useState(null);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [logs, setLogs] = useState([]);
  const [checkCount, setCheckCount] = useState(0);
  const [error, setError] = useState(null);
  const [notifPerm, setNotifPerm] = useState("default");
  const [swReg, setSwReg] = useState(null);

  // Discord webhook settings
  const [webhookUrls, setWebhookUrls] = useState([""]);
  const [discordUserId, setDiscordUserId] = useState("");
  const [alertTypes, setAlertTypes] = useState({
    up: true,
    down: true,
    offSale: true,
    backOnSale: true,
  });
  const [pingMe, setPingMe] = useState(false);
  const [spamPings, setSpamPings] = useState(false);
  const [spamCount, setSpamCount] = useState(3);
  const [discordStatus, setDiscordStatus] = useState(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Sound
  const [volume, setVolume] = useState(70);

  const timerRef = useRef(null);
  const lastPriceRef = useRef(undefined);
  const checkCountRef = useRef(0);
  const logContainerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const activeRef = useRef(false); // true only while monitoring is actually running
  const abortRef = useRef(null); // AbortController for the in-flight request
  const rateLimitStreakRef = useRef(0); // consecutive 429s, used to back off polling speed

  // Refs mirroring the Discord/volume settings state, so callbacks that
  // don't want to be recreated on every keystroke (doCheck's dependency
  // chain in particular) can always read the *current* value without
  // needing to be in a dependency array.
  const webhookUrlsRef = useRef([""]);
  const discordUserIdRef = useRef("");
  const alertTypesRef = useRef(alertTypes);
  const pingMeRef = useRef(false);
  const spamPingsRef = useRef(false);
  const spamCountRef = useRef(3);
  const volumeRef = useRef(70);

  useEffect(() => { webhookUrlsRef.current = webhookUrls; }, [webhookUrls]);
  useEffect(() => { discordUserIdRef.current = discordUserId; }, [discordUserId]);
  useEffect(() => { alertTypesRef.current = alertTypes; }, [alertTypes]);
  useEffect(() => { pingMeRef.current = pingMe; }, [pingMe]);
  useEffect(() => { spamPingsRef.current = spamPings; }, [spamPings]);
  useEffect(() => { spamCountRef.current = spamCount; }, [spamCount]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  // Register service worker + check notification permission
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then(setSwReg).catch(() => {});
    }
    if ("Notification" in window) setNotifPerm(Notification.permission);
  }, []);

  // Load saved settings (Discord + volume) once on mount
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (Array.isArray(saved.webhookUrls) && saved.webhookUrls.length) {
        setWebhookUrls(saved.webhookUrls);
      } else if (typeof saved.webhookUrl === "string" && saved.webhookUrl) {
        // Migrate from the old single-webhook setting
        setWebhookUrls([saved.webhookUrl]);
      }
      if (typeof saved.discordUserId === "string") setDiscordUserId(saved.discordUserId);
      if (saved.alertTypes) setAlertTypes({ up: true, down: true, offSale: true, backOnSale: true, ...saved.alertTypes });
      if (typeof saved.pingMe === "boolean") setPingMe(saved.pingMe);
      if (typeof saved.spamPings === "boolean") setSpamPings(saved.spamPings);
      if (typeof saved.spamCount === "number") setSpamCount(saved.spamCount);
      if (typeof saved.volume === "number") setVolume(saved.volume);
    } catch (_) {
      // ignore malformed/missing settings
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  // Persist settings whenever they change (skip the very first render so
  // we don't immediately overwrite saved settings with defaults before
  // they've been loaded)
  useEffect(() => {
    if (!settingsLoaded) return;
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ webhookUrls, discordUserId, alertTypes, pingMe, spamPings, spamCount, volume })
      );
    } catch (_) {}
  }, [settingsLoaded, webhookUrls, discordUserId, alertTypes, pingMe, spamPings, spamCount, volume]);

  // Auto-scroll the log — but only WITHIN the log box itself (never the
  // whole page), and only if you were already near the bottom of it.
  // Previously this used scrollIntoView(), which drags the entire page
  // scroll position down to the log on every single check — so scrolling
  // up to look at settings while monitoring was running got constantly
  // yanked back down. Now it leaves your page scroll alone entirely, and
  // even inside the log box itself it won't interrupt you if you've
  // scrolled up to read older entries.
  useEffect(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const wasNearBottom = distanceFromBottom < 80;
    if (wasNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const pushLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [
      ...prev.slice(-299),
      { ts, msg, type, id: Date.now() + Math.random() },
    ]);
  }, []);

  const ensureAudioUnlocked = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume();
      }
    } catch (_) {}
  }, []);

  // Pew pew sound via Web Audio API — no file needed. Reads volume from
  // a ref so it's always current without needing playPew itself to be
  // recreated (and cascade-recreate doCheck/runCheck/scheduleNext) every
  // time the slider moves.
  const playPew = useCallback(() => {
    try {
      ensureAudioUnlocked();
      const ctx = audioCtxRef.current;
      const peak = 0.5 * (volumeRef.current / 100);
      if (peak <= 0) return; // muted

      const playOnePew = (startTime) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        // Laser sweep: high freq falling fast
        osc.type = "square";
        osc.frequency.setValueAtTime(1400, startTime);
        osc.frequency.exponentialRampToValueAtTime(200, startTime + 0.18);

        gain.gain.setValueAtTime(peak, startTime);
        gain.gain.exponentialRampToValueAtTime(Math.max(peak * 0.003, 0.0001), startTime + 0.2);

        osc.start(startTime);
        osc.stop(startTime + 0.2);
      };

      // Two pews, slightly apart
      playOnePew(ctx.currentTime);
      playOnePew(ctx.currentTime + 0.25);
    } catch (_) {}
  }, [ensureAudioUnlocked]);

  const testSound = () => {
    ensureAudioUnlocked();
    playPew();
  };

  const sendNotification = useCallback(
    (title, body) => {
      if (swReg && Notification.permission === "granted") {
        swReg.showNotification(title, { body, tag: "price-alert", renotify: true });
      }
    },
    [swReg]
  );

  const requestNotifPermission = async () => {
    if (!("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    setNotifPerm(perm);
  };

  // Sends a Discord webhook message for a given event `kind`
  // ("up" | "down" | "offSale" | "backOnSale" | "test").
  //
  // Anti-raid guard: pings are ONLY ever sent to the single Discord user
  // ID configured in settings, via `allowed_mentions.users`, and
  // `allowed_mentions.parse` is explicitly set to an empty array so
  // Discord will never resolve @everyone/@here/@role even if such text
  // somehow ended up in the message content. There is no way to target
  // more than one user or a role/channel from this UI — that stays true
  // no matter how many webhooks are configured below.
  //
  // Multiple webhooks: each Discord webhook has its OWN independent rate
  // limit (~5 requests / 2s). A single webhook can only physically keep
  // up with so many spam pings before an item's ~15s sale window is
  // over. Splitting the burst round-robin across several webhooks (all
  // posting to the same channel is fine) lets far more messages land in
  // the same few seconds, since they're separate buckets on Discord's end.
  const sendDiscordAlert = useCallback(async (kind, title, description) => {
    const urls = webhookUrlsRef.current.map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) return { ok: false, reason: "No webhook URL configured." };

    if (kind !== "test" && !alertTypesRef.current[kind]) {
      return { ok: false, reason: "Alert type disabled." };
    }

    const rawId = discordUserIdRef.current.trim();
    const validUserId = /^\d{15,20}$/.test(rawId);
    const shouldPing = pingMeRef.current && validUserId;
    const mention = shouldPing ? `<@${rawId}> ` : "";

    const payload = {
      content: `${mention}${title}`.trim(),
      embeds: [
        {
          description,
          color: DISCORD_COLORS[kind] ?? 0x888888,
          timestamp: new Date().toISOString(),
        },
      ],
      allowed_mentions: {
        parse: [], // never resolve @everyone/@here/@role
        users: shouldPing ? [rawId] : [], // only ever this one user, if any
      },
    };

    const totalMessages = spamPingsRef.current && shouldPing
      ? Math.max(1, Math.min(spamCountRef.current, MAX_SPAM_PINGS))
      : 1;

    // Sends `count` messages to a single webhook, spaced out and
    // honoring `retry_after` on a 429 so this webhook's own share
    // arrives reliably even if Discord throttles it briefly.
    const sendBatchToWebhook = async (url, count) => {
      let lastOk = true;
      let retries = 0;
      for (let i = 0; i < count; i++) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (res.status === 429 && retries < 5) {
            retries++;
            let retryAfterMs = 1000;
            try {
              const body = await res.json();
              if (typeof body?.retry_after === "number") {
                retryAfterMs = Math.ceil(body.retry_after * 1000);
              }
            } catch (_) {}
            await new Promise((r) => setTimeout(r, retryAfterMs));
            i--; // retry this same message instead of counting it as sent
            continue;
          }

          lastOk = res.ok;
        } catch (_) {
          lastOk = false;
        }
        if (i < count - 1) await new Promise((r) => setTimeout(r, 700));
      }
      return lastOk;
    };

    // Round-robin the total message count across the configured webhooks
    const counts = new Array(urls.length).fill(0);
    for (let i = 0; i < totalMessages; i++) counts[i % urls.length]++;

    const results = await Promise.all(
      urls.map((url, idx) => (counts[idx] > 0 ? sendBatchToWebhook(url, counts[idx]) : true))
    );

    const anyOk = results.some(Boolean);
    return anyOk
      ? { ok: true }
      : { ok: false, reason: "Discord rejected the request — check the webhook URL(s)." };
  }, []);

  const handleTestDiscordAlert = async () => {
    setDiscordStatus("sending");
    const result = await sendDiscordAlert(
      "test",
      "🔔 Test alert",
      "This is a test message from Roblox Price Monitor."
    );
    setDiscordStatus(result.ok ? "sent" : `error:${result.reason || "Failed to send."}`);
    setTimeout(() => setDiscordStatus(null), 4000);
  };

  const doCheck = useCallback(
    async (id, signal) => {
      try {
        let price, name;

        if (id === DEMO_ITEM_ID) {
          // Simulated — small artificial delay so it still feels like a
          // real check, but no fetch, no rate limits, fully deterministic.
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (!activeRef.current) return;
          const nextCheckNum = checkCountRef.current + 1;
          name = DEMO_ITEM_NAME;
          price = nextCheckNum >= DEMO_OFFSALE_AT_CHECK ? null : DEMO_PRICE;
        } else {
          const res = await fetch(`/api/price?id=${id}`, { signal });
          if (!activeRef.current) return; // stopped while the request was in flight

          if (!res.ok) {
            let body = null;
            try {
              body = await res.json();
            } catch (_) {}

            if (body?.rateLimited) {
              rateLimitStreakRef.current += 1;
              if (rateLimitStreakRef.current === 1) {
                pushLog("Rate limited by Roblox — slowing down…", "warn");
              }
              return { rateLimited: true };
            }

            rateLimitStreakRef.current = 0;
            const detail = body?.error
              ? ` (${body.error}${body.robloxStatus ? `, HTTP ${body.robloxStatus}` : ""})`
              : "";
            pushLog(`API error — retrying…${detail}`, "warn");
            return;
          }
          rateLimitStreakRef.current = 0;
          const data = await res.json();
          if (!activeRef.current) return; // stopped while parsing
          price = data.price;
          name = data.name;
        }

        checkCountRef.current += 1;
        setCheckCount(checkCountRef.current);
        if (name) setItemName(name);
        setCurrentPrice(price);

        const prev = lastPriceRef.current;

        if (prev === undefined) {
          // First check
          lastPriceRef.current = price;
          pushLog(
            price != null
              ? `Started — R$ ${price.toLocaleString()}`
              : "Item found — not currently for sale",
            "good"
          );
        } else if (price !== prev) {
          // Price changed!
          if (price != null && prev != null) {
            const diff = price - prev;
            const dir = diff > 0 ? "📈 UP" : "📉 DOWN";
            const kind = diff > 0 ? "up" : "down";
            const title = `Price ${diff > 0 ? "increased" : "dropped"} — ${name || id}`;
            const body = `${dir}  R$ ${prev.toLocaleString()} → R$ ${price.toLocaleString()}  (${diff > 0 ? "+" : ""}${diff.toLocaleString()})`;
            pushLog(body, kind);
            sendNotification(title, body);
            sendDiscordAlert(kind, title, body);
          } else if (price == null) {
            const title = `Off sale — ${name || id}`;
            const body = `Was R$ ${prev.toLocaleString()}`;
            pushLog(`Off sale (was R$ ${prev.toLocaleString()})`, "warn");
            sendNotification(title, body);
            sendDiscordAlert("offSale", title, body);
          } else {
            const title = `Back on sale — ${name || id}`;
            const body = `R$ ${price.toLocaleString()}`;
            pushLog(`Back on sale — R$ ${price.toLocaleString()}`, "good");
            sendNotification(title, body);
            sendDiscordAlert("backOnSale", title, body);
          }
          playPew();
          lastPriceRef.current = price;
        } else {
          // No change — log every single check
          pushLog(
            price != null
              ? `Check #${checkCountRef.current} — R$ ${price.toLocaleString()}`
              : `Check #${checkCountRef.current} — Not for sale`,
            "info"
          );
        }
      } catch (err) {
        if (err?.name === "AbortError") return; // intentional cancel — not a real error
        if (!activeRef.current) return;
        pushLog("Network error — retrying…", "warn");
      }
    },
    [pushLog, sendNotification, sendDiscordAlert, playPew]
  );

  // Runs one check with its own AbortController, tracked in abortRef so
  // stopMonitoring() can cancel it immediately instead of letting it
  // finish (and keep logging) after the user has hit Stop.
  const runCheck = useCallback(
    async (id) => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await doCheck(id, controller.signal);
        return result;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [doCheck]
  );

  // Self-scheduling loop: the next check is only queued once the previous
  // one has fully finished, so slow/backed-up API calls can never overlap
  // or keep firing faster than they resolve. When Roblox rate-limits us
  // (429), back off exponentially instead of hammering it at the same
  // interval — capped at 8s so it still recovers reasonably fast.
  const scheduleNext = useCallback(
    (id) => {
      timerRef.current = setTimeout(async () => {
        if (!activeRef.current) return;
        await runCheck(id);
        if (!activeRef.current) return;
        scheduleNext(id);
      }, rateLimitStreakRef.current > 0 ? Math.min(interval * 2 ** rateLimitStreakRef.current, 8000) : interval);
    },
    [interval, runCheck]
  );

  const startMonitoring = async () => {
    if (!itemId || !/^\d+$/.test(itemId)) {
      setError("Enter a valid numeric item ID.");
      return;
    }
    setError(null);
    setLogs([]);
    setCheckCount(0);
    checkCountRef.current = 0;
    lastPriceRef.current = undefined;
    rateLimitStreakRef.current = 0;
    setItemName(null);
    setCurrentPrice(null);
    activeRef.current = true;
    setMonitoring(true);

    // Create/unlock the AudioContext here, inside the actual click
    // handler, so browsers that suspend audio until a real user gesture
    // don't block the very first pew-pew (which would otherwise fire
    // later, inside an async callback, after the gesture has "expired").
    ensureAudioUnlocked();

    await runCheck(itemId);
    if (activeRef.current) scheduleNext(itemId);
  };

  const stopMonitoring = () => {
    activeRef.current = false; // blocks any in-flight/pending check from doing anything further
    clearTimeout(timerRef.current);
    timerRef.current = null;
    if (abortRef.current) {
      abortRef.current.abort(); // actually cancels the in-flight fetch
      abortRef.current = null;
    }
    setMonitoring(false);
    pushLog(`Stopped after ${checkCountRef.current} checks.`, "info");
  };

  useEffect(() => {
    return () => {
      activeRef.current = false;
      clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const toggleAlertType = (key) => {
    setAlertTypes((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const updateWebhookUrl = (idx, value) => {
    setWebhookUrls((prev) => prev.map((u, i) => (i === idx ? value : u)));
  };
  const addWebhookUrl = () => setWebhookUrls((prev) => [...prev, ""]);
  const removeWebhookUrl = (idx) => setWebhookUrls((prev) => prev.filter((_, i) => i !== idx));

  const activeWebhookCount = webhookUrls.filter((u) => u.trim()).length;

  const discordIdValid = discordUserId === "" || /^\d{15,20}$/.test(discordUserId);

  return (
    <>
      <Head>
        <title>Roblox Price Monitor</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="root">
        <header>
          <span className="logo">⬡</span>
          <div>
            <h1>ROBLOX PRICE MONITOR</h1>
            <p className="sub">Real-time tracking · Push notifications · Pew pew alerts 🔫</p>
          </div>
        </header>

        <section className="card controls">
          <div className="field-row">
            <label htmlFor="itemId">Asset ID</label>
            <input
              id="itemId"
              type="text"
              placeholder="e.g. 1365767"
              value={itemId}
              onChange={(e) => setItemId(e.target.value.replace(/\D/g, ""))}
              disabled={monitoring}
            />
          </div>
          <p className="hint">
            Testing it out? Try{" "}
            <button
              type="button"
              className="link-btn"
              onClick={() => setItemId(DEMO_ITEM_ID)}
              disabled={monitoring}
            >
              demo item {DEMO_ITEM_ID}
            </button>{" "}
            — it goes off-sale on check #{DEMO_OFFSALE_AT_CHECK} so you can hear the alert without waiting on a real item.
          </p>

          <div className="field-row">
            <label htmlFor="interval">Interval</label>
            <select
              id="interval"
              value={interval}
              onChange={(e) => setIntervalMs(Number(e.target.value))}
              disabled={monitoring}
            >
              <option value={200}>0.2s — Ultra 🔥</option>
              <option value={500}>0.5s — Fast ⚡</option>
              <option value={1000}>1s — Stable</option>
              <option value={2000}>2s — Relaxed</option>
            </select>
          </div>

          {error && <p className="error">{error}</p>}

          <div className="btn-row">
            {!monitoring ? (
              <button className="btn-start" onClick={startMonitoring}>Start monitoring</button>
            ) : (
              <button className="btn-stop" onClick={stopMonitoring}>Stop</button>
            )}

            {notifPerm === "granted" ? (
              <span className="notif-on">🔔 Notifications on</span>
            ) : (
              <button
                className="btn-notif"
                onClick={requestNotifPermission}
                disabled={notifPerm === "denied"}
              >
                {notifPerm === "denied" ? "Notifications blocked in browser" : "Enable notifications 🔔"}
              </button>
            )}
          </div>
          {notifPerm === "denied" && (
            <p className="hint">To unblock: click the 🔒 icon in your browser address bar → Notifications → Allow</p>
          )}
        </section>

        {itemName && (
          <section className="card stats">
            <div className="stat-block">
              <span className="stat-label">Item</span>
              <span className="stat-value name">{itemName}</span>
            </div>
            <div className="stat-block">
              <span className="stat-label">Price</span>
              <span className={`stat-value price ${monitoring ? "pulse" : ""}`}>
                {currentPrice != null ? `R$ ${currentPrice.toLocaleString()}` : "—"}
              </span>
            </div>
            <div className="stat-block">
              <span className="stat-label">Checks</span>
              <span className="stat-value">{checkCount.toLocaleString()}</span>
            </div>
            <div className="stat-block">
              <span className="stat-label">Status</span>
              <span className={`status-dot ${monitoring ? "active" : "idle"}`}>
                {monitoring ? "Live" : "Stopped"}
              </span>
            </div>
          </section>
        )}

        <section className="card sound">
          <h2>Sound</h2>
          <div className="field-row">
            <label htmlFor="volume">Volume</label>
            <input
              id="volume"
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
            <span className="volume-value">{volume === 0 ? "Muted" : `${volume}%`}</span>
          </div>
          <div className="btn-row">
            <button className="btn-notif" onClick={testSound}>Test sound 🔊</button>
          </div>
        </section>

        <section className="card discord">
          <h2>Discord Alerts</h2>

          <div className="webhook-list">
            {webhookUrls.map((url, idx) => (
              <div className="field-row" key={idx}>
                <label htmlFor={`webhookUrl-${idx}`}>{idx === 0 ? "Webhook URL" : ""}</label>
                <input
                  id={`webhookUrl-${idx}`}
                  type="password"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={url}
                  onChange={(e) => updateWebhookUrl(idx, e.target.value)}
                />
                {webhookUrls.length > 1 && (
                  <button type="button" className="link-btn" onClick={() => removeWebhookUrl(idx)}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn-notif add-webhook-btn" onClick={addWebhookUrl}>
              + Add another webhook
            </button>
          </div>
          <p className="hint">
            Server Settings → Integrations → Webhooks → New Webhook → Copy URL. Add a few pointed at the
            same channel — each webhook has its own Discord rate limit, so spam pings get spread across
            them and land faster when a sale window is short.
          </p>

          <div className="field-row">
            <label htmlFor="discordUserId">Your user ID</label>
            <input
              id="discordUserId"
              type="text"
              placeholder="123456789012345678"
              value={discordUserId}
              onChange={(e) => setDiscordUserId(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          {!discordIdValid && (
            <p className="error">Discord user IDs are 15–20 digits. Enable Developer Mode in Discord, then right-click your name → Copy User ID.</p>
          )}
          <p className="hint">
            Only this exact ID can ever be pinged — alerts never use @everyone, @here, or roles, no matter what.
          </p>

          <div className="checkbox-group">
            <span className="checkbox-group-label">Send alerts for</span>
            <label className="checkbox-row">
              <input type="checkbox" checked={alertTypes.up} onChange={() => toggleAlertType("up")} />
              Price increased
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={alertTypes.down} onChange={() => toggleAlertType("down")} />
              Price dropped
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={alertTypes.offSale} onChange={() => toggleAlertType("offSale")} />
              Went off sale
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={alertTypes.backOnSale} onChange={() => toggleAlertType("backOnSale")} />
              Back on sale
            </label>
          </div>

          <label className="checkbox-row">
            <input type="checkbox" checked={pingMe} onChange={(e) => setPingMe(e.target.checked)} />
            Ping me on matching alerts
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={spamPings}
              onChange={(e) => setSpamPings(e.target.checked)}
              disabled={!pingMe}
            />
            Spam ping (send it
            <input
              type="number"
              min={1}
              max={MAX_SPAM_PINGS}
              value={spamCount}
              disabled={!pingMe || !spamPings}
              onChange={(e) => setSpamCount(Math.max(1, Math.min(MAX_SPAM_PINGS, Number(e.target.value) || 1)))}
              className="spam-count"
            />
            times in a row so it's not missed)
          </label>
          <p className="hint">
            Capped at {MAX_SPAM_PINGS} messages, split round-robin across every webhook URL above
            {activeWebhookCount > 1 ? ` (currently ${activeWebhookCount} webhooks, so they land roughly ${activeWebhookCount}× faster)` : " — add more webhooks above to make a burst land faster"}.
            Still always targeted at your single user ID only, so this can't be used to mass-ping a server.
          </p>

          <div className="btn-row">
            <button className="btn-notif" onClick={handleTestDiscordAlert} disabled={activeWebhookCount === 0}>
              {discordStatus === "sending" ? "Sending…" : "Send test alert"}
            </button>
            {discordStatus === "sent" && <span className="notif-on">✓ Sent</span>}
            {typeof discordStatus === "string" && discordStatus.startsWith("error:") && (
              <span className="error">{discordStatus.slice(6)}</span>
            )}
          </div>
        </section>

        {logs.length > 0 && (
          <section className="card log-card">
            <h2>Event log</h2>
            <div className="log" ref={logContainerRef}>
              {logs.map((l) => (
                <div key={l.id} className={`log-line ${l.type}`}>
                  <span className="log-ts">{l.ts}</span>
                  <span className="log-msg">{l.msg}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="card changelog">
          <h2>Changelog</h2>
          {CHANGELOG.map((entry) => (
            <div className="changelog-entry" key={entry.version}>
              <div className="changelog-head">
                <span className="changelog-version">{entry.version}</span>
                <span className="changelog-date">{entry.date}</span>
              </div>
              <ul>
                {entry.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>

      <style jsx global>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background: #0a0a0f;
          color: #e8e8f0;
          font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
          min-height: 100vh;
        }
      `}</style>

      <style jsx>{`
        .root {
          max-width: 720px;
          margin: 0 auto;
          padding: 2rem 1rem 4rem;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }
        header {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding-bottom: 0.75rem;
          border-bottom: 1px solid #1e1e2e;
        }
        .logo {
          font-size: 2.2rem;
          color: #ff4444;
          filter: drop-shadow(0 0 8px #ff444466);
        }
        h1 {
          font-size: 1.15rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          color: #fff;
        }
        .sub {
          font-size: 0.72rem;
          color: #555570;
          letter-spacing: 0.04em;
          margin-top: 3px;
        }
        .card {
          background: #10101a;
          border: 1px solid #1e1e2e;
          border-radius: 8px;
          padding: 1.25rem;
        }
        .card h2 {
          font-size: 0.7rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #555570;
          margin-bottom: 0.9rem;
        }
        .controls { display: flex; flex-direction: column; gap: 0.9rem; }
        .discord { display: flex; flex-direction: column; gap: 0.75rem; }
        .sound { display: flex; flex-direction: column; gap: 0.75rem; }
        .field-row { display: flex; align-items: center; gap: 0.75rem; }
        .webhook-list { display: flex; flex-direction: column; gap: 0.5rem; }
        .add-webhook-btn { align-self: flex-start; }
        label {
          font-size: 0.72rem;
          letter-spacing: 0.1em;
          color: #555570;
          text-transform: uppercase;
          width: 80px;
          flex-shrink: 0;
        }
        input, select {
          flex: 1;
          background: #0a0a0f;
          border: 1px solid #2a2a3e;
          border-radius: 5px;
          color: #e8e8f0;
          font-family: inherit;
          font-size: 0.9rem;
          padding: 0.45rem 0.65rem;
          outline: none;
          transition: border-color 0.15s;
        }
        input[type="range"] {
          padding: 0;
          accent-color: #ff4444;
        }
        input:focus, select:focus { border-color: #ff4444; }
        input:disabled, select:disabled { opacity: 0.4; cursor: not-allowed; }
        .volume-value {
          width: 56px;
          flex-shrink: 0;
          font-size: 0.8rem;
          color: #888;
          text-align: right;
        }
        .error { font-size: 0.8rem; color: #ff4444; }
        .hint { font-size: 0.72rem; color: #666; margin-top: -4px; }
        .link-btn {
          background: none;
          border: none;
          padding: 0;
          color: #ff8866;
          font-family: inherit;
          font-size: inherit;
          font-weight: 600;
          text-decoration: underline;
          cursor: pointer;
        }
        .link-btn:disabled { opacity: 0.5; cursor: not-allowed; text-decoration: none; }
        .checkbox-group {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .checkbox-group-label {
          font-size: 0.65rem;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #555570;
        }
        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.82rem;
          color: #ccc;
          text-transform: none;
          letter-spacing: normal;
          width: auto;
          cursor: pointer;
        }
        .checkbox-row input[type="checkbox"] {
          flex: none;
          width: 14px;
          height: 14px;
          accent-color: #ff4444;
        }
        .spam-count {
          width: 48px;
          flex: none;
          padding: 0.25rem 0.4rem;
          text-align: center;
        }
        .btn-row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
        button {
          font-family: inherit;
          font-size: 0.8rem;
          letter-spacing: 0.08em;
          font-weight: 600;
          border: none;
          border-radius: 5px;
          padding: 0.5rem 1.1rem;
          cursor: pointer;
          transition: opacity 0.15s, transform 0.1s;
        }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        button:active:not(:disabled) { transform: scale(0.97); }
        .btn-start { background: #ff4444; color: #fff; text-transform: uppercase; }
        .btn-start:hover { opacity: 0.85; }
        .btn-stop { background: #2a2a3e; color: #e8e8f0; text-transform: uppercase; }
        .btn-stop:hover { background: #3a3a5e; }
        .btn-notif {
          background: transparent;
          border: 1px solid #2a2a3e;
          color: #888;
          font-size: 0.75rem;
        }
        .btn-notif:hover:not(:disabled) { border-color: #ff4444; color: #e8e8f0; }
        .notif-on { font-size: 0.75rem; color: #44cc88; }
        .stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 1rem;
        }
        .stat-block { display: flex; flex-direction: column; gap: 4px; }
        .stat-label {
          font-size: 0.65rem;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #555570;
        }
        .stat-value { font-size: 1rem; font-weight: 700; color: #e8e8f0; }
        .stat-value.name { font-size: 0.85rem; }
        .stat-value.price { color: #ff4444; font-size: 1.3rem; }
        @keyframes pulse-glow {
          0%, 100% { text-shadow: 0 0 4px #ff444433; }
          50% { text-shadow: 0 0 16px #ff4444bb; }
        }
        .pulse { animation: pulse-glow 1s ease-in-out infinite; }
        .status-dot {
          font-size: 0.8rem;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .status-dot::before {
          content: '';
          width: 7px; height: 7px;
          border-radius: 50%;
          background: #555570;
          display: inline-block;
        }
        .status-dot.active { color: #44cc88; }
        .status-dot.active::before {
          background: #44cc88;
          box-shadow: 0 0 6px #44cc88;
          animation: blink 1s ease-in-out infinite;
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.2; }
        }
        .log {
          max-height: 340px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 2px;
          scrollbar-width: thin;
          scrollbar-color: #2a2a3e transparent;
        }
        .log-line {
          display: flex;
          gap: 0.75rem;
          font-size: 0.78rem;
          line-height: 1.5;
          padding: 2px 4px;
          border-radius: 3px;
        }
        .log-line.info  { color: #555570; }
        .log-line.warn  { color: #cc8844; }
        .log-line.good  { color: #44cc88; }
        .log-line.up    { color: #ff6644; background: #ff44140a; }
        .log-line.down  { color: #44aaff; background: #4488ff0a; }
        .log-ts { flex-shrink: 0; color: #333355; font-size: 0.7rem; }
        .log-msg { word-break: break-word; }
        .changelog-entry {
          padding-bottom: 0.9rem;
          margin-bottom: 0.9rem;
          border-bottom: 1px solid #1a1a26;
        }
        .changelog-entry:last-child {
          padding-bottom: 0;
          margin-bottom: 0;
          border-bottom: none;
        }
        .changelog-head {
          display: flex;
          align-items: baseline;
          gap: 0.6rem;
          margin-bottom: 0.35rem;
        }
        .changelog-version {
          font-size: 0.85rem;
          font-weight: 700;
          color: #e8e8f0;
        }
        .changelog-date {
          font-size: 0.68rem;
          color: #555570;
        }
        .changelog-entry ul {
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
        }
        .changelog-entry li {
          font-size: 0.78rem;
          color: #999;
          line-height: 1.4;
          padding-left: 0.9rem;
          position: relative;
        }
        .changelog-entry li::before {
          content: '–';
          position: absolute;
          left: 0;
          color: #444460;
        }
      `}</style>
    </>
  );
}