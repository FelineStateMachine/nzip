---
name: nzip
description: Host standalone HTML with nzip and manage its shared sites. Use when an agent needs to publish HTML, inspect or protect a share, recover hosted source, restore a prior push, remove a site, or configure and diagnose nzip access.
---

# Nzip

Use the nzip toolset for site operations. Prefer the smallest operation that matches the request:
host_html for a standalone page, inspect_site for metadata, configure_site for TTL/password changes,
and restore_site or delete_site only after the user has requested the state change.

## Setup

1. Check status and list_vaults.
2. If nzip is not authenticated, ask the user for the server and token, then run nzip auth with the
   supplied server and token in their environment.
3. Use an explicit vault:alias when the destination matters. Respect the configured vault
   allow-list; do not work around it with a raw address.

## Use

- Call host_html only with complete, non-empty HTML. Return the URL and expiry.
- Use configure_site to change TTL or password protection after hosting.
- Use download_site only when asked to recover source into a local directory.
- Require confirm: true for delete_site; never infer it.

## Doctor

Run status first. Its error includes an actionable hint for missing authentication, rejected tokens,
unreachable servers, invalid targets, or disallowed vaults. Then use list_vaults to verify the
target vault before a write.
