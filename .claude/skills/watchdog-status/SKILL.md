---
name: "watchdog:status"
description: "Check Watchdog security posture — threats, modules, formations, health"
---

# Watchdog Security Status

Use Watchdog MCP tools to check the security posture of the system.

## Steps

1. Call `mcp__watchdog__watchdog_status` for overall status
2. Call `mcp__watchdog__watchdog_threats` for active threats
3. Display formatted dashboard showing:
   - Overall health (green/yellow/red)
   - Active modules count
   - Active formations
   - Threat summary (count by severity)
4. If threats detected, recommend running `/watchdog:defend`

## Example Output

```
=== Watchdog Security Dashboard ===
Status:     OPERATIONAL
Threat Level: GREEN
Active Modules: 12/12
Active Formations: 0

Threats: 0 critical | 0 high | 0 medium | 2 low
Recommendation: No action required
```

## Prerequisites

- Watchdog MCP server must be configured: `claude mcp add watchdog -- npx watchdog-mcp`
- Tools available: `mcp__watchdog__watchdog_status`, `mcp__watchdog__watchdog_threats`
