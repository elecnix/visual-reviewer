# Visual Reviewer — Product Brief

**Working title:** AI Semantic Test Oracle for Playwright (codename: *Visual Reviewer*)
**Status:** Concept / MVP specification, ready for coding-agent handoff
**Source:** Synthesized from the full product-research conversation ("AI Semantic Test Oracle for Playwright — Product Brief"), including prior-art research, AI code-review architecture analysis, agentic context-assembly research, and the goals / constraints / non-goals summary.

---

## 1. Product Vision

Build an extensible, multimodal **AI semantic test oracle** that observes complete UI test executions and independently determines whether the software actually behaved according to the test's **intent** — not merely whether deterministic assertions passed.

Playwright is the **first adapter, not the product boundary**. The durable product is:

- an evidence/observation protocol,
- an evidence store and evidence graph,
- a context engine,
- a semantic oracle agent with a judge step,
- an adapter ecosystem (web, mobile, native desktop).

The killer scenario this product owns:

```
Playwright test:  GREEN  (7/7 assertions passed)
AI Oracle:        ❌ REGRESSION

Reason:
The assertions passed, but the intended user outcome did not occur.
The payment API returned an application-level failure and the UI shows
an error state. The existing assertions only verify that the plan and
price are visible.
```

Catching **"green test → actual bug"** is the novel, high-value behavior. "AI writes assertions" is not the product.

---

## 2. The Problem

Conventional UI tests verify explicit, deterministic conditions well — but a green test does not necessarily mean the intended user outcome occurred:

1. Assertions cover only a narrow slice of the intended behavior.
2. The UI can display contradictory or erroneous information while all assertions remain green.
3. Application-level failures hide behind successful HTTP responses or passing selectors (e.g., HTTP 200 with `{success:false}`).
4. Visual regressions can be semantically harmless, while subtle *semantic* regressions can be visually small.
5. Debugging failures requires manually correlating source, screenshots, DOM/UI trees, network traffic, logs, and test output.
6. Regression detection needs historical/baseline context, not only the current run.

The academic framing: **automated tests can execute correctly without possessing a sufficiently powerful oracle to determine whether the application behaved correctly.**

---

## 3. Core Insight

Treat a test execution as a **multimodal evidence bundle**, and let an AI judge that evidence against the test's intent and source code:

```
Test source + intent
        ↓
   Test execution
        ↓
 Evidence collection
        ↓
 Context assembly
        ↓
 Multimodal AI oracle
        ↓
 PASS / REGRESSION / UNCERTAIN
        ↓
 Evidence-backed report
```

Critically, **Playwright already captures almost the entire evidence bundle**: source code, action timeline, DOM snapshots, screenshots, network requests/responses, console messages, errors, test logs, browser metadata, assertion failures, before/after states. This makes the idea unusually hackable today — it is instrumentation-light.

---

## 4. Two Products Hiding in One Idea

| | A. AI Test Oracle | B. AI Regression Oracle |
|---|---|---|
| Question | "Given the test's intent and everything that happened during this execution, did the application behave correctly?" | "Did this run differ from the previous/baseline run in ways inconsistent with the change's intent?" |
| Compares | Execution vs. intent | Current run vs. baseline run |
| Catches | Green test → actual bug | UI changed in areas unrelated to the code change; workflow broken |
| Phase | MVP | Phase 2 |

The regression variant should be able to say *"the UI changed, but the change is consistent with the modified test intent"* versus *"the UI changed in an area unrelated to the code change and appears to have broken the user workflow."*

---

## 5. What the AI Should Receive (Evidence Inventory)

- Test source code, name, and description (**test description + test code become the specification**).
- Deterministic assertion definitions and actual assertion results.
- Screenshots and selected video frames.
- DOM snapshots and accessibility tree (web).
- Native UI hierarchy / accessibility hierarchy (native apps).
- Browser/application state: URL, route, selected values, enabled/disabled states, focus.
- Network events and relevant request/response bodies.
- Console output, warnings, exceptions, crashes, platform logs.
- User/test actions and timestamps (action timeline).
- Trace artifacts.
- Baseline / previous-run evidence when regression analysis is enabled.
- Relevant application source files when available.

---

## 6. Verdict Model

Three first-class outcomes — **UNCERTAIN is a valid result, never a failure to decide**:

