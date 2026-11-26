/**
 * Hermes-style progressive tool disclosure for DeepSeek Harness.
 *
 * Core tools stay directly callable. Every other tool becomes *deferred*: it
 * leaves the model-facing declaration list but stays registered, so
 * `tool_search` finds it by keyword, `tool_inspect` shows its exact parameters,
 * and `tool_call` runs it through the shared guarded pipeline — pre-execute
 * policy, monotonic guards, execute wrappers, post-execute, and finalization —
 * exactly like a direct call.
 *
 * The narrowing happens in a per-agent tool executor's `describe()`, the seam
 * the shipped native and PTC executors use. It shrinks presentation only, so
 * registry lookup, scoped registrations, and conditional (step-gated) tools keep
 * resolving exactly as they otherwise would. A name restriction cannot do this:
 * it removes the tool from lookup and execution too, both of which `tool_call`
 * needs.
 *
 * @module dsh-progressive-tool
 */

import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'

/** Cordis plugin name. */
export const name = 'progressive-tool'

/** The tool registry and the prompt registry are hard dependencies. */
export const inject = ['tools', 'systemPrompt']

/** Tools this plugin registers itself: always directly callable. */
const OWN_TOOLS = Object.freeze(['tool_call', 'tool_inspect', 'tool_search'])

/** The PTC program transport. A step that presents it declares nothing else. */
const PROGRAM_TRANSPORT = 'run_code'

/** Default directly callable core set: what an agent needs without a lookup round trip. */
const DEFAULT_EXPOSE = Object.freeze([
  'apply_patch',
  'ask_user_question',
  'bash',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'glob',
  'grep',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'load_workspace_dependencies',
  // Never defer plugin management: it is the recovery path for this plugin and
  // for any bundle the user needs to disable.
  'plugin_manager',
  'present',
  'pwsh',
  'read',
  'read_image',
  'send_message',
  'skill',
  'subagent',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'wait_agent',
  // Web lookup is a routine step, not a long-tail capability.
  'web_fetch',
  'web_search',
  'workflow',
  'working_directory',
  'write',
])

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Compile one `*`-wildcard pattern into an anchored regular expression. */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Validate one glob-pattern array field. */
function stringArray(value, field) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new Error(`progressive-tool: "${field}" must be an array of non-empty glob patterns`)
  }
  return value
}

/** Validate one positive-integer field. */
function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`progressive-tool: "${field}" must be a positive integer`)
  }
  return value
}

/**
 * Resolve the configuration, failing loud instead of degrading silently.
 * @param config - the Loader row's configuration mapping, possibly absent.
 * @returns the frozen policy every registration reads.
 */
function resolvePolicy(config) {
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('progressive-tool: the config mapping must be an object')
  }
  const merged = config ?? {}
  const enabled = merged.enabled ?? true
  if (typeof enabled !== 'boolean') throw new Error('progressive-tool: "enabled" must be a boolean')
  return Object.freeze({
    enabled,
    expose: stringArray(merged.expose ?? DEFAULT_EXPOSE, 'expose').map(wildcardToRegExp),
    defer: stringArray(merged.defer ?? ['*'], 'defer').map(wildcardToRegExp),
    maxResults: positiveInteger(merged.maxResults ?? 8, 'maxResults'),
    summaryChars: positiveInteger(merged.summaryChars ?? 160, 'summaryChars'),
    maxCatalog: positiveInteger(merged.maxCatalog ?? 120, 'maxCatalog'),
  })
}

/** Whether one tool name matches any pattern of a compiled list. */
function matchesAny(patterns, toolName) {
  return patterns.some(pattern => pattern.test(toolName))
}

/**
 * Decide whether one tool stays directly callable.
 * @param policy - resolved configuration.
 * @param toolName - the registered tool name.
 * @returns whether the name is declared instead of deferred.
 */
function isDirectTool(policy, toolName) {
  if (!policy.enabled) return true
  if (OWN_TOOLS.includes(toolName)) return true
  if (matchesAny(policy.expose, toolName)) return true
  return !matchesAny(policy.defer, toolName)
}

