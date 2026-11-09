import { useEffect, useState } from 'react';

export type RealtimeState = 'idle' | 'connecting' | 'connected' | 'reconnecting';

const LOADING_FEEDBACK_DELAY_MS = 200;

export function useDelayedFlag(active: boolean, delay = LOADING_FEEDBACK_DELAY_MS, identity = '') {
  const [state, setState] = useState({ identity, visible: false });
  useEffect(() => {
    if (!active) {
      setState({ identity, visible: false });
      return;
    }
    setState({ identity, visible: false });
    const timer = window.setTimeout(() => setState({ identity, visible: true }), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay, identity]);
  return active && state.identity === identity && state.visible;
}

export function useDelayedRealtimeState(state: RealtimeState) {
  const [stableState, setStableState] = useState(state);
  useEffect(() => {
    if (state === 'idle' || state === 'connected') {
      setStableState(state);
      return;
    }
    const timer = window.setTimeout(() => setStableState(state), LOADING_FEEDBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  return state === 'idle' || state === 'connected' ? state : stableState;
}
