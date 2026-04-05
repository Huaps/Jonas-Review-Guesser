(function (root) {
  const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

  /**
   * Detect whether current Steam page is in a Chinese locale.
   *
   * @returns {boolean}
   */
  function isChineseLocale() {
    const htmlLang = (document.documentElement?.lang || "").toLowerCase();
    if (
      htmlLang === "zh" ||
      htmlLang.startsWith("zh-") ||
      htmlLang.includes("schinese") ||
      htmlLang.includes("tchinese")
    ) {
      return true;
    }

    const langParam = new URLSearchParams(location.search).get("l") || "";
    return /^(?:zh|zh-cn|zh-tw|schinese|tchinese)$/i.test(langParam);
  }

  /**
   * Replace non-breaking spaces with regular spaces and trim the string.
   * @param {string} s
   * @returns {string}
   */
  function normalizeSpaces(s) {
    return (s || "").replace(/\u00A0/g, " ").trim();
  }

  /**
   * Parse numbers like:
   *   7,036 / 7.036 / 7 036 / 7K / 7 Mio
   *
   * Returns:
   *   - integer count
   *   - 0 when explicitly "0" (for "No reviews" callers)
   *   - null when nothing reasonable can be parsed
   *
   * @param {string} raw
   * @returns {number|null}
   */
  function parseReviewCountRaw(raw) {
    const s = normalizeSpaces(raw);
    if (!s) return null;

    // Zero special-case (handles "No reviews", etc.) — leave general case to caller
    if (/^\s*0\s*$/.test(s)) return 0;

    // Suffixes (K/M/B + common "Mio"/"Tsd" + Chinese "万/亿")
    const mSuf = s.match(/(\d+[.,]?\d*)\s*(K|M|B|k|m|b|Mio|Tsd|万|亿)/);
    if (mSuf) {
      const n = parseFloat(mSuf[1].replace(",", "."));
      const sufRaw = mSuf[2];
      const suf = sufRaw.toLowerCase();
      const mult = (() => {
        if (suf === "k" || suf === "tsd") return 1e3;
        if (suf === "m" || suf === "mio") return 1e6;
        if (suf === "b") return 1e9;
        if (sufRaw === "万") return 1e4;
        if (sufRaw === "亿") return 1e8;
        return 1;
      })();
      const v = Math.round(n * mult);
      return Number.isFinite(v) ? v : null;
    }

    // Largest integer with separators
    const matches = [...s.matchAll(/\b(\d{1,3}(?:[ .,\u00A0]\d{3})+|\d{2,})\b/g)]
      .map((m) => parseInt(m[1].replace(/[ .,\u00A0]/g, ""), 10))
      .filter(Number.isFinite);

    if (matches.length) return Math.max(...matches);

    // Fallback: numbers immediately preceding 'review(s)' (captures single-digit counts)
    const mReviewWord = s.match(
      /\b(\d+)\b(?=\s*(?:user\s+)?reviews?\b)/i
    );
    if (mReviewWord) return parseInt(mReviewWord[1], 10);

    // Chinese fallback: "N 篇用户评测" / "N 用户评测" / "N 评测"
    const mZhReviewWord = s.match(
      /(\d+)\s*(?=(?:篇\s*)?(?:用户\s*)?评测\b)/
    );
    if (mZhReviewWord) return parseInt(mZhReviewWord[1], 10);

    return null;
  }

  /**
   * Format integers with a SPACE as the thousands separator.
   * Example: 24323 -> "24 323"
   *
   * @param {number} n
   * @returns {string}
   */
  function formatNum(n) {
    const s = String(Math.trunc(Number(n) || 0));
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  // Expose on namespace
  ns.isChineseLocale = isChineseLocale;
  ns.normalizeSpaces = normalizeSpaces;
  ns.parseReviewCountRaw = parseReviewCountRaw;
  ns.formatNum = formatNum;
})(window);
