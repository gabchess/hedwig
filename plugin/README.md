# Hedwig for Claude Code

Know before it pays.

Ask Hedwig before your AI agent pays. It checks the payment against your limits and says why. It never signs or sends.

## Install

You need Node.js 22 or newer. In Claude Code:

```text
/plugin install hedwig --marketplace gabchess/hedwig
```

Run `/mcp` to see `hedwig` connected.

## Try it

```text
/hedwig:ask Pay alice 1 USDC.
```

Then try 50 USDC. Nothing is sent.

## Set your own limits

Keep your limits file where your agent can't edit it. Start Claude Code with its path:

```sh
HEDWIG_POLICY_FILE=/absolute/path/limits.json claude
```

The fields are in the [MCP server guide](../mcp/README.md).
