"""Hermes adapter for the nzip agent interface."""

from .tools import definitions, invoke


def register(ctx):
    """Register the shared nzip tool contract with Hermes."""
    for tool in definitions():
        schema = {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["inputSchema"],
        }

        def handler(params, tool_name=tool["name"], **kwargs):
            del kwargs
            return invoke(tool_name, params)

        ctx.register_tool(
            name=tool["name"],
            toolset="nzip",
            schema=schema,
            handler=handler,
            description=tool["description"],
        )