- **PASS** — evidence supports the intended behavior; no material contradictory evidence found.
- **REGRESSION / FAIL** — evidence indicates the intended behavior was not achieved.
- **UNCERTAIN** — evidence insufficient or contradictory; request more evidence or flag for human review.

Every verdict must include:

- Confidence score (calibrated confidence band).
- Short explanation.
- Evidence references supporting the conclusion.
- Contradictory evidence, if any.
- Suggested next investigation step.
- Which deterministic assertions passed or failed.

### Report format (auditable, not magical)

```
TEST: User upgrades subscription

PLAYWRIGHT
✓ 7/7 assertions passed

AI VERDICT
⚠ REGRESSION — 87% confidence

WHY
✓ Pro plan displayed
✓ $29/month displayed
✗ POST /api/subscription returned application-level failure
✗ UI contains "Payment could not be completed"
✗ Screenshot differs from successful baseline

EVIDENCE
[ screenshot ] [ relevant DOM ] [ network request ] [ assertion ] [ baseline comparison ]

AI REASONING
...
```

Every conclusion links back to evidence.

---

## 7. Agentic Investigation (Not a One-Shot VLM Call)

The oracle must be able to ask for more evidence rather than deciding from the first screenshot:

1. Observe current evidence bundle.
2. Form a hypothesis about the test outcome.
3. Identify missing evidence.
4. Request additional evidence from the adapter.
5. Re-evaluate.
6. Return PASS / REGRESSION / UNCERTAIN with an evidence-backed explanation.

Example additional-evidence requests:

- Inspect a specific network response (`POST /api/orders`).
- Inspect the accessibility tree around a named element.
- Capture another screenshot after a short wait.
- Inspect console events around the relevant action.
- Compare a UI region against a baseline.
- Inspect application state exposed by the test environment.

This turns the loop around, GitHub-Copilot-style:

```
PLAYWRIGHT TEST → EXECUTION → OBSERVATIONS → SEMANTIC TEST AGENT → "Did this actually pass?"
```

Two modes result:

- **Passive mode:** judge existing runs ("Judge what happened").
- **Agentic mode:** investigate suspicious runs ("Something looks wrong — investigate").

---

## 8. Architecture

Organized around an **adapter-neutral evidence model**. The most important architectural principle: **images are not special** — a screenshot is simply another typed observation.

```
TEST ADAPTERS                (Playwright · Appium · XCTest · Espresso · Selenium …)
      ↓
OBSERVATION / EVIDENCE PROTOCOL
      ↓
EVIDENCE STORE               (UI/DOM · network · logs · screenshots · assertions · source)
      ↓
EVIDENCE GRAPH               (causal relationships between actions and observations)
      ↓
CONTEXT ENGINE               (retrieval · history · requirements · organization rules)
      ↓
ORACLE AGENT                 (dynamic investigation via evidence tools)
      ↓
JUDGE STEP                   (dedupe/conflict resolution → verdict)
      ↓
PASS / REGRESSION / UNCERTAIN
      ↓
EVIDENCE REPORT  →  HUMAN FEEDBACK  →  MEMORY
```

### The key architectural decision: give the agent tools, not a dump

Do **not** hand the model "17 screenshots, 82,000 DOM nodes, 4,000 network events." Give it a **tool interface to the evidence** and let it control context acquisition:

```other
get_test_source()          get_screenshot(step_id)     get_console_events(filter)
get_assertions()           get_ui_tree(step_id)         get_browser_state(step_id)
get_dom(step)              get_network_events(filter)   get_baseline(step_id)
compare_baseline(step)     get_application_state(...)
```

Prompt skeleton:

```other
SYSTEM
You are a semantic test oracle.
Test intent: ...
Test: ...
Deterministic result: 7/7 assertions passed.
Available evidence: 42 screenshots, DOM snapshots, accessibility trees,
137 network events, console events, browser state, baseline run.
Tools: inspect_screenshot(), inspect_ui_tree(), inspect_dom(),
inspect_network(), inspect_console(), inspect_state(), compare_baseline()
Determine whether the intended behavior actually occurred.
```

### Hybrid context philosophy

