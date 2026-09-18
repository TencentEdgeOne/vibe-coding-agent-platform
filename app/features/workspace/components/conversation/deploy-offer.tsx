'use client';

import { memo } from 'react';
import type { DeployOfferCopy } from './types';

export const DeployOffer = memo(function DeployOffer({
  deployOffer,
  onDeployOffer,
  onDismissDeployOffer,
}: {
  deployOffer: DeployOfferCopy;
  onDeployOffer?: () => void;
  onDismissDeployOffer?: () => void;
}) {
  return (
    <div className="deploy-offer" role="status">
      <span className="deploy-offer-copy">{deployOffer.prompt}</span>
      <div className="deploy-offer-actions">
        <button
          type="button"
          className="deploy-offer-dismiss"
          onClick={onDismissDeployOffer}
        >
          {deployOffer.dismiss}
        </button>
        <button
          type="button"
          className="deploy-offer-accept"
          onClick={onDeployOffer}
        >
          {deployOffer.deploy}
        </button>
      </div>
    </div>
  );
});
