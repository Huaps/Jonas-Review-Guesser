(function (root) {
  const ns = (root.ReviewGuesser = root.ReviewGuesser || {});
  const isChineseLocale = ns.isChineseLocale;

  // ---------------------------------------------------------------------------
  // CSV loading + caching
  // ---------------------------------------------------------------------------

  // All batch files used for "Smart Random"
  const BATCH_FILES = [
    "data/Batch_1.csv",
    "data/Batch_2.csv",
    "data/Batch_3.csv",
    "data/Batch_4.csv",
    "data/Batch_5.csv",
    "data/Batch_6.csv"
  ];

  // Simple in-memory cache: path -> Promise<number[]>
  const CSV_CACHE = Object.create(null);
  const APP_NAME_CACHE = Object.create(null);
  const CHINESE_NAME_CACHE = Object.create(null);
  const HAN_CHAR_RX = /[\u3400-\u9FFF]/;

  function getText(key) {
    const zh = !!(isChineseLocale && isChineseLocale());
    const dict = {
      nextRaw: zh ? "下一款（原始）" : "Next (Raw)",
      nextBalanced: zh ? "下一款（均衡）" : "Next (Balanced)",
    };
    return dict[key] || key;
  }

  /**
   * Load a CSV file and parse it into an array of app IDs (numbers).
   * Results are cached per-path so each file is only fetched once.
   *
   * @param {string} relativePath - e.g. "data/released_appids.csv"
   * @returns {Promise<number[]>}
   */
  function loadCsvIds(relativePath) {
    if (CSV_CACHE[relativePath]) {
      return CSV_CACHE[relativePath];
    }

    const url =
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      chrome.runtime.getURL
        ? chrome.runtime.getURL(relativePath)
        : relativePath;

    CSV_CACHE[relativePath] = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("CSV fetch failed: " + r.status);
        return r.text();
      })
      .then((text) => {
        return text
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => /^\d+$/.test(s))
          .map((s) => parseInt(s, 10));
      })
      .catch((err) => {
        console.warn("[ext] failed to load CSV", relativePath, err);
        return [];
      });

    return CSV_CACHE[relativePath];
  }

  /**
   * Resolve Steam app name via appdetails endpoint.
   *
   * @param {number} appid
   * @returns {Promise<string|null>}
   */
  function loadSteamAppName(appid) {
    const key = String(appid);
    if (APP_NAME_CACHE[key]) return APP_NAME_CACHE[key];

    const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(
      key
    )}`;
    APP_NAME_CACHE[key] = fetch(url, { credentials: "omit" })
      .then((r) => {
        if (!r.ok) throw new Error("appdetails fetch failed: " + r.status);
        return r.json();
      })
      .then((json) => {
        const node = json && json[key];
        if (!node || !node.success || !node.data) return null;
        const name = (node.data.name || "").trim();
        return name || null;
      })
      .catch((err) => {
        console.warn("[ext] failed to load app name", appid, err);
        return null;
      });

    return APP_NAME_CACHE[key];
  }

  /**
   * Check whether an app name contains any Han character.
   *
   * @param {string|null} name
   * @returns {boolean}
   */
  function hasHanCharInName(name) {
    if (!name) return false;
    return HAN_CHAR_RX.test(name);
  }

  /**
   * Determine whether an app's name contains Chinese characters.
   *
   * @param {number} appid
   * @returns {Promise<boolean>}
   */
  async function isChineseNamedAppId(appid) {
    const key = String(appid);
    if (key in CHINESE_NAME_CACHE) return CHINESE_NAME_CACHE[key];
    const name = await loadSteamAppName(appid);
    const isHit = hasHanCharInName(name);
    CHINESE_NAME_CACHE[key] = isHit;
    return isHit;
  }

  /**
   * Try to pick one app id whose game name contains Chinese characters.
   * Basic version: sample random IDs and validate names lazily.
   *
   * @param {number[]} ids
   * @param {number} maxAttempts
   * @returns {Promise<number|null>}
   */
  async function pickChineseNamedId(ids, maxAttempts = 25) {
    if (!ids || !ids.length) return null;

    const cap = Math.max(1, Math.min(maxAttempts, ids.length));
    const tried = new Set();

    while (tried.size < cap) {
      const id = pickRandomId(ids);
      if (id == null || tried.has(id)) continue;
      tried.add(id);

      if (await isChineseNamedAppId(id)) {
        return id;
      }
    }

    return null;
  }

  /**
   * Existing behavior: full released app id list (for Pure Random).
   *
   * @returns {Promise<number[]>}
   */
  async function getReleasedAppIds() {
    // NOTE: we assume you placed this file at data/released_appids.csv
    return loadCsvIds("data/released_appids.csv");
  }

  /**
   * Helper to pick a random element from an array of app IDs.
   *
   * @param {number[]} ids
   * @returns {number|null}
   */
  function pickRandomId(ids) {
    if (!ids || !ids.length) return null;
    const idx = Math.floor(Math.random() * ids.length);
    return ids[idx];
  }

  /**
   * "Pure Random" strategy: pick from the global released_appids list.
   *
   * @returns {Promise<number|null>}
   */
  async function getPureRandomAppId() {
    const ids = await getReleasedAppIds();
    const filtered = await pickChineseNamedId(ids, 30);
    return filtered != null ? filtered : pickRandomId(ids);
  }

  /**
   * "Smart Random" strategy:
   *   - pick a random batch CSV (Batch_1..Batch_6)
   *   - load IDs from that file
   *   - pick a random app id from that batch
   *   - if anything goes wrong / empty → fall back to Pure Random
   *
   * @returns {Promise<number|null>}
   */
  async function getSmartRandomAppId() {
    if (!BATCH_FILES.length) return getPureRandomAppId();

    const file =
      BATCH_FILES[Math.floor(Math.random() * BATCH_FILES.length)];
    const ids = await loadCsvIds(file);
    const id = await pickChineseNamedId(ids, 20);

    if (id != null) return id;

    // Fallback to Pure Random if this batch is empty or failed
    return getPureRandomAppId();
  }

  /**
   * Resolve a random app id based on mode ("pure" | "smart"),
   * and navigate to that app on the Steam store.
   *
   * @param {"pure"|"smart"} mode
   */
  async function navigateToRandomApp(mode) {
    let appid = null;

    if (mode === "smart") {
      appid = await getSmartRandomAppId();
    } else {
      appid = await getPureRandomAppId();
    }

    if (!appid) {
      // Fallback: Dota 2, in case everything fails
      appid = 570;
    }

    window.location.assign(
      `https://store.steampowered.com/app/${appid}/`
    );
  }

  /**
   * Create a "Next Game" button with the given label and strategy.
   *
   * @param {string} label - Button text ("Pure Random" / "Smart Random")
   * @param {"pure"|"smart"} mode
   * @returns {HTMLAnchorElement}
   */
  function makeNextGameButton(label, mode) {
    const a = document.createElement("a");
    a.className = "btnv6_blue_hoverfade btn_medium ext-next-game";
    a.href = "#";

    const span = document.createElement("span");
    span.textContent = label;
    a.appendChild(span);

    a.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        navigateToRandomApp(mode);
      },
      { passive: false }
    );

    return a;
  }

  // ---------------------------------------------------------------------------
  // Oops / region-locked page: header button(s)
  // ---------------------------------------------------------------------------

  function installNextGameButtonOnOops() {
    const header = document.querySelector(
      ".page_header_ctn .page_content"
    );
    if (!header) return;

    // Avoid duplicates – if we already placed any ext-next-game, stop.
    if (header.querySelector(".ext-next-game")) return;

    const target =
      header.querySelector("h2.pageheader") || header;

    // Wrap both buttons in a simple row
    const pureBtn = makeNextGameButton(getText("nextRaw"), "pure");
    const smartBtn = makeNextGameButton(getText("nextBalanced"), "smart");

    const row = document.createElement("div");
    row.style.marginTop = "10px";
    row.style.display = "flex";
    row.style.gap = "8px";
    row.appendChild(pureBtn);
    row.appendChild(smartBtn);

    if (target && target.parentElement) {
      target.insertAdjacentElement("afterend", row);
    } else {
      header.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Normal app page: replace Community Hub with two buttons
  // ---------------------------------------------------------------------------

  function installNextGameButton() {
    const container = document.querySelector(
      ".apphub_HomeHeaderContent .apphub_OtherSiteInfo"
    );
    if (!container) return;

    // Avoid duplicates
    if (container.querySelector(".ext-next-game")) return;

    // Remove the original Community Hub button, if present
    const hubBtn = container.querySelector(
      "a.btnv6_blue_hoverfade.btn_medium"
    );
    if (hubBtn) hubBtn.remove();

    const pureBtn = makeNextGameButton(getText("nextRaw"), "pure");
    const smartBtn = makeNextGameButton(getText("nextBalanced"), "smart");

    // Let Steam's layout handle positioning; just drop them in order
    container.appendChild(pureBtn);
    container.appendChild(smartBtn);
  }

  // Expose on namespace
  ns.getReleasedAppIds = getReleasedAppIds;
  ns.installNextGameButtonOnOops = installNextGameButtonOnOops;
  ns.installNextGameButton = installNextGameButton;
})(window);
