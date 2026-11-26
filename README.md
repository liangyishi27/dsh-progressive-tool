# dsh-progressive-tool

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/liangyishi27/dsh-progressive-tool)

Hermes-style progressive tool disclosure for DeepSeek Harness.

Core tools stay directly callable. Every other tool becomes **deferred**: it
leaves the model-facing declaration list but stays registered, so the model can
find it, read its exact parameters, and run it — on demand.

On a profile with roughly 90 declared tools, enabling this plugin cut the
per-request declaration list to about 31 tools (about 29 KB of JSON Schema
instead of about 65 KB). Deferred tools stay callable through `tool_call` and
keep the full permission and guard pipeline.

## Install

From npm (recommended — works in DSH's in-app Plugin Center):

```bash
dsh plugin --profile web add dsh-progressive-tool
```

Or from the GitHub source checkout:

```bash
dsh plugin --profile desktop add git+https://github.com/liangyishi27/dsh-progressive-tool.git
```

Restart DeepSeek Harness after installation. Supported profiles: `desktop` and
`web` (any profile with `@deepseek-ai/dsh-tools` 0.2.x). Requires Node 20+.

## What the model sees

Three extra tools are always directly callable:

| Tool | Purpose |
|---|---|
| `tool_search` | Find a deferred tool by keyword; omit the query for the whole catalog grouped by family. |
| `tool_inspect` | Show one tool's full description, required parameters, and exact JSON Schema. |
| `tool_call` | Run a deferred tool by name with its own parameters; returns the tool's content unchanged. |

`tool_call` takes `tool` (the target name) and `arguments` (that tool's own
parameters). It also accepts `name` for the target, and it accepts a request
that arrives wrapped around the wrapper itself (`{ name: 'tool_call',
arguments: { tool, arguments } }`), because some dispatchers record the invoked
tool's name beside its arguments.

Deferred tools are not declared in the request. A direct call to one fails with
a message pointing at `tool_search`; `tool_call` runs it through the same
pipeline a direct call uses: pre-execute policy, monotonic guards, `tools/execute`
wrappers, `tools/post-execute`, and finalization.

## How it works

The plugin installs a tool executor in each agent's own scope. Its `describe()`
declares only the directly callable subset and forwards every other schema
through `knownNames`, so prompt assembly keeps validating `toolOrder` against
the full set. Execution delegates to the shared batch scheduler, and a
`ToolExecutionPipeline` refusal makes a direct call to a deferred tool fail
loudly instead of silently working.

Because only presentation narrows, registry lookup, scoped registrations,
conditional (`when`) tools, and `tool_call`'s own nested dispatch all keep
resolving exactly as they otherwise would. A name restriction cannot do this: it
removes the tool from lookup and execution too, which is why `tool_call` needs
the executor seam.

## Configuration

The plugin takes an optional `config` mapping in `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-progressive-tool
      name: dsh-progressive-tool
      config:
        # Keep these directly callable (`*` wildcards allowed).
        expose: ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write']
        # Eligible for deferral; the default `['*']` defers everything not exposed.
        defer: ['*']
        # Search result and catalog bounds.
        maxResults: 8
        summaryChars: 160
        maxCatalog: 120
        # Set false to declare every tool directly and keep the three tools available.
        enabled: true
```

A bad value fails the plugin load rather than degrading the policy silently.

### Default exposed core

`apply_patch`, `ask_user_question`, `bash`, `create_goal`, `edit`,
`exit_plan_mode`, `get_goal`, `glob`, `grep`, `interrupt_agent`, `job_kill`,
`job_list`, `job_output`, `list_agents`, `load_workspace_dependencies`,
`plugin_manager`, `present`, `pwsh`, `read`, `read_image`, `send_message`,
`skill`, `subagent`, `subagent_fork`, `todo_write`, `update_goal`, `wait_agent`,
`web_fetch`, `web_search`, `workflow`, `working_directory`, `write`.

`plugin_manager` is deliberately in the core set: it is the recovery path for
disabling this or any other bundle, so it must never be deferred. Web lookup is
core as well because it is a routine step rather than a long-tail capability.

`tool_call` also accepts `tool` and `arguments` when the runtime delivers the
call wrapped as `{ name: 'tool_call', arguments: { … } }`; the wrapper peels
those envelopes so either shape resolves the same target.

## Known limits

- The per-request savings come from the declaration list only. A deferred tool's
  call and result still enter the conversation once it runs.
- Tool ordering configured through `system-prompt`'s `toolOrder` is validated
  against known names, including the deferred ones, so an existing `toolOrder`
  keeps working.
- If a composition presents the PTC program transport (`run_code`), every tool is
  already reached through the generated SDK; that step is passed through
  unchanged rather than double-narrowed.
- Turning the plugin off leaves the three tools registered and reporting the full
  catalog; remove the bundle to drop them entirely.

## Compatibility

Verified on DeepSeek Harness 0.2.2-rc.5 with `@deepseek-ai/dsh-tools` 0.2.x,
Node 20+; Windows Desktop (`desktop` profile) and Web (`web` profile).

## Permissions

No new system permissions. The plugin installs a per-agent tool executor and
registers three meta-tools; deferred calls still pass through the existing
approval and guard pipeline.

## License

MIT — see [LICENSE](LICENSE).

## Badges

After your listing goes live, replace the placeholder slug in the badge URL with the one on your dsh-plugin.org detail page:

```markdown
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/liangyishi27/dsh-progressive-tool)
```
