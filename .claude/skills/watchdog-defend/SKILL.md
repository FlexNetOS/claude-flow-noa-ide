---
name: "watchdog:defend"
description: "Activate Watchdog battle formations to defend against detected threats"
---

# Watchdog Defense

Activate battle formations when threats are detected.

## Steps

1. Call `mcp__watchdog__hub_threat_level` to assess current threat level
2. If threat level is yellow or red, recommend appropriate formation:
   - **Yellow**: `standard-defense` -- moderate monitoring, selective blocking
   - **Red**: `full-lockdown` -- maximum protection, aggressive blocking
3. Present recommendation to user and wait for confirmation
4. On user confirmation, call `mcp__watchdog__hub_activate_formation` with the chosen formation
5. Monitor status via `mcp__watchdog__watchdog_status` until threat clears

## Formation Reference

| Formation | Threat Level | Description |
|-----------|-------------|-------------|
| `standard-defense` | Yellow | Elevated monitoring, targeted blocking |
| `full-lockdown` | Red | All defenses active, aggressive response |
| `reconnaissance` | Any | Passive monitoring, intelligence gathering |

## Prerequisites

- Watchdog MCP server must be configured: `claude mcp add watchdog -- npx watchdog-mcp`
- Tools available: `mcp__watchdog__hub_threat_level`, `mcp__watchdog__hub_activate_formation`, `mcp__watchdog__watchdog_status`