/* -------------------------------------------------------------------------- */
/* catalog helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Trim one description to a single bounded line. */
function summarize(description, limit) {
  const flat = String(description ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** Split a query into lower-case word tokens. */
function tokensOf(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 0)
}

/** The names a parameter schema marks required. */
function requiredOf(parameters) {
  const required = parameters?.required
  return Array.isArray(required) ? required.filter(entry => typeof entry === 'string') : []
}

/**
 * Rank one catalog row against query tokens.
 * @returns a positive score, or 0 when a token appears nowhere.
 */
function rank(row, tokens) {
  const toolName = row.name.toLowerCase()
  const description = String(row.description ?? '').toLowerCase()
  let total = 0
  for (const token of tokens) {
    if (toolName === token) total += 12
    else if (toolName.startsWith(token)) total += 6
    else if (toolName.includes(token)) total += 4
    else if (description.includes(token)) total += 2
    else return 0
  }
  return total
}

/** A stable family label for one tool name. */
function groupOf(toolName) {
  if (toolName.startsWith('mcp__')) {
    const end = toolName.indexOf('__', 5)
    if (end > 5) return `mcp:${toolName.slice(5, end)}`
  }
  const separator = toolName.indexOf('_')
  return separator > 0 ? toolName.slice(0, separator) : 'other'
}

/** Project one definition onto its model-facing schema fields. */
function schemaOf(tool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

/* -------------------------------------------------------------------------- */
/* executor                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Per-agent executor: narrows `describe()` and delegates complete batches to the
 * shared scheduler, so policy, logging, cancellation, and settlement stay
 * identical to the deployment default.
 */
class ProgressiveExecutor {
  /**
   * @param ctx - the agent-scoped context that owns this executor.
   * @param direct - whether one tool name stays directly callable.
   */
  constructor(ctx, direct) {
    this.direct = direct
    // Deferred tools stay registered, so without this refusal a model that
    // guessed a name could call it directly and bypass the discovery path.
    // Nested dispatches are the ones `tool_call` performs.
    this.pipeline = new ToolExecutionPipeline(ctx, {
      // Resolve as the step sees it, then fall back to the agent's full view.
      // Passing `toolSet` keeps conditional registration admission intact, while
      // the fallback still reaches a tool that is merely absent from the step's
      // admitted set because `describe()` hid it.
      get: (toolName, scope, toolSet) => ctx.tools.get(toolName, scope, toolSet)
        ?? ctx.tools.get(toolName, scope),
      reject: (toolName, nested) => nested || direct(toolName)
        ? undefined
        : new Error(`tool "${toolName}" is deferred: find it with tool_search, read it with tool_inspect, then run it with tool_call`),
    })
  }

  /**
   * Describe the directly callable subset. A step presenting the PTC program
   * transport already hides every other definition behind `run_code`, and its
   * SDK section is not this executor's to reproduce, so that step is forwarded.
   * @param tools - visible capability definitions after scoped restrictions.
   * @returns model-facing schemas plus the full name set for order validation.
   */
  describe(tools) {
    const knownNames = tools.map(tool => tool.name)
    if (tools.some(tool => tool.name === PROGRAM_TRANSPORT)) {
      return { schemas: tools.map(schemaOf), knownNames }
    }
    return { schemas: tools.filter(tool => this.direct(tool.name)).map(schemaOf), knownNames }
  }

  /**
   * Execute one batch through the shared pipeline.
   * @param input - raw model calls, cancellation, agent, step admission, logging step.
   * @returns the settled batch.
   */
  execute(input) {
    return executeToolBatch(input, this.pipeline, () => input.maxParallelToolCalls ?? 10)
  }

  /**
   * Dispatch one nested call through the same pipeline a direct call uses.
   * @param exec - the enclosing `tool_call` execution.
   * @param target - the deferred tool to run.
   * @param args - that tool's parsed arguments.
   * @returns the settled outcome after policy and finalization.
   */
  async invoke(exec, target, args) {
    const prepared = await this.pipeline.prepare({
      callId: `${exec.callId}:nested`,
      name: target,
      arguments: args,
      signal: exec.signal,
      ...exec.agent === undefined ? {} : { agent: exec.agent },
      ...exec.toolSet === undefined ? {} : { toolSet: exec.toolSet },
      // Marks this as a nested dispatch, which the executor's refusal admits.
      // A fallback keeps the marker present even for an execution without a token.
      parent: exec.token ?? NESTED_PARENT,
    })
    const outcome = prepared.kind === 'dispatch' ? await this.pipeline.dispatch(prepared.exec) : prepared
    return this.pipeline.complete(prepared.exec, outcome)
  }
}

/** Parent marker for a nested dispatch whose enclosing execution carries no token. */
const NESTED_PARENT = Object.freeze({ nested: true })

/* -------------------------------------------------------------------------- */
/* tool definitions                                                           */
/* -------------------------------------------------------------------------- */

/** Render a string-valued canonical result. */
function renderText(_args, value) {
  return [{ type: 'text', text: String(value ?? '') }]
}

/**
 * Peel dispatch envelopes off a received request.
 *
 * A tool call may be delivered as `{ name: <invoked tool>, arguments: <the
 * model's arguments> }`. For these wrapper tools the envelope's own `name` and
 * the request's target field can collide, so the real request ends up nested
 * one or more levels down. Each level whose `arguments` describes another
 * request for this wrapper is peeled until the actual request appears.
 * @param args - the received arguments.
 * @returns the innermost request object.
 */
function unwrapRequest(args) {
  let request = args
  // A bound stops a malformed or hostile nesting from looping forever.
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof request?.name !== 'string' || !OWN_TOOLS.includes(request.name)) break
    const inner = request.arguments
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) break
    // The innermost level is an ordinary request object for this wrapper.
    request = inner
  }
  return request
}


