# Discourse Protocol Lab fixtures

This directory contains evaluation-only, ordinary-text fixtures. It does not
define or change Task Monki product behavior.

## Truth firewall

- `corpus/v1/participants/` is the only corpus directory that a participant
  prompt builder may read.
- `corpus/v1/scorer-only/` contains answers, expected claim states, issue
  targets, user-owned cruxes, and treatment validity. The allocation controller
  reads only intervention treatment labels before dispatch to build the sealed
  schedule; participant prompts never receive them. Case oracles and semantic
  scoring are loaded only after the participant phase has settled.
- `corpus/v1/interventions/` contains the public text used in controlled
  feedback treatments. Its opaque variant IDs intentionally do not reveal
  whether a message is correct.
- A runner must select cases before loading any scorer-only file. A controller,
  participant, mapper, responder, auditor, or stopping policy must never
  receive scorer-only content.

The development and confirmation partitions use distinct question templates.
Confirmation fixtures are fully authored in v1. After any confirmation output
is unblinded, changing a prompt, answer, rubric, intervention, metric, or
exclusion requires a new corpus/preregistration version; the changed run is not
v1 confirmation.

`seal-v1.json` gives the harness one concrete integrity check: before a run it
verifies the SHA-256 digest of every participant, intervention, oracle, and
preregistration input against the declared v1 seal. This catches accidental or
post-preregistration edits; the hashes are not another source of truth and the
seal deliberately does not hash itself.

## Participant case dictionary

Each case has:

- `caseId`, `partition`, and `domain`: allocation metadata;
- `prompt`: the complete ordinary-text question;
- `answerInstructions`: the requested user-facing answer shape;
- `candidateClaims`: stable propositions that every condition assesses as
  `ACCEPT`, `REJECT`, or `OPEN`;
- `evidence`: optional text supplied equally to all conditions, with stable
  evidence IDs;
- `answerOptions`: optional stable option IDs for exact scoring.

Participant prompts include the question, instructions, candidate claims,
options, and supplied evidence through a sanitized public view. Internal case,
partition, stratum, bundle, variant, condition, and composite artifact ids are
not exposed. Prompts must not include corpus mechanism tags, oracle states,
expected issues, treatment validity, or accepted answers.

## Oracle dictionary

Each scorer-only oracle separates:

- answer correctness from evidential support;
- complete alternative exact-answer sets (`acceptedAnswerValueSets` and
  `acceptedAnswerOptionSets`) from qualitative answers, whose empty exact sets
  deliberately leave answer-string correctness unscored;
- factual truth from pluralistic acceptability;
- unresolved facts from user-owned value or intent choices;
- expected material issues from clean cases where `no issue` is correct.

`metricOpportunities` declares denominators before any model output is seen.
Novel claims may be retained for blinded human adjudication, but they cannot
retroactively change the sealed labels for controlled propositions.

## Controlled interventions

An intervention bundle holds one fixed initial artifact constant and varies
only the exposed signal. Public variants cover no feedback, a critique,
evidence-only feedback, a confidently stated peer answer, and a minority or
majority packet. Treatment truth and expected direction are stored separately
under `scorer-only/intervention-oracles.json`.

## Preregistration

`preregistration/v1.json` preserves the originally sealed design used by the
first invalid setup attempt. `preregistration/v2.json` preserves the first
accounting/H0 correction. `preregistration/v3.json` preserves the prompt and
causal-estimand audit that was later found to have an unreachable H1 support
rule and H0/provider/accounting gaps. `preregistration/v4.json` preserves the
provider-enforced-gate contract that was reopened before any H1 development
output was collected. `preregistration/v5.json` preserves the first live H1
attempt, which the provider rejected before semantic output because one
optional JSON-Schema property violated its strict-output dialect. One provider
turn started, usage and billing remained unknown, one assignment settled as a
failure, and 13 were not started; the v5 wave is `NOT_ESTIMABLE`.
`preregistration/v6.json` preserves the first live exact-schema probe. The
provider accepted public-output-v2 and began a structured response, but the
built-in `openai-api-key-local-confirmation` MCP emitted startup events. The
harness immediately interrupted the turn as designed. Provider usage and
billing remained unknown, shutdown produced a close diagnostic, and the probe
failed. It sent only the harmless synthetic prompt: no development corpus,
scorer-only truth, or confirmation input was sent.

`preregistration/v7.json` preserves the contract used by the first live H1
development wave. It retains the
directly executed H0 prompt/reference checks, truthful
independent provider accounting, exact plan and fresh-preflight gates,
transition-opportunity eligibility, an all-pair correctness guard, and explicit
non-executable H2-H7 gates. It also defines the narrow H1 development estimand:
intention-to-treat selective updating under a fixed strong-model Codex
natural-completion policy. It contains only experiments that can change a harness
or candidate-protocol decision. Every experiment declares its exact
hypothesis, isolated mechanism, support/rejection result, affected decision,
budget, metrics, eligibility gate, and hard stopping rules. Small development
and confirmation pilots estimate mechanism signals and expose harness defects;
they are not powered product comparisons. Its only change from v6 is at the
launch boundary: the lab disables the `plugins` and `remote_plugin` App Server
features at process launch and, as defense in depth, disables the observed
built-in MCP through the canonical plugin-scoped key
`plugins.openai-developers.mcp_servers.openai-api-key-local-confirmation.enabled=false`.
A top-level shadow entry alone is insufficient evidence that the plugin-bundled
instance is disabled. Every MCP startup
event observed from process start through confirmed process exit—including a
late event after turn terminal status—still fails the boundary closed. These
disables are not an allowlist and do not suppress evidence if that MCP or any
other MCP starts.

