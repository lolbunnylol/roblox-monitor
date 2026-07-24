import { useState, useEffect, useRef, useCallback } from "react";
import Head from "next/head";

export default function Home() {
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

  const timerRef = useRef(null);
  const lastPriceRef = useRef(undefined);
  const checkCountRef = useRef(0);
  const logsEndRef = useRef(null);
  const audioCtxRef = useRef(null);
  const activeRef = useRef(false); // true only while monitoring is actually running
  const abortRef = useRef(null); // AbortController for the in-flight request
  const rateLimitStreakRef = useRef(0); // consecutive 429s, used to back off polling speed

  // Register service worker + check notification permission
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then(setSwReg).catch(() => {});
    }
    if ("Notification" in window) setNotifPerm(Notification.permission);
  }, []);

  // Auto-scroll log
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const pushLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [
      ...prev.slice(-299),
      { ts, msg, type, id: Date.now() + Math.random() },
    ]);
  }, []);

  // Pew pew sound via Web Audio API — no file needed
  const playPew = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;

      const playOnePew = (startTime) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        // Laser sweep: high freq falling fast
        osc.type = "square";
        osc.frequency.setValueAtTime(1400, startTime);
        osc.frequency.exponentialRampToValueAtTime(200, startTime + 0.18);

        gain.gain.setValueAtTime(0.35, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.2);

        osc.start(startTime);
        osc.stop(startTime + 0.2);
      };

      // Two pews, slightly apart
      playOnePew(ctx.currentTime);
      playOnePew(ctx.currentTime + 0.25);
    } catch (_) {}
  }, []);

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

  const doCheck = useCallback(
    async (id, signal) => {
      try {
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
        const { price, name } = data;

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
            pushLog(
              `${dir}  R$ ${prev.toLocaleString()} → R$ ${price.toLocaleString()}  (${diff > 0 ? "+" : ""}${diff.toLocaleString()})`,
              diff > 0 ? "up" : "down"
            );
            sendNotification(
              `Price ${diff > 0 ? "increased" : "dropped"} — ${name || id}`,
              `${dir}  R$ ${prev.toLocaleString()} → R$ ${price.toLocaleString()}`
            );
          } else if (price == null) {
            pushLog(`Off sale (was R$ ${prev.toLocaleString()})`, "warn");
            sendNotification(`Off sale — ${name || id}`, `Was R$ ${prev.toLocaleString()}`);
          } else {
            pushLog(`Back on sale — R$ ${price.toLocaleString()}`, "good");
            sendNotification(`Back on sale — ${name || id}`, `R$ ${price.toLocaleString()}`);
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
    [pushLog, sendNotification, playPew]
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
        const result = await runCheck(id);
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
    setItemName(null);
    setCurrentPrice(null);
    activeRef.current = true;
    setMonitoring(true);
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

        {logs.length > 0 && (
          <section className="card log-card">
            <h2>Event log</h2>
            <div className="log">
              {logs.map((l) => (
                <div key={l.id} className={`log-line ${l.type}`}>
                  <span className="log-ts">{l.ts}</span>
                  <span className="log-msg">{l.msg}</span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </section>
        )}
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
        .controls { display: flex; flex-direction: column; gap: 0.9rem; }
        .field-row { display: flex; align-items: center; gap: 0.75rem; }
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
        input:focus, select:focus { border-color: #ff4444; }
        input:disabled, select:disabled { opacity: 0.4; cursor: not-allowed; }
        .error { font-size: 0.8rem; color: #ff4444; }
        .hint { font-size: 0.72rem; color: #666; margin-top: -4px; }
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
        .log-card h2 {
          font-size: 0.7rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #555570;
          margin-bottom: 0.75rem;
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
      `}</style>
    </>
  );
}
