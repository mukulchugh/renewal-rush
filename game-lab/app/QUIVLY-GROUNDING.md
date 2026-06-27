# Renewal Rush — Quivly Product Grounding (theme source of truth)

Every overhaul module follows this so the game *is* a playable Quivly demo, not generic.
Pairs with `ARCHITECTURE.md` (how modules wire) — this is *what they mean*.
Grounded in the real `quivly-app` codebase (Nx monorepo; Next.js app + `packages/ai`).

## What Quivly is
"The AI workforce for post-sales teams — your new post-sales team, without the headcount."
A Customer Success Platform: it ingests every post-sales signal into one live account profile
(Customer 360), scores health 0–100 in real time (explained in plain English), and has AI agents
surface + act on churn risk and expansion. Flow: **Connect → See → Score → Act.**
Voice: confident, calm, plain-English, short fragments ending on the action payoff.

## Player & core analogy (shooter kept per user; themed as agent-deployment)
- **Player** = a Quivly **CSM commanding the AI workforce**. You don't fix churn by hand — you
  **deploy agents**.
- **Weapon "Agent Pulse"** = *deploying an agent* (`agents.agent_config {prompt, tool_ids}`) — an
  indigo pulse/beam, NOT a gun. Keep FPS feel. (E = AoE deploy.)
- **Enemies = the negative churn SIGNALS** (real `SIGNAL_TYPES`, see list) rendered as branded
  **signal cards**. Neutralizing one = the agent resolving that risk → ARR saved.
- **Healthy accounts** = green, must NOT be hit (false positive → health penalty).
- **Pickups = the two POSITIVE signals** `expansion_opportunity`, `upsell_signal` (score multiplier).
- **Boss = a renewal Opportunity at `negotiation`** — drive it to `closed_won` (account stays
  `active`); fail = `closed_lost` → account `churned`. **Renewal Gate** = the deadline (90s timer).

## ⚠️ CRITICAL: color by SCORE BUCKET, never by the risk word (it's inverted)
Health score is **0–100**. `risk_level="low"` means **HEALTHY**. Map difficulty/color to the bucket:
| Bucket | Score | Color | Game role |
|---|---|---|---|
| **Critical** | 0–24 | red `#ef4444` | boss-tier brute, fast, high damage |
| **High Risk** | 25–49 | orange `#f97316` | tough seeker |
| **Medium** | 50–74 | amber `#eab308` | standard |
| **Healthy** | 75–100 | green `#22c55e` | DO NOT SHOOT (false positive) |
Higher severity = tougher/faster/more damage. Never render a "low" entity as a red enemy.