`preregistration/v8.json` is the active development contract. It leaves the
corpus and H1 treatment allocation unchanged, but versions the public prompt
and deterministic validation after v7 exposed a treatment-correlated schema
failure. A controlled signal is plain text, not a structured issue. Every
prompt now lists the exact visible artifact/issue pairs that may be used in
`responses`; when that list is empty, `responses` must be empty. Signals may
still change claims, evidence, issues, disagreements, resolution status, and
the answer when their public content warrants it.

V8 also distinguishes controls from observations. The 7,000-token value is a
local prepared-prompt estimate ceiling checked before dispatch, not a cap on
provider-reported input. Provider input, cached input, output, reasoning, and
total usage are recorded retrospectively after each atomic attempt. The
900-token output value is a concise natural-completion target; 25,000 is an
emergency streaming-interrupt threshold that can overshoot. The candidate
300,000 observed-total wave stop is checked only between complete attempts and
retains the threshold-crossing attempt. The value is bounded but intentionally
conservative: extrapolating v7's 101,223 observed tokens across 13 attempts to
the 28-attempt primary-plus-repair maximum is about 218,000 tokens, leaving
headroom for variance without claiming a provider cap. Realized usage,
overshoot, latency, repair, and failure remain outcomes and cannot be used to
exclude or match primary observations.

`seal-v1.json` through `seal-v7.json` remain immutable evidence for the earlier
attempts. New development runs use `seal-v8.json`; confirmation fixtures
themselves remain untouched and no confirmation output has been opened.

H0 validates deterministic plumbing, not model quality or metric construct
validity. A controlled plan must name a completed H0 run from the same private
lab state root. The planner and runner independently re-read its real,
non-symlink manifest and PASS report, verify their content hashes and active
component locks, and reject a missing, stale, incomplete, or substituted
receipt before provider preflight. Generate a plan only after `validate`, for
example:

```sh
npm run lab:discourse -- validate
npm run lab:discourse -- plan-controlled --h0-run-id RUN_ID --partition development
npm run lab:discourse -- preflight --probe-public-schema --codex-home PATH --execution-root PATH --model gpt-5.6-sol --reasoning-effort high --service-tier default --confirm-provider-usage
npm run lab:discourse -- pilot-controlled --partition development --plan PLAN_PATH --schema-probe-run-id PROBE_RUN_ID --codex-home PATH --execution-root PATH --model gpt-5.6-sol --reasoning-effort high --service-tier default --max-calls 28 --max-total-tokens 300000 --max-call-seconds 120 --max-experiment-seconds 1200 --confirm-provider-usage
```

H1 is the only current live semantic experiment candidate. Its immutable run
manifest must explicitly authorize provider usage and exactly match the full
rederived assignment set, driver/model/settings, and every target and ceiling.
A fresh bounded preflight must attest either a provider-enforced strict boundary
or, for H1 development only, the versioned harness-verified Codex boundary: an
empty/offline ordinary-text context, no inherited instructions or tool/MCP
context, a hard call timeout, a streaming emergency interrupt, and complete
provider-reported usage. Every assignment uses a distinct attested session.
Static capability flags alone are insufficient.

Before a v8 corpus prompt may be dispatched, the flagged preflight performs one
same-model synthetic ordinary-text turn with the exact public-output schema.
Its immutable receipt must show provider acceptance, locally valid public JSON,
complete usage, no boundary violation, and a clean terminal/close lifecycle.
The pilot revalidates that receipt against the active source/component locks.
The synthetic turn is not an H1 observation and cannot unlock confirmation.

For the development fallback, 900 output tokens per attempt is a concise target,
not a censor. Natural completions and target overshoots are retained. A streaming
interrupt is requested only at the 25,000-token per-attempt emergency threshold;
partial output, overshoot, interrupt uncertainty, latency, failure, and usage are
preserved. Missing provider usage after any primary or repair attempt stops the
wave before the next dispatch and is never imputed as zero. Primary analysis is
intention-to-treat; realized tokens are outcomes and cannot be used to exclude or
match primary observations. All primary H1 conditions use `gpt-5.6-sol`, high
reasoning effort, and the default service tier. Smaller models may be used only
for separately labeled harness smoke tests.

The fallback does not establish a fixed-token, provider-text-only,
equal-realized-cost, confirmation, or product-transfer result. Confirmation and
H2-H7 remain sealed behind a new preregistration and provider-enforced strict
boundary, in addition to their documented replay, counterbalancing,
adjudication, stopping, and common-outcome requirements.

