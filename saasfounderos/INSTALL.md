# Install — SaaSFounderOS

## Claude.ai (recommended — one upload)

Upload **`saasfounderos.zip`** from Gumroad directly to Settings → Capabilities → Skills.

Claude registers **one skill** from the root `SKILL.md`. Type **`/saasfounderos`** to start.

The hub reads agent instructions from bundled `agents/{phase}/{slug}/AGENT.md` files when it routes you — you do **not** need separate uploads for each agent.

```
saasfounderos.zip
└── saasfounderos/
    ├── SKILL.md          ← hub (only SKILL.md in the zip)
    ├── INSTALL.md
    └── agents/
        ├── validate/ …
        ├── build/ …
        ├── launch/ …
        └── grow/ …
```

### What works

| Upload | Result |
|---|---|
| `saasfounderos.zip` | `/saasfounderos` hub + all 17 agents via internal routing |

### What fails on Claude

| Upload | Why |
|---|---|
| A zip with **multiple** `SKILL.md` files | Claude allows one skill per upload |
| A zip containing **nested `.zip`** files | Rejected |
| Renaming the inner folder so it does not match `name:` in YAML | Skill may not load |

---

## Claude Code / Cursor (local skills folder)

Extract the zip, then copy:

| From | To |
|---|---|
| `saasfounderos/` | `~/.claude/skills/saasfounderos/` or `~/.cursor/skills/saasfounderos/` |

Optional — standalone agent skills: copy `agents/{phase}/{slug}/`, rename `AGENT.md` → `SKILL.md`, place in `~/.claude/skills/{slug}/`.

Then run `/saasfounderos` or a single agent command (e.g. `/saas-discovery`).

---

## YAML format

Hub and each agent file start with:

```yaml
---
name: saasfounderos
description: … (≤200 characters)
---
```

---

## Agent phases (17 operators)

### 🔎 VALIDATE — is there a market?

| Slug | Agent |
|---|---|
| `saas-discovery` | SaaS Discovery |
| `market-intelligence` | Market Intelligence |
| `competitor-intelligence` | Competitor Intelligence |
| `pricing-intelligence` | Pricing Intelligence |

### 🛠️ BUILD — turn the idea into a plan

| Slug | Agent |
|---|---|
| `micro-saas-builder` | Micro SaaS Builder |
| `ai-agent-opportunity` | AI Agent Opportunity |
| `lead-research-intelligence` | Lead Research Intelligence |
| `saas-seo-discovery` | SaaS SEO Discovery |

### 🚀 LAUNCH — get first users

| Slug | Agent |
|---|---|
| `saas-launch` | SaaS Launch |
| `directory-launch` | Directory Launch |

### 📈 GROW — compound growth

**Find the opportunity:** `seo-opportunity` · `competitor-seo-page` · `content-gap` · `geo-aeo-audit`

**Plan & execute:** `seo-content-planner` · `seo-page-generator` · `internal-link-optimizer`

Paths: `agents/{validate|build|launch|grow}/{slug}/AGENT.md`

---

## Quick check before upload

- [ ] Uploading `saasfounderos.zip` (not an old multi-zip bundle)
- [ ] Zip has exactly **one** `SKILL.md` at `saasfounderos/SKILL.md`
- [ ] No `assets/` folder inside the zip
- [ ] No nested `.zip` files inside
