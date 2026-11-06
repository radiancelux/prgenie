# Token cost efficiency and model choice (PR Genie)

Research note for RadianceLux operators choosing models and **local vs cloud** agents when running PR Genie jobs. Figures below come from vendor documentation unless labeled **estimate**.

**Access date for web sources:** 2026-11-05 (UTC).

---

## Executive summary

- **Optimize for cost per completed task**, not cost per token alone. A model that finishes in one implement/review cycle often beats a cheaper model that needs extra rounds, large re-reads of the repo, or human unblocking.
- **Default local PR Genie runs** use **`composer-2.5`** via **`cursor-agent`** on Brett’s workstation ([local runner README](../../local-runner/README.md)). At Cursor’s published list rates, Composer 2.5 is among the lowest-cost **first-party** agent models and is positioned as a strong intelligence/cost tradeoff ([Composer 2 blog](https://cursor.com/blog/composer-2), [Models & Pricing](https://cursor.com/docs/models-and-pricing)).
- **Use cloud agents** when the task needs an isolated VM (build/test/browser), parallel agents, or work while the laptop is off—but only on plans that include them (Premium and above on current Cursor plans). **Use local agents** for tight privacy/control, existing workstation credentials, and fast iteration on small diffs.
- **Escalate model capability** (third-party frontier models or Composer Fast) when complexity, ambiguity, or failure rate dominates; **stay on Composer 2.5** for docs-only jobs, narrow fixes, and high-volume loops where review bars are clear.

---

## Cost per completed task vs cost per token

### What “per token” means in Cursor

Cursor bills agent usage against your plan’s **included usage pool** (weekly refresh on current plans) and, beyond that, **per-million-token rates** that depend on the model. First-party models such as **Composer 2.5** and **Grok 4.x** have published input/output (and cache read) rates in [Models & Pricing](https://cursor.com/docs/models-and-pricing). Third-party models (Claude, GPT, Gemini, etc.) bill at **API list price** from prepaid credit on Premium+; Teams/Enterprise may also pay the [**Cursor Token Rate**](https://cursor.com/help/models-and-usage/token-rate) ($0.25/M tokens on eligible third-party requests—first-party Composer/Grok exempt).

Token **cache reads** (where listed) reduce repeated context cost; long-context surcharges apply to some models (see pricing table notes).

### When a “more expensive” model is cheaper overall

Per-token price is only half the equation. Agent jobs also spend tokens on:

- **Tool loops** — file reads, searches, shell output, test logs, and MCP payloads re-enter context each round.
- **Retries** — wrong approach, failing tests, or review findings trigger another implement/fix pass (PR Genie’s loop is designed around this).
- **Context bloat** — pasting large logs, re-exploring the repo, or weak first attempts inflate input tokens on every subsequent step.

A more capable model can reduce **total tokens per merged outcome** when it:

- Picks the right design on the first pass (fewer fix rounds).
- Uses tools efficiently (targeted reads vs shotgun exploration).
- Produces review-ready diffs (less reviewer/agent churn).

**Qualitative rule:** For multi-file features, subtle bugs, security-sensitive changes, or ambiguous specs, compare **estimated rounds × context size × model rate**, not single-request token price. You do not need exact numbers to decide—watch **stuck jobs**, **maxRounds exhaustion**, and **repeat review cycles** as signals to step up.

**Illustrative framing (not measured on PR Genie):** If Model A costs 4× Model B per token but routinely needs one agent pass instead of three, Model A wins on total spend whenever total tokens stay below ~4× Model B’s. Replace the multiplier with your own observed round counts; do not treat this as a measured PR Genie benchmark.

### When cheaper-per-token models still win

Lower list rates (or smaller models) tend to win when:

- **Task scope is narrow** — typo fixes, config tweaks, single-file docs, mechanical refactors with explicit instructions.
- **Volume is high** — many small jobs where overhead dominates; default **Composer 2.5** is appropriate ([$0.50/M input, $2.50/M output](https://cursor.com/docs/models-and-pricing) vs e.g. Grok 4.7 at [$2/M input, $6/M output](https://cursor.com/docs/models-and-pricing) on the same page).
- **Budget is fixed** — you accept more review/fix rounds or human steering instead of frontier spend.
- **Output tokens are small** — chatty models burn output pricing; docs-mode jobs with tight prompts help.

**Composer 2.5 (Fast)** trades higher per-token rates ([$3/M input, $15/M output](https://cursor.com/docs/models-and-pricing)) for latency; use when **wall-clock** matters more than token minimization, not as the default cost setting.

---

## Local agents vs cloud agents

### Local (PR Genie local runner + Cursor CLI)

**What it is:** The [PR Genie local runner](../../local-runner/README.md) orchestrates implement → PR → review → fix on **localhost**, default driver **`cursor-agent`**, default model **`composer-2.5`** (`PRGENIE_RUNNER_MODEL`). Worktrees live under `~/.cursor/worktrees/…`; the agent uses the workstation’s git, shell, and configured MCP (runner token, Resend, etc.).

**Cost:** Same Cursor plan usage as Agent in the editor/CLI at the selected model’s rate ([Cloud Agent pricing FAQ](https://cursor.com/help/ai-features/cloud-agents) states cloud uses the same plan usage as editor/CLI). No separate “cloud VM fee” line item in public docs—cost is model/token usage plus your machine’s time.

**Speed:** Depends on local CPU/network and repo size; **stream-json** logging gives live steps. No clone/setup of a remote environment unless the job needs it.

**Limits:** Laptop must be on and runner reachable; parallel jobs compete for local resources; environment drift is “whatever is on Brett’s box.” Plus tier on current plans **does not include Cloud Agents** ([Models & Pricing — Plus bullet](https://cursor.com/docs/models-and-pricing)).

**Privacy / control:** Code and secrets stay on the workstation (subject to Cursor’s own data policies for API calls). Good for proprietary repos, local-only tokens, and debugging agent behavior interactively ([CLI overview](https://cursor.com/docs/cli/overview)).

**When to pick local:** Docs-mode dogfood, plugin/runner development, jobs that only need git + markdown checks, sensitive code paths, or when you want direct control over `--force`, worktrees, and MCP.

### Cloud (Cursor Cloud Agents)

**What it is:** Agents run in **isolated cloud VMs** with cloned repos, configured dependencies, secrets, and optional browser/desktop control ([Cloud Agents docs](https://cursor.com/docs/cloud-agent)). CLI can hand off mid-session with `&` prefix ([Using Agent in CLI](https://cursor.com/docs/cli/using)). Cloud agents can open PRs and run verification in their environment.

**Cost:** Billed like other Agent usage at the **chosen model rate**; legacy request-based plans have Max Mode nuances ([help — How is Cloud Agent usage priced?](https://cursor.com/help/ai-features/cloud-agents)). Larger context windows can increase token use (same help page).

**Speed:** Parallel agents without tying up the laptop; setup time depends on environment quality (“environment setup is the most important step,” per [Cloud Agents](https://cursor.com/docs/cloud-agent)).

**Limits:** Requires Premium+ on current individual plans for Cloud Agents feature access; needs VCS read/write; multi-repo setups need explicit configuration. Not a substitute for a misconfigured local runner token or missing secrets.

**Privacy / control:** Repo content runs in Cursor’s cloud VM; align with org policy, Privacy Mode, and enterprise retention rules (see model-specific notes for third-party retention on the pricing page).

**When to pick cloud:** Long-running tasks, parallel sweeps, full build/test in a standardized image, browser verification, or when the local machine should stay offline. PR Genie **cloud** workflows (outside this local runner) fit orgs that already standardized cloud agent environments.

### Comparison snapshot

| Dimension                   | Local (`cursor-agent` + local runner)           | Cloud Agents                                   |
| --------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| **Billing**                 | Plan pool + model per-token rates               | Same model/plan usage model (public docs)      |
| **Hardware**                | Your workstation                                | Remote VM                                      |
| **Parallelism**             | Limited by local resources                      | Many parallel agents supported                 |
| **Environment**             | Local toolchain                                 | Configured cloud dev env                       |
| **Best for PR Genie today** | Default dogfood path, docs/code on known runner | Heavy integration tests, parallel issue sweeps |

---

## Practical decision guide

Use this alongside PR Genie job type (code vs docs), review bar, and `maxRounds`.

### Tier 0 — `composer-2.5` (default local runner)

**Use for:** Docs-mode Markdown PRs, README/architecture notes, small targeted edits, well-specified Linear tickets, implementor prompts with clear acceptance criteria.

**Why:** Lowest first-party list rates in Cursor’s table and PR Genie’s operational default ([local runner](../../local-runner/README.md), [Composer 2 announcement](https://cursor.com/blog/composer-2)).

**Tips:** Keep prompts scoped; point at files; avoid dumping entire logs into the thread; prefer docs-only paths under `docs/` for research jobs.

### Tier 1 — `composer-2.5` (Fast) or faster variants

**Use for:** Time-critical fixes when latency dominates cost; interactive CLI sessions where waiting blocks you.

**Caution:** Fast pricing is materially higher per token ([Models & Pricing — Composer 2.5 (Fast)](https://cursor.com/docs/models-and-pricing)).

### Tier 2 — Stronger first-party models (e.g. Grok 4.7)

**Use for:** Hard reasoning, large-context single passes (mind long-context multipliers on Grok 4.7 per pricing notes), or when Composer repeatedly fails review.

**Cost:** Higher list rates than Composer 2.5 on the same page—justify with fewer rounds.

### Tier 3 — Third-party frontier (Claude Opus/Sonnet, GPT-5.x, etc.)

**Use for:** Architecture decisions, subtle concurrency/security bugs, large refactors, or when Cursor Router “Intelligence” routes there on Teams.

**Cost:** API list prices on the [third-party table](https://cursor.com/docs/models-and-pricing); Teams pay Token Rate on eligible routes. Requires Premium+ and prepaid credit for individuals.

**Privacy:** Check per-model retention and US residency columns before sending sensitive code.

### Tier 4 — Plan / Ask modes before Agent

**Use for:** Ambiguous tickets—**Plan** or **Ask** in CLI ([CLI modes](https://cursor.com/docs/cli/overview)) to reduce wasted implement tokens. PR Genie implementor still runs Agent mode for merges; human or steward can front-load planning in Cursor.

### Escalation triggers (operational)

Step up one tier when:

- Review returns the same class of defect twice.
- Job hits **stuck** or exhausts rounds without a mergeable PR.
- Agent spirals on tool output (repeated test failures, large stderr).
- Task spans multiple repos (consider **cloud** with multi-repo env vs local worktree limits).

Step down when:

- Jobs consistently one-shot with doc-check green.
- Work is repetitive and templated (changelog, research notes, fixture updates).

---

## Sources

Primary (Cursor):

1. [Models & Pricing](https://cursor.com/docs/models-and-pricing) — plan tiers, included usage pool, Composer 2.5 and third-party per-million-token rates, Plus vs Premium feature gates (Cloud Agents). Accessed 2026-11-05.
2. [Cursor Token Rate](https://cursor.com/help/models-and-usage/token-rate) — $0.25/M on eligible third-party usage for Teams/Enterprise; Composer/Grok exempt. Accessed 2026-11-05.
3. [Introducing Composer 2](https://cursor.com/blog/composer-2) — positioning of Composer family on intelligence vs cost; published Composer 2 list rates (superseded in detail by docs table for Composer 2.5). Accessed 2026-11-05.
4. [Cursor CLI overview](https://cursor.com/docs/cli/overview) — local CLI agent modes, non-interactive `-p`, cloud handoff with `&`. Accessed 2026-11-05.
5. [Using Agent in CLI](https://cursor.com/docs/cli/using) — Plan/Ask/Agent modes, cloud handoff. Accessed 2026-11-05.
6. [Cloud Agents (docs)](https://cursor.com/docs/cloud-agent) — VM environments, parallelism, VCS requirements. Accessed 2026-11-05.
7. [Cloud Agents (help)](https://cursor.com/help/ai-features/cloud-agents) — pricing parity with editor/CLI usage, context window cost note. Accessed 2026-11-05.
8. [Cursor pricing page](https://cursor.com/pricing) — marketing/feature comparison companion to docs. Accessed 2026-11-05.

Repository context (this monorepo):

9. [PR Genie local runner README](../../local-runner/README.md) — `cursor-agent` invocation, default `composer-2.5`, worktree and MCP behavior.

**Not in sources:** PR Genie-specific token benchmarks, round-count statistics, or RadianceLux spend totals. Any future numbers should come from runner usage exports or Cursor dashboard data, not this note.