/**
 * Build the three model-facing tools.
 * @param view - catalog, lookup, and dispatch access bound to this deployment.
 * @returns the three raw tool definitions.
 */
function createTools(view) {
  const searchTool = {
    name: 'tool_search',
    description:
      'Find a deferred tool by keyword. Deferred tools exist in this deployment and can be run, but they '
      + 'are not declared in this request, so a direct call to one fails. Search here, read the exact '
      + 'parameters with tool_inspect, then run it with tool_call. Omit the query to list the whole catalog.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords matched against tool names and descriptions. Omit to list the catalog.',
        },
        limit: { type: 'integer', description: 'Maximum results; defaults to the configured cap.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const request = unwrapRequest(args)
      const query = typeof request?.query === 'string' ? request.query.trim() : ''
      const rows = view.catalog(exec?.agent)
      if (query === '') {
        const groups = new Map()
        for (const row of rows) {
          const key = groupOf(row.name)
          const bucket = groups.get(key)
          if (bucket === undefined) groups.set(key, [row])
          else bucket.push(row)
        }
        const lines = []
        let shown = 0
        for (const key of [...groups.keys()].sort()) {
          if (shown >= view.policy.maxCatalog) break
          lines.push(`${key}:`)
          for (const row of groups.get(key)) {
            if (shown >= view.policy.maxCatalog) break
            shown += 1
            lines.push(`  ${row.name} — ${summarize(row.description, view.policy.summaryChars)}`)
          }
        }
        const omitted = rows.length - shown
        if (omitted > 0) lines.push(`  (+${omitted} more; narrow the catalog with a query)`)
        lines.push('', `${rows.length} deferred tools. Directly callable tools are already declared.`)
        return lines.join('\n')
      }
      const tokens = tokensOf(query)
      const limit = Number.isInteger(request?.limit) && request.limit > 0
        ? Math.min(request.limit, view.policy.maxResults)
        : view.policy.maxResults
      const hits = rows
        .map(row => ({ row, score: tokens.length === 0 ? 1 : rank(row, tokens) }))
        .filter(entry => entry.score > 0)
        .sort((left, right) => right.score - left.score
          || (left.row.name < right.row.name ? -1 : left.row.name > right.row.name ? 1 : 0))
        .slice(0, limit)
      if (hits.length === 0) {
        return `No deferred tool matched "${query}". ${rows.length} deferred tools exist; omit the query to list them.`
      }
      return [
        ...hits.map(entry => `${entry.row.name} — ${summarize(entry.row.description, view.policy.summaryChars)}`),
        '',
        'Use tool_inspect for exact parameters, then tool_call to run one.',
      ].join('\n')
    },
  }

  const inspectTool = {
    name: 'tool_inspect',
    description:
      'Show one tool\'s full description and exact parameter schema before calling it. Use this for a '
      + 'deferred tool found with tool_search.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact tool name.' } },
      required: ['name'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const request = unwrapRequest(args)
      const target = typeof request?.name === 'string' ? request.name.trim() : ''
      if (target === '') throw new Error('tool_inspect: "name" must be a non-empty string')
      const definition = view.definition(target, exec?.agent, exec?.toolSet)
      if (definition === undefined) {
        throw new Error(`tool_inspect: no tool named "${target}" is available to this step`)
      }
      const direct = isDirectTool(view.policy, target)
      return [
        `${target} — ${direct ? 'directly callable' : 'deferred; run it with tool_call'}`,
        '',
        String(definition.description ?? '').trim(),
        '',
        `Required parameters: ${requiredOf(definition.parameters).join(', ') || '(none)'}`,
        'Parameter schema:',
        JSON.stringify(definition.parameters ?? { type: 'object', properties: {} }, null, 2),
      ].join('\n')
    },
  }

  const callTool = {
    name: 'tool_call',
    description:
      'Run a tool by name with its own parameters. The call passes through the same permission, guard, '
      + 'and result policy as a direct call, and the tool\'s result content is returned unchanged. Use it '
      + 'for a deferred tool found with tool_search.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Exact name of the deferred tool to run.' },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description: 'The target tool\'s parameters, matching the schema tool_inspect prints.',
        },
      },
      required: ['tool'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { isError: { type: 'boolean' }, content: { type: 'array' } },
        required: ['isError', 'content'],
      },
      render(_args, value) {
        return Array.isArray(value?.content) ? value.content : [{ type: 'text', text: '' }]
      },
    },
    async execute(args, exec) {
      // Accept the envelope form as well as the flat one.
      const request = unwrapRequest(args)
      const raw = request?.tool ?? request?.name
      const target = typeof raw === 'string' ? raw.trim() : ''
      if (target === '') throw new Error('tool_call: "tool" must be the non-empty name of a deferred tool')
      if (OWN_TOOLS.includes(target)) {
        throw new Error(`tool_call: "${target}" is already directly callable; call it instead`)
      }
      if (view.definition(target, exec?.agent, exec?.toolSet) === undefined) {
        throw new Error(`tool_call: no tool named "${target}" is available to this step; find it with tool_search`)
      }
      const passed = request?.arguments
      if (passed !== undefined && (typeof passed !== 'object' || passed === null || Array.isArray(passed))) {
        throw new Error('tool_call: "arguments" must be a JSON object of the target tool\'s parameters')
      }
      const result = await view.dispatch(exec, target, passed ?? {})
      // Context the target deferred (a reminder, a notice) belongs to this step too.
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      return { isError: result.isError === true, content: result.content }
    },
  }

  return [searchTool, inspectTool, callTool]
}

