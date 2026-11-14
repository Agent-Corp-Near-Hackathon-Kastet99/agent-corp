/* Agent Corp growth tracker. Paste into the landing/game page.
 * Disabled unless <meta name="agentcorp-events" content="https://YOUR-SERVER"> is present.
 * Sends only: event name, a random per-browser id, and the utm_* attribution carried by the link.
 * Call window.agentCorpTrack("game_page_view" | "wallet_connect" | "pass_click") from the game/store pages. */
(function () {
  var m = document.querySelector('meta[name="agentcorp-events"]');
  var base = m && m.content;
  if (!base) return;
  var anon = localStorage.getItem("ac_anon");
  if (!anon) { anon = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("ac_anon", anon); }
  var q = new URLSearchParams(location.search);
  var attr = {};
  try { attr = JSON.parse(sessionStorage.getItem("ac_attr") || "{}"); } catch (e) { attr = {}; }
  var campaign = q.get("utm_campaign");
  if (campaign) {
    var c = /^cycle-(\d+)$/.exec(campaign);
    attr = { cycle: c ? Number(c[1]) : undefined, channel: q.get("utm_source") || undefined, asset: q.get("utm_content") || undefined };
    sessionStorage.setItem("ac_attr", JSON.stringify(attr));
  }
  window.agentCorpTrack = function (name) {
    fetch(base.replace(/\/$/, "") + "/api/growth/event", {
      method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
      body: JSON.stringify({ name: name, anon: anon, cycle: attr.cycle, channel: attr.channel, asset: attr.asset })
    }).catch(function () {});
  };
  window.agentCorpTrack("page_view");
})();
