# nzip agent interface

This directory contains nzip's portable agent-facing interface. It does not contain the nzip
application core.

## Quick install with npx skills

Install the nzip skill for the agent detected in the current project:

    npx skills add FelineStateMachine/nzip --skill nzip

Target Codex explicitly and skip prompts:

    npx skills add FelineStateMachine/nzip --skill nzip --agent codex --yes

The skill guides setup, use, and doctor. Run nzip auth with the server and token supplied by the
nzip operator before the first publish.

## Hermes plugin

From a checkout, install the adapter into Hermes's user plugin directory:

    mkdir -p ~/.hermes/plugins/nzip
    cp -R agent/hermes/. ~/.hermes/plugins/nzip/
    cp agent/tools.json ~/.hermes/plugins/nzip/tools.json
    hermes plugins enable nzip
    hermes plugins list

Hermes plugins are opt-in. Use hermes plugins disable nzip to turn the toolset off again.

## Claude Code plugin

Develop the adapter locally:

    claude --plugin-dir ./agent/claude/nzip

The adapter exposes the same nzip MCP toolset as the Codex plugin.