/* -------------------------------------------------------------------------- */
/* plugin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Install progressive disclosure for agents in this deployment.
 * @param ctx - plugin context; every registration and executor is disposed with it.
 * @param config - optional Loader row configuration.
 */
export function apply(ctx, config) {
  const policy = resolvePolicy(config)

  /** Executors installed per agent, keyed by the agent object. */
  const executors = new WeakMap()

  /**
   * The deferred catalog for one agent. Narrowing happens only in `describe()`,
   * so the registry's own definitions still list every tool.
   */
  const catalogRows = (agent) => {
    const rows = []
    for (const definition of ctx.tools.definitions(agent)) {
      if (definition.name === PROGRAM_TRANSPORT) continue
      if (isDirectTool(policy, definition.name)) continue
      rows.push({ name: definition.name, description: definition.description })
    }
    return rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }

  /** Resolve one tool as the calling agent and step see it. */
  const definition = (toolName, agent, toolSet) => {
    if (toolSet !== undefined) {
      const admitted = toolSet.view(agent).get(toolName)
      if (admitted !== undefined) return admitted
    }
    return ctx.tools.get(toolName, agent)
  }

  /** The executor for one agent, falling back to a plugin-owned one. */
  const executorFor = (agent) => {
    const installed = agent === undefined ? undefined : executors.get(agent)
    return installed ?? root
  }

  const dispatch = (exec, target, args) => executorFor(exec?.agent).invoke(exec, target, args)
  const view = { policy, catalog: catalogRows, definition, dispatch }

  /** Fallback executor for a call outside any agent scope. */
  const root = new ProgressiveExecutor(ctx, toolName => isDirectTool(policy, toolName))

  for (const tool of createTools(view)) ctx.tools.register(tool)

  if (!policy.enabled) return

  ctx.systemPrompt.section({
    name: 'tools:progressive-disclosure',
    order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK') - 1,
    interpolate: false,
    text:
      'Some tools are deferred: they exist in this deployment and can be run, but they are not declared '
      + 'in this request, so a direct call to one fails. Use tool_search to find a deferred tool (omit the '
      + 'query for the whole catalog), tool_inspect for its exact parameters, and tool_call to run it. Core '
      + 'file, shell, job, planning, delegation, and workspace tools stay directly callable.',
  })

  /**
   * Install the narrowing executor in one agent's own scope, which is nearer than
   * any preset or deployment selection.
   * @param agent - the live agent to narrow.
   */
  const disposers = new Map()

  const install = (agent) => {
    if (executors.has(agent)) return
    const executor = new ProgressiveExecutor(agent.ctx, toolName => isDirectTool(policy, toolName))
    executors.set(agent, executor)
    disposers.set(agent, agent.ctx.tools.setExecutor(executor))
  }

  // `agent.ctx` owns these registrations, so agent disposal lifts them; keeping
  // the disposers here also lifts them when this plugin unloads.
  ctx.effect(() => () => {
    for (const dispose of disposers.values()) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.(`progressive-tool: executor cleanup failed (${String(error)})`)
      }
    }
    disposers.clear()
  }, 'progressive-tool: agent executors')

  ctx.on('agent/disposed', ({ agent }) => {
    disposers.delete(agent)
  })

  ctx.on('agent/created', ({ agent }) => {
    try {
      install(agent)
    } catch (error) {
      ctx.logger?.warn?.(`progressive-tool: could not narrow agent ${String(agent?.id)} (${String(error)})`)
    }
  })

  // Cover agents that already run when this plugin activates, such as after a reload.
  ctx.inject(['agents'], (scope) => {
    for (const agent of scope.get('agents').list()) {
      try {
        install(agent)
      } catch (error) {
        scope.logger?.warn?.(`progressive-tool: could not narrow agent ${String(agent?.id)} (${String(error)})`)
      }
    }
  })
}