## Enemy types = the real negative SIGNAL_TYPES (`packages/ai/src/ledger/types.ts`)
`critical_health_score`, `low_health_score` (brutes) · `renewal_overdue`, `renewal_approaching`
(countdown enemies, tie to timer) · `payment_overdue` (billing) · `declining_usage`,
`low_product_adoption` (attrition swarm) · `no_activity_30d` (ghost/fade) · `negative_sentiment`,
`support_escalation` (aggressive, from calls/tickets) · `champion_departure` (HIGH-VALUE priority
target — your champion is leaving) · `negative_market_signal` (external: layoffs/funding cut/
competitor). Each carries a source chip (below). **Multi-source** card = highest value + toughest
(Quivly's moat: "CRM said healthy, usage said otherwise, Quivly saw both").

## Signal sources (real integration categories → enemy chip / pickup)
| Category | Sources (real) | Health weight | Churn signal | Expansion pickup |
|---|---|---|---|---|
| CRM | Salesforce, HubSpot, Attio | — | renewal overdue, champion removed | new contacts, upsell opp |
| Billing/Revenue | Stripe, Chargebee | 30% | payment failed, downgrade | expansion MRR, seat growth |
| Product Usage | Amplitude, Mixpanel, PostHog | 25% | declining usage, low adoption | usage growth |
| Conversation | Gong, Fireflies, Fathom | (engagement 20%) | negative call sentiment | exec buy-in, new use-case |
| Support | Zendesk, Intercom, Pylon | 15% | ticket spike, CSAT drop, escalation | fast resolve, high CSAT |
| Comms | Slack, Gmail, Calendar | (engagement) | sponsor quiet, no_activity_30d | praise, power-user |
| Market | (web/Tavily) | 10% | layoffs, champion left, competitor win | funding, hiring spree |

## Sectors = the real product flow (rename zones Connect → See → Score → Act)
- **Connect** = Integrations: scattered stack becomes one profile (sources light up).
- **See** = Customer 360 / Radar / Market Signals: signals surface as cards.
- **Score** = Health Score drops, risk escalates (the Insight Ledger gates signals → Actions).
- **Act** = Actions feed + Agents: deploy agents, draft already written, renewal saved at the gate.

## World tells the Quivly story (build this into world.js)
- **Accounts = buildings**, colored by health bucket, **sized by `tier`** (strategic skyscraper →
  high_touch → mid → low → self_serve shack), **glow/value by ARR** (contract amount). A red
  strategic skyscraper = your highest-stakes target.
- **Lifecycle as geography**: Onboarding → Active → Renewing districts; the **Churned wasteland**
  at the edge — the place you're fighting to keep accounts out of.
- Signals as branded floating cards orbiting buildings. A few **Radar** ground-ring markers per sector.
- Bright sunny "real world" daylight (NOT dark techno-sci-fi). Lush real grass + nature.

## Metrics, states & real vocabulary (use as in-game labels)
- **Health Score** 0–100 + trend `up/down/stable` (sample **57, −7**). Categories: revenue 30 ·
  usage 25 · engagement 20 · support 15 · market 10.
- **Lifecycle**: Prospect · Onboarding · Active · Renewing · At Risk · Churned.
- **Opportunity type**: New · Expansion · Renewal · Retention. **Priority**: Urgent/High/Medium/Low.
- **Contact roles**: Champion (glowing ally) · Decision Maker · Economic Buyer · Influencer · End User · Detractor.
- **Renewal** countdown (real field `renewal_in_days`), sample "**5d overdue**". Usage "**−42% WAU**".
  Sample **ARR $49,930**. Stat: "CSMs managing up to **60% more ARR**."
- Real surfaces to name in HUD/script: **Customer 360, Radar, Actions, Agents, Market Signals,
  Ask Quivly, Opportunities**. Agent verbs: Connect/Sync/Surface/Deploy/Review/Approve/Resolve/Renew/Expand.
- HUD reads like **Customer 360**: Health Score, Risk bucket, ARR Saved, Churn Threat, Renewal timer,
  Deploys, multiplier, "Full Stack" multi-source flag.
- NO "Playbook" in Quivly — say **Skills / Project Templates / recommended steps**.
- Keep arcade coinages clearly as game flavor: ARR Saved, Full Stack Signal, ranks Renewal Rookie →
  CSM Speedrunner → Chief Renewal Officer. "Agent Pulse" is game-coined; product verb = "deploy an agent".

## Script beats (Quivly voice)
- **Title:** "RENEWAL RUSH — Every signal. One place. 90 seconds to renewal day." sub: "Your post-sales team, without the headcount."
- **Connect:** "Your stack is scattered — Salesforce, Gong, Stripe, Zendesk, Slack, Market. Watch it become one profile."
- **Aha:** "CRM said healthy. Usage said otherwise. Quivly saw both."
- **High-value catch (champion_departure):** "Your champion is walking out — Slack quiet, Stripe failed, Market says layoffs. One card. Deploy."
- **Deploy feedback:** "Draft's already written — grounded in Gong + Stripe + Market."
- **Win:** "You saved the quarter. Renewal closed-won. ARR secured — your post-sales team, without the headcount."
- **Lose:** "Churn got there first. The account went dark. Quivly would've had the draft ready."
- **CTA:** "This is a game. Quivly does it for real, autonomously, across your whole stack. Book a demo → quivly.ai"