**Precompute a rich evidence substrate, then let an agent dynamically navigate it.** This mirrors the industry trajectory (e.g., Greptile v2 static flowchart → v3 agentic "detective"; GitHub Copilot's agentic context gathering):

1. **Layer 1 — Deterministic evidence generation** (cheap, reproducible): trace, screenshots, DOM, a11y tree, network, console, assertions, source.
2. **Layer 2 — Indexed evidence graph** (the equivalent of Greptile's code graph): relationships like `click("Upgrade") → screenshot #17 + DOM mutation #42 + POST /subscription + response 200 + console warning + assertion #5`.
3. **Layer 3 — Agent on top**: starts with only test intent, test source, assertion results, and a high-level run summary; investigates via tools.

The **evidence graph is our code graph** — the core architectural asset.

---

## 9. Pluggable Adapter Architecture

Pluggability is part of the architecture **from day one** — not bolted on after Playwright. No Playwright-specific concepts in the core oracle API.

Keep the adapter interface minimal, with declarative **capabilities** rather than forcing every adapter to implement everything:

```typescript
interface Adapter {
  capabilities: {
    screenshot: boolean;
    video: boolean;
    dom: boolean;
    accessibilityTree: boolean;
    network: boolean;
    console: boolean;
    nativeUiTree: boolean;
    sourceCode: boolean;
    assertions: boolean;
  };
}
```

Future adapters: Selenium/WebDriver, Appium, iOS XCTest/XCUITest, Android Espresso/UI Automator, desktop UI frameworks, future agent/browser adapters.

Separate **interaction** from **observation** for future extensibility:

```typescript
interface TestEnvironment {
  observe(): Promise<Evidence[]>;
  act(action: Action): Promise<void>;
}
```

Native UI is a strong fit: e.g., an iOS settings test where the "Marketing" switch *looks* disabled but the accessibility tree reports enabled and the settings API still returns `marketing=true` — exactly the class of bug conventional assertions miss. Long-term: **cross-platform verdicts** (same intent evaluated on web/iOS/Android; "Web and Android behave consistently, but iOS displays 'Pro' while the API still reports the old plan").

---

## 10. Evidence Model

One framework-agnostic protocol — never `PlaywrightEvidence`/`AppiumEvidence` subclasses:

```typescript
interface Evidence {
  id: string;
  timestamp: number;
  type: EvidenceType;
  source: string;
  content: unknown;
  metadata: Record<string, unknown>;
}

type EvidenceType =
  | "screenshot"
  | "video_frame"
  | "dom_snapshot"
  | "accessibility_tree"
  | "native_ui_tree"
  | "network_event"
  | "console_event"
  | "log_event"
  | "crash"
  | "assertion"
  | "test_source"
  | "browser_state"
  | "native_state"
  | "user_action";
```

A run is representable as a portable **EvidenceBundle**: run metadata, test source & intent, actions/timeline, assertions & results, screenshots/video frames, DOM/native UI snapshots, accessibility info, network events, console/logs/errors, runtime state, baseline references, artifact/trace locations.

---

## 11. Lessons From the AI Code-Review Market

The leading reviewers converge on **context engine + tools + specialized reasoning + judge + feedback loop**. The model itself is commoditized; the moat is orchestration.

| System | Borrow this |
|---|---|
| **GitHub Copilot Review** | Agent + tools + MCP + repository skills; agentic full-project context gathering |
| **CodeRabbit** | Hybrid deterministic (40+ analyzers) + AI architecture; knowledge base of team learnings |
| **Qodo 2** | Specialist agents each with dedicated context + judge agent; organizational Rule System |
| **Greptile** | Graph-based context retrieval; precomputed substrate + agentic investigation (v2→v3 lesson) |
| **Vercel OpenReview** | Simplest viable architecture: sandboxed agent + good tools; don't build elaborate indexing first |
| **Alibaba OpenCodeReview** | Explicit deterministic-pipeline + LLM-agent hybrid |
| **Mira** | Feedback/learning loop; noise filtering; confidence clamping |
| **calimero ai-code-reviewer** | Multi-agent consensus scoring; finding convergence across runs |
| **Martian Code Review Bench** | Rigorous open evaluation benchmark — we must have this from the start |

Our differentiator (a 7th axis beyond their six): **we can observe the software actually running** — code + specification + test + execution + UI + network + logs + history. Code reviewers reason over repo state; we reason over live behavior.

Multi-agent mapping (long-term, not MVP):

- **Visual agent:** notices error message visible.
- **Network agent:** `/api/payment` returned `402`.
- **Behavioral agent:** test intent says subscription should become active.
- **Judge agent:** resolves conflicts, dedupes, filters low-signal → **REGRESSION**.

Finding convergence: independent specialist verdicts across investigation rounds increase confidence when they agree.

---

## 12. Goals

### MVP functional goals

- Integrate with **Playwright** as the first adapter.
- Capture complete execution context: test code, assertions & results, screenshots, DOM, accessibility tree, browser state, network, console/errors, action timeline, trace.
- Give the model an understanding of the **test and its intent**.
- Produce an independent verdict: **PASS / REGRESSION / FAIL / UNCERTAIN**.
- Provide precise **evidence** justifying every verdict.
- Run in CI **without replacing deterministic assertions**.

### Architectural goals

- Designed as an **observation-and-reasoning platform**, not a Playwright plugin.
- Core depends on neither Playwright nor the DOM; adapters declare capabilities.
- Dynamic context: precomputed evidence substrate + agentic navigation.
- Model/provider choice behind an abstraction.

### Evolution goals (Phase 2+)

- Baseline / previous-run comparison (semantic, not pixel diffing).
- Agentic investigation; automatic evidence relevance ranking.
- Human feedback and learning loop.
- Multiple UI-framework adapters; cross-platform semantic tests.
- Semantic regression detection rather than purely visual.

---

## 13. Constraints

**Reliability** — never turn a probabilistic model into a blind authority:
- Every verdict justified; every claim traceable to evidence.
- UNCERTAIN is a valid outcome.
- Distinguish observation from interpretation; no hallucinated UI state.

**Cost / latency** — cannot ship "50 screenshots + 100k DOM nodes + 10k network requests" per call:
- Retrieval, summarization, filtering, progressive context, targeted multimodal calls.

**Compatibility** — core is framework-agnostic; adapters contribute what they can.

**Determinism first** — deterministic tools stay primary where appropriate (assertions, linters, a11y checks, network checks, console errors, visual diff). The AI contributes **semantic reasoning and correlation**, layered over existing signals.

**Evaluation** — a benchmark must measure false positives, false negatives, regression-detection rate, confidence calibration, cost, latency, and explanation quality.

---

## 14. Non-Goals (MVP)

The product does **not** initially aim to:

- Replace Playwright or classic assertions.
- Auto-generate entire test suites.
- Become an autonomous browsing/navigation agent.
- Do pixel-perfect visual regression testing.
- Support every framework up front.
- **Fail CI automatically based solely on an AI verdict** (advisory-only at first).
- Build its own foundation model.
- Auto-fix bugs.

The first product must simply excel at: **observing an existing test and detecting when its green assertions mask a real regression.**

---

## 15. Design Principles (Philosophy)

1. **Evidence over intuition.** Not "I think it's broken," but "REGRESSION — here are the three observations that demonstrate it."
2. **Multimodal, but not vision-only.** Code + assertions + UI + screenshots + network + logs + state + history.
3. **Agentic, but controlled.** The agent may request more information, only through system-defined tools and observations.
4. **Framework-agnostic.** The real product is *Evidence → Context → Reasoning → Verdict*, not *Playwright → VLM*.
5. Augment conventional assertions; don't replace them.
6. Retrieval over trace-dumping.
7. Human-auditable results are mandatory.
8. Uncertainty is a first-class result.
9. Design for evaluation from day one.

---

## 16. MVP Scope

Build the smallest end-to-end vertical slice:

1. Implement a **Playwright reporter/adapter**.
2. Capture test source, metadata, assertion results, and available trace artifacts.
3. Normalize screenshots, DOM/a11y snapshots, network events, console output, browser state into the Evidence model.
4. Build the **EvidenceBundle** representation.
5. Implement a **context builder** that selects relevant evidence (intent-first; prioritize failed assertions, warnings, errors, state transitions; retrieve screenshots around relevant actions; baselines only where comparison helps).
6. Implement a model-provider interface with one vision-capable provider.
7. Return structured **PASS / REGRESSION / UNCERTAIN** JSON (verdict, confidence, violated intent, supporting evidence, suspicious observations).
8. Generate a human-readable HTML/Markdown **Evidence Report**.
9. Keep the oracle **advisory** — do not fail CI automatically.
10. Persist enough data to support future baseline comparison.

### MVP acceptance criteria

- A normal green Playwright test can receive an independent semantic verdict.
- The oracle identifies a deliberately seeded bug that existing assertions miss.
- Every report cites concrete evidence.
- Screenshots and structured browser evidence are considered together.
- Graceful handling of missing evidence.
- The model never needs Playwright internals beyond adapter-provided evidence.
- A second adapter could be added without changing the oracle core.
- Runs locally and in CI.

### Explicitly out of scope for v1

See §14 Non-Goals. Additionally: multi-agent specialist fan-out (use **one capable agent + excellent evidence tools + deterministic signals + a judge step**; let evaluation data justify specialist agents later).

---

## 17. Roadmap

**Phase 2**
- Baseline / previous-run comparison (semantic screenshot, DOM/a11y structure, network behavior, logs).
- Distinguish intended changes from regressions; explain why a difference matters.
- Agentic evidence retrieval/investigation; relevance ranking.
- CI annotations; flakiness analysis; persistent run history.
- Human feedback on verdicts → evaluation dataset from accepted/rejected verdicts.

**Phase 3**
- Appium, XCTest/XCUITest, Espresso/UI Automator, native-desktop adapters.
- Cross-platform semantic consistency tests.
- Automatic investigation workflows; regression clustering.
- Learned project-specific expectations (org memory: test specs, known bugs, conventions, flaky behaviors).
- Multiple model providers + local VLM support.
- Optional autonomous reproduction/debugging.

---

## 18. Evaluation Strategy

Create a benchmark with deliberately seeded UI regressions and cases where deterministic tests pass despite incorrect behavior (inspired by Martian's Code Review Bench). Measure:

- True regression detection rate.
- False-positive rate / false-negative rate.
- Confidence calibration.
- Evidence-attribution accuracy.
- Cost per test run; latency; additional-evidence requests per run.
- Explanation quality; human acceptance rate of AI verdicts.

---

## 19. Prior Art / Inspiration

- **RippleGUItester** (2026 research) — multimodal GUI-change analysis vs. natural-language change intent to separate intended changes from regressions; closest to the regression-judge half.
- **LLM-as-test-oracle literature** — multimodal LLMs detecting non-crash functional bugs where conventional assertions struggle.
- **Trident** — VLM reasoning over GUI-state sequences to infer functional testing oracles.
- **WebTestPilot** — web test generation from NL specs with expected-behavior reasoning.
- **AugmenTest** — augmenting conventional tests with LLM reasoning/oracles.
- **Playwright Trace Viewer / tracing CLI** — already captures DOM snapshots, screenshots, network activity, console at every step (infrastructure enabler).
- **BrowserTrace** — LLM decision context added to browser traces (infrastructure analogue).
- **Test-Lab** — exposes full Playwright trace for AI test runs (debugging focus, not judging).
- **Stably / VLM visual-testing projects** — narrow "screenshot → VLM → looks right?" products.
- **GitHub Copilot Vision & browser tooling** — vision as one modality inside an agentic system; images as ordinary attachments; observe→reason→act loops.

**Honest novelty assessment:** none of the individual components is novel, and there is a substantial research ecosystem around AI test oracles and multimodal GUI testing — but no obvious existing implementation combines **Playwright test source + intent + assertion results + complete execution evidence + baselines → multimodal agentic judge → independent semantic verdict on green/red tests**.

Key design lessons imported from Copilot Vision: treat vision as a modality inside an agent, assemble context instead of shipping everything, let evidence types coexist in one reasoning context, keep model capabilities behind abstraction, iterate (observe → request context → re-evaluate), and present results as inspectable work/evidence rather than opaque chat output.

---

## 20. Open Questions

- Which VLM/LLM gives the best cost/accuracy trade-off for UI judgment?
- Send raw DOM/UI trees or summarize first?
- How should relevant screenshot regions be selected automatically?
- How should confidence be calibrated?
- How to prevent hallucinations about unobserved UI state?
- When should the oracle request additional evidence?
- How much historical context is useful?
- What evidence format should native-app adapters expose?
- Should the core protocol be open source?
- What is the minimum useful CI integration?

---

## 21. North Star

A developer writes a normal UI test describing what the user is supposed to accomplish. The system runs it, collects everything that happened, and independently answers one question:

> **"Did the software actually do what this test was intended to verify?"**

If the answer is no, the system shows exactly why — with the relevant code, assertion, screenshot, UI state, network behavior, logs, and historical evidence — without requiring the developer to manually reconstruct the failure.