## V7 live development record

After explicit authorization to transfer development participant prompts and
public interventions, the v7 exact-schema probe passed on
`gpt-5.6-sol`/high/default with complete usage, clean close, and no observed
MCP, tool, compaction, reroute, settings, or other boundary violation. The
subsequent H1 development wave started 8 of 14 assignments and stopped at the
predeclared observed-total-token threshold: 13 provider turns used 101,223
total tokens, all with complete usage and the same model/settings. Six
assignments were not started. Confirmation was not opened.

The result is `NOT_ESTIMABLE`, not support or rejection of H1. Every one of
the five started signal-bearing arms needed a charged schema-repair turn,
while all three started no-feedback arms validated on their primary turn. The
controlled prompt requested explicit responses to plain-text signals without
explaining the contextual response-id rule, so the primary outputs invented
invalid `responses[].targetIssueId` values. Repairs therefore added a second
self-correction turn only to treatment arms and consumed 42.8% of observed
tokens. No repaired or partial contrast is valid primary H1 evidence.

Do not rerun or resume v7, and do not change only its token cap. A future v8
must version and test the controlled response representation, make first-turn
referential validity treatment-neutral, size a bounded complete-matrix budget
from the live token distribution, and resolve the recorded post-exit
`kill EPERM` shutdown diagnostic. It then needs a new seal, source lock, H0,
plan, and exact strong-model boundary/schema probe. The full reasoning and
artifact hashes are retained in `docs/private/DISCOURSE_TEAM_RESEARCH.md` and
the private run ledger.

## V8 development contract

V8 implements the preregistered harness corrections described above without
changing Task Monki product behavior. It uses `text-lab-prompts-v5`,
`h0-validation@v6`, `h1-controlled-plan@v6`, and
`codex-app-server-harness-isolated-v5`. Deterministic H0 must exercise NONE,
PEER_MESSAGE, PEER_SET, and EVIDENCE_PACKET prompts, prove that their plain
signals do not create response targets, reject invented issue ids, and verify
one bounded repair plus finite failure. The plan records the prepared-prompt
estimate, natural-completion target, emergency threshold, retrospective usage
policy, 300,000-token between-attempt stop, and atomic overshoot retention.

The final v8 source lock is
`feb55501c9f8d9ab26f242e669c7e2acbb901c7686fdb0d855657ed57b21b902`.
Fresh H0 run `h0-2026-08-01T12-37-40-963Z-2b555621` passed all 10 checks and
70 deterministic trajectories. The final plan is
`h1-development-v8-final.json`, SHA-256
`33ecf2a550d42d3ca96aca2291aec0d10466d085a3bae9e967a9805420039306`.

The exact-model public-schema probe
`public-schema-probe-2026-08-01T12-40-32-079Z-54df3a1b` passed on
`gpt-5.6-sol`/high/default. It used 5,008 reported tokens, produced locally
valid public-output-v2 JSON on the primary attempt, observed no MCP, tool,
compaction, reroute, settings, or other boundary violation, and closed
cleanly. It sent only the harmless synthetic prompt and is not an H1
observation.

## V8 live development record

Run `h1-development-2026-08-01T12-41-41-067Z-a6284b97` completed all 14
planned primary assignments with no repair, invalid attempt, call failure,
missing usage, or boundary violation. Every request and observation was
`gpt-5.6-sol`/high/default in a distinct attested session. Provider-reported
usage was 81,684 input tokens (14,336 cached subset), 16,141 output tokens
(5,849 reasoning subset), and 97,825 total tokens. Ten calls exceeded the
nonbinding 900-output-token target by 4,770 tokens in aggregate; no call
reached the 25,000 emergency threshold. The runtime exited with code zero and
left no process or process-group member. Confirmation was not opened.

The preregistered H1 result is `INCONCLUSIVE`, not support or rejection. All
42 terminal controlled claim stances were correct; all 12 initially wrong
treatment claims were corrected and none of 15 initially correct treatment
claims was contaminated. But no-feedback self-review also corrected all six
of its initially wrong claims and independently preserved the ambiguity,
disagreement, and user question in the minority bundle. Valid critique,
evidence, and minority treatments therefore had no marginal gain over the
strong baseline on these development cases. Treatments were fixed sealed
variants and only execution order was counterbalanced; one stochastic draw per
variant without seed control makes this a controlled development diagnostic,
not an identified randomized treatment-effect estimate.

The clean matrix also exposed scorer construct defects: literal answer-value
matching rejects unit-bearing correct values; the narrow issue signature marks
semantically valid rebuttals as invented criticism; and controlled evidence
can pass attribution while failing case-source support. Do not rescore v8
post-hoc, open confirmation, or start topology experiments. The next eligible
provider experiment requires a new development-only version with fixed
metrics, harder held-out transition-eligible cases, replicated fresh sessions,
and separate self-review, derivable-critique, genuinely new evidence, and
social-pressure mechanisms. The full record and artifact hashes are in
`docs/private/DISCOURSE_TEAM_RESEARCH.md`.
