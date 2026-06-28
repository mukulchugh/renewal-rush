// accounts.js — the customer accounts you're fighting to keep.
//
// ORIGINAL transformative wordmark-parodies of real tech companies — riffs, not
// traced logos. Each is a real word/pun that comments on the company (and, where
// it lands, on CHURN itself — the thing this game is about): Amazon→Amazdone,
// Brex→Brexit, Dropbox→Dropped, Databricks→Databricked. That double meaning is the
// joke; a misspelled logo is not. These ARE Quivly's customer accounts — each
// becomes a city building (tier = footprint/height, health bucket = color/beacon)
// and is referenced on the result card ("Amazdone renewed · Slackoff churned") and
// on enemy signal badges ("Swypey · payment_overdue").
//
// Pure data — no Babylon, importable anywhere. `accent` is the sign/logo color
// (an evocative tint, not the trademarked exact value). `tier` ∈
// strategic|high_touch|mid|low|self_serve. `parodyOf` is flavor only.

export const ACCOUNTS = [
  { name: "Gaggle",       accent: "#1aa3d6", tier: "strategic",  parodyOf: "Google" },
  { name: "Googol",       accent: "#ea4335", tier: "strategic",  parodyOf: "Google" },
  { name: "Fakebook",     accent: "#1877f2", tier: "strategic",  parodyOf: "Meta" },
  { name: "Amazdone",     accent: "#ff9900", tier: "strategic",  parodyOf: "Amazon" },
  { name: "Pearble",      accent: "#a3aab2", tier: "strategic",  parodyOf: "Apple" },
  { name: "Macrohard",    accent: "#7cbb00", tier: "strategic",  parodyOf: "Microsoft" },
  { name: "Nyetflix",     accent: "#e50914", tier: "high_touch", parodyOf: "Netflix" },
  { name: "Salesfarce",   accent: "#00a1e0", tier: "high_touch", parodyOf: "Salesforce" },
  { name: "Goober",       accent: "#111827", tier: "high_touch", parodyOf: "Uber" },
  { name: "Airpnp",       accent: "#ff5a5f", tier: "high_touch", parodyOf: "Airbnb" },
  { name: "Spotifry",     accent: "#1db954", tier: "high_touch", parodyOf: "Spotify" },
  { name: "Snaprat",      accent: "#fffc00", tier: "high_touch", parodyOf: "Snap" },
  { name: "Paranoir",     accent: "#101418", tier: "high_touch", parodyOf: "Palantir" },
  { name: "Invidia",      accent: "#76b900", tier: "high_touch", parodyOf: "Nvidia" },
  { name: "Coinbust",     accent: "#1652f0", tier: "high_touch", parodyOf: "Coinbase" },
  { name: "Slackoff",     accent: "#611f69", tier: "mid",        parodyOf: "Slack" },
  { name: "Swypey",       accent: "#635bff", tier: "mid",        parodyOf: "Stripe" },
  { name: "Zendread",     accent: "#03363d", tier: "mid",        parodyOf: "Zendesk" },
  { name: "HubSnot",      accent: "#ff7a59", tier: "mid",        parodyOf: "HubSpot" },
  { name: "Gongshow",     accent: "#8039df", tier: "mid",        parodyOf: "Gong" },
  { name: "Notyet",       accent: "#111827", tier: "mid",        parodyOf: "Notion" },
  { name: "Figment",      accent: "#a259ff", tier: "mid",        parodyOf: "Figma" },
  { name: "Datahound",    accent: "#632ca6", tier: "mid",        parodyOf: "Datadog" },
  { name: "Zoombie",      accent: "#2d8cff", tier: "mid",        parodyOf: "Zoom" },
  { name: "Snowfluke",    accent: "#29b5e8", tier: "mid",        parodyOf: "Snowflake" },
  { name: "Databricked",  accent: "#ff3621", tier: "mid",        parodyOf: "Databricks" },
  { name: "Verchell",     accent: "#111827", tier: "low",        parodyOf: "Vercel" },
  { name: "Supabased",    accent: "#3ecf8e", tier: "low",        parodyOf: "Supabase" },
  { name: "Backlogg",     accent: "#5e6ad2", tier: "low",        parodyOf: "Linear" },
  { name: "Cursed",       accent: "#111827", tier: "low",        parodyOf: "Cursor" },
  { name: "Perplexed",    accent: "#20808d", tier: "low",        parodyOf: "Perplexity" },
  { name: "Rampage",      accent: "#fbdb44", tier: "low",        parodyOf: "Ramp" },
  { name: "Brexit",       accent: "#f45d48", tier: "low",        parodyOf: "Brex" },
  { name: "Plaidypus",    accent: "#111827", tier: "low",        parodyOf: "Plaid" },
  { name: "Twillight",    accent: "#f22f46", tier: "low",        parodyOf: "Twilio" },
  { name: "Dropped",      accent: "#0061ff", tier: "self_serve", parodyOf: "Dropbox" },
  { name: "Mixpanik",     accent: "#7856ff", tier: "self_serve", parodyOf: "Mixpanel" },
  { name: "Threddit",     accent: "#ff4500", tier: "self_serve", parodyOf: "Reddit" },
  { name: "Spinterest",   accent: "#e60023", tier: "self_serve", parodyOf: "Pinterest" },
  { name: "Glitch",       accent: "#9146ff", tier: "self_serve", parodyOf: "Twitch" },
];

// Deterministic helper: pick an account for a building slot from a seeded rng
// (so a daily-seed run always lays the skyline out the same way).
export function accountFor(index, rng) {
  if (typeof index === "number" && !rng) return ACCOUNTS[index % ACCOUNTS.length];
  const r = typeof rng === "function" ? rng() : Math.abs(Math.sin(index || 0));
  return ACCOUNTS[Math.floor(r * ACCOUNTS.length) % ACCOUNTS.length];
}
