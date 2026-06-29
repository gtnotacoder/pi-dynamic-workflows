/**
 * Issue Delivery (Scout-Thinker-Worker-Verifier) multi-agent orchestrator.
 * Built-in workflow for parallel DAG task execution and automatic PR shipping.
 *
 * Fugu/Trinity are historical inspirations; operator-facing names should use
 * the project-neutral "Issue Delivery" vocabulary.
 */
export function generateIssueDeliveryWorkflow(): string {
  return `export const meta = {
  name: 'issue_delivery',
  description: 'Issue Delivery multi-agent orchestrator with PR auto-ship, host StageCheck, compacted feedback, and an ad-hoc prototype lane',
  phases: [
    { title: 'Scout' },
    { title: 'Thinker' },
    { title: 'Worker' },
    { title: 'LocalChecks' },
    { title: 'Verifier' },
    { title: 'Telemetry' }
  ],
}

// 1. SCHEMAS
const THINKER_SCHEMA = {
  type: 'object',
  required: ['summary', 'steps'],
  properties: {
    summary: { type: 'string', description: 'High-level summary of the architectural approach.' },
    steps: {
      type: 'array',
      description: 'List of isolated modifications, forming a Directed Acyclic Graph (DAG) of dependencies.',
      items: {
        type: 'object',
        required: ['id', 'file', 'instructions', 'expectedOutput'],
        properties: {
          id: { type: 'string', description: 'Unique step ID, e.g., \\'step-1\\'.' },
          file: { type: 'string', description: 'Target file path relative to project root.' },
          instructions: { type: 'string', description: 'Extremely focused, explicit instructions for the Worker. State what to edit/write.' },
          expectedOutput: { type: 'string', description: 'Concrete code signature or functionality added.' },
          dependencies: {
            type: 'array',
            description: 'Step IDs that MUST be completed and verified BEFORE this step can start. Touch the same file? Sequentially depend them to avoid git conflict. Touch different files? Keep dependencies empty so they run in parallel.',
            items: { type: 'string' }
          }
        }
      }
    }
  }
}

const VERIFIER_SCHEMA = {
  type: 'object',
  required: ['passed', 'feedback'],
  properties: {
    passed: { type: 'boolean', description: 'True if the modification met all criteria and is bug-free.' },
    feedback: { type: 'string', description: 'Explicit semantic bug details to feed back to the Worker if failed. Do not paste raw chronological logs.' }
  }
}

// 2. ORCHESTRATION ENGINE
const ARG_OBJECT = args && typeof args === 'object' ? args : {}
const TASK = ARG_OBJECT.task || ARG_OBJECT.issue || ARG_OBJECT.planPath || ARG_OBJECT._raw || ARG_OBJECT._ || 'Implement a safe addition helper with tests.'
const REPO_CONTEXT = typeof ARG_OBJECT.repo === 'string' && ARG_OBJECT.repo ? ARG_OBJECT.repo : ''
const ISSUE_CONTEXT = typeof ARG_OBJECT.issue === 'string' && ARG_OBJECT.issue ? ARG_OBJECT.issue : ''
const PLAN_CONTEXT = typeof ARG_OBJECT.planPath === 'string' && ARG_OBJECT.planPath ? ARG_OBJECT.planPath : ''
const TASK_CONTEXT = [
  TASK,
  ISSUE_CONTEXT && !String(TASK).includes(ISSUE_CONTEXT) ? 'Issue: ' + ISSUE_CONTEXT : '',
  PLAN_CONTEXT && !String(TASK).includes(PLAN_CONTEXT) ? 'Plan: ' + PLAN_CONTEXT : '',
  REPO_CONTEXT ? 'Repo: ' + REPO_CONTEXT : ''
].filter(Boolean).join(' ')
const FINALIZATION_BASE_REF = typeof ARG_OBJECT.baseRef === 'string' && ARG_OBJECT.baseRef ? ARG_OBJECT.baseRef : (typeof ARG_OBJECT.baseBranch === 'string' && ARG_OBJECT.baseBranch ? 'origin/' + ARG_OBJECT.baseBranch : 'origin/main')
const PROTOTYPE_READ_ONLY_TOOLS = [
  'read', 'grep', 'find', 'ls',
  'ctx_read', 'ctx_grep', 'ctx_find', 'ctx_ls',
  'ffgrep', 'fffind',
  'fastcontext_health', 'fastcontext_explore', 'fastcontext_explore_with_trace',
  'codegraph_search', 'codegraph_context', 'codegraph_files', 'codegraph_explore',
  'module_report', 'read_symbol',
  'lsp_navigation', 'lsp_diagnostics', 'lens_diagnostics',
  'ast_grep_search', 'ast_dump'
]

function optionBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === false) return value
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'prototype', 'minimal', 'quick'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

function optionInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function selectDependencyClosedSteps(steps, maxSteps) {
  if (!Number.isFinite(maxSteps) || maxSteps >= steps.length) return steps
  const allIds = new Set(steps.map(step => step.id))
  const selected = []
  const selectedIds = new Set()
  const remaining = steps.slice()
  while (selected.length < maxSteps && remaining.length > 0) {
    const readyIndex = remaining.findIndex(step => (step.dependencies || []).every(depId => selectedIds.has(depId) || !allIds.has(depId)))
    if (readyIndex < 0) break
    const step = remaining.splice(readyIndex, 1)[0]
    selected.push(step)
    selectedIds.add(step.id)
  }
  return selected
}

function renderPrototypeReport(input) {
  const lines = ['# Issue Delivery prototype report', '']
  lines.push('Task: ' + input.task)
  lines.push('Prototype: ' + input.prototype + ', dryRun: ' + input.dryRun)
  if (input.prototype && input.dryRun) lines.push('Stop condition: dry-run stopped before Worker edits, git push, and PR creation.')
  if (input.prototype && !input.dryRun) lines.push('Stop condition: prototype execution stopped before git push and PR creation.')
  lines.push('Safety: ' + (input.safety && input.safety.ok ? 'ok' : 'blocked') + ' — ' + (input.safety ? input.safety.reason : 'not checked'))
  if (input.safety && input.safety.nextAction) lines.push('Safety next action: ' + input.safety.nextAction)
  if (input.plan) {
    lines.push('Plan summary: ' + input.plan.summary)
    lines.push('Planned steps: ' + input.plan.steps.length + ', selected steps: ' + input.steps.length + ', omitted by maxSteps: ' + input.omittedSteps)
    for (const step of input.steps) lines.push('- ' + step.id + ': ' + step.file + ' — ' + step.instructions)
  }
  if (input.localChecks) lines.push('Local checks: ' + input.localChecks.summary)
  if (input.review) lines.push('Review: ' + String(input.review).slice(0, 1200))
  lines.push('Next action: ' + input.nextAction)
  return lines.join('\\n')
}

const RAW_PROTOTYPE = ARG_OBJECT.prototype || false
const DRY_RUN_REQUESTED = optionBool(ARG_OBJECT.dryRun, false)
const PROTOTYPE_LANE = optionBool(RAW_PROTOTYPE, false) || DRY_RUN_REQUESTED
const PROTOTYPE_DRY_RUN = PROTOTYPE_LANE ? optionBool(ARG_OBJECT.dryRun, true) : false
const MAX_STEPS = PROTOTYPE_LANE ? optionInt(ARG_OBJECT.maxSteps, 4, 1, 100) : Number.POSITIVE_INFINITY
const MAX_REPAIR_ROUNDS = optionInt(ARG_OBJECT.maxRepairRounds, PROTOTYPE_LANE ? 1 : 2, 0, 5)
const MAX_REVIEW_ROUNDS = optionInt(ARG_OBJECT.maxReviewRounds, PROTOTYPE_LANE ? 1 : 1, 1, 5)
const WORKTREE_REQUIRED = PROTOTYPE_LANE ? optionBool(ARG_OBJECT.worktreeRequired, true) : false
const ALLOW_SHARED_CHECKOUT = optionBool(ARG_OBJECT.allowSharedCheckout, false)
const ALLOW_DIRTY = optionBool(ARG_OBJECT.allowDirty, false)
const WORKER_ATTEMPTS = PROTOTYPE_LANE ? MAX_REPAIR_ROUNDS + 1 : 3
const VERIFIER_TIER = PROTOTYPE_LANE ? 'medium' : 'big'

log('[IssueDelivery] Initiating Issue Delivery orchestrator for task: "' + TASK_CONTEXT + '" (prototype=' + PROTOTYPE_LANE + ', dryRun=' + PROTOTYPE_DRY_RUN + ')')
setSemanticStatus({ status: 'workflow-running', reason: PROTOTYPE_LANE ? 'Issue Delivery prototype mode is checking safety and planning bounded work.' : 'Issue Delivery workflow is planning and applying changes.', nextAction: PROTOTYPE_LANE ? 'Wait for safety, plan, checks, and prototype report.' : 'Wait for scout/worker/verifier stages to finish.' })

let prototypeSafety = null
if (PROTOTYPE_LANE) {
  prototypeSafety = await prototypeSafetyCheck({ worktreeRequired: WORKTREE_REQUIRED, allowSharedCheckout: ALLOW_SHARED_CHECKOUT, requireClean: true, allowDirty: ALLOW_DIRTY })
  log('[IssueDelivery:Prototype] Safety check: ' + prototypeSafety.reason)
  if (!prototypeSafety.ok) {
    const blockedReport = renderPrototypeReport({ task: TASK_CONTEXT, prototype: true, dryRun: PROTOTYPE_DRY_RUN, safety: prototypeSafety, plan: null, steps: [], omittedSteps: 0, localChecks: null, review: null, nextAction: prototypeSafety.nextAction })
    setSemanticStatus({ status: 'needs-human', reason: prototypeSafety.reason, nextAction: prototypeSafety.nextAction, details: blockedReport })
    return { success: false, prototype: true, dryRun: PROTOTYPE_DRY_RUN, stoppedBy: 'prototype-safety', safety: prototypeSafety, report: blockedReport }
  }
}

// --- Phase 0: Scout firewall ---
phase('Scout')
log('[IssueDelivery:Scout] Spawning fastcontext-scout (small tier) to create a compact Code Map before Thinker planning...')

const codeMap = await agent(
  'Use FastContext and targeted reads to produce a compact Code Map for this task. Do not edit files. Return only relevant files, line ranges, exported APIs, tests, and caveats. Keep it under 1200 words.\\n' +
  'Task: "' + TASK_CONTEXT + '"',
  {
    label: 'issue-scout',
    tier: 'small',
    agentType: 'fastcontext-scout',
    tools: PROTOTYPE_DRY_RUN ? PROTOTYPE_READ_ONLY_TOOLS : undefined
  }
)

// --- Phase 1: Thinker ---
phase('Thinker')
log('[IssueDelivery:Thinker] Spawning Thinker agent (big tier) to map out the execution plan from compact Code Map...')

const plan = await agent(
  'Analyze the codebase and map out a step-by-step modification plan to complete this task:\\n' +
  'Task: "' + TASK_CONTEXT + '"\\n\\n' +
  'Compact Code Map from Scout (candidate citations; verify before relying on them):\\n' +
  JSON.stringify(codeMap).slice(0, 6000) + '\\n\\n' +
  'Break the task down into a Directed Acyclic Graph (DAG) of sequential and parallelizable modifications.\\n' +
  'Guidelines for DAG mapping:\\n' +
  '1. Steps touching the SAME file MUST depend on each other sequentially (e.g. step-2 depends on step-1) to avoid Git merge conflicts.\\n' +
  '2. Steps touching DIFFERENT files with no logical dependencies should have EMPTY dependencies so they execute in parallel.\\n' +
  '3. Keep each Worker step narrow enough for one focused edit pass.\\n\\n' +
  'Structured output only. Do not perform any file edits yourself. Please think step-by-step.',
  {
    label: 'issue-thinker',
    tier: 'big',
    schema: THINKER_SCHEMA,
    tools: PROTOTYPE_DRY_RUN ? PROTOTYPE_READ_ONLY_TOOLS : undefined
  }
)

if (!plan || !plan.steps || plan.steps.length === 0) {
  throw new Error('Thinker failed to produce a valid execution plan.')
}

const selectedSteps = PROTOTYPE_LANE ? selectDependencyClosedSteps(plan.steps, MAX_STEPS) : plan.steps
const omittedSteps = Math.max(0, plan.steps.length - selectedSteps.length)
log('[IssueDelivery:Thinker] Plan created! Found ' + plan.steps.length + ' steps in the dependency graph; selected ' + selectedSteps.length + ' step(s) for this run.')

if (PROTOTYPE_LANE && PROTOTYPE_DRY_RUN) {
  phase('LocalChecks')
  const prototypeChecks = await stageCheck({ includeDefaultChecks: true })
  phase('Verifier')
  const prototypeReview = await parallel(Array.from({ length: MAX_REVIEW_ROUNDS }, (_unused, index) => () => agent(
    'Review this dry-run Issue Delivery prototype plan. No edits have been made and no git/GitHub mutation is allowed. Assess whether the bounded plan is ready for a real delivery run.\\n' +
    'Task: ' + TASK_CONTEXT + '\\n' +
    'Plan summary: ' + plan.summary + '\\n' +
    'Selected steps: ' + JSON.stringify(selectedSteps).slice(0, 4000) + '\\n' +
    'Safety: ' + JSON.stringify(prototypeSafety).slice(0, 2000) + '\\n' +
    'Review round: ' + (index + 1) + ' of ' + MAX_REVIEW_ROUNDS + '\\n' +
    'Local checks: ' + prototypeChecks.summary,
    { label: 'prototype-review:' + (index + 1), tier: VERIFIER_TIER, tools: PROTOTYPE_READ_ONLY_TOOLS }
  )))
  const nextAction = prototypeChecks.ok ? 'Review the report, then rerun with dryRun=false in the same isolated worktree for safe edits.' : 'Fix local check failures before running prototype execution.'
  const report = renderPrototypeReport({ task: TASK_CONTEXT, prototype: true, dryRun: true, safety: prototypeSafety, plan, steps: selectedSteps, omittedSteps, localChecks: prototypeChecks, review: prototypeReview, nextAction })
  phase('Telemetry')
  setSemanticStatus({ status: prototypeChecks.ok ? 'workflow-complete-pane-open' : 'needs-human', reason: 'Dry-run prototype stopped before Worker edits, git push, and PR creation.', nextAction, details: report })
  return { success: prototypeChecks.ok, prototype: true, dryRun: true, stoppedBeforeMutation: true, summary: plan.summary, stepsPlanned: selectedSteps, omittedSteps, localChecks: prototypeChecks, review: prototypeReview, report }
}

// --- Phase 2 & 3: Worker & Verifier DAG Loop ---
const executionState = {
  task: TASK_CONTEXT,
  summary: plan.summary,
  completedSteps: [],
  logs: []
}

const completed = {}
const started = {}

while (Object.keys(completed).length < selectedSteps.length) {
  // Find steps that are ready (all dependencies met, not started)
  const readySteps = selectedSteps.filter(step => {
    if (started[step.id]) return false
    const deps = step.dependencies || []
    return deps.every(depId => completed[depId])
  })

  if (readySteps.length === 0) {
    throw new Error('Cyclic dependency or deadlock detected in Thinker plan.')
  }

  log('[IssueDelivery:Orchestrator] Found ' + readySteps.length + ' ready step(s) to execute in parallel: ' + readySteps.map(s => s.id).join(', '))

  // Mark all ready steps as started
  for (const step of readySteps) {
    started[step.id] = true
  }

  // Execute ready steps concurrently using parallel()
  await parallel(readySteps.map(step => async () => {
    log('[IssueDelivery:Orchestrator] Starting Parallel Step: [' + step.id + '] on ' + step.file)

    const feedbackRounds = []
    let lastDelta = null

    const result = await gate(
      async (previousFeedback, attempt) => {
        phase('Worker')
        const workerTier = attempt === 0 ? 'small' : (attempt === 1 ? 'medium' : 'big')
        let prompt = 'You are the Specialized Worker. Your sole task is to implement this specific step:\\n' +
          'Step ID: ' + step.id + '\\n' +
          'File: ' + step.file + '\\n' +
          'Instructions: ' + step.instructions + '\\n' +
          'Expected Output: ' + step.expectedOutput + '\\n\\n'

        if (previousFeedback) {
          prompt += '⚠️ PREVIOUS ATTEMPT FAILED. Correct your mistakes using this bounded Correction Delta only; do not chase old raw logs:\\n' +
                    previousFeedback + '\\n\\n' +
                    'Attempt: #' + (attempt + 1) + '. Please fix the code and try again. Treat constraints as hard rules.'
        } else {
          prompt += 'Use your file edit tools (edit/write) to apply these changes directly to the codebase.'
        }

        log('[IssueDelivery:Worker] Starting implementation of ' + step.file + ' (' + workerTier + ' tier) (Attempt #' + (attempt + 1) + ')...')
        return await agent(prompt, {
          label: 'issue-worker:' + step.id,
          tier: workerTier,
          agentType: 'specialized-worker'
        })
      },

      async (workerResult) => {
        const roundIndex = feedbackRounds.length + 1
        phase('LocalChecks')
        log('[IssueDelivery:LocalChecks] Running host-side stageCheck on ' + step.file + ' (zero LLM tokens)...')

        const localChecks = await stageCheck({ targetFile: step.file })
        if (!localChecks.ok) {
          const round = {
            index: roundIndex,
            verdict: 'fail',
            feedback: renderStageCheckFeedback(localChecks),
            localChecks
          }
          const delta = compactFeedback({
            rounds: feedbackRounds.concat([round]),
            previousDelta: lastDelta,
            maxTokens: 512,
            auditLogId: 'issue-delivery-' + step.id
          })
          feedbackRounds.push(round)
          lastDelta = delta
          const rendered = renderCorrectionDelta(delta)
          log('[IssueDelivery:LocalChecks] Step ' + step.id + ' failed host checks. Compacted correction delta size: ' + rendered.length + ' chars.')
          return { ok: false, feedback: rendered }
        }

        phase('Verifier')
        log('[IssueDelivery:Verifier] strict LLM verification of ' + step.file + ' using ' + VERIFIER_TIER + ' tier...')
        const verification = await agent(
          'Review the changes made to ' + step.file + ' for correctness and completeness.\\n' +
          'Task requirements: ' + step.instructions + '\\n' +
          'Expected Output: ' + step.expectedOutput + '\\n\\n' +
          'Host-side LocalChecks summary (mechanical checks already passed):\\n' +
          JSON.stringify({ summary: localChecks.summary, checks: localChecks.checks.map(c => ({ name: c.name, ok: c.ok, exitCode: c.exitCode, durationMs: c.durationMs })) }) + '\\n\\n' +
          'Inspect the file and perform a strict semantic evaluation. Is the code robust, correct, and matching the plan? Return passed=true or passed=false with concise, forward-looking feedback. Do not paste raw chronological logs.',
          {
            label: 'issue-verifier:' + step.id,
            tier: VERIFIER_TIER,
            schema: VERIFIER_SCHEMA
          }
        )

        if (verification && verification.passed) {
          log('[IssueDelivery:Verifier] Step ' + step.id + ' PASSED verification!')
          return { ok: true }
        }

        const errorFeedback = verification ? verification.feedback : 'Verification failed without specific logs.'
        const round = {
          index: roundIndex,
          verdict: 'fail',
          feedback: errorFeedback,
          findings: [{
            rule: 'verifier:semantic',
            severity: 'error',
            message: errorFeedback,
            status: 'open',
            blocking: true
          }],
          trace: 'workerResult=' + String(workerResult).slice(0, 1000)
        }
        const delta = compactFeedback({
          rounds: feedbackRounds.concat([round]),
          previousDelta: lastDelta,
          maxTokens: 512,
          auditLogId: 'issue-delivery-' + step.id
        })
        feedbackRounds.push(round)
        lastDelta = delta
        const rendered = renderCorrectionDelta(delta)
        log('[IssueDelivery:Verifier] Step ' + step.id + ' FAILED verification. Compacted correction delta size: ' + rendered.length + ' chars.')
        return { ok: false, feedback: rendered }
      },
      { attempts: WORKER_ATTEMPTS }
    )

    if (!result.ok) {
      throw new Error('Step ' + step.id + ' failed verification after ' + result.attempts + ' attempts. Aborting.')
    } 

    completed[step.id] = {
      id: step.id,
      file: step.file,
      attemptsNeeded: result.attempts
    }

    executionState.completedSteps.push({
      id: step.id,
      file: step.file,
      attemptsNeeded: result.attempts
    })

    // Write state utilizing our lightweight local check model to keep overhead very low
    await agent(
      'Write the following JSON to the transient file .issue-delivery/status.json (create the folder if it doesn\\'t exist). Do not output extra prose:\\n' +
      'JSON:\\n' + JSON.stringify(executionState, null, 2),
      {
        label: 'issue-state',
        tier: 'small'
      }
    )
  }))
}

log('[IssueDelivery] 🎉 All steps executed and verified successfully!')

if (PROTOTYPE_LANE) {
  phase('LocalChecks')
  const prototypeFinalChecks = await stageCheck({ includeDefaultChecks: true })
  phase('Verifier')
  const prototypeExecutionReview = await parallel(Array.from({ length: MAX_REVIEW_ROUNDS }, (_unused, index) => () => agent(
    'Review this prototype execution result. Edits/checks were allowed, but git push and PR creation are forbidden in prototype mode. Assess whether this is ready for normal Issue Delivery.\\n' +
    'Task: ' + TASK_CONTEXT + '\\n' +
    'Completed steps: ' + JSON.stringify(executionState.completedSteps) + '\\n' +
    'Review round: ' + (index + 1) + ' of ' + MAX_REVIEW_ROUNDS + '\\n' +
    'Final local checks: ' + prototypeFinalChecks.summary,
    { label: 'prototype-review:' + (index + 1), tier: VERIFIER_TIER, tools: PROTOTYPE_READ_ONLY_TOOLS }
  )))
  const nextAction = prototypeFinalChecks.ok ? 'Inspect the diff/report, then run normal /issue-delivery or manually promote the changes.' : 'Fix local check failures before promotion.'
  const report = renderPrototypeReport({ task: TASK_CONTEXT, prototype: true, dryRun: false, safety: prototypeSafety, plan, steps: selectedSteps, omittedSteps, localChecks: prototypeFinalChecks, review: prototypeExecutionReview, nextAction })
  phase('Telemetry')
  setSemanticStatus({ status: prototypeFinalChecks.ok ? 'workflow-complete-pane-open' : 'needs-human', reason: 'Prototype execution stopped before git push and PR creation.', nextAction, details: report })
  return { success: prototypeFinalChecks.ok, prototype: true, dryRun: false, stoppedBeforePr: true, summary: executionState.summary, stepsCompleted: executionState.completedSteps, omittedSteps, localChecks: prototypeFinalChecks, review: prototypeExecutionReview, report }
}

setSemanticStatus({ status: 'workflow-complete-pane-open', reason: 'All worker/verifier steps passed. Opening PR delivery pane.', nextAction: 'Creating branch, commit, and draft PR.' })

// --- PR Delivery (execution work remains in the canonical Worker phase) ---
phase('Worker')
log('[IssueDelivery:PR_Delivery] Initiating automatic Git branch push and Pull Request creation...')

const prResult = await agent(
  'You are the Issue Delivery Agent. All file modifications and verification checks are 100% green and successful!\\n' +
  'Your task is to create a new Git branch, commit ONLY the files listed in the Modified Files list below, push the branch to GitHub, and create a draft Pull Request.\\n\\n' +
  'Details of completed work:\\n' +
  'Task: "' + TASK_CONTEXT + '"\\n' +
  'Summary of changes: ' + executionState.summary + '\\n' +
  'Modified Files:\\n' + executionState.completedSteps.map(s => '- ' + s.file).join('\\n') + '\\n\\n' +
  'IMPORTANT: You must only stage and commit the files explicitly listed in the Modified Files list above. Do NOT stage any unlisted paths, including transient paths under .issue-delivery/, legacy .fugu/, or .fastcontext/. If there are any non-transient changed files that are NOT in the Modified Files list, stop and report them rather than committing them.\\n\\n' +
  'Please use your bash tool to run the necessary git and gh command steps to construct a neat draft Pull Request. Try to parse an issue number out of the task text if present (e.g., #2) so you can close it (using \\'Closes #N\\' in the PR body). Double check that the branch name is safe (e.g. issue-delivery/auto-pr-<timestamp>) and commit message is clear. Return a summary of the created PR URL.',
  {
    label: 'issue-pr-delivery',
    tier: 'small'
  }
)

log('[IssueDelivery] Pull Request creation complete! Result:\\n' + prResult)

// --- Finalization / Telemetry gate: verify clean-committed-pushed invariants ---
// Do not declare success if changes are dirty, uncommitted, or unpushed.
phase('Telemetry')
log('[IssueDelivery:finalization] Running finalization gate...')

setSemanticStatus({ status: 'finalizing', reason: 'Running deterministic finalization gate.', nextAction: 'Check clean-committed-pushed invariants.' })

const finalization = await checkFinalization(cwd, { baseRef: FINALIZATION_BASE_REF })

const finalizationStatus = finalization.toRunStatus || {
  status: finalization.status || 'unknown',
  reason: finalization.reason || 'Finalization gate completed.',
  nextAction: finalization.nextAction || 'Review details below.',
  details: finalization.details || ''
}

setSemanticStatus(finalizationStatus)
log('[IssueDelivery:finalization] Status: ' + finalizationStatus.status + ' — ' + finalizationStatus.reason)

return {
  success: finalizationStatus.status === 'completed' || finalizationStatus.status === 'finalizing',
  summary: executionState.summary,
  stepsCompleted: executionState.completedSteps,
  pr: prResult,
  finalization: finalization
}`;
}
