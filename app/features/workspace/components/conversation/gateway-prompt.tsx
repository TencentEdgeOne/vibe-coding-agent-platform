'use client';

import { memo, useEffect, useRef, useState } from 'react';
import type { GatewayPromptCopy } from './types';

export const GatewayPrompt = memo(function GatewayPrompt({
  gatewayPrompt,
  gatewayChip,
  gatewaySaved,
  gatewayBusy,
  onGatewaySubmit,
  onGatewaySkip,
  onGatewayReopen,
}: {
  gatewayPrompt?: GatewayPromptCopy | null;
  gatewayChip?: string | null;
  gatewaySaved?: string | null;
  gatewayBusy?: boolean;
  onGatewaySubmit?: (values: { apiKey: string }) => void;
  onGatewaySkip?: () => void;
  onGatewayReopen?: () => void;
}) {
  const [gatewayApiKey, setGatewayApiKey] = useState('');
  const gatewayInputRef = useRef<HTMLInputElement | null>(null);
  const gatewayVisible = Boolean(gatewayPrompt);

  useEffect(() => {
    if (!gatewayVisible) {
      setGatewayApiKey('');
      return;
    }
    const node = gatewayInputRef.current;
    if (!node || node.disabled) return;
    node.focus();
  }, [gatewayVisible]);

  return (
    <>
      {gatewayPrompt && (
        <form
          className="gateway-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            if (gatewayBusy) return;
            onGatewaySubmit?.({
              apiKey: gatewayApiKey.trim(),
            });
          }}
        >
          <div className="gateway-prompt-copy">
            <p className="gateway-prompt-title">{gatewayPrompt.title}</p>
            {gatewayPrompt.description && (
              <p className="gateway-prompt-description">{gatewayPrompt.description}</p>
            )}
            <p className="gateway-prompt-docs">
              <a
                href={gatewayPrompt.docsUrl}
                target="_blank"
                rel="noreferrer"
              >
                {gatewayPrompt.docs}
              </a>
            </p>
          </div>
          <label className="gateway-prompt-field">
            <span>{gatewayPrompt.apiKey}</span>
            <input
              ref={gatewayInputRef}
              type="password"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              value={gatewayApiKey}
              disabled={gatewayBusy}
              onChange={(event) => setGatewayApiKey(event.target.value)}
            />
          </label>
          <div className="gateway-prompt-actions">
            <button
              type="button"
              className="deploy-offer-dismiss"
              disabled={gatewayBusy}
              onClick={onGatewaySkip}
            >
              {gatewayPrompt.skip}
            </button>
            <button
              type="submit"
              className="deploy-offer-accept"
              disabled={gatewayBusy || !gatewayApiKey.trim()}
            >
              {gatewayPrompt.continue}
            </button>
          </div>
        </form>
      )}
      {!gatewayPrompt && gatewayChip && (
        <button
          type="button"
          className="gateway-prompt-chip"
          onClick={onGatewayReopen}
        >
          {gatewayChip}
        </button>
      )}
      {!gatewayPrompt && !gatewayChip && gatewaySaved && (
        <p className="gateway-prompt-saved" role="status">{gatewaySaved}</p>
      )}
    </>
  );
});
