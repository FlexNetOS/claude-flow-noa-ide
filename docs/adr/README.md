## Status Bar on Narrow Terminals

On narrow terminal windows, the status bar can occupy significant screen space and reduce visible log output.

### Recommended Terminal Width

For the best terminal experience, use a window width of at least 100 columns.

### Recommended Workarounds

- Widen the terminal window
- Reduce terminal zoom level
- Use the web UI for compact layouts
- Disable the statusline in `.claude/settings.json`

### Disable Statusline

You can disable the terminal statusline by removing or disabling the `statusline` setting in `.claude/settings.json`.

### Notes

Statusline density is more noticeable in narrow terminal layouts and split-pane workflows. Recent versions include rendering improvements, but narrow terminals may still feel cramped.