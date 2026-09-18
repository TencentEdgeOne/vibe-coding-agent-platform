'use client';

import { PanelRight, PanelRightClose } from 'lucide-react';

export function ResultPanelToggle({
  open,
  showLabel,
  hideLabel,
  onToggle,
}: {
  open: boolean;
  showLabel: string;
  hideLabel: string;
  onToggle: () => void;
}) {
  const label = open ? hideLabel : showLabel;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="workspace-icon-button"
      aria-expanded={open}
      aria-controls="workspace-result-panel"
      aria-label={label}
      data-tooltip={label}
    >
      {open ? <PanelRightClose /> : <PanelRight />}
    </button>
  );
}
