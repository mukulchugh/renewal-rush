// accounts.js — the customer accounts you're fighting to keep.
//
// Parody tech-company names in the spirit of the HBO "Silicon Valley" title
// sequence: a San-Francisco skyline of recognizable-but-legally-distinct morphs
// of real companies. These ARE Quivly's customer accounts — each becomes a city
// building (tier = footprint/height, health bucket = color/beacon) and can be
// referenced on the result card ("Amazoom renewed · Slackr churned") and on
// enemy signal badges ("Stribe · payment_overdue").
//
// Pure data — no Babylon, importable anywhere. `accent` is the sign/logo color.
// `tier` ∈ strategic|high_touch|mid|low|self_serve. `parodyOf` is flavor only.

export const ACCOUNTS = [
  { name: "Hooli",        accent: "#1aa3d6", tier: "strategic",  parodyOf: "Google/Apple" },
  { name: "Goolybib",     accent: "#ea4335", tier: "strategic",  parodyOf: "Google" },
  { name: "Facebark",     accent: "#1877f2", tier: "strategic",  parodyOf: "Meta" },
  { name: "Amazoom",      accent: "#ff9900", tier: "strategic",  parodyOf: "Amazon" },
  { name: "Appabit",      accent: "#a3aab2", tier: "strategic",  parodyOf: "Apple" },
  { name: "Macrohard",    accent: "#7cbb00", tier: "strategic",  parodyOf: "Microsoft" },
  { name: "Nyetflix",     accent: "#e50914", tier: "high_touch", parodyOf: "Netflix" },
  { name: "Salesfarce",   accent: "#00a1e0", tier: "high_touch", parodyOf: "Salesforce" },
  { name: "Oober",        accent: "#111827", tier: "high_touch", parodyOf: "Uber" },
  { name: "Airpnp",       accent: "#ff5a5f", tier: "high_touch", parodyOf: "Airbnb" },
  { name: "Spotifry",     accent: "#1db954", tier: "high_touch", parodyOf: "Spotify" },
  { name: "Snapchap",     accent: "#fffc00", tier: "high_touch", parodyOf: "Snap" },
  { name: "Palantar",     accent: "#101418", tier: "high_touch", parodyOf: "Palantir" },
  { name: "Invidia",      accent: "#76b900", tier: "high_touch", parodyOf: "Nvidia" },
  { name: "Coinvase",     accent: "#1652f0", tier: "high_touch", parodyOf: "Coinbase" },
  { name: "Slackr",       accent: "#611f69", tier: "mid",        parodyOf: "Slack" },
  { name: "Stribe",       accent: "#635bff", tier: "mid",        parodyOf: "Stripe" },
  { name: "Zendsk",       accent: "#03363d", tier: "mid",        parodyOf: "Zendesk" },
  { name: "HubSnot",      accent: "#ff7a59", tier: "mid",        parodyOf: "HubSpot" },
  { name: "Gongg",        accent: "#8039df", tier: "mid",        parodyOf: "Gong" },
  { name: "Notiion",      accent: "#111827", tier: "mid",        parodyOf: "Notion" },
  { name: "Figmoa",       accent: "#a259ff", tier: "mid",        parodyOf: "Figma" },
  { name: "Datadawg",     accent: "#632ca6", tier: "mid",        parodyOf: "Datadog" },
  { name: "Zoombie",      accent: "#2d8cff", tier: "mid",        parodyOf: "Zoom" },
  { name: "Snowfluke",    accent: "#29b5e8", tier: "mid",        parodyOf: "Snowflake" },
  { name: "Datablocks",   accent: "#ff3621", tier: "mid",        parodyOf: "Databricks" },
  { name: "Vercccel",     accent: "#111827", tier: "low",        parodyOf: "Vercel" },
  { name: "Supabased",    accent: "#3ecf8e", tier: "low",        parodyOf: "Supabase" },
  { name: "Linearr",      accent: "#5e6ad2", tier: "low",        parodyOf: "Linear" },
  { name: "Cursr",        accent: "#111827", tier: "low",        parodyOf: "Cursor" },
  { name: "Pearplexity",  accent: "#20808d", tier: "low",        parodyOf: "Perplexity" },
  { name: "Rampart",      accent: "#fbdb44", tier: "low",        parodyOf: "Ramp" },
  { name: "Brexit",       accent: "#f45d48", tier: "low",        parodyOf: "Brex" },
  { name: "Plaidd",       accent: "#111827", tier: "low",        parodyOf: "Plaid" },
  { name: "Twilllio",     accent: "#f22f46", tier: "low",        parodyOf: "Twilio" },
  { name: "Dropcrate",    accent: "#0061ff", tier: "self_serve", parodyOf: "Dropbox" },
  { name: "Mixpanik",     accent: "#7856ff", tier: "self_serve", parodyOf: "Mixpanel" },
  { name: "Reddnit",      accent: "#ff4500", tier: "self_serve", parodyOf: "Reddit" },
  { name: "Pintcrest",    accent: "#e60023", tier: "self_serve", parodyOf: "Pinterest" },
  { name: "Twitchr",      accent: "#9146ff", tier: "self_serve", parodyOf: "Twitch" },
];

// Deterministic helper: pick an account for a building slot from a seeded rng
// (so a daily-seed run always lays the skyline out the same way).
export function accountFor(index, rng) {
  if (typeof index === "number" && !rng) return ACCOUNTS[index % ACCOUNTS.length];
  const r = typeof rng === "function" ? rng() : Math.abs(Math.sin(index || 0));
  return ACCOUNTS[Math.floor(r * ACCOUNTS.length) % ACCOUNTS.length];
}
