/**
 * Fugu Trinity (Thinker-Worker-Verifier) Multi-Agent Orchestrator.
 * Built-in workflow for parallel DAG task execution and automatic PR shipping.
 */

/**
 * Generate a fugu workflow that orchestrates specialized models using a
 * Directed Acyclic Graph (DAG) for parallel execution.
 */
export function generateFuguWorkflow(): string {
  return `export const meta = {
  name: 'fugu',
  description: 'Fugu Trinity (Thinker-Worker-Verifier) Multi-Agent Orchestrator with PR Auto-Ship',
  phases: [
    { title: 'Thinker' },
    { title: 'Worker' },
    { title: 'LocalChecks' },
    { title: 'Verifier' },
    { title: 'PR_Delivery' }
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
    feedback: { type: 'string', description: 'Explicit error log, linter findings, or bug details to feed back to the Worker if failed.' }
  }
}

// 2. ORCHESTRATION ENGINE
const TASK = args && typeof args === 'object' ? (args.task || args._raw || args._ || 'Implement a safe addition helper with tests.') : 'Implement a safe addition helper with tests.'
log('[Fugu] Initiating Fugu Trinity Orchestrator for task: "' + TASK + '"')

// --- Phase 1: Thinker ---
phase('Thinker')
log('[Fugu:Thinker] Spawning Thinker agent (big tier) to map out the execution plan...')

const plan = await agent(
  'Analyze the codebase and map out a step-by-step modification plan to complete this task:\\n' +
  'Task: "' + TASK + '"\\n\\n' +
  'Break the task down into a Directed Acyclic Graph (DAG) of sequential and parallelizable modifications.\\n' +
  'Guidelines for DAG mapping:\\n' +
  '1. Steps touching the SAME file MUST depend on each other sequentially (e.g. step-2 depends on step-1) to avoid Git merge conflicts.\\n' +
  '2. Steps touching DIFFERENT files with no logical dependencies should have EMPTY dependencies so they execute in parallel.\\n\\n' +
  'Structured output only. Do not perform any file edits yourself. Please think step-by-step.',
  {
    label: 'fugu-thinker',
    tier: 'big',
    schema: THINKER_SCHEMA
  }
)

if (!plan || !plan.steps || plan.steps.length === 0) {
  throw new Error('Thinker failed to produce a valid execution plan.')
}

log('[Fugu:Thinker] Plan created! Found ' + plan.steps.length + ' steps in the dependency graph.')

// --- Phase 2 & 3: Worker & Verifier Trinity DAG Loop ---
const executionState = {
  task: TASK,
  summary: plan.summary,
  completedSteps: [],
  logs: []
}

const completed = {}
const started = {}

while (Object.keys(completed).length < plan.steps.length) {
  // Find steps that are ready (all dependencies met, not started)
  const readySteps = plan.steps.filter(step => {
    if (started[step.id]) return false
    const deps = step.dependencies || []
    return deps.every(depId => completed[depId])
  })

  if (readySteps.length === 0) {
    throw new Error('Cyclic dependency or deadlock detected in Thinker plan.')
  }

  log('[Fugu:Orchestrator] Found ' + readySteps.length + ' ready step(s) to execute in parallel: ' + readySteps.map(s => s.id).join(', '))

  // Mark all ready steps as started
  for (const step of readySteps) {
    started[step.id] = true
  }

  // Execute ready steps concurrently using parallel()
  await parallel(readySteps.map(step => async () => {
    log('[Fugu:Orchestrator] Starting Parallel Step: [' + step.id + '] on ' + step.file)

    const result = await gate(
      async (previousFeedback, attempt) => {
        phase('Worker')
        let prompt = 'You are the Specialized Worker. Your sole task is to implement this specific step:\\n' +
          'Step ID: ' + step.id + '\\n' +
          'File: ' + step.file + '\\n' +
          'Instructions: ' + step.instructions + '\\n' +
          'Expected Output: ' + step.expectedOutput + '\\n\\n'

        if (previousFeedback) {
          prompt += '⚠️ PREVIOUS ATTEMPT FAILED verification! Correct your mistakes based on this feedback:\\n' +
                    'Feedback:\\n' + previousFeedback + '\\n\\n' +
                    'Attempt: #' + (attempt + 1) + '. Please fix the code and try again.'
        } else {
          prompt += 'Use your file edit tools (edit/write) to apply these changes directly to the codebase.'
        }

        log('[Fugu:Worker] Starting implementation of ' + step.file + ' (medium tier) (Attempt #' + (attempt + 1) + ')...')
        return await agent(prompt, {
          label: 'fugu-worker:' + step.id,
          tier: 'medium'
        })
      },

      async (workerResult) => {
        phase('LocalChecks')
        log('[Fugu:Verifier] Running compile & linter checks on ' + step.file + ' using small tier...')

        const localChecks = await agent(
          'Check if there are compile, type-check, or linter errors in the workspace, particularly in ' + step.file + '. Run appropriate bash commands if required to check for errors. Return a short log of results.',
          {
            label: 'fugu-checks:' + step.id,
            tier: 'small'
          }
        )

        phase('Verifier')
        log('[Fugu:Verifier] strict LLM verification of ' + step.file + ' using big tier...')
        const verification = await agent(
          'Review the changes made to ' + step.file + ' for correctness and completeness.\\n' +
          'Task requirements: ' + step.instructions + '\\n' +
          'Expected Output: ' + step.expectedOutput + '\\n\\n' +
          'Local check logs:\\n' + JSON.stringify(localChecks) + '\\n\\n' +
          'Inspect the file and perform a strict evaluation. Is the code robust, correct, and matching the plan? Return passed=true or passed=false with helpful feedback.',
          {
            label: 'fugu-verifier:' + step.id,
            tier: 'big',
            schema: VERIFIER_SCHEMA
          }
        )

        if (verification && verification.passed) {
          log('[Fugu:Verifier] Step ' + step.id + ' PASSED verification!')
          return { ok: true }
        } else {
          const errorFeedback = verification ? verification.feedback : 'Verification failed without specific logs.'
          log('[Fugu:Verifier] Step ' + step.id + ' FAILED verification! Feedback: ' + errorFeedback)
          return { ok: false, feedback: errorFeedback }
        }
      },
      { attempts: 3 }
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
      'Write the following JSON to the transient file .fugu/status.json (create the folder if it doesn\\'t exist). Do not output extra prose:\\n' +
      'JSON:\\n' + JSON.stringify(executionState, null, 2),
      {
        label: 'fugu-write-state',
        tier: 'small'
      }
    )
  }))
}

log('[Fugu] 🎉 All steps executed and verified successfully!')

// --- Phase 4: PR Delivery ---
phase('PR_Delivery')
log('[Fugu:PR_Delivery] Initiating automatic Git branch push and Pull Request creation...')

const prResult = await agent(
  'You are the Fugu Delivery Agent. All file modifications and verification checks are 100% green and successful!\\n' +
  'Your task is to create a new Git branch, commit the changed files, push the branch to GitHub, and create a draft Pull Request.\\n\\n' +
  'Details of completed work:\\n' +
  'Task: "' + TASK + '"\\n' +
  'Summary of changes: ' + executionState.summary + '\\n' +
  'Modified Files:\\n' + executionState.completedSteps.map(s => '- ' + s.file).join('\\n') + '\\n\\n' +
  'Please use your bash tool to run the necessary git and gh command steps to construct a neat draft Pull Request. Try to parse an issue number out of the task text if present (e.g., #2) so you can close it (using \\'Closes #N\\' in the PR body). Double check that the branch name is safe (e.g. fugu/auto-pr-<timestamp>) and commit message is clear. Return a summary of the created PR URL.',
  {
    label: 'fugu-pr-delivery',
    tier: 'small'
  }
)

log('[Fugu] Pull Request creation complete! Result:\\n' + prResult)

return {
  success: true,
  summary: executionState.summary,
  stepsCompleted: executionState.completedSteps,
  pr: prResult
}`;
}
