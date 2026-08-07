// ponytail: the sidepanel is an extension page, so it can call Gemini itself —
// no message-relay worker needed. This exists only to open the panel on icon click.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
