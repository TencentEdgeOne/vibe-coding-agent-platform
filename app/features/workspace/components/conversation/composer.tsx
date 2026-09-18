'use client';

import { FormEvent, memo } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { ModelPicker } from '../model-picker';
import type { ConversationCopy, ModelOption } from './types';

export const Composer = memo(function Composer({
  input,
  loading,
  canSend,
  copy,
  models,
  model,
  onModelChange,
  onInputChange,
  onSubmit,
  onStop,
}: {
  input: string;
  loading: boolean;
  canSend: boolean;
  copy: ConversationCopy;
  models: readonly ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form onSubmit={submit} className="conversation-composer">
      <textarea
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!loading && canSend) onSubmit();
          }
        }}
        placeholder={copy.placeholder}
        rows={1}
      />
      {/* Locked mid-run: the turn already went out on a model, and letting the
          control move would show one name while another was answering. */}
      <ModelPicker
        models={models}
        value={model}
        ariaLabel={copy.modelLabel}
        disabled={loading}
        onChange={onModelChange}
      />
      {loading ? (
        <button type="button" className="composer-stop" onClick={onStop} title={copy.stop} aria-label={copy.stop}>
          <Square className="size-3" fill="currentColor" />
        </button>
      ) : (
        <button type="submit" className="composer-send" disabled={!canSend} title={copy.send} aria-label={copy.send}>
          <ArrowUp className="size-4" />
        </button>
      )}
    </form>
  );
});
