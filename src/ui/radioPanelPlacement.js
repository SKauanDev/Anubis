/** Keep Radio as its own right-rail menu in every theme. */
export function syncRadioPanelPlacement(doc) {
  if (!doc?.getElementById) return;
  const panel = doc.getElementById('radio-panel');
  const rail = doc.getElementById('right-context-rail');
  const dock = doc.getElementById('context-radio-dock');
  const mini = doc.getElementById('context-radio-mini');
  const header = panel?.querySelector('.panel-header');
  if (!panel || !rail || !header || !dock || !mini) return;
  if (panel.parentElement !== rail) rail.append(panel);
  if (dock.parentElement !== header)
    header.insertBefore(dock, header.querySelector('.panel-collapse-btn'));
  if (mini.parentElement !== dock) dock.append(mini);
}
